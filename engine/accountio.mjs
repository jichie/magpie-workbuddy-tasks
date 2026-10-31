// accountio.mjs —— WorkBuddy 账号 JSON 导入 / 导出（hub 移植口径，契约 §9）
//
// 事实来源（workbuddy2api-hub，只读核对，行号为本仓库 /tmp/wbsrc/repo 快照）：
//   wb_accounts.py:5311  EXPORT_FORMAT = "workbuddy-accounts"
//   wb_accounts.py:5312  EXPORT_VERSION = 1
//   wb_accounts.py:5326  account_to_export()        —— 导出行 = to_dict() 去掉 path
//   wb_accounts.py:5335  build_export_document()    —— 信封 {format,version,exportedAt,count,accounts}
//   wb_accounts.py:5366  _coerce_account_rows()     —— 四种输入形态 + 错误文案
//   wb_accounts.py:5405  normalise_import_row()     —— 行归一（token/uid/realm/过期）
//   wb_accounts.py:1136  Account.to_dict()          —— 导出行字段名以它为准（hub 形状）
//   wb_proxy.py:19314    _get_accounts_export()     —— realm/secrets/uid/download 语义与 404
//   wb_proxy.py:18698    _download()                —— Content-Disposition 文件名净化规则
//   wb_proxy.py:20919    /accounts/import           —— 裸数组包成 {"data":[...]}
//   wb_proxy.py:21788    _route_accounts_import()   —— dryRun（预览）/ 真写 两段式
//
// 产品口径（用户已定，不得扩张）：
//   1. 只同步国内版：realm==="cn" → 写进 provider "workbuddy"；realm==="intl" 一律
//      进 rejects（「只同步国内版 workbuddy，国际版账号不导入」）。
//   2. 导入直接写 magpie 的 plugin-auth.json（官方字段名 access/refresh/expires/…），
//      绝不建第二份私有账号库（同账号两条 token 血统会在 refresh 轮换时互相踢下线）。
//   3. 智能合并：uid 已存在时，现有 token 未过期 = skip（绝不把在用新 token 换成
//      JSON 里的旧 token）；现有已过期且导入的 expires 更新 = update；导入项无
//      refresh 而现有有 = skip（削弱续期能力）。
//   4. 两段式：planImport 纯函数（预览与确认共用）→ applyImport 才写（写前备份）。
//   5. 零凭据外泄：本模块任何「报告」形状（adds/updates/skips/rejects/totals/日志）
//      都不含 token 明文；token 只出现在两处 —— 写进 plugin-auth.json 的条目、
//      includeSecrets=true 的导出文档（导出文件本身必须真值，否则回灌无效）。

import { basename } from "node:path";
import {
  authFile,
  backupAuthFile,
  providerOfKey,
  readAuthDocument,
  writeAuthDocument,
} from "./store.mjs";

// ---- 常量（hub 逐字）--------------------------------------------------------

export const EXPORT_FORMAT = "workbuddy-accounts"; // wb_accounts.py:5311
export const EXPORT_VERSION = 1; // wb_accounts.py:5312

export const INTL_REJECT_REASON = "只同步国内版 workbuddy，国际版账号不导入";
export const UNDETECTABLE_REALM_REASON =
  "无法判定账号区域（realm 字段缺失，token 签发方与域名也认不出来），为防写错出口拒绝导入";

// 区域判据（hub wb_accounts.py:541-543，逐字）：
// 国内版换过出口 copilot.tencent.com → codebuddy.cn → workbuddy.cn，三个都得认；
// 只认前两个会把 workbuddy.cn 的国内账号判成国际版。
export const CN_REALM_MARKERS = ["copilot.tencent.com", "codebuddy.cn", "workbuddy.cn"];
export const INTL_REALM_MARKERS = ["workbuddy.ai", "codebuddy.ai"];
// hub REALM_CONFIGS(:350) 的 domain 兜底值：cn → copilot.tencent.com（X-Domain 兜底）、
// intl → www.workbuddy.ai。
export const REALM_DOMAINS = { cn: "copilot.tencent.com", intl: "www.workbuddy.ai" };

// 静态 API Key 前缀（hub wb_accounts.py:434 API_KEY_PREFIXES）：这类凭证不是 JWT、
// 不能刷新，magpie 里要用 type:"api" 的条目形状，本导入不收（避免写错形状）。
const API_KEY_PREFIXES = ["ck_", "pt_"];

