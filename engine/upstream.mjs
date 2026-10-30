// upstream.mjs —— 上游调用的统一入口：信封、重试、退避、403/11140 限权、
// chat 主机失联回退（CONTRACT §2）。
//
// 零真实网络：fetch 一律来自 opts.fetch ?? globalThis.fetch，测试注入假
// responder。时钟同理：opts.now / opts.sleep，引擎逻辑里绝不直接摸
// Date.now()/setTimeout（兜底 defaultNow 仅在调用方什么都不给时用）。

import * as identity from "./identity.mjs";
import {
  BILL_BASE,
  CHAT_BASE,
  CHAT_FALLBACK_BASE,
  DEFAULT_GAP_MS,
  REFRESH_PATH,
  WEB_BASE,
} from "./constants.mjs";

// 兜底时钟（生产 runner/daemon 会注入真时钟；测试注入假时钟）。
export const clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// ---- base -------------------------------------------------------------------
// growthBase：默认 https://copilot.tencent.com；环境变量 WB_GROWTH_BASE /
// WB_CN_CHAT_UPSTREAM 可覆盖（与 hub 的 wb_identity.CN_CHAT_BASE 同口径）。
export function growthBase(env = globalThis.process?.env ?? {}) {
  const raw = String(env.WB_GROWTH_BASE || env.WB_CN_CHAT_UPSTREAM || "").trim();
  if (!raw) return CHAT_BASE;
  const base = raw.replace(/\/+$/, "");
  const m = /^(https?:\/\/)/.exec(base);
  return m ? base : CHAT_BASE;
}

export function billBase() {
  return BILL_BASE;
}

export function webBase() {
  return WEB_BASE;
}

// chatBase：growthBase，可被 opts.base / opts.bases.chat（daemon 的
// settings.host）覆盖。
export function chatBase(opts = {}) {
  const fromOpts = String(opts.base || opts.bases?.chat || "").trim();
  return fromOpts ? fromOpts.replace(/\/+$/, "") : growthBase(opts.env ?? globalThis.process?.env ?? {});
}

// ---- makeCtx：一次流水线共享的时钟 + 节奏器 ----------------------------------
// breathe(ms) 保证「自上一次 breathe 至少过了 ms 毫秒」（假时钟上就是把时钟
// 拨过去），这是 ≥1 s 防风控间隔的实现载体：所有上游调用前都 breathe 一下。
export function makeCtx(opts = {}) {
  const now = opts.now ?? clock.now;
  const sleep = opts.sleep ?? clock.sleep;
  const gap = Math.max(0, Number(opts.gap ?? DEFAULT_GAP_MS));
  let last = now() - gap; // 首个调用前不空等（与 hub 行为一致：调用后才睡）
  return {
    now,
    sleep,
    gap,
    signal: opts.signal ?? null,
    fetch: opts.fetch ?? globalThis.fetch,
    log: typeof opts.log === "function" ? opts.log : null,
    async breathe(ms = gap) {
      const wait = Math.max(0, ms - (now() - last));
      if (wait > 0) await sleep(wait);
      last = now();
    },
  };
}

// 取 ctx：顶层流水线用 makeCtx 建一个并挂到 opts.__ctx 上层层传递；单独调用
// 的低层函数就地建一个并记在 opts 上（同一个 opts 对象此后共享同一个时钟与
// 节奏器 —— 否则跨函数的 ≥1s 间隔会失效）。
export function ctxOf(opts) {
  if (opts.__ctx === undefined) opts.__ctx = makeCtx(opts);
  return opts.__ctx;
}

function stepOf(opts, acct) {
  const ctx = ctxOf(opts);
  return (state, detail) =>
    ctx.log?.({ uid: acct?.uid ?? "", leg: opts.leg ?? "upstream", state, detail });
}

// ---- 头 ----------------------------------------------------------------------
export function headersFor(acct, kind, ids = {}, opts = {}) {
  if (kind === "billing") return identity.billingHeaders(acct, opts);
  if (kind === "web") return identity.webHeaders(acct);
  return identity.chatHeaders(acct, ids, opts);
}

// ---- 信封 --------------------------------------------------------------------
function parseEnvelope(text) {
  let env = {};
  try {
    env = JSON.parse(text);
  } catch {
    return { env: null };
  }
  if (!env || typeof env !== "object" || Array.isArray(env)) return { env: null };
  const code = typeof env.code === "number" ? env.code : Number.parseInt(env.code, 10) || 0;
  return { env, code };
}

function shortPath(url) {
  try {
    const u = new URL(url);
    return u.pathname + (u.search || "");
  } catch {
    return url;
  }
}

