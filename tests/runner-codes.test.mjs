// tests/runner-codes.test.mjs —— JobRunner 的任务级勾选（CONTRACT §2/§3）回归：
// spec.taskCodes = {uid: string[]} | null；growth 腿把它按账号作为 opts.codes
// 传给 runGrowthTasks（未勾选/不在映射/空清单 = 全部任务）；travel/night 腿无
// 任务码，不受影响。归一化防御（脏输入 → null）也在这里钉死。

import { test } from "node:test";
import assert from "node:assert/strict";

import { JobRunner } from "../engine/runner.mjs";
import { fakeClock, localTime, makeAcct, task, wbBackend } from "./helpers.mjs";

const DAY = localTime(2026, 9, 15, 10, 0);

function twoAccounts() {
  return [
    makeAcct({ key: "workbuddy", uid: "uid-A", nickname: "A" }),
    makeAcct({ key: "workbuddy#b", uid: "uid-B", nickname: "B" }),
  ];
}

function backendFor(clock, litRules = {}) {
  return wbBackend({
    clock,
    tasks: [
      task("create_canvas", { reward: 300 }),
      task("chat_5", { reward: 100, target: 5, status: "accepted" }),
    ],
    litRules,
  });
}

test("runner：taskCodes 按 uid 分流 —— 映射内的账号只做选中任务，映射外的全量", async () => {
  const clock = fakeClock(DAY);
  const backendA = backendFor(clock, { wbx_design_canvas_task_create: "create_canvas", chat_request_send: "chat_5" });
  const backendB = backendFor(clock, { wbx_design_canvas_task_create: "create_canvas", chat_request_send: "chat_5" });
  const fetch = (url, init = {}) =>
    init.headers?.["X-User-Id"] === "uid-B" ? backendB.fetchImpl(url, init) : backendA.fetchImpl(url, init);
  const runner = new JobRunner({
    accounts: twoAccounts(),
    now: clock.now,
    sleep: clock.sleep,
    fetch,
  });
  const job = runner.start({ legs: ["growth"], taskCodes: { "uid-A": ["create_canvas", "chat_5"] } });
  const done = await runner.wait(job.id);
  assert.equal(done.state, "done");

  assert.deepEqual(done.spec.taskCodes, { "uid-A": ["create_canvas", "chat_5"] }, "spec 原样携带归一后的 taskCodes");

  // A：只处理选中的两个任务（create_canvas 接取+点亮、chat_5 点亮）
  assert.deepEqual(backendA.state.claims, ["create_canvas", "chat_5"]);
  assert.ok(
    backendA.state.reports.every((e) => ["chat_request_send", "wbx_design_canvas_task_create"].includes(e.eventCode)),
    "A 不该有专家等其它事件",
  );

  // B：不在映射里 = 全部任务（旧行为：first_buddy 不在任务表，接取批次只含 create_canvas）
  const acceptB = backendB.calls.filter((c) => c.path === "/v2/activity/growth/tasks/accept").map((c) => c.body);
  assert.deepEqual(acceptB[0].task_codes, ["create_canvas"]);
  assert.deepEqual(backendB.state.claims, ["create_canvas", "chat_5"]);
});

test("runner：travel 腿不携带 codes（任务级勾选只作用于 growth 腿）", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({ clock, tasks: [task("create_canvas", { reward: 300 })], litRules: {} });
  const runner = new JobRunner({
    accounts: [makeAcct()],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  // 只跑 travel 腿：勾选存在也不该影响 travel（runCatTravel 不吃 codes，
  // 这里通过「travel 照常闭环」与 growth 腿未运行来验证分流）
  const job = runner.start({ legs: ["travel"], taskCodes: { "u-12345678": ["create_canvas"] } });
  const done = await runner.wait(job.id);
  assert.equal(done.state, "done");
  assert.equal(done.steps[0].leg, "travel");
  assert.equal(done.steps[0].state, "ok");
  // growth 腿没跑：没有任何任务接取/领奖
  assert.equal(backend.state.claims.length, 0);
});

test("runner：taskCodes 归一化 —— 脏输入全部落到 null（= 全部任务）", async () => {
  const clock = fakeClock(DAY);
  const cases = [
    null,
    undefined,
    "uid-A",
    ["create_canvas"],
    42,
    {},
    { "uid-A": [] },
    { "": ["create_canvas"] },
    { "uid-A": "create_canvas" },
    { "uid-A": [123, null, ""] },
  ];
  for (const taskCodes of cases) {
    const runner = new JobRunner({ accounts: [], now: clock.now, sleep: clock.sleep });
    const job = runner.start({ legs: ["growth"], taskCodes });
    assert.equal(
      job.spec.taskCodes,
      null,
      `taskCodes=${JSON.stringify(taskCodes)} 应归一成 null`,
    );
    await runner.wait(job.id);
  }
  // 值清洗：去重、剔非字符串、留非空字符串
  const runner2 = new JobRunner({ accounts: [], now: clock.now, sleep: clock.sleep });
  const job2 = runner2.start({
    legs: ["growth"],
    taskCodes: { "uid-A": ["create_canvas", "create_canvas", "", null, 7, " chat_5 "] },
  });
  assert.deepEqual(job2.spec.taskCodes, { "uid-A": ["create_canvas", "chat_5"] });
  await runner2.wait(job2.id);
});

test("runner：taskCodes 清单上限 500（与 daemon 的 API 边界同款）", () => {
  const clock = fakeClock(DAY);
  const runner = new JobRunner({ accounts: [], now: clock.now, sleep: clock.sleep });
  const big = Array.from({ length: 600 }, (_, i) => `code_${i}`);
  const job = runner.start({ legs: ["growth"], taskCodes: { "uid-A": big } });
  assert.equal(job.spec.taskCodes["uid-A"].length, 500);
  void clock;
});
