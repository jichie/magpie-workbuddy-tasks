// tasks.mjs —— 国内版成长任务批量自动化流水线（wb_tasks.py 的移植）。
//
// 流程铁序（CONTRACT §7 / wb_tasks.run_growth_tasks）：
//   auto 任务先点亮领取（first_buddy 是前置）→ 批量接取 → 复查 → 二次补接
//   → 逐任务点亮（上报 + 轮询进度）→ 领奖 → 猫猫旅行 → 结算。
//
// 防风控：所有上游调用之间 ≥1 s（ctx.breathe，假时钟下可断言）；上报后等
// 1.5 s、轮询进度最多 6 次（在涨再等 2.5 s），没到位就把领奖顺延到下一轮，
// 绝不硬闯。时钟全部走 opts.now / opts.sleep。

import {
  ACCEPT_CHUNK,
  CLAIM_POLL_ATTEMPTS,
  EXPERT_ID_POOL,
  LIBRARY_DOC_URL,
  LIBRARY_ELEMENT_ID,
  LIBRARY_ELEMENT_NAME,
  NIGHT_TASK_CODES,
  PROGRESS_RISING_MS,
  REPORT_SETTLE_MS,
  TASK_SPECS,
  TEAM_ID_POOL,
  WEB_UA,
  inNightWindow,
} from "./constants.mjs";
import { deriveId } from "./fingerprint.mjs";
import { defaultNow } from "./identity.mjs";
import { resolveTaskKind } from "./taskkind.mjs"; // 任务 → kind 解析（CONTRACT §2/§7，唯一判断源）
import { runCatTravel } from "./travel.mjs"; // 循环引用（travel 需要 tasks 的流水线件）；ESM 函数声明提升下安全
import {
  billBase as _billBase,
  callJSON,
  ctxOf,
  growthBase as _growthBase,
  makeCtx,
  webBase as _webBase,
} from "./upstream.mjs";

// ---- 查询 --------------------------------------------------------------------

// fetchTasks(acct, opts) -> Task[]
// Task 是**规范形状**（camelCase，全引擎与 daemon 只认这一种拼写，CONTRACT §2）；
// 上游的 snake_case 字段（task_code/reward_credit/…、顶层 current/target/status/name）
// 在这里一次性归一。非枚举的 raw 字段保留上游原始对象，仅供调试。
export async function fetchTasks(acct, opts = {}) {
  if (acct?.enterpriseId) return []; // 企业版账号无成长体系
  const ctx = ctxOf(opts);
  await ctx.breathe(); // 防风控：任何两次上游调用之间 ≥ gap
  const res = await callJSON(acct, "chat", chatUrl(opts) + "/v2/activity/growth/tasks", { method: "GET" }, opts);
  if (!res.ok) {
    // 以前这里静默返回 []，夜猫子 01:00 失败时只剩「未获取到清单」一句，分不清
    // 是网络/信封失败还是列表里确实没有任务。记一行可读原因（不含 token）。
    ctx.log?.(
      `拉取任务清单失败：HTTP ${res.status ?? 0}` +
      `${res.msg ? ` ${String(res.msg).slice(0, 160)}` : ""}` +
      `${res.restricted ? " (restricted)" : ""}`,
    );
    return [];
  }
  const rawTasks = res.data?.tasks ?? [];
  const tasks = [];
  for (const t of rawTasks) {
    const code = t.task_code || "";
    // Object.hasOwn：上游若回 "constructor" 这类键名，不许吃到原型链上的东西
    const spec = code && Object.hasOwn(TASK_SPECS, code) ? TASK_SPECS[code] : {};
    const prog = t.progress ?? {};
    const task = {
      code,
      title: t.title || spec.name || code,
      description: t.description || t.task_desc || "",
      jumpUrl: t.jump_url || "",
      acceptStatus: t.accept_status || "not_accepted",
      taskType: t.task_type || "",
      progress: {
        current: prog.current ?? 0,
        target: prog.target ?? spec.target ?? 1,
      },
      rewardCredit: t.reward_credit || spec.reward || 0,
      rewardEnergy: t.reward_energy ?? 0,
      unforgeable: false,
      reason: "",
    };
    // kind 解析（CONTRACT §2/§7）：TASK_SPECS 命中沿用 spec 语义；未收录但
    // jump_url 能解出 expertId=ex_… 的按 expert 类点亮；都否则 unforgeable+
    // 「未收录任务」—— needsAccept 据此把它们挡在接取批次之外。
    const rk = resolveTaskKind(task);
    task.unforgeable = rk.unforgeable;
    task.reason = rk.reason;
    // raw 挂成非枚举：不进 JSON.stringify / Object.keys，但调试时拿得到上游原文
    Object.defineProperty(task, "raw", { value: t, enumerable: false });
    tasks.push(task);
  }
  return tasks;
}

