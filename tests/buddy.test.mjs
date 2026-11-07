// tests/buddy.test.mjs —— Buddy 盲盒腿（engine/buddy.mjs，hub 937c179 的
// do_buddy_open 移植）回归。
//
// 口径：
//   - quota 读 affordable / max_open_count；affordable<=0 → ok:true + 提示日志，
//     绝不发 open 请求；
//   - count = min(affordable, max(1, max_open_count))，一次 POST 批量开；
//   - 成功解析 data.buddy | name | buddies（数组 join），日志「Buddy 盲盒: 开启
//     ×N 成功 (...)」；**不领积分、不加 credit**；
//   - 403/11140 → restricted 透传（runner 记冷却）；
//   - 全部调用走 callJSON + ctx.breathe：两次上游调用间隔 ≥ gap（假时钟断言）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { runBuddyOpen } from "../engine/buddy.mjs";
import { JobRunner } from "../engine/runner.mjs";
import { fakeClock, localTime, makeAcct, task, wbBackend } from "./helpers.mjs";

const GAP = 1000;
const NOW = localTime(2026, 9, 15, 10, 0);

function boot(backendOpts = {}, acctOpts = {}) {
  const clock = fakeClock(NOW);
  const backend = wbBackend({ clock, tasks: [], litRules: {}, ...backendOpts });
  const acct = makeAcct(acctOpts);
  return { clock, backend, acct };
}

test("buddy：共享时钟下有能量 → count=min(affordable,max_open_count)，不领积分", async () => {
  const { clock, backend, acct } = boot({
    buddyQuota: { affordable: 2, max_open_count: 5 },
    buddyOpenResponse: { code: 0, data: { buddies: ["布丁猫", "雪球猫"] } },
  });
  const res = await runBuddyOpen(acct, {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP,
  });

  assert.equal(res.ok, true);
  assert.equal(res.opened, 2, "affordable=2 < max_open_count=5 → 开 2 个");
  assert.equal(res.name, "布丁猫, 雪球猫", "buddies 数组 join");
  assert.deepEqual(res.logs, ["Buddy 盲盒: 开启 ×2 成功 (布丁猫, 雪球猫)"]);
  assert.equal(res.credit, undefined, "不领积分：结果里没有 credit 字段");

  // 上游调用：1 次 quota + 1 次 open，open body 带 count 与 client_token
  const quota = backend.calls.filter((c) => c.path === "/v2/activity/growth/buddy/quota");
  const opens = backend.calls.filter((c) => c.path === "/v2/activity/growth/buddy/open");
  assert.equal(quota.length, 1);
  assert.equal(opens.length, 1);
  assert.equal(opens[0].method, "POST");
  assert.equal(opens[0].body.count, 2);
  assert.ok(typeof opens[0].body.client_token === "string" && opens[0].body.client_token.length >= 32);
  // 节流：两次调用间隔 ≥ gap
  assert.ok(opens[0].at - quota[0].at >= GAP);
});

test("buddy：affordable=0 → ok:true、不发 open、诚实日志", async () => {
  const { clock, backend, acct } = boot({ buddyQuota: { affordable: 0, max_open_count: 3 } });
  const res = await runBuddyOpen(acct, {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP,
  });
  assert.equal(res.ok, true);
  assert.equal(res.opened, 0);
  assert.deepEqual(res.logs, ["成长能量不足以开启 Buddy 盲盒"]);
  assert.equal(backend.calls.filter((c) => c.path === "/v2/activity/growth/buddy/open").length, 0, "能量不足绝不开盒");
});

test("buddy：max_open_count 兜底（缺省按 1）且不超过 affordable", async () => {
  const { clock, backend, acct } = boot({
    buddyQuota: { affordable: 4, max_open_count: 0 }, // 上游回了 0 → 按 max(1,0)=1
    buddyOpenResponse: { code: 0, data: { name: "星际猫" } },
  });
  const res = await runBuddyOpen(acct, {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP,
  });
  assert.equal(res.opened, 1);
  assert.equal(res.name, "星际猫", "data.name 兜底拼写");
  assert.deepEqual(backend.state.buddyOpens, [{ count: 1, client_token: backend.state.buddyOpens[0]?.client_token }]);
});

test("buddy：data.buddy 拼写优先；开盒失败 → ok:false", async () => {
  const a = boot({
    buddyQuota: { affordable: 1, max_open_count: 1 },
    buddyOpenResponse: { code: 0, data: { buddy: "团子" } },
  });
  const r1 = await runBuddyOpen(a.acct, { now: a.clock.now, sleep: a.clock.sleep, fetch: a.backend.fetchImpl, gap: GAP });
  assert.equal(r1.opened, 1);
  assert.equal(r1.name, "团子");

  const b = boot({
    buddyQuota: { affordable: 1, max_open_count: 1 },
    buddyOpenResponse: { code: 500, msg: "insufficient energy" },
  });
  const r2 = await runBuddyOpen(b.acct, { now: b.clock.now, sleep: b.clock.sleep, fetch: b.backend.fetchImpl, gap: GAP });
  assert.equal(r2.ok, false);
  assert.equal(r2.opened, 0);
  assert.ok(r2.logs[0].includes("开启失败"));
  assert.ok(r2.logs[0].includes("insufficient energy"));
});

