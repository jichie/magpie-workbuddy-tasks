import { test } from "node:test";
import assert from "node:assert/strict";

import { claimTask, buildEvent, reportEvents } from "../engine/tasks.mjs";
import { runNightTask, runCatTravel } from "../engine/travel.mjs";
import { fakeClock, localTime, makeAcct, task, wbBackend } from "./helpers.mjs";

const DAY = localTime(2026, 9, 15, 10, 0); // 本地 10:00
const NIGHT = localTime(2026, 9, 15, 23, 30); // 本地 23:30

test("claimTask：chat 域成功", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({
    clock,
    tasks: [task("skill_1", { status: "completed", current: 1 })],
  });
  const res = await claimTask(makeAcct(), "skill_1", {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
  });
  assert.deepEqual({ ok: res.ok, credit: res.credit, energy: res.energy, via: res.via }, {
    ok: true, credit: 100, energy: 0, via: "chat",
  });
  const call = backend.calls.at(-1);
  assert.equal(call.host, "copilot.tencent.com");
  assert.equal(call.path, "/activity/growth/tasks/skill_1/claim");
  assert.deepEqual(call.body, {});
});

test("claimTask：HTTP 400「task not completed」→ 试一次 web 域回退", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({
    clock,
    tasks: [task("skill_1", { status: "completed", current: 1 })],
    chatClaimAlways400: true,
  });
  const res = await claimTask(makeAcct(), "skill_1", {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
  });
  assert.equal(res.ok, true);
  assert.equal(res.via, "web");
  assert.equal(res.credit, 100);

  const claims = backend.calls.filter((c) => c.path.endsWith("/claim"));
  assert.equal(claims.length, 2, "只回退一次");
  assert.equal(claims[0].host, "copilot.tencent.com");
  assert.equal(claims[1].host, "www.workbuddy.cn");
  const h = claims[1].headers;
  assert.equal(h["Origin"], "https://www.workbuddy.cn");
  assert.equal(h["Referer"], "https://www.workbuddy.cn/profile/growth-center");
  assert.equal(h["x-client-platform"], "web");
  assert.equal(h["X-Domain"], "https://www.workbuddy.cn");
  assert.equal(h["Authorization"], "Bearer access-token-abc");
  assert.equal(backend.state.webClaims, 1);
});

test("claimTask：web 回退也失败 → ok:false / via web", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({ clock, tasks: [task("skill_1", {})], chatClaimAlways400: true });
  // 任务未达标：chat 与 web 都回 400
  const res = await claimTask(makeAcct(), "skill_1", {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
  });
  assert.equal(res.ok, false);
  assert.equal(res.via, "web");
  assert.match(res.reason, /task not completed/);
});

test("claimTask：信封 code 400（HTTP 200）也触发 web 回退；其它码不回退", async () => {
  const clock = fakeClock(DAY);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(new URL(url));
    if (calls.length === 1) return { status: 200, text: async () => JSON.stringify({ code: 400, msg: "task not completed" }) };
    return { status: 200, text: async () => JSON.stringify({ code: 0, data: { credit: 5, energy: 1 } }) };
  };
  const res = await claimTask(makeAcct(), "x", { now: clock.now, sleep: clock.sleep, fetch: fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.via, "web");
  assert.equal(res.credit, 5);
  assert.equal(res.energy, 1);

  const calls2 = [];
  const res2 = await claimTask(makeAcct(), "x", {
    now: clock.now, sleep: clock.sleep,
    fetch: async (url) => {
      calls2.push(url);
      return { status: 200, text: async () => JSON.stringify({ code: 500, msg: "boom" }) };
    },
  });
  assert.equal(res2.ok, false);
  assert.equal(res2.via, "chat");
  assert.equal(calls2.length, 1, "code 500 不触发 web 回退");
});

test("夜猫子：白天诚实跳过", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({ clock, tasks: [task("black_cat", { target: 3 })], litRules: { chat_request_send: "black_cat" } });
  const res = await runNightTask(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.earnedCredit, 0);
  assert.match(res.logs.join("\n"), /23:00-08:00/);
  assert.equal(backend.calls.length, 0, "白天一个上游请求都不发");
});

test("夜猫子：夜间未接取 → 先接取再上报，当晚 +1", async () => {
  const clock = fakeClock(NIGHT);
  const backend = wbBackend({
    clock,
    tasks: [task("black_cat", { target: 3 })],
    litRules: { chat_request_send: "black_cat" },
  });
  const logs = [];
  const res = await runNightTask(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
    log: (l) => typeof l === "string" && logs.push(l),
  });
  assert.equal(res.ok, true);
  assert.equal(res.earnedCredit, 0);
  assert.equal(backend.state.acceptCalls, 1, "先接取");
  const acceptIdx = backend.calls.findIndex((c) => c.path.endsWith("/accept"));
  const reportIdx = backend.calls.findIndex((c) => c.path === "/v2/report");
  assert.ok(acceptIdx >= 0 && reportIdx > acceptIdx, "接取先于上报");
  assert.match(logs.join("\n"), /夜猫子任务已接取/);
  assert.match(logs.join("\n"), /今晚 \+1 \(1\/3\)/);
  const ev = backend.state.reports[0];
  assert.equal(ev.eventCode, "chat_request_send");
  assert.equal(ev.requestModelId, "glm-5.2");
  assert.equal(ev.mode, "night");
  assert.ok(ev.userId);
  // 轮询间隔 4s
  const polls = backend.calls.filter((c) => c.path === "/v2/activity/growth/tasks");
  assert.ok(polls.length >= 2);
  assert.ok(polls[1].at - polls[0].at >= 4000);
});