// magpie 多账号键的后缀字母表（真实文件见 #3592pb/#75352q/#ztdceq/#ed8f2r：6 位小写
// 数字字母）；首个账号用裸 provider id，其余 "#"+6 位（官方规则，不得与已有键撞）。
const KEY_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

// ---- 时间单位（契约 §7 的结论在这里落地）------------------------------------
// hub 的 expiresAt/expires_at 是 epoch 秒：
//   :919-920  self.expires_at = normalize_epoch(data.get("expiresAt")) or jwt_exp(token)
//   :514-518  jwt_exp() 返回 JWT exp 声明（RFC 恒为秒）
//   :526-533  normalize_epoch()：>1e11 一律当毫秒除以 1000 → 内部秒
//   :1230-1232 public() 里 exp <= time.time() 判过期（秒）
//   :1829-1831 ready()/throttle 里 exp - time.time() <= 120 → 「凭证已过期」（秒）
// magpie 的 expires 是毫秒（真实 plugin-auth.json 全部为 13 位毫秒值）。
// 搞错的后果：秒值当毫秒 → 5 万年后到期 =「永不过期」，智能合并静默走错分支；
// 毫秒值当秒 → 1970 年 =「立刻已过期」。测试有专门防混淆用例。

export function normalizeEpoch(value) {
  // hub wb_accounts.py:526 normalize_epoch() 的移植：数字/数字串 → 秒；>1e11 视为
  // 毫秒除以 1000。解析不出返回 0（hub 同款：0 = 未知，不代表 1970）。
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.floor(n > 1e11 ? n / 1000 : n);
}

// magpie 毫秒 → hub 秒（floor，毫秒级精度丢弃 <1s，对过期判断无影响）
export function magpieMsToEpoch(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n / 1000);
}

// hub 秒 → magpie 毫秒
export function epochToMagpieMs(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n) * 1000;
}

// ---- JWT（不做签名校验；与 hub 一样只解 payload 拿 exp/sub/iss）--------------

function jwtClaims(token) {
  try {
    const seg = String(token || "").split(".")[1] || "";
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : {};
  } catch {
    return {};
  }
}

export function jwtExpSec(token) {
  // hub jwt_exp()：JWT exp（秒）；解不开 = 0
  const exp = Number(jwtClaims(token).exp);
  return Number.isFinite(exp) && exp > 0 ? Math.floor(exp) : 0;
}

export function jwtSub(token) {
  return String(jwtClaims(token).sub || "");
}

export function jwtIssuer(token) {
  return String(jwtClaims(token).iss || "");
}

// ---- 本地时间格式化（hub time.strftime 口径）--------------------------------

function pad2(n) {
  return String(n).padStart(2, "0");
}

