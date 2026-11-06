// tests/taskkind-pipeline.test.mjs —— kind 解析接进流水线（P0-1）的回归：
//   1. 派生专家任务（expert_use_*，TASK_SPECS 之外、jump_url 带真实专家 id）
//      全流程：批量接取 → 用解析出的 id 上报 expert_actual_use → 领奖 +50/+5；
//   2. 真实形态 19 项 + 1 项未收录：批量接取的 codes 与 canAccept 收敛结论
//      完全一致；未收录任务绝不进批次、绝不伪造事件（防「接了一大堆却一项
//      不亮、领奖报 task not completed」）。
// 全程零真实网络（wbBackend 假后端，进度/领奖都是活状态）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchTasks, runGrowthTasks } from "../engine/tasks.mjs";
import { resolveTaskKind } from "../engine/taskkind.mjs";
import { fakeClock, localTime, makeAcct, task, wbBackend } from "./helpers.mjs";

const GAP = 1000;

const jumpOf = (id) =>
  `https://www.workbuddy.cn/work/launch/?deeplink=workbuddy%3A%2F%2Fexperts%3FexpertId%3D${id}&buddy_type=workbuddy`;

function collectLog() {
  const logs = [];
  const fn = (line) => typeof line === "string" && logs.push(line);
  return { logs, fn };
}

// 真实形态的 expert_use_* 种子（容器实测：not_accepted、progress null、50 积分 + 5 能量）。
const derivedSeed = (code, title, id) => ({
  task_code: code,
  title,
  description: "",
  jump_url: jumpOf(id),
  accept_status: "not_accepted",
  task_type: "single",
  reward_credit: 50,
  reward_energy: 5,
  progress: null,
});

test("流水线：expert_use_maidehao 全流程 —— 接取 → 钉解析出的专家 id 点亮 → 领奖 +50/+5", async () => {
  const clock = fakeClock(localTime(2026, 10, 31, 10, 0));
  const backend = wbBackend({
    clock,
    tasks: [derivedSeed("expert_use_maidehao", "体验「中国电商运营专家」", "ex_GDl31WahyIH0")],
    litRules: { expert_actual_use: "expert_use_maidehao" },
  });
  const { logs, fn } = collectLog();
  const res = await runGrowthTasks(makeAcct({ uid: "uid-derived" }), {
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
    log: fn,
    gap: GAP,
  });

  assert.equal(res.ok, true, logs.join("\n"));
  assert.equal(res.earnedCredit, 50, "reward 50 积分（真实形态）");
  assert.equal(res.energy, 5, "reward 5 能量");
  assert.equal(res.lit, 1);
  assert.equal(res.claimed, 1);

  // 接取批次里只有它
  const acceptBodies = backend.calls
    .filter((c) => c.path === "/v2/activity/growth/tasks/accept")
    .map((c) => c.body);
  assert.deepEqual(acceptBodies[0].task_codes, ["expert_use_maidehao"]);

  // 事件：expert_actual_use、id 钉死在 jump_url 解出的专家上（上游按
  // (eventCode,id) 去重 —— 池子里的通用 id 对这个任务不推进进度）。
  const reports = backend.state.reports;
  assert.equal(reports.length, 1);
  const ev = reports[0];
  assert.equal(ev.eventCode, "expert_actual_use");
  assert.equal(ev.id, "ex_GDl31WahyIH0", "事件 id = jump_url 派生的真实专家 id");
  assert.equal(ev.expertType, "agent");
  assert.equal(ev.name, "中国电商运营专家", "专家名取自任务标题「」内");
  assert.equal(ev.expertTitle, "中国电商运营专家");
  assert.ok(ev.userId, "事件必带 userId");
  assert.ok(ev.conversationId && ev.requestId, "沿用 expert_actual_use 的形状");

  assert.deepEqual(backend.state.claims, ["expert_use_maidehao"]);
  assert.ok(logs.join("\n").includes("领奖成功: +50 积分"), logs.join("\n"));
});