test("夜猫子：达标当晚领奖", async () => {
  const clock = fakeClock(NIGHT);
  const backend = wbBackend({
    clock,
    tasks: [task("black_cat", { target: 3, current: 2, status: "accepted", reward: 100 })],
    litRules: { chat_request_send: "black_cat" },
  });
  const res = await runNightTask(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.earnedCredit, 100);
  assert.deepEqual(backend.state.claims, ["black_cat"]);
  assert.match(res.logs.join("\n"), /夜猫子任务完成 3\/3/);
});

test("夜猫子：已领奖 / 企业号 / 国际版", async () => {
  const clock = fakeClock(NIGHT);
  const backend = wbBackend({ clock, tasks: [task("black_cat", { status: "claimed" })] });
  const done = await runNightTask(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl });
  assert.match(done.logs.join("\n"), /已领奖/);

  const ent = await runNightTask(makeAcct({ enterpriseId: "e1" }), { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl });
  assert.match(ent.logs.join("\n"), /企业版/);

  const intl = await runNightTask(makeAcct({ provider: "workbuddy-ai" }), { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl });
  assert.equal(intl.ok, false);
});

test("猫猫旅行：arrived → 领奖 +20", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({ clock, tasks: [], travel: { state: "arrived" } });
  const res = await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.action, "claim");
  assert.equal(res.credit, 20);
  assert.match(res.msg, /领奖成功/);
});

test("猫猫旅行：idle → 带 location_id 派出", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({ clock, tasks: [], travel: { state: "idle" } });
  const res = await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.action, "depart");
  assert.match(res.msg, /外滩/);
  const depart = backend.calls.find((c) => c.path.endsWith("/travel/depart"));
  assert.deepEqual(depart.body, { location_id: 1 }, "body 必须携带 {location_id}");
  const cfgIdx = backend.calls.findIndex((c) => c.path.endsWith("/travel/config"));
  const departIdx = backend.calls.findIndex((c) => c.path.endsWith("/travel/depart"));
  assert.ok(cfgIdx >= 0 && departIdx > cfgIdx);
});

test("猫猫旅行：no active buddy → 补齐 first_buddy 后重试一次", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({
    clock,
    tasks: [task("first_buddy", { task_type: "auto", reward: 300 })],
    litRules: { chat_request_send: "first_buddy" },
    travel: { state: "idle" },
    buddyDepartFails: 1,
  });
  const logs = [];
  const res = await runCatTravel(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
    log: (l) => typeof l === "string" && logs.push(l),
  });
  assert.equal(res.ok, true, res.msg);
  assert.equal(res.action, "depart");
  const departs = backend.calls.filter((c) => c.path.endsWith("/travel/depart"));
  assert.equal(departs.length, 2, "派出失败后重试一次");
  // 补 first_buddy：上报 + 领奖都发生过
  assert.deepEqual(backend.state.claims, ["first_buddy"]);
  const fb = backend.state.tasks.find((t) => t.task_code === "first_buddy");
  assert.equal(fb.accept_status, "claimed");
});

test("猫猫旅行：补不了 Buddy → 诚实告知", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({
    clock,
    tasks: [], // 清单里没有 first_buddy → ensureBuddy false
    travel: { state: "idle" },
    buddyDepartFails: 1,
  });
  const res = await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.msg, /还没有 Buddy/);
});

test("猫猫旅行：traveling / daily_limit / 未知状态 / 企业号", async () => {
  const clock = fakeClock(DAY);
  const t1 = wbBackend({ clock, tasks: [], travel: { state: "traveling" } });
  const r1 = await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: t1.fetchImpl });
  assert.equal(r1.action, "traveling");

  const t2 = wbBackend({ clock, tasks: [], travel: { state: "idle", daily_limit_reached: true } });
  const r2 = await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: t2.fetchImpl });
  assert.equal(r2.action, "idle");
  assert.ok(r2.msg.includes("00:00"));

  const t3 = wbBackend({ clock, tasks: [], travel: { state: "mystery" } });
  const r3 = await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: t3.fetchImpl });
  assert.equal(r3.action, "mystery");

  const r4 = await runCatTravel(makeAcct({ enterpriseId: "e1" }), {
    now: clock.now, sleep: clock.sleep, fetch: async () => { throw new Error("no"); },
  });
  assert.equal(r4.action, "skip");
});

test("猫猫旅行：两次上游调用间隔 ≥ 1000ms", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({
    clock,
    tasks: [task("first_buddy", { task_type: "auto" })],
    litRules: { chat_request_send: "first_buddy" },
    travel: { state: "idle" },
    buddyDepartFails: 1,
  });
  await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl });
  const calls = backend.calls;
  for (let i = 1; i < calls.length; i++) {
    assert.ok(calls[i].at - calls[i - 1].at >= 1000, `${calls[i - 1].path} → ${calls[i].path}`);
  }
});

test("reportEvents：body 是事件数组", async () => {
  const clock = fakeClock(DAY);
  const bodies = [];
  const res = await reportEvents(makeAcct(), [buildEvent(makeAcct(), "chat", 0, null, { now: clock.now })], {
    now: clock.now, sleep: clock.sleep,
    fetch: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return { status: 200, text: async () => JSON.stringify({ code: 0 }) };
    },
  });
  assert.equal(res, true);
  assert.ok(Array.isArray(bodies[0]));
  assert.equal(bodies[0].length, 1);
});