function fallbackUrl(url) {
  // chat 主机失联 → 回退 https://www.workbuddy.cn：只换 host，路径与
  // X-Domain 都不动（CONTRACT §2）。
  try {
    const u = new URL(url);
    const fb = new URL(CHAT_FALLBACK_BASE);
    u.protocol = fb.protocol;
    u.host = fb.host;
    return u.toString();
  } catch {
    return url;
  }
}

// 一次 HTTP 尝试。返回 {kind:"http", status, text} 或 {kind:"error", error}。
async function attempt(fetchImpl, url, method, headers, body, signal) {
  try {
    const res = await fetchImpl(url, { method, headers, body: body ?? undefined, signal });
    const text = await res.text();
    return { kind: "http", status: res.status, text };
  } catch (err) {
    return { kind: "error", error: err };
  }
}

// callJSON(acct, kind, url, init, opts) -> {ok, status, code, data, msg, raw, restricted?}
//
// - kind: 'chat' | 'billing' | 'web'（决定头族）
// - init: {method, body}（body 已是字符串/undefined）
// - opts: {fetch, now, sleep, signal, log, leg, env, base, bases, gap, __ctx}
// - 信封：{code, msg, data}，code===0 视为成功（2xx 且 code 0）
// - 3 次线性退避重试，只重试「瞬时网络故障 / 5xx」（hub 的 _retryable 口径）
// - HTTP 403 或信封 code 11140 → restricted:true，绝不重试（runner 记冷却）
// - chat 主机网络级失败 → 最后用 https://www.workbuddy.cn 再试一次，X-Domain 不变
export async function callJSON(acct, kind, url, init = {}, opts = {}) {
  const ctx = ctxOf(opts);
  const fetchImpl = opts.fetch ?? ctx.fetch ?? globalThis.fetch;
  const sleep = opts.sleep ?? ctx.sleep;
  const method = String(init.method || "GET").toUpperCase();
  const step = stepOf(opts, acct);
  const headers = headersFor(acct, kind, init.ids ?? {}, opts);
  const body = init.body === undefined ? undefined : String(init.body);
  const signal = opts.signal ?? ctx.signal ?? undefined;

  let lastError = null;
  let lastStatus = 0;
  let lastText = "";

  for (let i = 1; i <= 3; i++) {
    const r = await attempt(fetchImpl, url, method, headers, body, signal);

    if (r.kind === "error") {
      lastError = r.error;
      step("retry", `${method} ${shortPath(url)} 网络错误 (${String(r.error?.message || r.error)})`);
      // TLS verify 一类不该重试的错误这里无法可靠区分（Node 里没有独立类型），
      // 与 hub 一致按「网络故障」处理；重试预算用尽后走下方失败路径。
      if (i < 3) {
        await sleep(1000 * i); // 线性退避 1s, 2s（hub http_json 的 backoff*attempt）
        continue;
      }
      break;
    }

    lastStatus = r.status;
    lastText = r.text || "";

    if (r.status === 403) {
      // 账号级风控限制（hub note_restricted：立即停手，绝不换头再试）
      const { env, code } = parseEnvelope(lastText);
      step("restricted", `${method} ${shortPath(url)} HTTP 403${env?.msg ? ` ${env.msg}` : ""}`);
      return {
        ok: false, status: 403, code: code ?? 0, data: env?.data ?? null,
        msg: env?.msg || "HTTP 403", raw: lastText.slice(0, 400), restricted: true,
      };
    }

    if (r.status >= 500 || r.status === 429 || r.status === 408) {
      step("retry", `${method} ${shortPath(url)} HTTP ${r.status}`);
      if (i < 3) {
        await sleep(1000 * i);
        continue;
      }
      break;
    }

    // 2xx/4xx：不再重试，按信封结算
    const { env, code } = parseEnvelope(lastText);
    if (env) {
      if (code === 11140) {
        step("restricted", `${method} ${shortPath(url)} code 11140 ${env.msg || ""}`);
        return {
          ok: false, status: r.status, code, data: env.data ?? null,
          msg: env.msg || "request illegal", raw: lastText.slice(0, 400), restricted: true,
        };
      }
      const ok = r.status >= 200 && r.status < 300 && code === 0;
      step(ok ? "ok" : "fail", `${method} ${shortPath(url)} HTTP ${r.status} code ${code}${env.msg ? ` ${env.msg}` : ""}`);
      return {
        ok,
        status: r.status,
        code,
        data: env.data ?? null,
        msg: ok ? "" : env.msg || `code=${code}`,
        raw: lastText.slice(0, 400),
      };
    }
    // 非 JSON 主体：2xx 也没有信封可看 —— 按失败结算
    step("fail", `${method} ${shortPath(url)} HTTP ${r.status} (非 JSON 响应)`);
    return {
      ok: false,
      status: r.status,
      code: -1,
      data: null,
      msg: r.status >= 200 && r.status < 300 ? "invalid JSON response" : `HTTP ${r.status}`,
      raw: lastText.slice(0, 400),
    };
  }

  // 三次都撞网络错误：chat 主机失联（TLS reset 一类）→ 回退到
  // https://www.workbuddy.cn 再试一次；头不变（X-Domain 仍是账号 domain）。
  if (lastError && kind === "chat") {
    const alt = fallbackUrl(url);
    if (alt !== url) {
      step("retry", `${method} ${shortPath(url)} 主机失联，回退 ${CHAT_FALLBACK_BASE}`);
      const r = await attempt(fetchImpl, alt, method, headers, body, signal);
      if (r.kind === "http") {
        const { env, code } = parseEnvelope(r.text || "");
        if (env) {
          if (code === 11140) {
            step("restricted", `${method} ${shortPath(alt)} code 11140`);
            return {
              ok: false, status: r.status, code, data: env.data ?? null,
              msg: env.msg || "request illegal", raw: (r.text || "").slice(0, 400), restricted: true,
            };
          }
          const ok = r.status >= 200 && r.status < 300 && code === 0;
          step(ok ? "ok" : "fail", `${method} ${shortPath(alt)} HTTP ${r.status} code ${code}`);
          return {
            ok, status: r.status, code, data: env.data ?? null,
            msg: ok ? "" : env.msg || `code=${code}`, raw: (r.text || "").slice(0, 400),
          };
        }
        step("fail", `${method} ${shortPath(alt)} HTTP ${r.status} (非 JSON 响应)`);
        return { ok: false, status: r.status, code: -1, data: null, msg: `HTTP ${r.status}`, raw: (r.text || "").slice(0, 400) };
      }
      step("fail", `${method} ${shortPath(alt)} 回退也失败 (${String(r.error?.message || r.error)})`);
    }
  }

  const detail = lastError
    ? `网络错误: ${String(lastError?.message || lastError)}`
    : `HTTP ${lastStatus}`;
  step("fail", `${method} ${shortPath(url)} ${detail}`);
  return {
    ok: false,
    status: lastStatus,
    code: -1,
    data: null,
    msg: detail,
    raw: (lastText || "").slice(0, 400),
    ...(lastError ? { error: String(lastError?.message || lastError) } : {}),
  };
}

