import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { accountProxyFetch } from "../engine/account-proxy.mjs";
import { loadAccounts } from "../engine/store.mjs";
import { JobRunner } from "../engine/runner.mjs";
import { fakeClock, localTime, makeAcct, task, wbBackend } from "./helpers.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "wb-proxy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const save = (mapping) => writeFileSync(join(dir, "providers.json"), JSON.stringify({
    providers: [{ id: "workbuddy", accountProxies: mapping }],
  }));
  return { dir, save };
}
const account = (id) => ({ provider: "workbuddy", accountId: id, uid: `uid-${id}` });

test("proxy: standalone installation without providers.json keeps its injected fetch", async (t) => {
  const {dir}=fixture(t);let calls=0;
  const f=accountProxyFetch(dir,account("A"),{fetchImpl:async()=>{calls++;return new Response("legacy");}});
  assert.equal(await(await f("https://upstream.invalid")).text(),"legacy");
  assert.equal(calls,1);
});

test("proxy: exact accountId/provider match, dynamic reload, no nickname fallback", async (t) => {
  const {dir, save} = fixture(t);
  save({ A: "http://localhost:1001", B: "http://localhost:1002" });
  const seen = [];
  const fetchImpl = async (_, init) => { seen.push(init); return new Response("ok"); };
  const proxyFetch = async (_, init, proxy) => { seen.push({...init, proxy}); return new Response("ok"); };
  const a = accountProxyFetch(dir, account("A"), {fetchImpl, proxyFetch});
  await a("https://upstream.invalid", {method:"POST", body:"test", signal: AbortSignal.timeout(5000)});
  await accountProxyFetch(dir, account("B"), {fetchImpl, proxyFetch})("https://upstream.invalid");
  save({ A: "http://localhost:1003" });
  await a("https://upstream.invalid");
  await accountProxyFetch(dir, account("unbound"), {fetchImpl, proxyFetch})("https://upstream.invalid");
  assert.deepEqual(seen.map(i => i.proxy), ["http://localhost:1001","http://localhost:1002","http://localhost:1003",undefined]);

  assert.equal(seen[0].method, "POST"); assert.equal(seen[0].body, "test");
  await assert.rejects(accountProxyFetch(dir, {provider:"workbuddy",nickname:"A"}, {fetchImpl, proxyFetch})("https://upstream.invalid"), /accountId/);
});

test("proxy: corrupt or disappeared config and bad proxies fail closed; redact errors", async (t) => {
  const {dir,save} = fixture(t); let calls=0;
  const fetchImpl = async () => { calls++; throw Error("http://user:secret@private.invalid"); };
  save({A:"http://localhost:1234"});
  const proxyFetch = fetchImpl;
  const f = accountProxyFetch(dir,account("A"),{fetchImpl, proxyFetch});
  rmSync(join(dir,"providers.json"));
  await assert.rejects(f("https://upstream.invalid"), /阻止/);
  writeFileSync(join(dir,"providers.json"), "{");
  await assert.rejects(f("https://upstream.invalid"), /阻止/);
  for(const bad of [null,42,"ftp://localhost:1234","bad"]){
    save({A:bad}); await assert.rejects(f("https://upstream.invalid"), /阻止/);
  }
  save({A:"http://user:secret@localhost:1234"});
  assert.equal(calls,0);
  await assert.rejects(f("https://upstream.invalid"), e => !/secret|private|localhost/.test(e.message) && /未回退直连/.test(e.message));
  assert.equal(calls,1);
});

test("store: preserves original accountId independently of nickname fallback", (t) => {
  const {dir} = fixture(t);
  writeFileSync(join(dir,"plugin-auth.json"), JSON.stringify({workbuddy:{uid:"u1",accountId:"original",access:"fake"},"workbuddy#2":{uid:"u2",access:"fake"}}));
  const loaded=loadAccounts(dir);
  assert.equal(loaded[0].accountId,"original");
  assert.equal(loaded[1].accountId,""); assert.equal(loaded[1].nickname,"u2");
});

test("runner: refresh, daily activity and task legs all use account-specific fetch", async () => {
  const clock=fakeClock(localTime(2026,9,15,10,0));
  const accounts=["A","B"].map(id=>makeAcct({...account(id),key:`workbuddy#${id}`,expires:clock.now()-1}));
  const calls=[];
  const backends=Object.fromEntries(accounts.map(a=>[a.uid,wbBackend({clock,tasks:[task("create_canvas",{reward:300})]})]));
  const runner=new JobRunner({accounts,now:clock.now,sleep:clock.sleep,fetch:()=>{throw Error("unscoped fetch");},
    fetchForAccount: acct => async (url,init) => {calls.push({id:acct.uid,url:String(url)});return backends[acct.uid].fetchImpl(url,init);},
    saveRefresh:()=>{},
  });
  const job=runner.start({legs:["growth"]}); const done=await runner.wait(job.id);
  assert.equal(done.state,"done"); assert.equal(done.steps.length,2);
  for(const acct of accounts){
    const own=calls.filter(c=>c.id===acct.uid);
    assert.ok(own.some(c=>c.url.includes("refresh")),JSON.stringify(own));
    assert.ok(own.length>2);
  }
  assert.ok(done.steps.every(s=>s.state==="ok"),JSON.stringify(done.steps));
});

async function listen(t, server) {
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return `http://127.0.0.1:${server.address().port}`;
}

test("transport: two proxies, NO_PROXY override, CONNECT and no direct fallback", async (t) => {
  const {dir,save}=fixture(t); let direct=0; const hits=[]; let tunnels=0;
  const origin=await listen(t,http.createServer((req,res)=>{direct++;res.end("DIRECT");}));
  const proxyA=http.createServer((req,res)=>{hits.push(["A",req.url]);res.end("A");});
  proxyA.on("connect",(req,socket)=>{tunnels++; socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");});
  const aUrl=await listen(t,proxyA);
  const bUrl=await listen(t,http.createServer((req,res)=>{hits.push(["B",req.url]);res.end("B");}));
  save({A:aUrl,B:bUrl});
  const previous=process.env.NO_PROXY; const lower=process.env.no_proxy;
  process.env.NO_PROXY="*";process.env.no_proxy="*";
  t.after(()=>{if(previous===undefined)delete process.env.NO_PROXY;else process.env.NO_PROXY=previous;if(lower===undefined)delete process.env.no_proxy;else process.env.no_proxy=lower;});
  const a=accountProxyFetch(dir,account("A")); const b=accountProxyFetch(dir,account("B"));
  assert.equal(await (await a(`${origin}/one`)).text(),"A");
  assert.equal(await (await b(`${origin}/two`)).text(),"B");
  assert.deepEqual(hits.map(h=>h[0]),["A","B"]); assert.equal(direct,0);
  const tunnelFailure = await a("https://upstream.invalid/",{signal:AbortSignal.timeout(3000)});
  assert.equal(tunnelFailure.status,502);
  await tunnelFailure.text();
  assert.equal(tunnels,1);
  // A closed port must not fall back to the reachable origin.
  await new Promise(resolve=>proxyA.close(resolve));
  await assert.rejects(a(`${origin}/blocked`,{signal:AbortSignal.timeout(3000)}),/未回退直连/);
  assert.equal(direct,0);
});