// fetchEnergy(acct, opts) -> number（GET /v2/activity/growth/energy）
export async function fetchEnergy(acct, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe();
  const res = await callJSON(acct, "chat", chatUrl(opts) + "/v2/activity/growth/energy", { method: "GET" }, opts);
  return res.ok ? res.data?.balance ?? 0 : 0;
}

// fetchGrowthSummary(acct, opts) -> 能量 / 连登 / 抽奖 / 旅行一次性快照
//（wb_tasks.fetch_growth_summary 的移植；任何一段失败都不拖死其余）。
export async function fetchGrowthSummary(acct, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe();
  const out = { energy: 0, streakDays: 0, makeupCards: 0, tiers: [], tierStatuses: {}, lotteryChances: 0, travel: { state: "unknown" } };
  const log = (msg) => ctx.log?.(msg);
  const get = async (path) =>
    callJSON(acct, "chat", chatUrl(opts) + path, { method: "GET" }, opts);

  let res = await get("/v2/activity/growth/energy");
  if (res.ok) out.energy = res.data?.balance ?? 0;
  else log(`growth/energy query failed: ${res.msg}`);
  await ctx.breathe();

  res = await get("/activity/growth/streak");
  if (res.ok) {
    const data = res.data ?? {};
    out.streakDays = data.streak?.days ?? 0;
    out.makeupCards = data.makeup_cards?.balance ?? 0;
    const redemp = data.redemption_status ?? {};
    out.tiers = redemp.tiers ?? [];
    out.tierStatuses = {
      "7d": redemp.tier_7d_status ?? "locked",
      "14d": redemp.tier_14d_status ?? "locked",
      "28d": redemp.tier_28d_status ?? "locked",
    };
  } else log(`growth/streak query failed: ${res.msg}`);
  await ctx.breathe();

  res = await get("/activity/growth/lottery/summary");
  if (res.ok) out.lotteryChances = res.data?.chances ?? 0;
  else log(`growth/lottery query failed: ${res.msg}`);
  await ctx.breathe();

  res = await get("/activity/growth/buddy/travel/status");
  if (res.ok) out.travel = res.data ?? {};
  else log(`buddy/travel/status query failed: ${res.msg}`);
  return out;
}

// ---- 接取 --------------------------------------------------------------------

// acceptTasks(acct, codes, opts) -> {ok, accepted[], already[], failed[], msg, reasons[], restricted?}
// 20 个一批（ACCEPT_CHUNK）；批内已接/新接分账，整批被拒时把整批记 failed。
export async function acceptTasks(acct, codes, opts = {}) {
  const ctx = ctxOf(opts);
  const out = { ok: true, accepted: [], already: [], failed: [], msg: "", reasons: [] };
  if (!codes || codes.length === 0) return out;
  const url = chatUrl(opts) + "/v2/activity/growth/tasks/accept";
  const chunk = Math.max(1, Number(opts.chunk ?? ACCEPT_CHUNK));
  for (let i = 0; i < codes.length; i += chunk) {
    await ctx.breathe(); // 批与批之间也 ≥ gap（hub 这里漏了，铁律 4 补上）
    const part = codes.slice(i, i + chunk);
    const res = await callJSON(
      acct, "chat", url,
      { method: "POST", body: JSON.stringify({ task_codes: part }) },
      opts,
    );
    if (res.restricted) {
      out.ok = false;
      out.restricted = true;
      out.msg = res.msg || "restricted";
      out.failed.push(...part);
      out.reasons.push(`restricted: ${out.msg}`);
      break;
    }
    if (!res.ok) {
      out.ok = false;
      out.msg = res.msg || `code=${res.code}`;
      out.failed.push(...part);
      out.reasons.push(out.msg);
      ctx.log?.(`accept batch failed: ${out.msg}`);
      continue;
    }
    const results = res.data?.results ?? [];
    const seen = new Set();
    for (const item of results) {
      const code = item.task_code;
      const st = String(item.status ?? "");
      seen.add(code);
      if (st === "accepted") out.accepted.push(code);
      else if (st === "already_accepted") out.already.push(code);
      else {
        out.failed.push(code);
        out.reasons.push(`${code}: ${item.message || st}`);
        ctx.log?.(`task ${code} accept status=${st}`);
      }
    }
    for (const code of part) if (!seen.has(code)) out.failed.push(code);
  }
  return out;
}

