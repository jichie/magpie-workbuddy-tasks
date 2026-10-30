import { test } from "node:test";
import assert from "node:assert/strict";

import { runGrowthTasks, acceptTasks } from "../engine/tasks.mjs";
import { fakeClock, localTime, makeAcct, task, wbBackend } from "./helpers.mjs";

const GAP = 1000;

function collectLog() {
  const logs = [];
  const steps = [];
  const fn = (line) => {
    if (typeof line === "string") logs.push(line);
    else steps.push(line);
  };
  return { logs, steps, fn };
}

const seedTasks = () => [
  task("first_buddy", { task_type: "auto", reward: 300, target: 1 }),
  task("create_canvas", { reward: 300 }),
  task("expert_5", { reward: 200, target: 5 }),
  task("chat_5", { reward: 100, target: 5, status: "accepted" }),
  task("RichMeow_Chat", { reward: 100, jump_url: "workbuddy://chat" }),
  task("black_cat", { reward: 100, target: 3 }),
];

const litRules = {
  chat_request_send: ["first_buddy", "chat_5"],
  wbx_design_canvas_task_create: "create_canvas",
  expert_actual_use: "expert_5",
};

function fullRun(overrides = {}) {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0)); // 本地 10:00，非夜间
  const backend = wbBackend({ clock, tasks: seedTasks(), litRules, ...overrides });
  const { logs, steps, fn } = collectLog();
  const acct = makeAcct({ uid: "uid-A" });
  const promise = runGrowthTasks(acct, {
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
    log: fn,
    gap: GAP,
  });
  return { clock, backend, logs, steps, acct, promise };
}

test("流水线：完整一轮（点亮、接取、领奖的顺序与结算）", async () => {
  const { backend, logs, promise } = fullRun();
  const result = await promise;

  assert.equal(result.ok, true, logs.join("\n"));
  assert.equal(result.earnedCredit, 300 + 300 + 200 + 100);
  assert.equal(result.lit, 4);
  assert.equal(result.claimed, 4);
  // 结算行里带回能量余额
  assert.ok(logs.join("\n").includes("当前能量 42"), logs.join("\n"));

  const calls = backend.calls;
  const idx = (pred) => calls.findIndex(pred);
  const firstReport = idx((c) => c.path === "/v2/report");
  const firstAccept = idx((c) => c.path === "/v2/activity/growth/tasks/accept");
  const firstClaim = idx((c) => c.path.endsWith("/claim"));

  // auto 任务先点亮再领奖，都发生在批量接取之前（first_buddy 是前置）
  assert.ok(firstReport >= 0 && firstAccept >= 0 && firstClaim >= 0);
  assert.ok(firstReport < firstAccept, "auto 任务上报应先于接取");
  assert.ok(firstClaim < firstAccept, "first_buddy 领奖应先于接取");
  assert.equal(calls[firstClaim].path, "/activity/growth/tasks/first_buddy/claim");

  // 接取批次：20 上限内一批；不含 auto / 已接取
  const acceptBodies = calls.filter((c) => c.path === "/v2/activity/growth/tasks/accept").map((c) => c.body);
  assert.equal(acceptBodies.length, 1);
  assert.deepEqual(acceptBodies[0].task_codes, ["create_canvas", "expert_5", "RichMeow_Chat", "black_cat"]);
  assert.ok(!acceptBodies[0].task_codes.includes("first_buddy"), "auto 任务不进接取批次");
  assert.ok(!acceptBodies[0].task_codes.includes("chat_5"), "已接取的不重接");
  assert.equal(backend.state.acceptCalls, 1, "复查后无遗漏 → 不二次补接");

  // 专家事件：5 次上报、5 个互不相同的 id、都带 userId
  const expertReports = backend.state.reports.filter((e) => e.eventCode === "expert_actual_use");
  assert.equal(expertReports.length, 5);
  assert.equal(new Set(expertReports.map((e) => e.id)).size, 5, "(eventCode,id) 去重 → id 必须轮换");
  for (const e of backend.state.reports) assert.ok(e.userId, "事件缺 userId（服务端会静默丢弃）");

  // 领奖都发生在进度到位之后（假后端只在达标时给领奖成功），且顺序正确
  assert.deepEqual(backend.state.claims, ["first_buddy", "create_canvas", "expert_5", "chat_5"]);

  // DESKTOP_ONLY：进了接取批次（Python 口径），但绝不伪造事件
  assert.ok(logs.join("\n").includes("桌面对话事件链"), logs.join("\n"));
  assert.ok(!backend.state.claims.includes("RichMeow_Chat"));
  const richmeow = backend.state.tasks.find((t) => t.task_code === "RichMeow_Chat");
  assert.equal(richmeow.accept_status, "accepted"); // 接上了但没点亮

  // 夜猫子：10:00 不在窗口 → 诚实跳过
  assert.ok(logs.join("\n").includes("23:00-08:00"));
  const blackCat = backend.state.tasks.find((t) => t.task_code === "black_cat");
  assert.equal(blackCat.accept_status, "accepted");
  assert.equal(backend.state.reports.filter((e) => e.mode === "night").length, 0);
});

