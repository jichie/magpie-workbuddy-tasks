import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,writeFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { startDaemon } from "../daemon.mjs";
import * as store from "../engine/store.mjs";

test("daemon: checkin engine options resolve the current account proxy", async (t) => {
  const dir=mkdtempSync(join(tmpdir(),"wb-proxy-daemon-"));
  const hits=[];
  const proxy=http.createServer((req,res)=>{hits.push(req.url);res.setHeader("content-type","application/json");res.end(JSON.stringify({code:0,msg:"success",data:{credit:1}}));});
  await new Promise(r=>proxy.listen(0,"127.0.0.1",r));
  t.after(()=>{proxy.closeAllConnections();proxy.close();rmSync(dir,{recursive:true,force:true});});
  writeFileSync(join(dir,"providers.json"),JSON.stringify({providers:[{id:"workbuddy",accountProxies:{original:`http://127.0.0.1:${proxy.address().port}`}}]}));
  writeFileSync(join(dir,"plugin-auth.json"),JSON.stringify({workbuddy:{uid:"fake-uid",accountId:"original",access:"fake-only",expires:Date.now()+86400000}}));
  const engine={ok:true,errors:[],store,upstream:{
    billBase:()=>"http://must-not-resolve.invalid",
    callJSON:async(acct,kind,url,request,opts)=>{
      assert.equal(acct.accountId,"original");
      return {...await (await opts.fetch(url,{...request,signal:AbortSignal.timeout(2000)})).json(),ok:true};
    },
  }};
  const h=await startDaemon({cfgDir:dir,stateDir:join(dir,"state"),port:0,engine,noTimers:true,skipExistingCheck:true,log:()=>{},sleep:async()=>{}});
  try {
    const res=await fetch(`http://127.0.0.1:${h.port}/api/checkin`,{method:"POST",headers:{"Content-Type":"application/json",Connection:"close"},body:JSON.stringify({uids:["fake-uid"]}),proxy:false});
    assert.equal(res.status,200);const rows=await res.json();
    assert.equal(rows[0].outcome,"claimed");assert.equal(hits.length,1);
    assert.ok(hits[0].includes("must-not-resolve.invalid/billing/meter/daily-checkin"));
  } finally {await h.stop();}
});