// ---- 上报 --------------------------------------------------------------------

// reportEvents(acct, events, opts) -> boolean
// body 是事件数组（CONTRACT §7）；事件缺 userId 服务端 200 但静默丢弃。
export async function reportEvents(acct, events, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe(); // 防风控：与上一次上游调用之间 ≥ gap
  const base = opts.reportBase || chatUrl(opts);
  const kind = base === billUrl() ? "billing" : "chat";
  const res = await callJSON(
    acct, kind, base + "/v2/report",
    { method: "POST", body: JSON.stringify(events) },
    opts,
  );
  return !!res.ok;
}

// reportLibraryEvent(acct, opts) -> boolean
// 「浏览资料库」（Library_read）的点亮事件（wb_tasks.report_web_library 同源）：
// 上游不认 chat 域的伪造事件，只认 web 端在资料库介绍文档页的一次元素点击
//（web_element_click，CONTRACT §7）。事件走 **web 域** /v2/report，头族用
// webHeaders 并覆盖三处：Referer=文档 URL、User-Agent=WEB_UA（与事件里的
// userAgent 同值，冒充同一次浏览器会话）、X-User-Id=空串（web 端点击事件的
// 真实形态 —— 身分靠 Authorization 与事件体内的 userId/machineId 携带）。
export async function reportLibraryEvent(acct, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe(); // 防风控：与上一次上游调用之间 ≥ gap
  const uid = String(acct?.uid ?? "");
  const now = Math.floor(ctx.now());
  const event = {
    eventCode: "web_element_click",
    timestamp: now,
    reportDelay: 0,
    pageURL: LIBRARY_DOC_URL,
    elementId: LIBRARY_ELEMENT_ID,
    elementName: LIBRARY_ELEMENT_NAME,
    os: "Win32",
    arch: "",
    osVersion: "10.0",
    userAgent: WEB_UA,
    machineId: deriveId(uid, "webmachine"), // wb_fingerprint：salt:uid 的 md5 派生
    userId: uid,
    userNickname: String(acct?.nickname ?? ""),
  };
  const res = await callJSON(
    acct, "web", `${webUrl_()}/v2/report`,
    {
      method: "POST",
      body: JSON.stringify([event]),
      headers: {
        Referer: LIBRARY_DOC_URL,
        "User-Agent": WEB_UA,
        "X-User-Id": "",
      },
    },
    opts,
  );
  return !!res.ok;
}

// ---- 领奖 --------------------------------------------------------------------

// claimTask(acct, code, opts) -> {ok, credit, energy, via, reason, restricted?}
// HTTP 400（或信封 code 400）「task not completed」→ 试一次 web 域回退
//（www.workbuddy.cn + webHeaders），且只试一次。
export async function claimTask(acct, code, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe(); // 领奖前也 ≥ gap（hub 在轮询结束后直接领，这里补上）
  const url = `${chatUrl(opts)}/activity/growth/tasks/${encodeURIComponent(code)}/claim`;
  const res = await callJSON(acct, "chat", url, { method: "POST", body: "{}" }, opts);
  if (res.ok) {
    return { ok: true, credit: res.data?.credit ?? 0, energy: res.data?.energy ?? 0, via: "chat", reason: "" };
  }
  if (res.restricted) {
    return { ok: false, credit: 0, energy: 0, via: "chat", reason: res.msg || "restricted", restricted: true };
  }
  const chatReason = res.msg || `code=${res.code}` || `HTTP ${res.status}`;
  if (res.status === 400 || res.code === 400) {
    // 降级到 web 域领奖
    await ctx.breathe();
    const webUrl = `${webUrl_()}/activity/growth/tasks/${encodeURIComponent(code)}/claim`;
    const res2 = await callJSON(acct, "web", webUrl, { method: "POST", body: "{}" }, opts);
    if (res2.ok) {
      return { ok: true, credit: res2.data?.credit ?? 0, energy: res2.data?.energy ?? 0, via: "web", reason: "" };
    }
    ctx.log?.(`task ${code} web claim rejected: code=${res2.code} msg=${res2.msg}`);
    return {
      ok: false, credit: 0, energy: 0, via: "web",
      reason: res2.msg || chatReason,
      ...(res2.restricted ? { restricted: true } : {}),
    };
  }
  ctx.log?.(`task ${code} claim failed: ${chatReason}`);
  return { ok: false, credit: 0, energy: 0, via: "chat", reason: chatReason };
}

