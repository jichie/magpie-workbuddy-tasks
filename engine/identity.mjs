// identity.mjs —— 三套出站请求头构造：chat / billing / web（+ 刷新）。
//
// 移植自 wb_identity.build_identity_headers 的**桌面端国内版分支**（成长任务
// 全部走 product=workbuddy、realm=cn 的桌面身分）与 wb_accounts.Account.headers
// 的外层包装。键名大小写必须逐字一致（上游网关看的是头名形态）。
//
// 头族速记（桌面端 CN）：
//   - Account.headers 的浏览器形态包装：Content-Type / Accept /
//     X-Requested-With / Origin / Referer / X-CodeBuddy-Request /
//     Accept-Language（Origin/Referer 是 codebuddy.cn，即便请求打向
//     copilot.tencent.com —— 与 hub 同一口径）；
//   - wb_identity 桌面分支：X-Agent-* / X-IDE-* / X-Product / X-Domain /
//     User-Agent / Authorization / X-User-Id / X-Conversation-* 家族；
//   - trace 头族：X-Trace-ID / traceparent / b3 / X-B3-*（桌面端无父 span）。
//
// 注意：官方对话请求不带 X-Machine-ID / X-Session-ID（那两个只用于计费/反馈
// 上报），chat 头里也不发 —— 与 hub 的 Account.headers 注释一致。

import { deriveId, sessionKey, uuidHex } from "./fingerprint.mjs";
import {
  BILLING_UA_CN,
  CN_CHAT_DOMAIN,
  CN_ORIGIN,
  DESKTOP_UA_CN,
  DESKTOP_VERSION_CN,
  REFRESH_SOURCE_CN,
  WEB_BASE,
  WEB_UA,
} from "./constants.mjs";

// ---- 可注入时钟的兜底 -------------------------------------------------------
// 引擎内部永远通过 opts.now / opts.sleep 拿时间；这里只是调用方什么都没给的
// 时候的兜底（生产上 runner/daemon 会传真时钟，测试传假时钟）。
export const defaultNow = () => Date.now();

// ---- id 形态（wb_identity.uuid7 / new_message_id / new_conversation_id）----
// RFC 9562 UUIDv7：48 位毫秒时间戳打头、后面是随机位。请求/消息 id 是 32 位
// 无连字符 hex，会话 id 是带连字符的 UUID。上游不校验版本号，形态贴近即可。
export function uuid7Hex(nowMs = defaultNow()) {
  // 注意掩码必须在 BigInt 上做：Number 上的 & 会被 int32 化成负数。
  const ms = BigInt(Math.floor(nowMs)) & ((1n << 48n) - 1n); // (1<<48)-1
  const randA = BigInt("0x" + uuidHex().slice(0, 6)) & 0xfffn; // 12 bits
  const randB = BigInt("0x" + uuidHex().slice(0, 16)) & 0x3fffffffffffffffn; // 62 bits
  const value = (ms << 80n) | (0x7n << 76n) | (randA << 64n) | (0b10n << 62n) | randB;
  return value.toString(16).padStart(32, "0");
}

