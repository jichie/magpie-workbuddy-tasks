// Bun aliases the bare node-fetch specifier to native fetch, which ignores
// node:http agents. Load the installed ESM implementation on both runtimes.
import fetch from "node-fetch/src/index.js";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

const agents = new Map();
function agentFor(proxy, target) {
  const protocol = new URL(proxy).protocol;
  const secure = target.protocol === "https:";
  const key = `${secure ? "https" : "http"}:${proxy}`;
  let agent = agents.get(key);
  if (!agent) {
    const Agent = protocol.startsWith("socks") ? SocksProxyAgent : secure ? HttpsProxyAgent : HttpProxyAgent;
    agent = new Agent(proxy, { keepAlive: true, timeout: 30000 });
    agents.set(key, agent);
    if (agents.size > 32) {
      const oldest = agents.keys().next().value;
      agents.get(oldest).destroy();
      agents.delete(oldest);
    }
  }
  return agent;
}

// Explicit agents ignore proxy environment bypasses. socks5h retains the target
// hostname for DNS at the proxy. Select an agent again after HTTP(S) redirects.
export function proxyFetch(input, init = {}, proxy) {
  const options = {
    ...init,
    agent: (target) => agentFor(proxy, target),
    signal: init.signal ?? AbortSignal.timeout(30000),
  };
  delete options.proxy;
  delete options.dispatcher;
  return fetch(input, options);
}