// ---- 事件构造（wb_tasks.build_event 逐字拷贝，字段名一个不改）-----------------
//
// expert: [expert_id, expert_name] —— 专家/团队类事件必须每次使用不同的 id，
// 上游按 (eventCode, id) 去重，重复 id 不会推进任务进度。
export function buildEvent(acct, kind, idx = 0, expert = null, opts = {}) {
  const now = Math.floor(opts.now ? opts.now() : defaultNow());
  const cid = `wb-task-${now}-${idx}`;
  const rid = `${cid}-req`;
  const uid = acct.uid;

  if (kind === "canvas") {
    return { eventCode: "wbx_design_canvas_task_create", timestamp: now,
      reportDelay: 0, conversationId: cid, requestId: rid,
      source: "summon_keyword", isCustomModel: false, name: "",
      inputLength: 12, id: `wbx-canvas-${now}`, cost: 0,
      isSuccessful: true, userId: uid };
  }
  if (kind === "template") {
    return { eventCode: "agent_task_created_with_template", timestamp: now,
      reportDelay: 0, isCustomModel: true, id: String(idx),
      name: "幻灯片", requestId: rid, conversationId: cid, userId: uid };
  }
  if (kind === "expert" || kind === "team" || kind === "lighthouse") {
    const etype = kind === "team" ? "team" : "agent";
    let exId, name;
    if (expert) [exId, name] = expert;
    else if (kind === "lighthouse") [exId, name] = ["ex_2cvvUZQhDyeJ", "腾讯轻量云专家"];
    else if (kind === "team") [exId, name] = ["CloudOpsTeam", "运维专家团队"];
    else [exId, name] = ["ContentCreator", "内容创作专家"];
    return { eventCode: "expert_actual_use", timestamp: now, reportDelay: 0,
      mode: "CLOUD", id: exId, name, expertTitle: name,
      type: "02-Engineering", expertType: etype, source: "builtin",
      version: "1.0.2", cost: 0, characterCount: 12, conversationId: cid,
      requestId: rid, messageId: rid, requestModelId: "deepseek-v4-flash",
      requestModelName: "DeepSeek V4 Flash", userId: uid };
  }
  if (kind === "skill") {
    return { eventCode: "skill_info", timestamp: now, reportDelay: 0,
      skillId: "skill_2096525080079265792", name: "pptx", userId: uid };
  }
  if (kind === "automation") {
    return { eventCode: "automated_task_create_suc", timestamp: now, reportDelay: 0,
      name: "每周工作整理", type: "cron", source: "manually",
      modelId: "deepseek-v4-flash", modelIsThinking: false,
      conversationId: cid, requestId: rid,
      schedule: { type: "recurring", rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0" },
      prompt: "每周五自动整理本周工作", userId: uid };
  }
  if (kind === "playbook") {
    return { eventCode: "playbook_prompt_send", timestamp: now, reportDelay: 0,
      id: "worker-ledger-freedom-dashboard", name: "打工人小账本",
      type: "other", promptLength: 10, isOfficial: 1,
      source: "discover", conversationId: cid, requestId: rid, userId: uid };
  }
  if (kind === "skin") {
    return { eventCode: "appearance_skin_apply", timestamp: now, reportDelay: 0,
      action: "apply", source: "settings_close", id: "theme-tkmw7j",
      vipLevel: "free", series: "craft", type: "unknown",
      name: "和平精英激战金秋", userId: uid };
  }
  if (kind === "chat" || kind === "glmchat" || kind === "cat") {
    const mId = kind === "glmchat" || kind === "cat" ? "glm-5.2" : "deepseek-v4-flash";
    const mNm = kind === "glmchat" || kind === "cat" ? "GLM-5.2" : "DeepSeek V4 Flash";
    const mode = kind === "cat" ? "night" : "craft";
    return { eventCode: "chat_request_send", timestamp: now, reportDelay: 0,
      mode, conversationId: cid, requestId: rid,
      inputLength: 12, requestModelId: mId, requestModelName: mNm,
      isPlan: false, agentName: "default", agentType: "conversation",
      userId: uid };
  }
  return { eventCode: "heartbeat", timestamp: now, userId: uid };
}

// ---- 单任务推进（wb_tasks._progress_one 的移植）------------------------------

// progressTask(acct, t, logs, opts) -> {credit, energy, lit, claimed, restricted?}
export async function progressTask(acct, t, logs, opts = {}) {
  const ctx = ctxOf(opts);
  const claim = opts.claim !== false;
  const code = t.code;
  const rk = resolveTaskKind(t);
  const spec = rk.spec;
  const name = spec?.name || t.title || code;

  // 未收录任务（TASK_SPECS 没有、jump_url 也派生不出专家 id）：引擎没有任何
  // 合法的事件构造方式 —— 不接取、不上报、不领奖，诚实标注（P0-1）。
  if (rk.source === "none") {
    logs.push(`⏭ 任务 [${name}] ${rk.reason || "未收录任务"}: 引擎没有该任务的事件构造方式, 跳过接取/上报/领奖`);
    return { credit: 0, energy: 0, lit: 0, claimed: 0 };
  }

  if (rk.unforgeable) {
    if (rk.reason) {
      logs.push(`⏭ 任务 [${name}] 需真实操作完成: ${rk.reason}, 跳过`);
    }
    return { credit: 0, energy: 0, lit: 0, claimed: 0 };
  }

  const status = t.acceptStatus;
  const cur = t.progress?.current ?? 0;
  const tgt = t.progress?.target ?? 1;

  if (status === "claimed") return { credit: 0, energy: 0, lit: 0, claimed: 0 };

  // 已完成的任务先领奖 —— 桌面端/夜间任务也可能被真实操作完成，这类任务必须
  // 先结算，不能因为「只能靠真实操作」就直接跳过丢掉奖励。
  if (status === "completed" || cur >= tgt) {
    if (!claim) {
      logs.push(`⏸ 任务 [${name}] 已达成，等待手动领取`);
      return { credit: 0, energy: 0, lit: 0, claimed: 0 };
    }
    const res = await claimTask(acct, code, opts);
    if (res.ok) {
      const cr = res.credit ?? 0;
      logs.push(`✓ 任务 [${name}] 领奖成功: +${cr} 积分`);
      await ctx.breathe();
      return { credit: cr, energy: res.energy ?? 0, lit: 0, claimed: 1 };
    }
    logs.push(`! 任务 [${name}] 领奖失败: ${res.reason || "未知原因"}`);
    await ctx.breathe();
    return { credit: 0, energy: 0, lit: 0, claimed: 0, ...(res.restricted ? { restricted: true } : {}) };
  }

  // 只认桌面端真实行为的任务：伪造事件不会推进进度，诚实跳过并给出深链。
  if (rk.desktopOnly) {
    const jump = t.jumpUrl || "workbuddy://chat";
    logs.push(`⏭ 任务 [${name}] 需真实操作完成: ${rk.desktopReason || "需在桌面端完成"} (深链 ${jump}), 跳过事件伪造`);
    return { credit: 0, energy: 0, lit: 0, claimed: 0 };
  }

  // 夜猫子任务只在 23:00-08:00 计数（每日 01:00 调度器也会自动执行）
  if (NIGHT_TASK_CODES.has(code) && !inNightWindow(ctx.now())) {
    logs.push(`🌙 任务 [${name}] 仅 23:00-08:00 上报计数, 当前不在窗口, 跳过 (每日 01:00 调度器自动执行, 累计 3 天)`);
    return { credit: 0, energy: 0, lit: 0, claimed: 0 };
  }

  if (status === "not_accepted" && t.taskType !== "auto") {
    // 接取没成功就上报是白费功夫：上游只对已接取的任务累计进度。
    logs.push(`⏭ 任务 [${name}] 仍未接取, 跳过 (先解决接取失败)`);
    return { credit: 0, energy: 0, lit: 0, claimed: 0 };
  }

  // 需点亮上报 —— 专家/团队事件必须使用互不相同的 id，否则上游按
  // (eventCode, id) 去重，进度永远不动。
  const need = Math.max(1, tgt - cur);
  const kind = rk.kind;
  // 「浏览资料库」走 web 域的元素点击事件（CONTRACT §7），不是 chat 域的
  // buildEvent 族 —— 日志也注明路径不同。
  if (kind === "library") {
    logs.push(`正在点亮任务 [${name}]（web 点击事件）(需上报 ${need} 次)...`);
  } else {
    logs.push(`正在点亮任务 [${name}] (需上报 ${need} 次)...`);
  }
  let reportOk = true;
  let idPool = null;
  if (kind === "expert" || kind === "team") idPool = kind === "team" ? TEAM_ID_POOL : EXPERT_ID_POOL;
  let fixedExpert = spec?.expert ?? null;
  if (!fixedExpert && rk.pinnedExpertId) {
    // 钉死/派生专家 id（CONTRACT §7）：lighthouse 的常量钉死与 expert_use_*
    // 从 jump_url 解出的 id 都走这里 —— 上游按 (eventCode,id) 去重，池子里的
    // 通用 id 对这类任务不推进进度。
    fixedExpert = [rk.pinnedExpertId, rk.expertName || name];
  }
  for (let i = 0; i < need; i++) {
    let ok;
    if (kind === "library") {
      // 资料库：每次 need 循环发一条 web 点击事件（不走 buildEvent/专家池）
      ok = await reportLibraryEvent(acct, opts);
    } else {
      let expert = fixedExpert;
      if (expert == null && idPool) {
        const [pid, pnm] = idPool[(cur + i) % idPool.length];
        expert = [pid, pnm];
      }
      const ev = buildEvent(acct, kind, i, expert, { now: ctx.now });
      ok = await reportEvents(acct, [ev], opts);
    }
    if (!ok) reportOk = false;
    if (i < need - 1) await ctx.breathe();
  }
  if (!reportOk) logs.push(`! 任务 [${name}] 部分事件上报失败 (上游拒绝), 继续尝试领奖`);
  await ctx.breathe(REPORT_SETTLE_MS);

  // 等上游把进度落账再领奖。进度通常 1-3 秒就可见，因此先快查几次；只有
  // 确实在动才继续等，免得每个卡住的任务都空等 20 秒（整轮要几分钟）。
  let prog = cur;
  for (let attempt = 0; attempt < CLAIM_POLL_ATTEMPTS; attempt++) {
    const fresh = (await fetchTasks(acct, opts)).find((x) => x.code === code) ?? null;
    if (fresh) {
      prog = fresh.progress?.current ?? 0;
      if (prog >= tgt || fresh.acceptStatus === "completed" || fresh.acceptStatus === "claimed") break;
      if (prog > cur) {
        // 已经在涨了，值得多等一会儿
        await ctx.breathe(PROGRESS_RISING_MS);
        continue;
      }
    }
    if (attempt < 2) await ctx.breathe(REPORT_SETTLE_MS);
    else break;
  }
  if (prog < tgt) {
    logs.push(`? 任务 [${name}] 已上报但进度 ${prog}/${tgt} 未达成, 领奖顺延到下次运行`);
    await ctx.breathe();
    return { credit: 0, energy: 0, lit: 0, claimed: 0 };
  }

  // 领奖
  if (!claim) {
    logs.push(`⏸ 任务 [${name}] 已点亮，等待手动领取`);
    await ctx.breathe();
    return { credit: 0, energy: 0, lit: 1, claimed: 0 };
  }
  const res = await claimTask(acct, code, opts);
  if (res.ok) {
    const cr = res.credit ?? 0;
    logs.push(`✓ 任务 [${name}] 点亮并领奖成功: +${cr} 积分`);
    await ctx.breathe();
    return { credit: cr, energy: res.energy ?? 0, lit: 1, claimed: 1 };
  }
  logs.push(`! 任务 [${name}] 进度已达 ${prog}/${tgt} 但领奖失败: ${res.reason || "未知原因"}`);
  await ctx.breathe();
  return { credit: 0, energy: 0, lit: 1, claimed: 0, ...(res.restricted ? { restricted: true } : {}) };
}

// ---- 完整流水线（wb_tasks.run_growth_tasks 的移植）---------------------------

// 任务级勾选（CONTRACT §3/§6/§7）：opts.codes 非空数组 = 只处理这些 code；
// 未传 / 空数组 / 非法类型 = 全部任务（旧行为）。这里做一层防御性归一——只留
// 非空字符串并去重（去重保序不必要，进 Set）；每个 uid 清单的去重/上限（500）
// 由 daemon 的 API 边界负责（startJob），引擎只认「非空集合 = 勾选生效」。
function selectedCodeSet(codes) {
  if (!Array.isArray(codes)) return null;
  const out = new Set();
  for (const c of codes) {
    if (typeof c === "string" && c.trim()) out.add(c.trim());
  }
  return out.size ? out : null;
}

// runGrowthTasks(acct, opts) -> GrowsResult
// opts: {gap=1000, claim=true, codes?: string[], log(fn), sleep(fn), now(fn), fetch, signal}
//   opts.codes —— 任务级勾选：非空数组时只对选中的任务接取/点亮/领奖；未选中
//   的任务完全不动作（不接取、不上报、不轮询、不领奖）。每次 fetchTasks 之后
//   都按选中集合过滤；选中但任务表里没有的 code 记一次警告并跳过，绝不硬闯。
//   空数组/未传 = 全部任务（旧行为）。
// GrowsResult: {ok, logs, earnedCredit, credit, energy, lit, claimed, restricted?}
export async function runGrowthTasks(acct, opts = {}) {
  const ctx = makeCtx(opts);
  const run = { ...opts, __ctx: ctx };
  const logs = [];
  // 人读日志既进返回值也走 opts.log（runner/面板靠 opts.log 实时收集）
  const emit = (line) => {
    logs.push(line);
    ctx.log?.(line);
  };
  // progressTask 只对数组 push：给它一个同时 emit 的代理
  const logsOut = { push: (line) => emit(line) };
  const totals = { credit: 0, energy: 0, lit: 0, claimed: 0 };
  const collect = (r) => {
    if (!r) return;
    totals.credit += r.credit || 0;
    totals.energy += r.energy || 0;
    totals.lit += r.lit || 0;
    totals.claimed += r.claimed || 0;
    return r.restricted;
  };

  if (acct.provider !== "workbuddy") {
    return { ok: false, msg: "国际版不适用国内成长任务中心", logs: [], earnedCredit: 0 };
  }
  if (acct.enterpriseId) {
    return { ok: true, msg: "企业版账号无成长体系，跳过", logs: [], earnedCredit: 0 };
  }

  emit(`开始为账号 ${acct.nickname || acct.uid.slice(0, 8)} 运行成长任务自动化...`);
  let tasks = await fetchTasks(acct, run);
  if (!tasks.length) {
    emit("未能获取到任务清单，请检查网络或账号状态");
    return { ok: false, logs, earnedCredit: 0, ...totals };
  }

  // 任务级勾选（CONTRACT §3/§6/§7）：选中集合对「整份任务表」先校验一次——
  // 选中但任务表里不存在的 code 记一次警告并跳过（绝不硬闯），随后每次
  // fetchTasks 之后都重新按集合过滤。selected=null = 未勾选，原样透传（旧行为）。
  const selected = selectedCodeSet(opts.codes);
  const scope = (list) => (selected ? list.filter((t) => selected.has(t.code)) : list);
  if (selected) {
    emit(`仅处理选中的 ${selected.size} 项任务`);
    const missing = [...selected].filter((c) => !tasks.some((t) => t.code === c));
    if (missing.length) {
      emit(
        `! 选中的 ${missing.length} 项任务不在任务表中，本轮跳过: ${missing.slice(0, 5).join(", ")}` +
        (missing.length > 5 ? " ..." : ""),
      );
    }
  }
  tasks = scope(tasks);

  // 0. auto 类任务（如 first_buddy）不需要接取，且可能是其他任务与猫猫旅行
  //    的前置：必须先把它们点亮并领奖（first_buddy 的奖励就是 Buddy 实例），
  //    否则 single 任务接取会报 "prerequisite not met: first_buddy"。
  //    只有选中的任务才进这一步（tasks 已按勾选过滤）。
  for (const t of tasks) {
    if (t.taskType === "auto") {
      if (collect(await progressTask(acct, t, logsOut, run))) {
        return { ok: false, restricted: true, logs, earnedCredit: totals.credit, ...totals };
      }
    }
  }

  // 1. 批量接取未接任务（auto 类不接受接取，unforgeable 无法自动化）
  const needsAccept = (x) =>
    x.acceptStatus === "not_accepted" && !x.unforgeable && x.taskType !== "auto";

  const unaccepted = tasks.filter(needsAccept).map((t) => t.code);
  if (unaccepted.length) {
    emit(`发现 ${unaccepted.length} 个待接取任务，正在批量接取...`);
    const acc = await acceptTasks(acct, unaccepted, run);
    if (acc.restricted) {
      return { ok: false, restricted: true, logs, earnedCredit: totals.credit, ...totals };
    }
    if (acc.failed.length) {
      const why = acc.msg || (acc.reasons ?? []).join("; ").slice(0, 160);
      emit(
        `! 接取未成功 ${acc.failed.length} 个: ${acc.failed.slice(0, 5).join(", ")}` +
        (acc.failed.length > 5 ? " ..." : "") +
        (why ? ` (${why})` : ""),
      );
    }
    if (acc.accepted.length) emit(`✓ 已接取 ${acc.accepted.length} 个任务`);
    await ctx.breathe();
    // 复核一次：上游偶尔会瞬时拒绝整个批次，复查后仍处于未接取的再补一次，
    // 否则后面所有上报都作用在未接取的任务上 —— 进度全是 0。
    // 「清单拉空」按**过滤前**的整表判断（勾选过滤后为空是正常现象，不是拉取失败）。
    let refetched = await fetchTasks(acct, run);
    if (!refetched.length) {
      emit("! 接取后无法获取任务清单，本轮中止");
      return { ok: false, logs, earnedCredit: totals.credit, ...totals };
    }
    tasks = scope(refetched);
    const still = tasks.filter(needsAccept).map((t) => t.code);
    if (still.length) {
      emit(`仍有 ${still.length} 个未接取，重试接取一次...`);
      const retry = await acceptTasks(acct, still, run);
      if (retry.restricted) {
        return { ok: false, restricted: true, logs, earnedCredit: totals.credit, ...totals };
      }
      if (retry.accepted.length) emit(`✓ 重试接取成功 ${retry.accepted.length} 个`);
      await ctx.breathe();
      refetched = await fetchTasks(acct, run);
      if (!refetched.length) {
        emit("! 接取后无法获取任务清单，本轮中止");
        return { ok: false, logs, earnedCredit: totals.credit, ...totals };
      }
      tasks = scope(refetched);
    }
    const stillPending = tasks.filter(needsAccept).map((t) => t.code);
    if (stillPending.length) {
      emit(`! 仍有 ${stillPending.length} 个任务处于未接取状态，对未接取任务上报事件不会计入进度，本轮跳过这些任务`);
    }
  }

  // 2. 处理每个任务（auto 已在第 0 步处理过；tasks 仍是选中集合的投影）
  for (const t of tasks) {
    if (t.taskType === "auto") continue;
    if (collect(await progressTask(acct, t, logsOut, run))) {
      return { ok: false, restricted: true, logs, earnedCredit: totals.credit, ...totals };
    }
  }

  // 3. 顺手检查猫猫旅行
  const trRes = await runCatTravel(acct, run);
  if (trRes.msg) {
    emit(`猫猫日常: ${trRes.msg}`);
    if (trRes.credit) totals.credit += trRes.credit;
  }
  if (trRes.restricted) {
    return { ok: false, restricted: true, logs, earnedCredit: totals.credit, ...totals };
  }

  // 4. 结算（hub 会顺带刷新积分余额，这里以能量余额回显代之）
  const energy = await fetchEnergy(acct, run);
  emit(`🎉 全部完成！本次累计新增到账: +${totals.credit} 积分（当前能量 ${energy}）`);
  return { ok: true, logs, earnedCredit: totals.credit, ...totals };
}

// ---- 内部小工具 ----------------------------------------------------------------

function chatUrl(opts = {}) {
  const fromOpts = String(opts.base || opts.bases?.chat || "").trim();
  return fromOpts ? fromOpts.replace(/\/+$/, "") : _growthBase(opts.env ?? globalThis.process?.env ?? {});
}
function billUrl() {
  return _billBase();
}
function webUrl_() {
  return _webBase();
}