// "YYYY-MM-DD HH:MM:SS"（本地时区；build_export_document 的 exportedAt 格式）
export function formatLocalSeconds(nowMs) {
  const d = new Date(Number(nowMs) || Date.now());
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

// "YYYYMMDD-HHMMSS"（hub 下载文件名与备份名的时间戳格式）
export function formatStamp(nowMs) {
  const d = new Date(Number(nowMs) || Date.now());
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

function asNowMs(now) {
  if (typeof now === "function") return Number(now()) || Date.now();
  const n = Number(now);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

// ---- 区域判定 ----------------------------------------------------------------

// hub realm_evidence(:614)：token 的 iss 优先、域名其次；看不出返回 ""（不瞎猜）。
function realmEvidence(token, domain) {
  const iss = jwtIssuer(token).toLowerCase();
  if (CN_REALM_MARKERS.some((m) => iss.includes(m))) return "cn";
  if (INTL_REALM_MARKERS.some((m) => iss.includes(m))) return "intl";
  const dom = String(domain || "").toLowerCase();
  if (CN_REALM_MARKERS.some((m) => dom.includes(m))) return "cn";
  if (INTL_REALM_MARKERS.some((m) => dom.includes(m))) return "intl";
  return "";
}

// 行内区域：token 证据 > 行显式 realm（hub normalise 的顺序；token 才是要拿去
// 请求的那一串，行里带错了区域不能把请求带回错出口）。判定不出 = ""（调用方拒）。
export function detectRowRealm(row, token, domain) {
  const rowRealm = String(row?.realm ?? "").trim().toLowerCase();
  const evidence = realmEvidence(token, domain);
  if (evidence) return evidence;
  if (rowRealm === "cn" || rowRealm === "intl") return rowRealm;
  return "";
}

// hub domain_for_realm(:636)：域名写着另一个区域时换成该区域的规范域名；
// 看不出区域时原样保留。
export function domainForRealm(realm, domain) {
  const dom = String(domain || "").trim();
  const otherMarkers = realm === "cn" ? INTL_REALM_MARKERS : CN_REALM_MARKERS;
  if (dom && !otherMarkers.some((m) => dom.toLowerCase().includes(m))) return dom;
  return REALM_DOMAINS[realm] ?? dom;
}

// ---- 导入文档解析（纯；hub _coerce_account_rows 逐字移植）--------------------
//
// 接受四种形态（wb_accounts.py:5298-5306 的注释）：
//   1. 本模块的导出信封 {"format":"workbuddy-accounts","accounts":[...]}
//   2. 裸数组 [{...},{...}]
//   3. 单个账号对象 {...}
//   4. 桌面端凭据 {"auth":{...},"account":{...}}
// 另接受 {"blob":<以上任意>} 信封（daemon 的 POST /api/accounts/import 解包）。
// 信封校验：format/version/count 字段存在但不符 → 拒绝（hub 对此宽容，我们的导入
// 更严：格式标错多半是拿错了文件，宁可 400 也不静默按裸数组吃下去）。

export function coerceImportRows(blob) {
  if (Array.isArray(blob)) {
    return finishRows(blob);
  }
  if (blob && typeof blob === "object") {
    if (Array.isArray(blob.accounts)) {
      // 导出信封（或任何带 accounts 数组的对象）
      if ("format" in blob && blob.format !== EXPORT_FORMAT) {
        return { error: `format 不是 ${EXPORT_FORMAT}（拿到的是 ${JSON.stringify(blob.format)}），不是本插件的导出格式` };
      }
      if ("version" in blob && Number(blob.version) !== EXPORT_VERSION) {
        return { error: `不支持的导出版本：${JSON.stringify(blob.version)}（只认 version=${EXPORT_VERSION}）` };
      }
      if ("count" in blob && Number(blob.count) !== blob.accounts.length) {
        return { error: `信封 count=${JSON.stringify(blob.count)} 与 accounts 数量 ${blob.accounts.length} 不符，文件可能被截断或手改坏` };
      }
      return finishRows(blob.accounts);
    }
    const looksLikeAccount =
      blob.accessToken || blob.access_token || (blob.auth && typeof blob.auth === "object") || (blob.account && typeof blob.account === "object");
    if (looksLikeAccount) {
      return finishRows([blob]);
    }
    const keys = Object.keys(blob).slice(0, 6).join(", ") || "none";
    return {
      error:
        `not an account document (expected an accounts array, a list, or an account object; got keys: ${keys})`,
    };
  }
  return { error: "expected an object or a list of accounts" };

  function finishRows(rows) {
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i] || typeof rows[i] !== "object" || Array.isArray(rows[i])) {
        return { error: `account #${i + 1} is not an object` };
      }
    }
    if (!rows.length) {
      return { error: "no accounts found in the document" };
    }
    return { rows };
  }
}

// ---- 行归一（hub normalise_import_row 移植；抛 Error = 进 rejects）------------

// 桌面端凭据分层读取（hub pick()）：flat → auth → account，空值跳过
function pickField(row, key) {
  for (const layer of [row, row?.auth, row?.account]) {
    if (layer && typeof layer === "object" && layer[key] !== undefined && layer[key] !== null && layer[key] !== "") {
      return layer[key];
    }
  }
  return undefined;
}