test("流水线：任意两次上游调用间隔 ≥ 1000ms（假时钟断言）", async () => {
  const { backend, promise } = fullRun();
  await promise;
  const calls = backend.calls;
  assert.ok(calls.length > 10, `应有大量上游调用，实际 ${calls.length}`);
  for (let i = 1; i < calls.length; i++) {
    const delta = calls[i].at - calls[i - 1].at;
    assert.ok(delta >= GAP, `第 ${i - 1}→${i} 次调用间隔 ${delta}ms < ${GAP}ms: ${calls[i - 1].path} → ${calls[i].path}`);
  }
});

test("流水线：整批接取被瞬时拒绝 → 复查后二次补接", async () => {
  const { backend, logs, promise } = fullRun({ failAcceptOnce: true });
  const result = await promise;
  assert.equal(result.ok, true);
  assert.equal(backend.state.acceptCalls, 2);
  const text = logs.join("\n");
  assert.ok(text.includes("重试接取一次"));
  assert.ok(text.includes("重试接取成功 4 个"));
  assert.ok(text.includes("接取未成功 4 个"));
});

test("流水线：接取批次上限 20 个一批", async () => {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const tasks = Array.from({ length: 25 }, (_, i) => task(`bulk_${i}`, { reward: 1 }));
  const backend = wbBackend({ clock, tasks, litRules: {} });
  const acct = makeAcct();
  const out = await acceptTasks(acct, tasks.map((t) => t.task_code), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
  });
  assert.equal(out.ok, true);
  assert.equal(out.accepted.length, 25);
  assert.equal(backend.state.acceptCalls, 2);
  const bodies = backend.calls.filter((c) => c.path === "/v2/activity/growth/tasks/accept").map((c) => c.body);
  assert.equal(bodies[0].task_codes.length, 20);
  assert.equal(bodies[1].task_codes.length, 5);
  // 批与批之间也有 ≥1s 间隔
  const acceptCalls = backend.calls.filter((c) => c.path === "/v2/activity/growth/tasks/accept");
  assert.ok(acceptCalls[1].at - acceptCalls[0].at >= GAP);
});

test("流水线：进度未落账 → 领奖顺延（不硬闯）", async () => {
  // litRules 里不给 chat 对应规则：上报后进度永远不动
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const backend = wbBackend({
    clock,
    tasks: [task("chat_5", { reward: 100, target: 5, status: "accepted" })],
    litRules: {}, // 无规则 → 上报不计进度
  });
  const { fn } = { fn: () => {} };
  const logs = [];
  const result = await runGrowthTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
    log: (l) => typeof l === "string" && logs.push(l),
  });
  assert.equal(result.ok, true);
  assert.equal(result.earnedCredit, 0);
  assert.equal(backend.state.claims.length, 0);
  assert.ok(logs.join("\n").includes("领奖顺延到下次运行"));
  // 轮询节奏（hub 口径）：1 次初始 + 3 次轮询（attempt<2 两次；第 3 次探测后 break）
  const taskCalls = backend.calls.filter((c) => c.path === "/v2/activity/growth/tasks");
  assert.equal(taskCalls.length, 4);
});

test("流水线：已完成的任务直接领奖（不重复点亮）", async () => {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const backend = wbBackend({
    clock,
    tasks: [task("skill_1", { reward: 100, status: "completed", current: 1, target: 1 })],
    litRules: { skill_info: "skill_1" },
  });
  const logs = [];
  const result = await runGrowthTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
    log: (l) => typeof l === "string" && logs.push(l),
  });
  assert.equal(result.ok, true);
  assert.equal(result.earnedCredit, 100);
  assert.ok(logs.join("\n").includes("领奖成功: +100 积分"));
  assert.equal(backend.state.reports.length, 0, "已完成任务不再上报事件");
});

test("流水线：claim=false 只点亮不领奖", async () => {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const backend = wbBackend({
    clock,
    tasks: [task("create_canvas", { reward: 300 })],
    litRules: { wbx_design_canvas_task_create: "create_canvas" },
  });
  const logs = [];
  const result = await runGrowthTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
    log: (l) => typeof l === "string" && logs.push(l),
    claim: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.earnedCredit, 0);
  assert.equal(backend.state.claims.length, 0);
  const t = backend.state.tasks.find((x) => x.task_code === "create_canvas");
  assert.equal(t.accept_status, "completed"); // 点亮了
  assert.ok(logs.join("\n").includes("等待手动领取"));
});

test("流水线：国际版与企业号直接跳过", async () => {
  const intl = await runGrowthTasks(makeAcct({ provider: "workbuddy-ai" }), { fetch: async () => { throw new Error("no network"); } });
  assert.equal(intl.ok, false);
  assert.match(intl.msg, /国际版/);
  const ent = await runGrowthTasks(makeAcct({ enterpriseId: "ent-1" }), { fetch: async () => { throw new Error("no network"); } });
  assert.equal(ent.ok, true);
  assert.match(ent.msg, /企业版/);
});

test("流水线：任务清单拉不到 → 失败收场", async () => {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const backend = wbBackend({ clock, tasks: [], litRules: {} });
  const result = await runGrowthTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.ok(result.logs.join("\n").includes("未能获取到任务清单"));
});