// 真实 19 项（容器实测的任务码/状态/奖励/深链形态；状态取两账号并集里的真实值，
// wb_wechat 取 not_accepted 形态以覆盖「unforgeable 挡在批次外」这条路径）。
const REAL_19 = () => [
  task("playbook_prompt", { title: "探索优秀灵感", status: "claimed", current: 1, target: 1, reward: 100, reward_energy: 5, jump_url: "workbuddy://playbook" }),
  task("RichMeow_Chat", { title: "桌面端对话1次", status: "claimed", current: 1, target: 1, reward: 100, reward_energy: 5, jump_url: "workbuddy://chat" }),
  task("Library_read", { title: "体验「资料库」", status: "accepted", current: 0, target: 1, reward: 100, reward_energy: 5, jump_url: "workbuddy://library" }),
  task("Expert_lighthouse", { title: "体验「腾讯轻量云」专家", status: "claimed", current: 1, target: 1, reward: 100, reward_energy: 5, jump_url: "workbuddy://expert" }),
  task("Hp_Appearance", { title: "体验「和平精英」主题", status: "claimed", current: 1, target: 1, reward: 100, reward_energy: 5, jump_url: "workbuddy://settings/appearance" }),
  task("Buddy_App", { title: "体验 WorkBuddy 「发现应用」", status: "accepted", current: 0, target: 1, reward: 100, reward_energy: 5, jump_url: "workbuddy://home?openBuddySwitcher=true" }),
  task("wb_wechat_oa_subscribe_task", { title: "关注「腾讯 WorkBuddy」官方公众号", status: "not_accepted", current: 0, target: 1, reward: 100, reward_energy: 5, jump_url: "https://www.workbuddy.cn/events/follow-guide/" }),
  task("WorkBuddy_Valorant", { title: "体验「无畏契约拼豆专家」", status: "not_accepted", reward: 100, reward_energy: 5, jump_url: "workbuddy://expert" }),
  derivedSeed("expert_use_maidehao", "体验「中国电商运营专家」", "ex_GDl31WahyIH0"),
  derivedSeed("expert_use_douyinyin", "体验「抖音策略师」", "ex_FbY5nlWTqDod"),
  derivedSeed("expert_use_shangjia_xuanchuan", "体验「商家宣传页与海报设计师」", "ex_Weo3x2EZuSDm"),
  derivedSeed("expert_use_bowangwang", "体验「直播电商教练」", "ex_WZY136wV5aMt"),
  task("Expert_team_use_3", { title: "召唤 3 次专家团", status: "claimed", current: 3, target: 3, reward: 100, reward_energy: 5, jump_url: "workbuddy://experts" }),
  task("first_buddy", { title: "领取一只 Buddy", status: "claimed", current: 1, target: 1, reward: 300, reward_energy: 8, task_type: "auto", jump_url: "workbuddy://chat" }),
  task("chat_5", { title: "和 AI 聊天 5 次", status: "claimed", current: 5, target: 5, reward: 100, reward_energy: 5, jump_url: "workbuddy://chat" }),
  task("skill_1", { title: "尝鲜热门技能", status: "claimed", current: 1, target: 1, reward: 100, reward_energy: 5, jump_url: "workbuddy://skills" }),
  task("expert_5", { title: "召唤 5 次专家", status: "claimed", current: 5, target: 5, reward: 100, reward_energy: 5, jump_url: "workbuddy://expert" }),
  task("template_5", { title: "使用 5 个模板", status: "claimed", current: 5, target: 5, reward: 100, reward_energy: 5, jump_url: "workbuddy://templates" }),
  task("automation_1", { title: "设置自动化任务", status: "claimed", current: 1, target: 1, reward: 100, reward_energy: 5, jump_url: "workbuddy://automation" }),
];

