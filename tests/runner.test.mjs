import { test } from "node:test";
import assert from "node:assert/strict";

import { RESTRICTED_COOLDOWN_MS } from "../engine/constants.mjs";
import { JobRunner } from "../engine/runner.mjs";
import { fakeClock, localTime, makeAcct, task, wbBackend } from "./helpers.mjs";

const DAY = localTime(2026, 9, 15, 10, 0);

function twoAccounts() {
  return [
    makeAcct({ key: "workbuddy", uid: "uid-A", nickname: "A" }),
    makeAcct({ key: "workbuddy#b", uid: "uid-B", nickname: "B" }),
  ];
}

function simpleBackend(clock, overrides = {}) {
  return wbBackend({
    clock,
    tasks: [task("first_buddy", { task_type: "auto", reward: 300 }), task("create_canvas", { reward: 300 })],
    litRules: {
      chat_request_send: "first_buddy",
      wbx_design_canvas_task_create: "create_canvas",
    },
    ...overrides,
  });
}

test("runner：完整 job（两账号 × growth 腿），状态与结算", async () => {
  const clock = fakeClock(DAY);
  // 每个账号一个独立后端（上游状态本来就按账号隔离）
  const backendA = simpleBackend(clock);
  const backendB = simpleBackend(clock);
  const fetch = (url, init = {}) =>
    init.headers?.["X-User-Id"] === "uid-B" ? backendB.fetchImpl(url, init) : backendA.fetchImpl(url, init);
  const saved = [];
  const runner = new JobRunner({
    accounts: twoAccounts(),
    now: clock.now,
    sleep: clock.sleep,
    fetch,
    saveRefresh: (key, patch) => saved.push([key, patch]),
  });
  const job = runner.start({ legs: ["growth"] });
  assert.ok(["queued", "running"].includes(job.state));
  const done = await runner.wait(job.id);

  assert.equal(done.state, "done");
  assert.ok(done.endedAt > done.startedAt);
  assert.equal(done.steps.length, 2);
  for (const step of done.steps) {
    assert.equal(step.leg, "growth");
    assert.equal(step.state, "ok");
    assert.equal(step.credit, 600);
    assert.ok(step.nickname);
    assert.ok(step.at >= done.startedAt);
  }
  assert.deepEqual(done.uids ?? done.spec.uids, null);
  assert.equal(done.totals.credit, 1200);
  // 每日活跃（CONTRACT §7）在开跑前先发一条 chat 事件：litRules 里 chat_request_send
  // 对应 first_buddy，两个账号的 first_buddy 被「每日活跃」提前点亮为 completed，
  // growth 腿直接领奖（claimed 不变、lit 各少 1）—— 4 → 2 是预期移动，不是回归。
  assert.equal(done.totals.tasksLit, 2);
  assert.equal(done.totals.tasksClaimed, 4);
  assert.ok(done.log.some((l) => l.includes("开始为账号")));
  assert.ok(done.log.some((l) => l.includes("每日活跃：已上报")), done.log.join("\n"));
  // 每日活跃打计费域且先于腿（每个账号 job 开始前的固定动作）
  for (const be of [backendA, backendB]) {
    const dailyCalls = be.calls.filter((c) => c.host === "www.codebuddy.cn" && c.path === "/v2/report");
    assert.equal(dailyCalls.length, 1, "每账号一条每日活跃（同北京日首发）");
    assert.equal(be.calls[0].path, "/v2/report", "腿的任何调用之前先发每日活跃");
    assert.equal(be.calls[0].host, "www.codebuddy.cn");
  }
  assert.equal(saved.length, 0, "token 未临期不刷新");
  // 两账号之间 1.5s（manual）
  const aSteps = done.steps.filter((s) => s.uid === "uid-A");
  const bSteps = done.steps.filter((s) => s.uid === "uid-B");
  assert.ok(bSteps[0].at - aSteps.at(-1).at >= 1500);
});