export function normalizeImportRow(row) {
  let src = row;
  // cockpit 工具导出的 snake_case OAuth 行（hub :5418-5429）：expires_at 是毫秒，
  // normalizeEpoch 会换算成秒。
  if (src && typeof src === "object" && "access_token" in src && !("accessToken" in src)) {
    src = {
      uid: src.uid,
      nickname: src.nickname || src.email || "",
      domain: src.domain,
      accessToken: src.access_token,
      refreshToken: src.refresh_token,
      expiresAt: src.expires_at,
      source: "cockpit",
    };
  }

  const token = String(pickField(src, "accessToken") || "").trim();
  if (!token) {
    throw new Error("no accessToken");
  }
  if (API_KEY_PREFIXES.some((p) => token.startsWith(p))) {
    // 静态 Key 在 magpie 里是 type:"api" 的另一种条目形状，本导入只收 OAuth
    throw new Error("API Key 行不导入：请在 magpie 里直接添加 API Key（本导入只收 OAuth 账号）");
  }
  if (token.split(".").length !== 3) {
    // hub：三段式是「这串东西确实是 OAuth token」唯一可靠的本地判据
    throw new Error("accessToken is not a JWT");
  }

  const domain = String(pickField(src, "domain") || "");
  const realm = detectRowRealm(src, token, domain);

  const rawUid = String(pickField(src, "uid") || "").trim() || jwtSub(token);
  const uid = rawUid
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!uid) {
    throw new Error("cannot determine uid (no uid field and no sub claim)");
  }

  const expiresSec = normalizeEpoch(pickField(src, "expiresAt")) || jwtExpSec(token);
  const refreshExpiresSec = normalizeEpoch(pickField(src, "refreshExpiresAt"));
  const nickname = String(pickField(src, "nickname") ?? "").trim();

  return {
    uid,
    nickname,
    domain: domainForRealm(realm, domain),
    realm, // "cn" | "intl" | ""（"" 由 planImport 拒绝）
    platform: String(pickField(src, "platform") || "CLI"),
    enterpriseId: String(pickField(src, "enterpriseId") || "").trim(),
    accessToken: token,
    refreshToken: String(pickField(src, "refreshToken") || "").trim(),
    expiresSec, // hub 单位：epoch 秒；0 = 未知
    refreshExpiresSec, // 0 = 源文档没有
    tokenType: String(pickField(src, "tokenType") || "").trim(),
    source: String(pickField(src, "source") || "import"),
  };
}

// ---- 报告的 inputHint：绝不携带 token 值 --------------------------------------
// 只拼身份类字段；都没有时给出「字段名清单」（字段名不是秘密）。
const HINT_FIELDS = ["uid", "nickname", "email", "domain", "realm", "platform"];
const SECRET_KEY_RE = /(token|secret|access|refresh|key|authorization|credential)/i;

export function inputHintOf(row) {
  const layers = [row, row?.auth, row?.account].filter((l) => l && typeof l === "object");
  const parts = [];
  for (const f of HINT_FIELDS) {
    for (const layer of layers) {
      const v = layer[f];
      if (v !== undefined && v !== null && String(v).trim()) {
        parts.push(`${f}=${String(v).trim().slice(0, 40)}`);
        break;
      }
    }
  }
  if (parts.length) return parts.join(", ");
  const keys = Object.keys(row ?? {}).filter((k) => !SECRET_KEY_RE.test(k));
  return `字段：${keys.slice(0, 6).join(", ") || "（无可识别字段）"}`;
}

// ---- key 分配（官方规则：首个裸 id，其余 "#"+6 位，不得与已有键撞）------------

function randomSuffix() {
  let s = "";
  for (let i = 0; i < 6; i++) {
    s += KEY_ALPHABET[Math.floor(Math.random() * KEY_ALPHABET.length)];
  }
  return s;
}

export function allocateWorkbuddyKey(takenKeys) {
  if (!takenKeys.has("workbuddy")) {
    takenKeys.add("workbuddy");
    return "workbuddy";
  }
  for (;;) {
    const key = `workbuddy#${randomSuffix()}`;
    if (!takenKeys.has(key)) {
      takenKeys.add(key);
      return key;
    }
  }
}

// ---- 官方 magpie 条目（写进 plugin-auth.json 的形状；官方字段名，非 hub 名）----
//
// 官方插件写入的形状：{type:"oauth",access,refresh,expires(ms),refreshExpiresAt,
// domain,tokenType,uid,enterpriseId,accountId}。accountId 填可读昵称（magpie 用它
// 显示账号名）。importedFrom:"hub-json" 是易失标记（magpie 整体覆写会抹掉），
// 只作展示，绝不参与逻辑判断（契约 §9）。