test("buddy：quota 查询失败 → ok:false；403/11140 → restricted 透传", async () => {
  // quota 网络失败：wbBackend 没有 404 之外的失败注入口，用 restrictedUids 让
  // quota 也 403（同一 uid 的所有上游调用都受限）—— 一次覆盖 restricted 透传。
  const { clock, backend, acct } = boot(
    { restrictedUids: ["u-12345678"], buddyQuota: { affordable: 9, max_open_count: 3 } },
  );
  const res = await runBuddyOpen(acct, {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP,
  });
  assert.equal(res.ok, false);
  assert.equal(res.restricted, true, "restricted 透传（runner 据此记冷却）");
  assert.equal(res.opened, 0);
  assert.equal(backend.calls.filter((c) => c.path === "/v2/activity/growth/buddy/open").length, 0, "restricted 后绝不开盒");
});

test("buddy：企业号跳过、国际版不适用", async () => {
  const ent = await runBuddyOpen(makeAcct({ enterpriseId: "ent-1" }), {
    fetch: async () => { throw new Error("no network"); },
  });
  assert.equal(ent.ok, true);
  assert.match(ent.logs.join("\n"), /企业版/);
  const intl = await runBuddyOpen(makeAcct({ provider: "workbuddy-ai" }), {
    fetch: async () => { throw new Error("no network"); },
  });
  assert.equal(intl.ok, false);
  assert.match(intl.logs.join("\n"), /国际版/);
});

test("runner：腿的顺序固定 growth → buddy → travel → night（buddy 在 travel 前）", async () => {
  const clock = fakeClock(NOW);
  const backend = wbBackend({
    clock,
    tasks: [task("first_buddy", { task_type: "auto", reward: 300, status: "claimed", current: 1, target: 1 })],
    litRules: {},
    travel: { state: "idle" }, // 猫在家 → travel 腿会派出，便于断言 buddy 在 travel 之前
    buddyQuota: { affordable: 1, max_open_count: 1 },
  });
  const runner = new JobRunner({
    accounts: [makeAcct()],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  // 只跑 buddy+travel（不含 growth，排除干扰；growth 腿的旅行收尾已由 travel 腿
  // 接管 —— growth+travel 同时跑时旅行只发生一次，见 tests/runner.test.mjs 的
  // 需求 1 回归）；全腿顺序归一另有单独断言（["night","bogus","buddy","growth",
  // "mp","travel"] 入参）。
  const job = runner.start({ legs: ["travel", "bogus", "buddy"] });
  const done = await runner.wait(job.id);
  assert.deepEqual(done.steps.map((s) => s.leg), ["buddy", "travel"], "未知腿剔除、顺序归一为 buddy→travel");

  // buddy 步骤：detail = 最后一条日志；开盒发生在 travel 派出之前
  const buddyStep = done.steps.find((s) => s.leg === "buddy");
  assert.equal(buddyStep.state, "ok");
  assert.equal(buddyStep.detail, "Buddy 盲盒: 开启 ×1 成功 (布丁猫)");
  assert.equal(buddyStep.credit, 0, "buddy 腿不加积分");
  const buddyOpenAt = backend.calls.find((c) => c.path === "/v2/activity/growth/buddy/open")?.at;
  const departAt = backend.calls.find((c) => c.path === "/activity/growth/buddy/travel/depart")?.at;
  assert.ok(buddyOpenAt != null && departAt != null && buddyOpenAt <= departAt, "先开盲盒后派旅行");
});

test("runner：全腿入参乱序 → 归一为 growth → mp → buddy → travel → night", async () => {
  const clock = fakeClock(NOW);
  const backend = wbBackend({
    clock,
    tasks: [task("first_buddy", { task_type: "auto", reward: 300, status: "claimed", current: 1, target: 1 })],
    litRules: {},
    buddyQuota: { affordable: 0, max_open_count: 1 },
  });
  const runner = new JobRunner({
    accounts: [makeAcct()],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const job = runner.start({ legs: ["night", "bogus", "buddy", "growth", "mp", "travel"] });
  const done = await runner.wait(job.id);
  assert.deepEqual(done.steps.map((s) => s.leg), ["growth", "mp", "buddy", "travel", "night"], "未知腿剔除、顺序归一");
});
