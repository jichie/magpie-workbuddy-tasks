// store.mjs —— magpie 凭据（plugin-auth.json）共享读 + 原子回写，以及本插件
// 的状态文件（CONTRACT §2 store 部分、铁律 3）。
//
// 凭据不外泄：这里只读/写文件，绝不把 token 打进日志；调用方拿到的 Account
// 只有在内存里才有完整 token。

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// plugin-auth.json 里与刷新结果相关的字段（与 magpie 官方插件的
// TOKEN_FIELDS 完全一致 —— saveAccountRefresh 只允许改这几个键）。
const TOKEN_FIELDS = ["access", "refresh", "expires", "refreshExpiresAt", "domain", "tokenType"];

// ---- 路径 --------------------------------------------------------------------
// readMagpieConfigDir(env) -> string|null
// 显式 MAGPIE_CONFIG_DIR 优先；否则用默认 ~/.config/magpie（存在才返回）。
export function readMagpieConfigDir(env = globalThis.process?.env ?? {}) {
  const explicit = String(env.MAGPIE_CONFIG_DIR || "").trim();
  if (explicit) return explicit;
  const fallback = join(homedir(), ".config", "magpie");
  try {
    return existsSync(fallback) ? fallback : null;
  } catch {
    return null;
  }
}

export function authFile(cfg) {
  return join(String(cfg || ""), "plugin-auth.json");
}

// 本插件状态目录（daemon 的 control.json / settings.json / daemon.json 也应
// 落在这里 —— CONTRACT §4 的 state/）。
export function stateDir(cfg) {
  return join(String(cfg || ""), "workbuddy-tasks", "state");
}

export function tasksStateFile(cfg) {
  return join(stateDir(cfg), "tasks-accounts.json");
}

// ---- 账号读取 ------------------------------------------------------------------
// acctKey 形如 "workbuddy" | "workbuddy#xxxxxxxx"（magpie/OpenCode 多账号键）。
function providerOfKey(key) {
  const base = String(key || "").split("#")[0];
  if (base === "workbuddy") return "workbuddy";
  if (base === "workbuddy-ai") return "workbuddy-ai";
  return null; // workbuddy-tasks（我们自己）与其它 provider 一律不算账号
}

function isApiKeyEntry(entry) {
  return (
    entry.type === "api" ||
    entry.source === "key" ||
    (typeof entry.key === "string" && entry.key.length > 0)
  );
}

// 静态 API Key 没有 uid 声明：按 hub 的 api_key_id 口径从 key 派生
// （ck_<id>.<secret> → apikey-<id>，只留 [A-Za-z0-9_-]）。
function apiKeyUid(key) {
  let text = String(key || "");
  for (const prefix of ["ck_", "pt_"]) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length);
      break;
    }
  }
  const id = String(text).split(".")[0].replace(/[^A-Za-z0-9_-]/g, "");
  return id ? `apikey-${id}` : "";
}

// 读本插件状态里的 tasksEnabled 映射（uid 或 acctKey -> false 才算关）。
function readTasksEnabledMap(cfg) {
  const file = tasksStateFile(cfg);
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
    if (raw && typeof raw === "object" && typeof raw.accounts === "object") return raw.accounts;
  } catch {}
  return {};
}

// loadAccounts(cfg) -> Account[]
// 只读 plugin-auth.json 的 workbuddy* 条目，映射成我们的内部形状。字段缺失
// 都给默认值，坏的条目跳过而不是抛错（一个坏账号不能拖死整个面板）。
export function loadAccounts(cfg) {
  const file = authFile(cfg);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const enabledMap = readTasksEnabledMap(cfg);
  const accounts = [];
  for (const [key, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const provider = providerOfKey(key);
    if (!provider) continue;
    const access = typeof entry.access === "string" ? entry.access : "";
    const isApiKey = isApiKeyEntry(entry);
    const uid =
      typeof entry.uid === "string" && entry.uid ? entry.uid : isApiKey ? apiKeyUid(entry.key) : "";
    if (!access && !uid) continue; // 空壳条目（如 authorize 占位）
    accounts.push({
      key,
      provider,
      uid,
      nickname: typeof entry.accountId === "string" && entry.accountId ? entry.accountId : uid,
      access,
      refresh: typeof entry.refresh === "string" ? entry.refresh : "",
      expires: Number(entry.expires) || 0,
      refreshExpiresAt: Number(entry.refreshExpiresAt) || 0,
      domain: typeof entry.domain === "string" ? entry.domain : "",
      enterpriseId: typeof entry.enterpriseId === "string" ? entry.enterpriseId.trim() : "",
      tokenType: typeof entry.tokenType === "string" ? entry.tokenType : "",
      source: typeof entry.source === "string" ? entry.source : isApiKey ? "key" : "oauth",
      isApiKey,
      // tasksEnabled 来自本插件状态，不是 auth 字段；缺省 = 参与。
      tasksEnabled: enabledMap[key] !== false && enabledMap[uid] !== false,
    });
  }
  return accounts;
}

// eligibleAccounts(accounts, opts) -> Account[]
// 对齐 hub 的 task_accounts("cn")：国内个人 OAuth 且本插件没关掉任务的账号。
export function eligibleAccounts(accounts, opts = {}) {
  void opts;
  return (accounts ?? []).filter(
    (a) =>
      a.provider === "workbuddy" &&
      !a.isApiKey &&
      !a.enterpriseId &&
      a.tasksEnabled !== false,
  );
}

// ---- 原子回写 ------------------------------------------------------------------
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
  const text = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows 上 chmod 只影响只读位，失败无碍
  }
  let lastErr = null;
  for (let i = 0; i < 5; i++) {
    try {
      renameSync(tmp, file);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err; // Windows 上目标被占用时 EPERM，稍后立刻重试
    }
  }
  if (lastErr) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw lastErr;
  }
  try {
    // rename 后把最终权限钉在 600（POSIX 上 tmp 的 mode 会跟着过来，这里是保险）
    chmodSync(file, 0o600);
  } catch {}
  return statSync(file);
}

// saveAccountRefresh(cfg, acctKey, patch) -> void
//
// 读-改-写：只把 patch 里出现的 TOKEN_FIELDS 盖进 acctKey 那一条，其余字段
// （包括未知字段）与所有兄弟条目（其它 provider / 其它账号）原样保留；tmp +
// rename 原子落盘，mode 600。patch 里 undefined 的键不碰旧值，绝不把别人的
// 账号冲掉。
export function saveAccountRefresh(cfg, acctKey, patch) {
  const file = authFile(cfg);
  let raw = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`plugin-auth.json 解析失败，拒绝回写以免丢数据: ${String(err?.message || err)}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("plugin-auth.json 顶层不是对象，拒绝回写");
    }
  }
  const entry =
    raw[acctKey] && typeof raw[acctKey] === "object" && !Array.isArray(raw[acctKey])
      ? { ...raw[acctKey] }
      : {};
  for (const field of TOKEN_FIELDS) {
    if (patch && patch[field] !== undefined) entry[field] = patch[field];
  }
  raw[acctKey] = entry;
  writeJsonAtomic(file, raw);
}