export function uuid7String(nowMs = defaultNow()) {
  const h = uuid7Hex(nowMs);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// X-Domain：账号登录时记下的 domain 优先（wb_identity：覆盖 base 也不改它）。
export function domainOf(acct) {
  const d = String(acct?.domain || "").trim();
  return d || CN_CHAT_DOMAIN;
}

// ---- trace 头族（wb_identity.trace_headers，with_parent=False 桌面分支）----
function traceHeaders(nowMs) {
  const trace = uuid7Hex(nowMs);
  const span = uuidHex().slice(0, 16); // secrets.token_hex(8) = 16 hex
  return {
    "X-Trace-ID": trace,
    traceparent: `00-${trace}-${span}-01`,
    b3: `${trace}-${span}-1`,
    "X-B3-TraceId": trace,
    "X-B3-SpanId": span,
    "X-B3-Sampled": "1",
  };
}

// ---- chat 头（wb_accounts.Account.headers(purpose="chat") 桌面 CN 分支）----
//
// ids: {conversationId, requestId, messageId, rootRequestId} 全部可注入；
// 缺省时按桌面端「每请求新生成」生成（会话 id 带连字符 UUIDv7、消息 id 32hex）。
export function chatHeaders(acct, ids = {}, opts = {}) {
  const nowMs = opts.now ? opts.now() : defaultNow();
  const uid = String(acct?.uid ?? "anonymous");
  const conv = String(ids.conversationId || "").trim() || uuid7String(nowMs);
  const msgId = String(ids.messageId || "").trim() || uuid7Hex(nowMs);
  // 桌面端主链路：X-Conversation-Request-ID 与 X-Root-Request-ID 是同一个值。
  const convReqId = String(ids.requestId || ids.rootRequestId || "").trim() || uuid7Hex(nowMs);
  const rootId = String(ids.rootRequestId || "").trim() || convReqId;

  const headers = {
    // 浏览器形态包装（hub 的 cn 分支）
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: CN_ORIGIN,
    Referer: CN_ORIGIN + "/",
    "X-CodeBuddy-Request": "1",
    "Accept-Language": "zh-CN",
    // wb_identity 桌面分支
    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",
    "X-Agent-Type": "main",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Version": DESKTOP_VERSION_CN,
    "X-Private-Data": "true",
    "X-Product": "SaaS",
    "X-Domain": domainOf(acct),
    "User-Agent": DESKTOP_UA_CN,
    "X-User-Id": uid,
    Authorization: "Bearer " + String(acct?.access ?? ""),
    "X-Conversation-ID": conv,
    "X-Conversation-Request-ID": convReqId,
    "X-Root-Request-ID": rootId,
    "X-Conversation-Message-ID": msgId,
    "X-Request-ID": msgId,
  };
  Object.assign(headers, traceHeaders(nowMs));
  // 企业号（任务侧基本不会出现，eligibleAccounts 已排除，但头保持完备）
  if (acct?.enterpriseId) {
    headers["X-Enterprise-Id"] = String(acct.enterpriseId);
    headers["X-Tenant-Id"] = String(acct.enterpriseId);
  }
  return headers;
}

// ---- billing 头（wb_accounts.Account.headers(purpose!="chat") CN 分支）----
// 计费端点不吃桌面那套身分，但必须带按账号派生的 X-Machine-ID / X-Session-ID
// （wb_fingerprint：进程级取值会把所有账号串到同一台设备上）。
export function billingHeaders(acct, opts = {}) {
  const nowMs = opts.now ? opts.now() : defaultNow();
  const uid = String(acct?.uid ?? "");
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": BILLING_UA_CN,
    Origin: CN_ORIGIN,
    Referer: CN_ORIGIN + "/",
    Authorization: "Bearer " + String(acct?.access ?? ""),
    "X-User-Id": uid,
    "X-Domain": domainOf(acct),
    "X-CodeBuddy-Request": "1",
    "Accept-Language": "zh-CN",
    "X-Request-ID": uuid7Hex(nowMs),
    "X-Machine-ID": deriveId(uid, "machine"),
    "X-Session-ID": sessionKey(uid),
  };
  if (acct?.enterpriseId) {
    headers["X-Enterprise-Id"] = String(acct.enterpriseId);
    headers["X-Tenant-Id"] = String(acct.enterpriseId);
  } else {
    headers["X-No-Enterprise-Id"] = "1";
  }
  // wb_accounts：cn 分支发 X-Product: SaaS
  headers["X-Product"] = "SaaS";
  return headers;
}

// ---- web 头（wb_tasks.claim_task 的 400 → web 回退分支，逐字拷贝）---------
// 注意 X-Domain 的值是带 scheme 的完整 WEB_BASE —— Python 里就这么写的。
export function webHeaders(acct) {
  return {
    Authorization: "Bearer " + String(acct?.access ?? ""),
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    Origin: WEB_BASE,
    Referer: WEB_BASE + "/profile/growth-center",
    "x-client-platform": "web",
    "User-Agent": WEB_UA,
    "X-User-Id": String(acct?.uid ?? ""),
    "X-Domain": WEB_BASE,
  };
}

// ---- 刷新头（wb_accounts.Account._refresh_locked 的 CN 头族）--------------
export function refreshHeaders(acct) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": BILLING_UA_CN,
    Origin: CN_ORIGIN,
    Referer: CN_ORIGIN + "/",
    "X-Refresh-Token": String(acct?.refresh ?? ""),
    "X-Auth-Refresh-Source": REFRESH_SOURCE_CN,
    "X-User-Id": String(acct?.uid ?? ""),
    "X-Domain": domainOf(acct),
    "X-CodeBuddy-Request": "1",
    "Accept-Language": "zh-CN",
  };
  if (acct?.enterpriseId) headers["X-Enterprise-Id"] = String(acct.enterpriseId);
  return headers;
}