test("流水线：19 项真实形态 + 1 项未收录 —— 接取批次 codes 与 canAccept 收敛结论一致", async () => {
  const clock = fakeClock(localTime(2026, 10, 31, 10, 0));
  const tasks20 = [...REAL_19(), task("brand_new_task", { title: "brand_new_task", jump_url: "workbuddy://future-thing" })];
  const backend = wbBackend({ clock, tasks: tasks20, litRules: {} });
  const opts = { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP, log: () => {} };
  const acct = makeAcct({ uid: "uid-19" });

  // 引擎在动任何状态之前先给一遍收敛结论（与 daemon.snapTask 下发字段同源）
  const before = await fetchTasks(acct, opts);
  assert.equal(before.length, 20);
  const canAcceptCodes = before.filter((t) => resolveTaskKind(t).canAccept).map((t) => t.code);
  assert.deepEqual(canAcceptCodes, [
    "WorkBuddy_Valorant",
    "expert_use_maidehao",
    "expert_use_douyinyin",
    "expert_use_shangjia_xuanchuan",
    "expert_use_bowangwang",
  ]);

  const { logs, fn } = collectLog();
  const res = await runGrowthTasks(acct, { ...opts, log: fn });

  assert.equal(res.ok, true, logs.join("\n"));
  const batchCodes = backend.calls
    .filter((c) => c.path === "/v2/activity/growth/tasks/accept")
    .flatMap((c) => c.body.task_codes);
  assert.deepEqual(batchCodes, canAcceptCodes, "批量接取的 codes 必须与 canAccept 收敛结论逐项一致");

  // cannot-accept 项绝不进批次
  for (const banned of [
    "wb_wechat_oa_subscribe_task", // unforgeable
    "brand_new_task", // 未收录且派生不出
    "first_buddy", // auto
    "Library_read", // accepted（状态挡；点亮走 web 点击，不走接取）
    "Buddy_App", // accepted（状态挡）
    "chat_5", // claimed（状态挡）
  ]) {
    assert.ok(!batchCodes.includes(banned), `${banned} 不得进接取批次`);
  }

  // 未收录任务：零接取、零上报、有诚实日志
  const text = logs.join("\n");
  assert.ok(text.includes("未收录任务"), text);
  assert.ok(!backend.state.claims.includes("brand_new_task"));
  assert.ok(!backend.state.claims.includes("wb_wechat_oa_subscribe_task"));

  // 点亮阶段上报的事件：5 个专家 id 全部钉对（Valorant 钉死常量 + 4 个派生），
  // 没有任何池子通用 id 混进来。
  const expertEvents = backend.state.reports.filter((e) => e.eventCode === "expert_actual_use");
  assert.deepEqual(
    [...new Set(expertEvents.map((e) => e.id))].sort(),
    [
      "ex_FbY5nlWTqDod",
      "ex_GDl31WahyIH0",
      "ex_WZY136wV5aMt",
      "ex_Weo3x2EZuSDm",
      "ex_xQHHD1u5Jkua",
    ],
  );
  const byId = new Map(expertEvents.map((e) => [e.id, e]));
  assert.equal(byId.get("ex_xQHHD1u5Jkua").name, "无畏契约拼豆专家");
  assert.equal(byId.get("ex_GDl31WahyIH0").name, "中国电商运营专家");
  assert.equal(byId.get("ex_FbY5nlWTqDod").name, "抖音策略师");
  assert.equal(byId.get("ex_Weo3x2EZuSDm").name, "商家宣传页与海报设计师");
  assert.equal(byId.get("ex_WZY136wV5aMt").name, "直播电商教练");
  for (const e of expertEvents) {
    assert.equal(e.expertType, "agent");
    assert.ok(e.userId);
  }
  // 未收录/unforgeable/claimed 的任务零上报；Library_read（accepted）走 web
  // 点击事件；Buddy_App（accepted）走 5 条 buddyapp_* 桌面事件链。
  assert.equal(expertEvents.length, 5);
  const libEvents = backend.state.reports.filter((e) => e.eventCode === "web_element_click");
  assert.equal(libEvents.length, 1, "Library_read 恰好发一条 web 点击事件");
  assert.equal(libEvents[0].elementId, "library_doc_intro_click");
  const buddyEvents = backend.state.reports.filter((e) => String(e.eventCode).startsWith("buddyapp_"));
  assert.equal(buddyEvents.length, 5, "Buddy_App 一次上报 5 条事件");
  assert.equal(backend.state.reports.length, 11, "5 个专家 + 1 条资料库 + 5 条 Buddy 链");
  // Library_read 的事件打 web 域（www.workbuddy.cn/v2/report），不是 chat 域
  const libReportCall = backend.calls.find((c) => c.path === "/v2/report" && String(c.body?.[0]?.eventCode) === "web_element_click");
  assert.ok(libReportCall, "web 点击事件确有发出");
  assert.equal(libReportCall.host, "www.workbuddy.cn", "Library_read 事件必须打 web 域");
  // 没进度就不硬闯：领奖全部顺延（litRules 为空，web 点击也不推进）
  assert.equal(backend.state.claims.length, 0);
  assert.ok(text.includes("领奖顺延到下次运行"));
});
