// travel.mjs —— 猫猫旅行闭环 + 夜猫子任务（wb_tasks.py 的 do_cat_travel /
// ensure_buddy / _travel_depart / run_night_growth 的移植）。
//
// 状态里的 buddy_id 是「当前旅行实例」的 id，猫在家（idle）时恒为 0，不能拿
// 它判断有没有 Buddy。以 depart 的 "no active buddy" 为准：先直接派，失败再
// 补齐 first_buddy（其奖励即 Buddy 实例）重试一次。

import {
  NIGHT_POLL_ATTEMPTS,
  NIGHT_POLL_MS,
  NIGHT_TASK_CODES,
  inNightWindow,
} from "./constants.mjs";
import { acceptTasks, buildEvent, claimTask, fetchEnergy, fetchTasks, progressTask, reportEvents } from "./tasks.mjs";
import { callJSON, ctxOf } from "./upstream.mjs";

// ---- 状态查询 ------------------------------------------------------------------

// travelStatus(acct, opts) -> data|null（GET /activity/growth/buddy/travel/status）
export async function travelStatus(acct, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe(); // 防风控：与上一次上游调用之间 ≥ gap
  const res = await callJSON(acct, "chat", chatUrl(opts) + "/activity/growth/buddy/travel/status", { method: "GET" }, opts);
  if (res.restricted) return { data: null, restricted: true };
  return { data: res.ok ? res.data ?? {} : null };
}

// ---- 派出旅行 -------------------------------------------------------------------
// 返回 {data, err}：成功 data 为响应 data，失败 err 为上游 msg。
async function travelDepart(acct, lid, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe(); // 防风控：与上一次上游调用之间 ≥ gap
  const res = await callJSON(
    acct, "chat", chatUrl(opts) + "/activity/growth/buddy/travel/depart",
    { method: "POST", body: JSON.stringify({ location_id: lid }) },
    opts,
  );
  if (res.restricted) return { data: null, err: res.msg || "restricted", restricted: true };
  if (res.ok) return { data: res.data ?? {}, err: null };
  // 信封失败：msg 优先；HTTP 错误：带状态码（hub 的 _travel_depart 口径）
  const err = res.msg || (res.code !== -1 ? `code=${res.code}` : `HTTP ${res.status}`);
  return { data: null, err };
}

// ensureBuddy(acct, opts) -> boolean
// 确保账号已领到 Buddy 实例：没有则完成并领取 first_buddy。first_buddy 是
// auto 类任务，其奖励（reward_buddy）就是 Buddy 实例；single 任务与猫猫旅行
// 都以它为前提。返回是否已就绪。
export async function ensureBuddy(acct, opts = {}) {
  const logs = [];
  let tasks = await fetchTasks(acct, opts);
  let fb = tasks.find((t) => t.code === "first_buddy") ?? null;
  if (!fb) return false;
  if (fb.acceptStatus === "claimed") return true;
  await progressTask(acct, fb, logs, opts);
  tasks = await fetchTasks(acct, opts);
  fb = tasks.find((t) => t.code === "first_buddy") ?? null;
  return !!(fb && fb.acceptStatus === "claimed");
}

// ---- 猫猫旅行 -------------------------------------------------------------------