test("runner：job 顶层 trigger = 归一后的 spec.trigger（schedule|manual；非法值按 manual）", async () => {
  const clock = fakeClock(DAY);
  const backend = simpleBackend(clock);
  const runner = new JobRunner({
    accounts: twoAccounts(),
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  // 排程口径（daemon.checkScheduler → startJob 传 trigger:"schedule"）
  const scheduled = runner.start({ legs: ["growth"], trigger: "schedule" });
  assert.equal(scheduled.trigger, "schedule", "顶层 trigger 直接可读（/api/jobs、看板不必钻 spec）");
  assert.equal(scheduled.spec.trigger, "schedule");
  assert.equal(scheduled.trigger, scheduled.spec.trigger, "顶层与 spec 永远一致（同一份归一值）");
  await runner.wait(scheduled.id);

  // 缺省 = manual（daemon 手动 /api/run 不传 trigger）
  const manual = runner.start({ legs: ["growth"] });
  assert.equal(manual.trigger, "manual");
  assert.equal(manual.spec.trigger, "manual");
  await runner.wait(manual.id);

  // 非法值：normalizeSpec 兜底成 manual，绝不透出第三种拼写
  const bogus = runner.start({ legs: ["growth"], trigger: "bogus" });
  assert.equal(bogus.trigger, "manual");
  assert.equal(bogus.spec.trigger, "manual");
  await runner.wait(bogus.id);
});

test("runner：两个 start() → 第二个 409", async () => {
  const clock = fakeClock(DAY);
  const backend = simpleBackend(clock);
  let releaseGap;
  const gate = new Promise((resolve) => {
    releaseGap = resolve;
  });
  let gated = false;
  const runner = new JobRunner({
    accounts: twoAccounts(),
    now: clock.now,
    fetch: backend.fetchImpl,
    sleep: async (ms) => {
      await clock.sleep(ms);
      if (ms >= 1500) {
        gated = true; // 卡在账号间隔上，job 保持 running
        await gate;
      }
    },
  });
  const job1 = runner.start({ legs: ["growth"] });
  // 等 job1 跑完账号 A 并卡在账号间隔
  for (let i = 0; i < 200 && !gated; i++) await new Promise((r) => setImmediate(r));
  assert.ok(gated, "job1 应该正卡在账号间隔上");
  assert.equal(runner.current().id, job1.id);
  assert.throws(() => runner.start({ legs: ["growth"] }), (err) => err.status === 409 && err.code === "busy");
  releaseGap();
  const done = await runner.wait(job1.id);
  assert.equal(done.state, "done");
  // 现在可以再跑
  const job2 = runner.start({ legs: ["travel"] });
  await runner.wait(job2.id);
  assert.equal(job2.state, "done");
});

test("runner：stop() 在步骤边界中止", async () => {
  const clock = fakeClock(DAY);
  const backend = simpleBackend(clock);
  let releaseGap;
  const gate = new Promise((resolve) => {
    releaseGap = resolve;
  });
  let gated = false;
  const runner = new JobRunner({
    accounts: twoAccounts(),
    now: clock.now,
    fetch: backend.fetchImpl,
    sleep: async (ms) => {
      await clock.sleep(ms);
      if (ms >= 1500 && !gated) {
        gated = true;
        await gate;
      }
    },
  });
  const job = runner.start({ legs: ["growth", "night"] });
  for (let i = 0; i < 200 && !gated; i++) await new Promise((r) => setImmediate(r));
  const stopped = runner.stop();
  assert.equal(stopped.id, job.id);
  releaseGap();
  const done = await runner.wait(job.id);
  assert.equal(done.state, "done");
  assert.equal(done.stopped, true);
  assert.deepEqual(done.steps.map((s) => s.uid), ["uid-A"], "B 账号还没开始就被取消了");
  assert.ok(done.log.some((l) => l.includes("取消")));
});

test("runner：403/11140 → 记入 holds，本轮跳过该账号", async () => {
  const clock = fakeClock(DAY);
  const backend = simpleBackend(clock, { restrictedUids: ["uid-A"] });
  const runner = new JobRunner({
    accounts: twoAccounts(),
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const job = runner.start({ legs: ["growth"] });
  const done = await runner.wait(job.id);
  const aStep = done.steps.find((s) => s.uid === "uid-A");
  const bStep = done.steps.find((s) => s.uid === "uid-B");
  assert.equal(aStep.state, "fail");
  assert.match(aStep.detail, /未能获取到任务清单|风控|restricted|失败/);
  assert.equal(bStep.state, "ok");
  // holds 形状（CONTRACT §2/§3）：[{uid, releasedAt}]，releasedAt = 解除时刻 epoch ms
  const holds = runner.holds();
  assert.equal(holds.length, 1);
  assert.equal(holds[0].uid, "uid-A");
  assert.ok(Number.isFinite(holds[0].releasedAt), "releasedAt 必须是 epoch ms");
  assert.ok(holds[0].releasedAt > clock.time, "解除时刻在未来");
  assert.ok(holds[0].releasedAt - clock.time <= RESTRICTED_COOLDOWN_MS, "解除时刻不超过完整冷却窗");
  assert.deepEqual(job.log.filter((l) => l.includes("风控限制")).length >= 1, true);

  // 冷却中的账号下一轮直接 skip
  const job2 = runner.start({ legs: ["growth"], uids: ["uid-A"] });
  const done2 = await runner.wait(job2.id);
  assert.equal(done2.steps.length, 1);
  assert.equal(done2.steps[0].state, "skip");
  assert.match(done2.steps[0].detail, /风控冷却/);
});

test("runner：holds() 精确形状与到期（注入时钟）", async () => {
  const clock = fakeClock(DAY);
  const runner = new JobRunner({ accounts: [], now: clock.now, sleep: clock.sleep });
  assert.deepEqual(runner.holds(), [], "初始无冷却");
  runner.hold("uid-X", 5000);
  assert.deepEqual(runner.holds(), [{ uid: "uid-X", releasedAt: DAY + 5000 }]);
  clock.advance(5000);
  assert.deepEqual(runner.holds(), [], "过了 releasedAt 就不再算冷却");
  // 默认冷却时长 = RESTRICTED_COOLDOWN_MS（2 小时）
  runner.hold("uid-Y");
  assert.equal(runner.holds()[0].releasedAt - clock.time, RESTRICTED_COOLDOWN_MS);
});

test("runner：token 临期 → 刷新 + 原子回写 + 内存合并", async () => {
  const clock = fakeClock(DAY);
  const backend = simpleBackend(clock, {
    refreshTokens: [{ accessToken: "at-brand-new", refreshToken: "rt-brand-new", expiresAt: DAY + 3600_000 }],
  });
  const saved = [];
  const acct = makeAcct({ expires: DAY + 60_000, refresh: "rt-old", access: "at-old" }); // 1 分钟后过期
  const runner = new JobRunner({
    accounts: [acct],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
    saveRefresh: (key, patch) => saved.push({ key, patch }),
  });
  const job = runner.start({ legs: ["travel"] });
  const done = await runner.wait(job.id);
  assert.equal(done.state, "done");
  assert.equal(acct.access, "at-brand-new");
  assert.equal(acct.refresh, "rt-brand-new");
  assert.equal(acct.expires, DAY + 3600_000);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].key, "workbuddy");
  assert.equal(saved[0].patch.access, "at-brand-new");
  assert.ok(done.log.some((l) => l.includes("回写")));
  // 刷新请求确实发出（带 X-Refresh-Token）
  const refreshCall = backend.calls.find((c) => c.path.endsWith("/refresh"));
  assert.ok(refreshCall);
  assert.equal(refreshCall.headers["X-Refresh-Token"], "rt-old");
});

test("runner：uids 过滤与 loadAccounts 注入", async () => {
  const clock = fakeClock(DAY);
  const backend = simpleBackend(clock);
  const runner = new JobRunner({
    loadAccounts: async () => twoAccounts(),
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const job = runner.start({ legs: ["growth"], uids: ["uid-B"] });
  const done = await runner.wait(job.id);
  assert.deepEqual(done.steps.map((s) => s.uid), ["uid-B"]);
});

test("runner：腿的顺序固定 growth → travel → night；未知腿剔除", async () => {
  const clock = fakeClock(DAY);
  const backend = simpleBackend(clock);
  const runner = new JobRunner({
    accounts: [makeAcct()],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const job = runner.start({ legs: ["night", "bogus", "growth", "travel"] });
  const done = await runner.wait(job.id);
  assert.deepEqual(done.steps.map((s) => s.leg), ["growth", "travel", "night"]);
});
