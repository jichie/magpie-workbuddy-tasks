// fingerprint.mjs —— 设备指纹稳定派生（wb_fingerprint.py 的逐字节移植）。
//
// 无论是国内版（copilot.tencent.com / codebuddy.cn）还是国际版，都基于账号
// UID + 盐做单向 md5，派生出固定的伪物理设备特征（machineId / sessionId），
// 保证每个账号永远来自一台固定的物理设备，且多账号之间天然隔离防风控关联。
//
// 形态按 5.8.4 抓包对齐：machineId / sessionId 都是带连字符的 UUID（版本位
// 4、变体位 a 强制成 UUIDv4 的样子）。

import { createHash, randomBytes } from "node:crypto";

// deriveId(uid, salt) —— 由 uid + salt 稳定派生一个带连字符的 UUID 形状设备标识。
//
// 幂等：同一账号每次调用产生相同值，彻底避免随机机器码导致的上游风控。
// 与 wb_fingerprint.derive_id 逐字节一致：
//   seed = f"{salt}:{uid or 'anonymous'}"（uid 为空串/缺省时用 'anonymous'）
//   h = md5(seed).hexdigest()
//   h = h[:12] + "4" + h[13:16] + "a" + h[17:]   # 版本位/变体位
//   8-4-4-4-12 连字符
export function deriveId(uid, salt) {
  const seed = `${salt}:${uid || "anonymous"}`;
  let h = createHash("md5").update(seed, "utf8").digest("hex");
  h = h.slice(0, 12) + "4" + h.slice(13, 16) + "a" + h.slice(17);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// session_id(uid) 的对应盐（wb_fingerprint.session_id）。
export const SESSION_SALT = "session";
export const MACHINE_SALT = "machine";

// sessionKey(acct 的 uid) —— 账号的 sessionId：同一账号恒定、账号之间互不
// 相同，等价于「每个账号一个客户端实例」。
export function sessionKey(uid) {
  return deriveId(uid, SESSION_SALT);
}

// uuidHex() —— 32 位无连字符 hex（wb_fingerprint.generate_request_id 的形态；
// 真实客户端的请求 id 与账号无关，每条随机）。
export function uuidHex() {
  return randomBytes(16).toString("hex");
}