// ---- token 刷新（wb_accounts.Account._refresh_locked + magpie merge 口径）--
// POST {chat} + engine/constants.REFRESH_PATH（字面值只在 constants.mjs）；
// 头 X-Refresh-Token / X-Auth-Refresh-Source: workbuddy / X-Domain；响应
// data.accessToken（可能嵌套 data.data），refreshToken 轮换时一并带回。
// 调用方（runner）负责原子回写 plugin-auth.json（铁律 3：单一凭据血统）。
export async function refreshAccount(acct, opts = {}) {
  const now = opts.now ?? clock.now;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const step = stepOf(opts, acct);
  if (!acct?.refresh) return { ok: false, reason: "no refresh token" };
  const url = chatBase(opts) + REFRESH_PATH;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: identity.refreshHeaders(acct),
      body: "{}",
      signal: opts.signal,
    });
    const text = await res.text();
    let env = {};
    try {
      env = JSON.parse(text);
    } catch {}
    let data = env.data ?? {};
    data = data.data ?? data; // 响应可能嵌套 data.data
    const access = data.accessToken;
    const okStatus = res.status >= 200 && res.status < 300;
    if (!okStatus || !access) {
      step("fail", `refresh HTTP ${res.status} ${env.msg || ""}`);
      return { ok: false, reason: env.msg || `HTTP ${res.status}` };
    }
    const patch = { access };
    if (data.refreshToken) patch.refresh = data.refreshToken;
    const expires =
      data.expiresAt > 0 ? data.expiresAt : data.expiresIn > 0 ? now() + data.expiresIn * 1000 : 0;
    if (expires) patch.expires = expires;
    if (data.refreshExpiresAt > 0) patch.refreshExpiresAt = data.refreshExpiresAt;
    else if (data.refreshExpiresIn > 0) patch.refreshExpiresAt = now() + data.refreshExpiresIn * 1000;
    if (data.domain) patch.domain = data.domain;
    if (data.tokenType) patch.tokenType = data.tokenType;
    step("ok", "refresh 刷新成功");
    return { ok: true, patch };
  } catch (err) {
    step("fail", `refresh 网络错误 (${String(err?.message || err)})`);
    return { ok: false, reason: String(err?.message || err) };
  }
}
