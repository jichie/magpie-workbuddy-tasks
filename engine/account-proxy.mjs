import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A missing providers.json remains compatible with standalone installations.
// Once a config was observed, disappearance is an error, not a direct fallback.
const knownConfigFiles = new Set();

export function accountProxyFetch(cfgDir, acct, {
  fetchImpl = globalThis.fetch,
  proxyFetch,
} = {}) {
  const file = join(cfgDir, "providers.json");
  if (existsSync(file)) knownConfigFiles.add(file);
  return async (input, init = {}) => {
    let config;
    try {
      config = JSON.parse(readFileSync(file, "utf8"));
      knownConfigFiles.add(file);
      if (!Array.isArray(config?.providers)) throw new Error();
    } catch (err) {
      if (err?.code === "ENOENT" && !knownConfigFiles.has(file)) return fetchImpl(input, init);
      throw new Error("无法读取账户代理配置，已阻止请求（不回退直连）");
    }
    const proxies = config.providers.find((p) => p?.id === acct?.provider)?.accountProxies;
    if (proxies == null) return fetchImpl(input, init);
    if (typeof proxies !== "object" || Array.isArray(proxies)) {
      throw new Error("账户代理映射格式无效，已阻止请求");
    }
    const accountId = acct?.accountId;
    if (!accountId && Object.keys(proxies).length) {
      throw new Error("账户缺少原始 accountId，无法安全匹配代理，已阻止请求");
    }
    if (!Object.hasOwn(proxies, accountId) || proxies[accountId] === "") return fetchImpl(input, init);
    const proxy = proxies[accountId];
    try {
      const url = new URL(proxy);
      if (typeof proxy !== "string" || !["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)) throw new Error();
    } catch {
      throw new Error("账户代理地址无效或协议不支持，已阻止请求");
    }
    try {
      const transport = proxyFetch ?? (await import("./proxy-transport.mjs")).proxyFetch;
      return await transport(input, init, proxy);
    } catch {
      // Never leak proxy credentials through transport exceptions or retry direct.
      throw new Error("账户代理请求失败，未回退直连");
    }
  };
}
