// buddy.mjs —— Buddy 盲盒腿（wb_tasks.do_buddy_open 的移植，参考
// 88lin/workbuddy-auto-signin 的开盒流程，hub commit 937c179）。
//
// 用积累的成长能量开启 Buddy 盲盒（/v2/activity/growth/buddy/open），避免能量
// 闲置。这是一条**独立腿**（CONTRACT §7）：
//   - 批量口径：quota 读出 affordable（当前能量还能开几个）与 max_open_count
//     （单次开盒上限），一次 POST 按 min(affordable, max(1, max_open_count)) 开；
//   - 排程口径：daemon 的 SCHEDULE_HOURS_LEGS 收 buddy，但默认 hours.buddy=[]
//     （开盲盒消耗成长能量，默认绝不自动跑，用户显式配窗口才生效）。
//
// 红线：**不领积分、不加 credit** —— 开盒本身不产出积分，能量消耗也不计入收益；
// 本腿的产物只有 logs（人读过程）与 opened/name。所有上游调用走 callJSON
//（自带重试/退避/403-11140 restricted 透传 + chat 主机回退），经 opts.spacer 全局
// 节流器与其它路径共用「任意两次上游调用 ≥ gap」的红线；调用前 ctx.breathe。

import { randomUUID } from "node:crypto";
import { callJSON, ctxOf, growthBase as _growthBase } from "./upstream.mjs";

// runBuddyOpen(acct, opts) -> {ok, opened, name?, logs, restricted?}
// opts: {base?/bases?, gap?, now?, sleep?, fetch?, log(fn), spacer?, signal, env?}
export async function runBuddyOpen(acct, opts = {}) {
  const ctx = ctxOf(opts);
  const logs = [];

  if (acct?.provider !== "workbuddy") {
    return { ok: false, opened: 0, logs: ["国际版不适用国内成长任务中心"] };
  }
  if (acct?.enterpriseId) {
    return { ok: true, opened: 0, logs: ["企业版账号无成长体系，跳过"] };
  }

  // 1. 配额查询：affordable = 当前成长能量还够开几个；max_open_count = 单次上限
  await ctx.breathe(); // 防风控：与上一次上游调用之间 ≥ gap
  const res = await callJSON(
    acct, "chat", chatUrl(opts) + "/v2/activity/growth/buddy/quota",
    { method: "GET" },
    opts,
  );
  if (res.restricted) {
    return { ok: false, opened: 0, logs: ["Buddy 盲盒: 账号已被风控限制"], restricted: true };
  }
  if (!res.ok) {
    const why = res.msg || `HTTP ${res.status ?? 0}`;
    logs.push(`Buddy 盲盒: 查询成长能量配额失败 (${why})`);
    return { ok: false, opened: 0, logs };
  }
  const affordable = Number(res.data?.affordable ?? 0) || 0;
  const maxOpen = Number(res.data?.max_open_count ?? 1) || 1;
  if (affordable <= 0) {
    // 能量不够是常态而非故障：ok:true，一步都不多发
    return { ok: true, opened: 0, logs: ["成长能量不足以开启 Buddy 盲盒"] };
  }
  const count = Math.min(affordable, Math.max(1, maxOpen));

  // 2. 开盒：body {count, client_token}（client_token 每次随机，幂等键由上游持有）
  await ctx.breathe();
  const open = await callJSON(
    acct, "chat", chatUrl(opts) + "/v2/activity/growth/buddy/open",
    { method: "POST", body: JSON.stringify({ count, client_token: randomUUID() }) },
    opts,
  );
  if (open.restricted) {
    return { ok: false, opened: 0, logs: ["Buddy 盲盒: 账号已被风控限制"], restricted: true };
  }
  if (!open.ok) {
    logs.push(`Buddy 盲盒: 开启失败 (${open.msg || `HTTP ${open.status ?? 0}`})`);
    return { ok: false, opened: 0, logs };
  }

  // 3. 解析开出的 Buddy 名：上游口径有 buddy / name / buddies（数组）三种拼写
  const data = open.data ?? {};
  let name = data.buddy || data.name || data.buddies || "新 Buddy";
  if (Array.isArray(name)) name = name.length ? name.join(", ") : "新 Buddy";
  logs.push(`Buddy 盲盒: 开启 ×${count} 成功 (${name})`);
  return { ok: true, opened: count, name: String(name), logs };
}

// ---- 内部小工具 ----------------------------------------------------------------

function chatUrl(opts = {}) {
  const fromOpts = String(opts.base || opts.bases?.chat || "").trim();
  return fromOpts ? fromOpts.replace(/\/+$/, "") : _growthBase(opts.env ?? globalThis.process?.env ?? {});
}