// runCatTravel(acct, opts) -> {ok, action, msg, credit?, restricted?}
// 检查并执行猫猫旅行（领奖 / 派出）。
export async function runCatTravel(acct, opts = {}) {
  const ctx = ctxOf(opts);

  if (acct?.enterpriseId) {
    return { ok: true, action: "skip", msg: "企业版账号无成长体系，跳过" };
  }

  // 1. 查询状态
  const stRes = await travelStatus(acct, opts);
  if (stRes.restricted) return { ok: false, action: "restricted", msg: "账号已被风控限制", restricted: true };
  if (!stRes.data) return { ok: false, msg: "查询旅行状态失败" };
  const st = stRes.data;
  const state = st.state;

  if (state === "arrived") {
    // 领奖（官方前端：POST travel/claim body {}）
    await ctx.breathe();
    const res = await callJSON(
      acct, "chat", chatUrl(opts) + "/activity/growth/buddy/travel/claim",
      { method: "POST", body: "{}" },
      opts,
    );
    if (res.restricted) return { ok: false, msg: "领奖失败: 账号已被风控限制", restricted: true };
    if (res.ok) {
      const credit = res.data?.reward_credit ?? 0;
      return { ok: true, action: "claim", credit, msg: `旅行归来领奖成功！获得 ${credit} 积分` };
    }
    return { ok: false, msg: `领奖失败: ${res.msg || `HTTP ${res.status}`}` };
  }

  if (state === "idle") {
    if (st.daily_limit_reached) {
      return { ok: true, action: "idle", msg: "猫猫今日已完成旅行，明日 00:00 刷新" };
    }
    // 派出旅行：官方前端要求 body 携带 {location_id}（目的地清单在
    // travel/config）—— 空 body 会被拒 400 "invalid request"。
    let lid = null;
    await ctx.breathe();
    const cfgRes = await callJSON(acct, "chat", chatUrl(opts) + "/activity/growth/buddy/travel/config", { method: "GET" }, opts);
    if (cfgRes.ok) {
      const locs = cfgRes.data?.locations ?? [];
      if (locs.length) lid = locs[0].id;
    } else {
      ctx.log?.(`buddy/travel/config query failed: ${cfgRes.msg}`);
    }
    if (lid == null) lid = 1;

    // 先直接派，失败再补齐 first_buddy（其奖励即 Buddy 实例）重试一次。
    let dep = await travelDepart(acct, lid, opts);
    if (dep.restricted) return { ok: false, msg: `派出旅行失败: ${dep.err}`, restricted: true };
    if (dep.data == null && String(dep.err || "").toLowerCase().includes("no active buddy")) {
      if (await ensureBuddy(acct, opts)) {
        await ctx.breathe();
        dep = await travelDepart(acct, lid, opts);
        if (dep.restricted) return { ok: false, msg: `派出旅行失败: ${dep.err}`, restricted: true };
      } else {
        return {
          ok: false,
          msg: "还没有 Buddy：需先完成并领取「领取一只 Buddy」任务（新建任务并发起对话）",
        };
      }
    }
    if (dep.data != null) {
      const loc = dep.data.location?.name || "";
      return { ok: true, action: "depart", msg: `猫猫已出发前往「${loc}」，预计数小时后归来！` };
    }
    return { ok: false, msg: `派出旅行失败: ${dep.err}` };
  }

  if (state === "traveling") {
    return { ok: true, action: "traveling", msg: "猫猫正在旅行途中，请稍后再来查看！" };
  }

  return { ok: true, action: state, msg: `当前状态: ${state}` };
}

// ---- 夜猫子任务（black_cat，23:00-08:00）----------------------------------------

// 01:00 刚过日切时，上游任务列表可能还没把 black_cat 下发出来（生产实测两账号
// 同时「未获取到夜猫子任务清单」）。先立即查一次，再按 5s/15s/30s 重试；总计
// 约 50s，夜间没有其它 job。仍没有就如实跳过，不记失败。
const NIGHT_DISCOVERY_DELAYS_MS = [0, 5000, 15000, 30000];