export function officialAddEntry(norm) {
  const entry = { type: "oauth" };
  entry.access = norm.accessToken;
  if (norm.refreshToken) entry.refresh = norm.refreshToken;
  entry.expires = epochToMagpieMs(norm.expiresSec);
  if (norm.refreshExpiresSec > 0) entry.refreshExpiresAt = epochToMagpieMs(norm.refreshExpiresSec);
  if (norm.domain) entry.domain = norm.domain;
  entry.tokenType = norm.tokenType || "Bearer";
  entry.uid = norm.uid;
  if (norm.enterpriseId) entry.enterpriseId = norm.enterpriseId;
  entry.accountId = norm.nickname || norm.uid;
  entry.importedFrom = "hub-json";
  return entry;
}

// 更新只动 token 三件套（access/refresh/expires）：domain/tokenType/accountId 等
// 是 magpie 官方登录流程写下的现场信息，导入 JSON 不比它权威；其余未知字段靠
// merge 时的展开原样保留。刷新能力只增强不削弱（import 有 refresh 才写 refresh）。
export function officialUpdatePatch(norm, existingEntry) {
  const patch = { access: norm.accessToken, expires: epochToMagpieMs(norm.expiresSec) };
  if (norm.refreshToken) patch.refresh = norm.refreshToken;
  if (existingEntry && existingEntry.importedFrom === undefined) patch.importedFrom = "hub-json";
  return patch;
}

// ---- planImport：纯函数（不碰磁盘/网络；预览与确认共用）----------------------
//
// planImport(rows, existingAuth, {now}) -> {
//   adds:    [{uid, nickname, key}],                       // 展示形状（无 token）
//   updates: [{uid, nickname, key, fromExpires, toExpires, reason}],
//   skips:   [{uid, nickname, reason}],
//   rejects: [{index, reason, inputHint}],                 // index 从 1 起（hub 口径）
//   totals:  {adds, updates, skips, rejects},
//   ops:     [{kind:"add", key, entry} | {kind:"update", key, patch}],  // 机器形状，applyImport 专用
// }
//
// rows 是 coerceImportRows().rows（原始行数组）；existingAuth 是解析后的
// plugin-auth.json 对象（或 null）。时间 now 传毫秒（数字或 () => ms）。
export function planImport(rows, existingAuth, { now } = {}) {
  const nowMs = asNowMs(now);
  const doc =
    existingAuth && typeof existingAuth === "object" && !Array.isArray(existingAuth) ? existingAuth : {};
  const takenKeys = new Set(Object.keys(doc));

  // 只认国内版 provider（"workbuddy"）的条目做合并对象：workbuddy-ai（国际版）
  // 一律不导入，自然也不参与匹配。
  const uidIndex = new Map();
  for (const [key, entry] of Object.entries(doc)) {
    if (providerOfKey(key) !== "workbuddy") continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const uid = typeof entry.uid === "string" ? entry.uid.trim() : "";
    if (!uid || uidIndex.has(uid)) continue;
    uidIndex.set(uid, { key, entry });
  }

  const adds = [];
  const updates = [];
  const skips = [];
  const rejects = [];
  const ops = [];
  const seen = new Set();

  (Array.isArray(rows) ? rows : []).forEach((row, i) => {
    const index = i + 1; // hub：index 从 1 起（"account #N"）
    let norm;
    try {
      norm = normalizeImportRow(row);
    } catch (e) {
      rejects.push({ index, reason: String(e?.message || e), inputHint: inputHintOf(row) });
      return;
    }

    // 产品口径：国际版一律不导入；判定不出区域也不导入（写错出口比不导入更糟）。
    if (norm.realm !== "cn") {
      const reason = norm.realm === "intl" ? INTL_REJECT_REASON : UNDETECTABLE_REALM_REASON;
      rejects.push({ index, reason, inputHint: inputHintOf(row) });
      return;
    }

    if (seen.has(norm.uid)) {
      skips.push({ uid: norm.uid, nickname: norm.nickname || norm.uid, reason: "文档内有重复 uid，只导入第一条" });
      return;
    }
    seen.add(norm.uid);

    const hit = uidIndex.get(norm.uid);
    if (!hit) {
      const key = allocateWorkbuddyKey(takenKeys);
      adds.push({ uid: norm.uid, nickname: norm.nickname || norm.uid, key });
      ops.push({ kind: "add", key, entry: officialAddEntry(norm) });
      return;
    }

    // ---- 智能合并（口径见文件头注释 3）----
    const importHasRefresh = !!norm.refreshToken;
    const existingHasRefresh = typeof hit.entry.refresh === "string" && !!hit.entry.refresh;
    const importExpiresMs = epochToMagpieMs(norm.expiresSec);
    const existingExpiresMs = Number(hit.entry.expires) || 0;
    const who = norm.nickname || norm.uid;

    if (existingHasRefresh && !importHasRefresh) {
      skips.push({
        uid: norm.uid,
        nickname: who,
        reason: "导入项没有 refreshToken，写进去会削弱续期能力，保留现有账号",
      });
      return;
    }
    if (existingExpiresMs > nowMs) {
      skips.push({
        uid: norm.uid,
        nickname: who,
        reason: "现有 token 未过期，绝不把在用的新 token 换成 JSON 里的旧 token",
      });
      return;
    }
    if (importExpiresMs > existingExpiresMs) {
      updates.push({
        uid: norm.uid,
        nickname: who,
        key: hit.key,
        fromExpires: existingExpiresMs,
        toExpires: importExpiresMs,
        reason: existingExpiresMs
          ? "现有 token 已过期，导入的 token 更新，将覆盖 access/refresh/expires"
          : "现有条目缺 expires（有效期未知），导入项带有效期，将覆盖 access/refresh/expires",
      });
      ops.push({ kind: "update", key: hit.key, patch: officialUpdatePatch(norm, hit.entry) });
      return;
    }
    skips.push({
      uid: norm.uid,
      nickname: who,
      reason: "现有 token 已过期，但导入的 token 并不比现有的新，不覆盖",
    });
  });

  return {
    adds,
    updates,
    skips,
    rejects,
    totals: { adds: adds.length, updates: updates.length, skips: skips.length, rejects: rejects.length },
    ops,
  };
}

