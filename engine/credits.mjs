// credits.mjs —— 国内版「积分余额 + 套餐权益包明细」（只读，绝不发布 token）。
//
// wb_accounts.py 的 _fetch_credits_cn_detailed / _parse_package_account /
// tier_from_summary / deduction_end_text 的 ESM 重写（口径对齐，不整段照抄）：
//   1. POST {bill}/billing/meter/get-user-resource-summary        body "{}"
//   2. POST {bill}/billing/meter/get-user-resource-free-packages  body {PackageCodes, PageNumber:1, PageSize:200, Status:[0]}
//   3. POST {bill}/billing/meter/get-user-resource-paid-packages  body {同上, Status:[0,3], NeedRenewInfo:true}
// PackageCodes 取 summary data.Packages[].PackageCode 去重；free/paid 单个失败
// 忽略该来源（像参考实现一样不整体失败）；summary 失败 → {ok:false,error}，
// 401/403 或错误文本含「登录/过期/token/Authorization」→ needRelogin:true。
//
// 时区红线：守护进程可能跑在 UTC 容器里，上游的 naive 字符串时间
//（CycleEndTime / ExpiredTime 一族）是**北京时间** —— 一律补 +08:00 解析成
// epoch ms 再算 daysLeft；epoch → 文本同样固定北京时区输出。绝不用宿主本地
// 时区（与 engine/daily.beijingDayKey 的 UTC+8 口径同源）。
//
// 铁律 4：三次调用全部走 callJSON（billing 头族 + X-Client-Platform: web），
// 每次之前 ctx.breathe（同一 ctx 内 ≥gap），callJSON 内部再经全局 spacer 排队
// 对齐（daemon 经 engineOpts 注入唯一实例）—— 三个上游调用彼此间隔 ≥1s。

import { billBase, callJSON, ctxOf } from "./upstream.mjs";

// 路径常量（wb_accounts.py:389-391 逐字；wb_constants.py 未在快照里，路径以
// wb_accounts 的字面值为准）。
const RESOURCE_SUMMARY_PATH = "/billing/meter/get-user-resource-summary";
const RESOURCE_FREE_PACKAGES_PATH = "/billing/meter/get-user-resource-free-packages";
const RESOURCE_PAID_PACKAGES_PATH = "/billing/meter/get-user-resource-paid-packages";

// 上游用一个远超任何真实计费周期的抵扣截止时间表示「不会过期」（wb_accounts.
// EXPIRY_SENTINEL_DAYS：实测 Free Plan/体验版落在 2034/2035 年）。超过这个天数
// 按「不过期」处理，不再参与到期倒计时。
const EXPIRY_SENTINEL_DAYS = 730;
const DAY_MS = 86400000;
const CN_TZ_OFFSET_MS = 8 * 3600 * 1000;

// 登录态失效的口径：HTTP 401/403，或错误文本里出现这些字样（上游把「登录已
// 过期」写在信封 msg / 响应体里时状态码未必是 401）。
const RELOGIN_RE = /登录|过期|token|Authorization/i;

const pad2 = (n) => String(n).padStart(2, "0");

// epoch ms → 北京时区 "YYYY-MM-DD HH:mm:ss"（不用宿主本地时区）。
export function epochToBeijingText(ms) {
  const d = new Date(Number(ms) + CN_TZ_OFFSET_MS);
  if (!Number.isFinite(d.getTime())) return "";
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  );
}