// runNightTask(acct, opts) -> {ok, earnedCredit, logs, restricted?}
// 每日 23:00-08:00 上报 1 次 GLM-5.2 夜间对话事件，每天计 1 次、累计 3 天后
// 可领奖。白天调用会诚实跳过。
export async function runNightTask(acct, opts = {}) {
  const ctx = ctxOf(opts);
  const logs = [];
  const name = acct.nickname || acct.uid.slice(0, 8);
  const push = (line) => {
    logs.push(line);
    ctx.log?.(line); // runner 通过 opts.log 收集人读日志
  };

  if (acct.provider !== "workbuddy") {
    return { ok: false, earnedCredit: 0, logs: ["国际版不适用国内成长任务中心"] };
  }
  if (acct.enterpriseId) {
    return { ok: true, earnedCredit: 0, logs: ["企业版账号无成长体系，跳过"] };
  }
  if (!inNightWindow(ctx.now())) {
    return {
      ok: true, earnedCredit: 0,
      logs: [`[${name}] 当前不在 23:00-08:00 夜间窗口, 夜猫子任务跳过 (每日 01:00 自动执行)`],
    };
  }

  // black_cat 可能在日切后稍晚才出现在任务列表里；短暂重试，避免整晚误判失败。
  let t = null;
  for (let attempt = 0; attempt < NIGHT_DISCOVERY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await ctx.breathe(NIGHT_DISCOVERY_DELAYS_MS[attempt]);
    const tasks = await fetchTasks(acct, opts);
    t = tasks.find((x) => x.code === "black_cat") ?? null;
    if (t) break;
    push(
      `[${name}] 夜猫子任务清单未包含 black_cat（第 ${attempt + 1}/${NIGHT_DISCOVERY_DELAYS_MS.length} 次，` +
      `本次清单 ${tasks.length} 项）`,
    );
  }
  if (!t) {
    push(`[${name}] 夜猫子任务今晚未下发，跳过（不是插件故障；可能活动已结束/今日已领/上游日切未完成）`);
    return { ok: true, earnedCredit: 0, logs };
  }
  if (t.acceptStatus === "claimed") {
    return { ok: true, earnedCredit: 0, logs: [`[${name}] 夜猫子任务已领奖`] };
  }
  if (t.acceptStatus === "not_accepted") {
    // 上游只对已接取的任务累计进度；夜猫子任务也必须先接取。
    const accRes = await acceptTasks(acct, ["black_cat"], opts);
    if (accRes.restricted) {
      push(`[${name}] 夜猫子任务接取时触发风控限制`);
      return { ok: false, earnedCredit: 0, logs, restricted: true };
    }
    if (!accRes.accepted.length && !accRes.already.length) {
      const why = accRes.msg || (accRes.reasons ?? []).join("; ").slice(0, 120);
      push(`[${name}] 夜猫子任务未接取, 今晚跳过 (先解决接取失败${why ? ": " + why : ""})`);
      return { ok: false, earnedCredit: 0, logs };
    }
    push(`[${name}] 夜猫子任务已接取`);
  }

  const cur = t.progress?.current ?? 0;
  const tgt = t.progress?.target ?? 3;
  if (cur >= tgt) {
    const res = await claimTask(acct, "black_cat", opts);
    const cr = res.ok ? res.credit : 0;
    const base = { ok: res.ok, earnedCredit: cr, logs };
    if (res.restricted) return { ...base, ok: false, restricted: true };
    push(`[${name}] 夜猫子任务达标, 领奖 ${res.ok ? `✓ +${cr} 积分` : `! 失败: ${res.reason || ""}`}`);
    return base;
  }

  const ev = buildEvent(acct, "cat", 0, null, { now: ctx.now });
  const ok = await reportEvents(acct, [ev], opts);
  push(`[${name}] 上报夜间 GLM-5.2 对话事件: ${ok ? "成功" : "失败"} (进度 ${cur}/${tgt})`);

  let fresh = null;
  for (let i = 0; i < NIGHT_POLL_ATTEMPTS; i++) {
    await ctx.breathe(NIGHT_POLL_MS);
    const freshList = await fetchTasks(acct, opts);
    fresh = freshList.find((x) => x.code === "black_cat") ?? null;
    if (fresh && (fresh.progress?.current ?? 0) > cur) break;
  }
  const newCur = fresh ? fresh.progress?.current ?? cur : cur;

  let earned = 0;
  if (newCur >= tgt) {
    const res = await claimTask(acct, "black_cat", opts);
    const cr = res.ok ? res.credit : 0;
    if (res.ok) earned = cr;
    push(`[${name}] 夜猫子任务完成 ${newCur}/${tgt}, 领奖 ${res.ok ? `✓ +${cr} 积分` : `! 失败: ${res.reason || ""}`}`);
  } else if (newCur > cur) {
    push(`[${name}] 今晚 +1 (${newCur}/${tgt}), 明晚继续, 累计 3 天可领奖`);
  } else {
    push(`[${name}] 已上报但进度暂未变化 (${newCur}/${tgt}), 明晚调度器会继续累计`);
  }

  await fetchEnergy(acct, opts);
  return { ok: true, earnedCredit: earned, logs };
}

export { NIGHT_TASK_CODES };

// ---- 内部小工具 ----------------------------------------------------------------
import { growthBase as _growthBase } from "./upstream.mjs";

function chatUrl(opts = {}) {
  const fromOpts = String(opts.base || opts.bases?.chat || "").trim();
  return fromOpts ? fromOpts.replace(/\/+$/, "") : _growthBase(opts.env ?? globalThis.process?.env ?? {});
}