// plan 的展示形状（剥掉 ops —— ops 里是可写条目，含 token，绝不出门）
export function planView(plan) {
  return {
    adds: plan.adds,
    updates: plan.updates,
    skips: plan.skips,
    rejects: plan.rejects,
    totals: plan.totals,
  };
}

// ---- 写入 --------------------------------------------------------------------

// mergePlanIntoDocument(existingData, plan) -> 新文档对象（纯）
// 其它 provider 与未知字段逐值原样保留：文档浅展开、被改条目先整体展开再盖补丁。
export function mergePlanIntoDocument(existingData, plan) {
  const doc =
    existingData && typeof existingData === "object" && !Array.isArray(existingData)
      ? { ...existingData }
      : {};
  for (const op of Array.isArray(plan?.ops) ? plan.ops : []) {
    if (op?.kind === "add" && op.key && op.entry) {
      doc[op.key] = op.entry;
    } else if (op?.kind === "update" && op.key && op.patch) {
      const cur = doc[op.key] && typeof doc[op.key] === "object" && !Array.isArray(doc[op.key]) ? doc[op.key] : {};
      doc[op.key] = { ...cur, ...op.patch };
    }
  }
  return doc;
}

// applyImport(cfg, plan, {existingData, now}) -> {backedUpTo, document}
// 唯一落盘入口：先逐字节备份当前文件（plugin-auth.json.bak-hubimport-<stamp>），
// 再经 store 的原子原语（tmp + rename、0600）写 merged 文档。
// existingData 由调用方传入（daemon 在确认分支已做过竞态复查）；缺省时现读，
// 现读解析失败抛 WB_AUTH_PARSE（409 拒写）。文件不存在 = 空库，从零建（合法）。
export function applyImport(cfg, plan, { existingData, now } = {}) {
  let base = existingData;
  if (base === undefined) {
    const r = readAuthDocument(cfg);
    if (!r.ok && !r.missing) {
      const err = new Error(`plugin-auth.json 解析失败，拒绝写入以免丢数据：${r.error}`);
      err.code = "WB_AUTH_PARSE";
      throw err;
    }
    base = r.ok ? r.data : {};
  }
  const document = mergePlanIntoDocument(base, plan);
  const backup = backupAuthFile(cfg, `hubimport-${formatStamp(asNowMs(now))}`);
  writeAuthDocument(cfg, document);
  return { backedUpTo: backup ? basename(backup) : null, document };
}

