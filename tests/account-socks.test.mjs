import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,writeFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";
import { accountProxyFetch } from "../engine/account-proxy.mjs";

test("SOCKS5H: password auth, remote DNS, redirects and no direct fallback", async (t) => {
  const dir=mkdtempSync(join(tmpdir(),"wb-socks-"));
  const sockets=new Set(); const destinations=[];const auth=[];const requests=[];
  const origin=http.createServer((req,res)=>{
    requests.push({url:req.url,auth:req.headers['proxy-authorization']});
    if(req.url==='/redirect'){res.writeHead(302,{location:`http://second.invalid:${origin.address().port}/final`});res.end();}
    else res.end("via-socks");
  });
  await new Promise(r=>origin.listen(0,"127.0.0.1",r));
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    let buf=Buffer.alloc(0),stage=0;
    const read=chunk=>{
      buf=Buffer.concat([buf,chunk]);
      while(true){
        if(stage===0){if(buf.length<2||buf.length<2+buf[1])return;const length=2+buf[1];assert.equal(buf[0],5);buf=buf.subarray(length);socket.write(Buffer.from([5,2]));stage=1;}
        else if(stage===1){
          if(buf.length<2)return; const ul=buf[1];if(buf.length<3+ul)return;const pl=buf[2+ul];if(buf.length<3+ul+pl)return;
          const u=buf.subarray(2,2+ul).toString();const p=buf.subarray(3+ul,3+ul+pl).toString();auth.push([u,p]);
          buf=buf.subarray(3+ul+pl);if(p!=="fake-password"){socket.end(Buffer.from([1,1]));return;}
          socket.write(Buffer.from([1,0]));stage=2;
        } else if(stage===2){
          if(buf.length<5)return;assert.equal(buf[3],3,"DNS must be resolved by the SOCKS server");const len=buf[4];if(buf.length<7+len)return;
          destinations.push(buf.subarray(5,5+len).toString());
          const port=buf.readUInt16BE(5+len);buf=buf.subarray(7+len);stage=3;socket.removeListener('data',read);
          const upstream=net.connect(port,"127.0.0.1",()=>{
            socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));if(buf.length)upstream.write(buf);socket.pipe(upstream);upstream.pipe(socket);
          });upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());return;
        }else return;
      }
    };socket.on('data',read);
  });
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  t.after(()=>{for(const s of sockets)s.destroy();server.close();origin.closeAllConnections();origin.close();rmSync(dir,{recursive:true,force:true});});
  const proxy=`socks5h://fake-user:fake-password@127.0.0.1:${server.address().port}`;
  const save=p=>writeFileSync(join(dir,"providers.json"),JSON.stringify({providers:[{id:"workbuddy",accountProxies:{A:p}}]}));
  save(proxy);
  const f=accountProxyFetch(dir,{provider:"workbuddy",accountId:"A"});
  const previous=process.env.NO_PROXY;process.env.NO_PROXY="*";
  try{
    const r=await f(`http://first.invalid:${origin.address().port}/redirect`,{signal:AbortSignal.timeout(3000)});
    assert.equal(await r.text(),"via-socks");
    assert.deepEqual(destinations,["first.invalid","second.invalid"]);
    assert.ok(auth.every(([u,p])=>u==="fake-user"&&p==="fake-password"));
    assert.ok(requests.every(r=>!r.auth),"proxy credentials must not reach upstream");
    save(proxy.replace("fake-password","wrong-secret"));
    await assert.rejects(f(`http://reachable.invalid:${origin.address().port}/blocked`,{signal:AbortSignal.timeout(3000)}),e=>/未回退直连/.test(e.message)&&!/wrong-secret/.test(e.message));
    assert.equal(requests.length,2);
  } finally {if(previous===undefined)delete process.env.NO_PROXY;else process.env.NO_PROXY=previous;}
});