// naive 字符串 → epoch ms：按北京时间（+08:00）解析，与容器时区无关。
// 参考实现 time.strptime("%Y-%m-%d %H:%M:%S") 的严格口径：解析不出 → null
//（调用方不得拿它算 daysLeft，宁缺毋错）。
export function beijingTextToMs(text) {
  const clean = String(text ?? "").replace("T", " ").trim().slice(0, 19);
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(clean);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`);
  return Number.isFinite(ms) ? ms : null;
}

// hub 的 normalize_epoch：>1e11 已是毫秒原样用，否则按秒 ×1000。解析不出 → 0。
function normalizeEpochMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n > 1e11 ? n : Math.round(n * 1000);
}

// round2 带 -0 归零（Math.round 在 ±0 边界会产出 -0，JSON 序列化成 "0" 前先抹平）。
function round2(x) {
  return Math.round(Number(x) * 100) / 100 + 0;
}

// tier_from_summary 的移植：summary 里没有 IsPaidUser 字段时返回 null ——
// 「没答上来」绝不能记成「免费」。
export function tierFromSummary(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (!("IsPaidUser" in data)) return null;
  const rawTrial = data.ProTrialStatus;
  const trial = Number.parseInt(rawTrial, 10);
  return {
    paid: Boolean(data.IsPaidUser),
    package: String(data.SubscriptionPackageName ?? ""),
    packageCode: String(data.SubscriptionPackageCode ?? ""),
    protectedPrice: Boolean(data.IsProtectedPriceUser),
    trial: Number.isFinite(trial) ? trial : 0,
  };
}

// deduction_end_text 的移植：包的「抵扣截止时间」（DeductionEndTime，epoch ms）
// —— 积分到这个点就不能再抵扣，即作废时刻。上游没给返回 ""（调用方回退
// CycleEndTime）。免费包/体验版的 CycleEndTime 只是每月计费周期边界，两者能差
// 8 年 —— 到期只认这个字段。
function deductionEndText(acc) {
  const raw = acc?.DeductionEndTime;
  if (raw === undefined || raw === null || raw === "" || raw === 0 || raw === "0") return "";
  const ms = normalizeEpochMs(raw);
  return ms > 0 ? epochToBeijingText(ms) : "";
}

// _val(*keys) 的移植：按优先级取第一个能 parseFloat 的键；全取不到 → 0。
function numVal(acc, keys) {
  for (const k of keys) {
    const v = acc?.[k];
    if (v !== undefined && v !== null && v !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

// _parse_package_account 的移植：字段名保持上游原样读取，输出 camelCase。
// now 是注入的取 now 毫秒函数（daysLeft/isExpired 以它为基准，测试可拨表）。
function parsePackageAccount(acc, now) {
  const o = acc && typeof acc === "object" && !Array.isArray(acc) ? acc : {};
  const size = numVal(o, ["CycleCapacitySizePrecise", "CycleCapacitySize", "CapacitySizePrecise", "CapacitySize"]);
  let remain = numVal(o, ["CycleCapacityRemainPrecise", "CycleCapacityRemain", "CapacityRemainPrecise", "CapacityRemain"]);
  let used = numVal(o, ["CycleCapacityUsedPrecise", "CycleCapacityUsed", "CapacityUsedPrecise", "CapacityUsed"]);
  // 上游常只填三个量里的两个：缺哪个就用另两个补（if/elif 与参考实现同序，
  // 一次只修一个），补出的量下限 0。
  if (size > 0 && used <= 0) used = Math.max(0, size - remain);
  else if (size > 0 && remain <= 0) remain = Math.max(0, size - used);

  // 发放原因（如「官方活动发放」「拉新奖励」）藏在 AccountAttributes 里。
  let grantReason = "";
  const attrs = Array.isArray(o.AccountAttributes) ? o.AccountAttributes : [];
  for (const a of attrs) {
    if (a && typeof a === "object" && !Array.isArray(a) && a.Key === "grantReason") {
      grantReason = String(a.Value ?? "");
      break;
    }
  }

  // 创建时间：epoch（>1e11 已是 ms）→ 北京时区文本；解析不出原样字符串。
  const rawCreate = o.CreateTime;
  const createMs = rawCreate ? normalizeEpochMs(rawCreate) : 0;
  const createTime = createMs > 0 ? epochToBeijingText(createMs) : rawCreate ? String(rawCreate) : "";

  const endTimeStr = o.CycleEndTime || o.ExpiredTime || "";
  const expireTime = deductionEndText(o) || endTimeStr;
  let daysLeft = null;
  let isExpired = false;
  let noExpiry = false;
  if (expireTime) {
    const endMs = beijingTextToMs(expireTime);
    if (endMs !== null) {
      const diff = endMs - now(); // 字符串时间按北京时间（+08:00）解析，见文件头
      if (diff > EXPIRY_SENTINEL_DAYS * DAY_MS) {
        noExpiry = true; // 远超真实周期的哨兵值 = 不过期，不参与倒计时
      } else {
        daysLeft = Math.round((diff / DAY_MS) * 10) / 10 + 0; // 1 位小数（-0 归零）
        isExpired = diff < 0;
      }
    }
  }

  let inUsage = Boolean(o.InUsage);
  if (!inUsage && !isExpired && remain > 0 && used > 0) inUsage = true;

  return {
    name: o.PackageName || "Package",
    packageCode: o.PackageCode || "",
    productName: o.ProductName || "",
    subProductName: o.SubProductName || "",
    grantReason,
    resourceId: o.ResourceId || "",
    dealName: o.DealName || "",
    createTime,
    remain: round2(remain),
    used: round2(used),
    size: round2(size),
    unit: o.CapacityUnit || "credits",
    inUsage,
    autoRenew: Boolean(o.AutoRenewFlag || o.SupportAutoRenew),
    cycleStartTime: o.CycleStartTime || "",
    cycleEndTime: endTimeStr,
    expireTime,
    noExpiry,
    daysLeft,
    isExpired,
    status: o.Status ?? 0,
  };
}

// fetchCredits(acct, opts) -> {ok:true, credits} | {ok:false, error, needRelogin?}
//
// 只读：三个 billing 查询接口，绝不上报、绝不在响应/日志里携带 token
//（callJSON 的头族内部构造，opts 透传 spacer/fetch/now/sleep —— daemon 的
// engineOpts() 供给唯一节流器与假 fetch）。
export async function fetchCredits(acct, opts = {}) {
  const ctx = ctxOf(opts);
  const now = ctx.now;
  const base = billBase();
  const extraHeaders = { "X-Client-Platform": "web" };

  // 1. 套餐概览（失败即整体失败；401/403/登录话术 → needRelogin）
  await ctx.breathe();
  let sRes;
  try {
    sRes = await callJSON(acct, "billing", base + RESOURCE_SUMMARY_PATH, { method: "POST", body: "{}", headers: extraHeaders }, opts);
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
  if (!sRes?.ok) {
    const text = `${sRes?.msg ?? ""} ${sRes?.raw ?? ""} ${sRes?.error ?? ""}`;
    const needRelogin = sRes?.status === 401 || sRes?.status === 403 || RELOGIN_RE.test(text);
    return {
      ok: false,
      error: String(sRes?.msg || sRes?.error || `HTTP ${sRes?.status ?? 0}`),
      ...(needRelogin ? { needRelogin: true } : {}),
    };
  }
  const sData = sRes.data && typeof sRes.data === "object" ? sRes.data : {};
  const tier = tierFromSummary(sData);
  const summaryPkgs = Array.isArray(sData.Packages) ? sData.Packages : [];
  const pkgCodes = [];
  for (const p of summaryPkgs) {
    const c = p?.PackageCode;
    if (c !== undefined && c !== null && c !== "" && !pkgCodes.includes(c)) pkgCodes.push(c);
  }

  // 2/3. 免费/付费资源包：单个来源失败（信封非 0 或网络错）忽略该来源，
  // 不整体失败 —— 与参考实现的 try/except pass 同口径。
  const collect = async (path, body) => {
    await ctx.breathe();
    try {
      const r = await callJSON(acct, "billing", base + path, { method: "POST", body: JSON.stringify(body), headers: extraHeaders }, opts);
      if (r?.ok) {
        const accounts = r.data?.Accounts;
        return Array.isArray(accounts) ? accounts : [];
      }
    } catch {
      // 忽略该来源
    }
    return [];
  };
  const freeAccs = pkgCodes.length
    ? await collect(RESOURCE_FREE_PACKAGES_PATH, { PackageCodes: pkgCodes, PageNumber: 1, PageSize: 200, Status: [0] })
    : [];
  const paidAccs = pkgCodes.length
    ? await collect(RESOURCE_PAID_PACKAGES_PATH, { PackageCodes: pkgCodes, PageNumber: 1, PageSize: 200, Status: [0, 3], NeedRenewInfo: true })
    : [];

  // free + paid 逐条按 AccountId 去重（free 在前；无 id 的条目不去重）。
  const packages = [];
  const seen = new Set();
  for (const raw of [...freeAccs, ...paidAccs]) {
    const id = raw?.AccountId;
    const hasId = id !== undefined && id !== null && id !== "";
    if (hasId && seen.has(id)) continue;
    if (hasId) seen.add(id);
    packages.push(parsePackageAccount(raw, now));
  }

  // 汇总：包明细求和；包为空且 summary 有汇总容量时用 summary 的周期容量兜底。
  let totRemain = 0;
  let totUsed = 0;
  let totSize = 0;
  for (const p of packages) {
    totRemain += p.remain;
    totUsed += p.used;
    totSize += p.size;
  }
  if (!packages.length && summaryPkgs.length) {
    for (const sp of summaryPkgs) {
      totSize += numVal(sp, ["CycleTotalCapacity"]);
      totRemain += numVal(sp, ["CycleRemainCapacity"]);
      totUsed += numVal(sp, ["CycleUsedCapacity"]);
    }
  }
  totRemain = round2(totRemain);
  totUsed = round2(totUsed);
  totSize = round2(totSize);

  const usedPercent = totSize > 0 ? `${((totUsed / totSize) * 100).toFixed(1)}%` : "0.0%";
  const remainPercent = totSize > 0 ? `${((totRemain / totSize) * 100).toFixed(1)}%` : "100.0%";

  // 最早到期的有效包：有剩余、未过期、且算得出到期时间，按 daysLeft 升序第一个。
  let earliest = null;
  for (const p of packages) {
    if (!(p.remain > 0) || p.isExpired || p.daysLeft === null || p.daysLeft === undefined) continue;
    if (!earliest || p.daysLeft < earliest.daysLeft) {
      earliest = {
        name: p.name,
        packageCode: p.packageCode,
        remain: p.remain,
        cycleEndTime: p.cycleEndTime,
        daysLeft: p.daysLeft,
      };
    }
  }

  const at = now();
  return {
    ok: true,
    credits: {
      remain: totRemain,
      used: totUsed,
      size: totSize,
      usedPercent,
      remainPercent,
      // summary 没有 IsPaidUser 字段时如实给 null（不要瞎判免费）。
      isPaidUser: "IsPaidUser" in sData ? Boolean(sData.IsPaidUser) : null,
      tier,
      earliestExpiring: earliest,
      packages,
      updatedAt: at,
      updatedIso: epochToBeijingText(at),
    },
  };
}