// ---- 导出（我们的 Account[] → hub 形状文档）----------------------------------
//
// 导出行字段名以 hub Account.to_dict()（wb_accounts.py:1136）为准；我们从 magpie
// 的官方条目反向映射。to_dict 里其余字段（addedAt/proxySlot/proxy/weight/note/
// disabledModels/lastError/cooldownUntil/restrictedUntil/credits/tier/lastCheckin/
// lastDailyChat/lastActivityReport/modelCaps）是 hub 本地运行时状态或 magpie 侧
// 不存在的信息，不携带 —— 导入侧本就按 VOLATILE_FIELDS 丢弃，回灌无损。
// magpie 的 API Key 条目（type:"api"）不导出：没有 OAuth 凭据可导，导出空 token 行
// 只会误导。

export function accountRealm(a) {
  return a?.provider === "workbuddy-ai" ? "intl" : "cn";
}

function accountToExportRow(a) {
  return {
    uid: String(a?.uid ?? ""),
    nickname: String(a?.nickname ?? ""),
    domain: String(a?.domain ?? ""),
    realm: accountRealm(a),
    platform: "CLI",
    product: "workbuddy",
    enterpriseId: String(a?.enterpriseId ?? ""),
    accessToken: String(a?.access ?? ""),
    refreshToken: String(a?.refresh ?? ""),
    // magpie 毫秒 → hub 秒（契约 §7）
    expiresAt: magpieMsToEpoch(a?.expires),
    source: "magpie",
    apiKey: a?.isApiKey === true,
    enabled: true,
    tasksEnabled: a?.tasksEnabled !== false,
  };
}

// buildExportDocument(accounts, {realm, includeSecrets, uids, now})
//   realm: "cn"|"intl"|null（null = 不过滤，hub 同款）
//   includeSecrets: false → 按 hub 行为删 accessToken/refreshToken（secrets=0）
//   uids: uid 数组 | null（narrows to specific accounts）
//   now: 毫秒（数字或 () => ms），exportedAt 用本地时间 "YYYY-MM-DD HH:MM:SS"
// 纯国内版口径的 realm 默认值由调用方（daemon 的 /api/accounts/export 路由）决定：
// 不带 realm 只出 cn、显式 realm=intl 才出国际版（逃生口）。本引擎层保持 hub
// 通用的 realm 过滤语义（null = 不过滤），不掺路由层政策。
export function buildExportDocument(accounts, opts = {}) {
  const realm = opts.realm === "cn" || opts.realm === "intl" ? opts.realm : null;
  const includeSecrets = opts.includeSecrets !== false;
  const wanted = Array.isArray(opts.uids) && opts.uids.length ? new Set(opts.uids.map(String)) : null;
  const rows = [];
  for (const a of Array.isArray(accounts) ? accounts : []) {
    if (a?.isApiKey === true) continue; // API Key 条目无 OAuth 凭据，不导出
    if (realm && accountRealm(a) !== realm) continue;
    if (wanted && !wanted.has(String(a?.uid))) continue;
    const row = accountToExportRow(a);
    if (!includeSecrets) {
      delete row.accessToken; // hub build_export_document：secrets=0 删 token
      delete row.refreshToken;
    }
    rows.push(row);
  }
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: formatLocalSeconds(asNowMs(opts.now)),
    count: rows.length,
    accounts: rows,
  };
}

// 下载文件名（hub _get_accounts_export :19347-19353 + _download :18706 净化规则）：
//   单 uid → workbuddy-accounts-<uid 前 8 位><YYYYMMDD-HHMMSS>.json
//   多 uid/无 uid → workbuddy-accounts-[<realm>-]<YYYYMMDD-HHMMSS>.json
//   净化：[^A-Za-z0-9._-] → "_"，截 120，空则 "export.json"
export function exportFileName({ uids = [], realm = null, now } = {}) {
  const stamp = formatStamp(asNowMs(now));
  let label;
  if (Array.isArray(uids) && uids.length === 1) {
    label = String(uids[0]).slice(0, 8);
  } else {
    label = realm ? `${realm}-` : "";
  }
  const safe = `workbuddy-accounts-${label}${stamp}.json`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return safe || "export.json";
}
