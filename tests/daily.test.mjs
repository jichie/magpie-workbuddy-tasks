// tests/daily.test.mjs —— 每日活跃上报（点亮成长中心连登）的回归（CONTRACT §7）。
//
// 口径：每个账号每个**北京日**只发一条 chat 事件，打**计费域**
//（www.codebuddy.cn/v2/report，不是成长任务的 chat 域）；幂等键 = uid → 北京日键，
// 由 sentMap 持有、成功才落账并回调 onSent；任何失败返回 {sent:false,error} 不抛，
// 调用方（runner）只记日志继续跑腿。上游调用一律经 reportEvents（ctx.breathe +
// spacer），绝不绕开全局节流（铁律 4）。
//
// 本文件覆盖：北京日键（UTC+8 翻日）、幂等/跨日、失败不落账、打计费域、事件含
// userId、走 spacer；以及 runner 的接入（每账号开跑前一次、失败不阻断腿、
// 跳过不重发）。daemon 的持久化（state/daily-activity.json 读写/损坏回空）在
// tests-shell/daily-activity.test.mjs。

import { test } from "node:test";
import assert from "node:assert/strict";

import { beijingDayKey, reportDailyActivity } from "../engine/daily.mjs";
import { JobRunner } from "../engine/runner.mjs";
import { fakeClock, localTime, makeAcct, task, wbBackend } from "./helpers.mjs";

const RESP = (status, body) => ({ status, text: async () => JSON.stringify(body) });

// 2026-10-15 12:00 北京时间（与本地时区无关的确定性时刻）→ 北京日键 2026-10-15
const NOON_BJ = Date.UTC(2026, 9, 15, 4, 0, 0);

// 北京日键：UTC 16:00 整翻到北京次日（UTC+8）
test("beijingDayKey：UTC+8 翻日（UTC 16:00 前后跨北京日界）", () => {
  assert.equal(beijingDayKey(Date.UTC(2026, 9, 31, 15, 59, 59)), "2026-10-31", "UTC 15:59 = 北京 23:59 同一天");
  assert.equal(beijingDayKey(Date.UTC(2026, 9, 31, 16, 0, 0)), "2026-11-01", "UTC 16:00 = 北京次日 00:00");
  assert.equal(beijingDayKey(Date.UTC(2026, 0, 1, 0, 0, 0)), "2026-01-01", "UTC 00:00 = 北京 08:00 同一天");
  assert.equal(beijingDayKey(Date.UTC(2025, 11, 31, 16, 0, 0)), "2026-01-01", "跨年同样翻日");
});

function dailyFetch(record) {
  return async (url, init = {}) => {
    const u = new URL(url);
    record.push({
      host: u.host,
      path: u.pathname,
      method: String(init.method || "GET").toUpperCase(),
      headers: init.headers ?? {},
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    });
    return RESP(200, { code: 0, data: {} });
  };
}

test("reportDailyActivity：打计费域 /v2/report，chat 事件含 userId；成功落账 + onSent", async () => {
  const calls = [];
  const clock = fakeClock(NOON_BJ);
  const sentMap = {};
  const sent = [];
  const r = await reportDailyActivity(makeAcct({ uid: "uid-D1" }), {
    now: clock.now,
    sleep: clock.sleep,
    fetch: dailyFetch(calls),
    sentMap,
    onSent: (uid, key) => sent.push([uid, key]),
  });

  assert.equal(r.sent, true);
  assert.equal(r.key, "2026-10-15");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, "www.codebuddy.cn", "打计费域（不是 chat 域）");
  assert.equal(calls[0].path, "/v2/report");
  assert.equal(calls[0].method, "POST");
  assert.ok(Array.isArray(calls[0].body) && calls[0].body.length === 1, "body 是事件数组");
  const ev = calls[0].body[0];
  assert.equal(ev.eventCode, "chat_request_send", "每日活跃 = 一条 chat 事件");
  assert.equal(ev.userId, "uid-D1", "事件含 userId（缺了服务端静默丢弃）");
  assert.ok(ev.timestamp > 0);
  // 幂等账本只在成功后写入
  assert.equal(sentMap["uid-D1"], "2026-10-15");
  assert.deepEqual(sent, [["uid-D1", "2026-10-15"]]);
});

test("reportDailyActivity：同一北京日第二次不重发（skipped）；跨日（注入 now）会再发", async () => {
  const calls = [];
  const clock = fakeClock(NOON_BJ);
  const sentMap = {};
  const opts = { now: clock.now, sleep: clock.sleep, fetch: dailyFetch(calls), sentMap };

  const first = await reportDailyActivity(makeAcct({ uid: "uid-D2" }), opts);
  assert.equal(first.sent, true);
  assert.equal(calls.length, 1);

  // 同一天再报：账本命中 → skipped，零上游调用
  const again = await reportDailyActivity(makeAcct({ uid: "uid-D2" }), opts);
  assert.deepEqual(again, { sent: false, skipped: true, key: "2026-10-15" });
  assert.equal(calls.length, 1, "同一天绝不重发");

  // 注入 now 跨到北京次日（+1 天）→ 再发
  const nextDayClock = fakeClock(NOON_BJ + 86400000);
  const nextDay = await reportDailyActivity(makeAcct({ uid: "uid-D2" }), {
    ...opts,
    now: nextDayClock.now,
  });
  assert.equal(nextDay.sent, true);
  assert.equal(nextDay.key, "2026-10-16");
  assert.equal(calls.length, 2, "跨日重发一条");
  assert.equal(sentMap["uid-D2"], "2026-10-16");

  // 账本里是昨天的键（账本滞后）→ 同样再发
  sentMap["uid-D2"] = "2026-10-14";
  const stale = await reportDailyActivity(makeAcct({ uid: "uid-D2" }), opts);
  assert.equal(stale.sent, true);
  assert.equal(calls.length, 3, "账本键不是今天 → 再发");
});

test("reportDailyActivity：失败返回 {sent:false,error} 不抛；不落账、不回调", async () => {
  const clock = fakeClock(1_700_000_000_000);
  const sentMap = {};
  let onSentCalls = 0;
  const r = await reportDailyActivity(makeAcct({ uid: "uid-D3" }), {
    now: clock.now,
    sleep: clock.sleep,
    fetch: async () => RESP(500, { code: -1, msg: "boom" }), // 3 次重试全失败
    sentMap,
    onSent: () => {
      onSentCalls += 1;
    },
  });
  assert.equal(r.sent, false);
  assert.ok(r.error, "失败要带 error 供日志展示");
  assert.equal(sentMap["uid-D3"], undefined, "失败绝不落账（明天/下次重试）");
  assert.equal(onSentCalls, 0, "失败不回调 onSent");

  // 网络级异常同样不抛（reportEvents 只回布尔 —— error 是「上游拒绝」的同款口径）
  const r2 = await reportDailyActivity(makeAcct({ uid: "uid-D3" }), {
    now: clock.now,
    sleep: clock.sleep,
    fetch: async () => {
      throw new Error("ECONNRESET");
    },
    sentMap,
  });
  assert.equal(r2.sent, false);
  assert.ok(r2.error, "网络级失败也要给出 error");

  // 缺 uid：直接拒绝（事件会被服务端静默丢弃）
  const r3 = await reportDailyActivity({ uid: "" }, { now: clock.now, sleep: clock.sleep, fetch: dailyFetch([]) });
  assert.equal(r3.sent, false);
  assert.match(r3.error, /uid/);
});

test("reportDailyActivity：经全局节流器（spacer 排队），绝不绕开铁律 4", async () => {
  const calls = [];
  let spacerRuns = 0;
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const spacer = {
    async run(fn) {
      spacerRuns += 1;
      return fn();
    },
    peekLast: () => null,
  };
  await reportDailyActivity(makeAcct({ uid: "uid-D4" }), {
    now: clock.now,
    sleep: clock.sleep,
    fetch: dailyFetch(calls),
    spacer,
  });
  assert.equal(calls.length, 1);
  assert.equal(spacerRuns, 1, "上游调用经 spacer 排队（daemon 注入的唯一实例）");
});

// ---- runner 接入 ---------------------------------------------------------------

test("runner：每账号开跑前先发每日活跃（计费域），之后才进腿", async () => {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const backend = wbBackend({
    clock,
    tasks: [task("create_canvas", { reward: 300 })],
    litRules: { wbx_design_canvas_task_create: "create_canvas" },
  });
  const runner = new JobRunner({
    accounts: [makeAcct({ uid: "uid-R1" })],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const job = runner.start({ legs: ["growth"] });
  const done = await runner.wait(job.id);

  assert.equal(done.state, "done");
  // 第一条上游调用就是每日活跃（计费域 /v2/report），在腿的任何调用之前
  assert.equal(backend.calls[0].host, "www.codebuddy.cn");
  assert.equal(backend.calls[0].path, "/v2/report");
  assert.ok(backend.calls.slice(1).some((c) => c.path === "/v2/activity/growth/tasks"), "腿照常跑");
  assert.ok(done.log.some((l) => l.includes("每日活跃：已上报")), done.log.join("\n"));
  assert.deepEqual(backend.state.claims, ["create_canvas"], "腿不受影响");
});

test("runner：同一北京日的第二个 job 不再发（实例账本幂等）", async () => {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const backend = wbBackend({ clock, tasks: [], litRules: {} });
  const runner = new JobRunner({
    accounts: [makeAcct({ uid: "uid-R2" })],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const j1 = runner.start({ legs: ["travel"] });
  await runner.wait(j1.id);
  const reportsAfterFirst = backend.calls.filter((c) => c.path === "/v2/report").length;
  assert.equal(reportsAfterFirst, 1, "第一个 job 发一条");

  const j2 = runner.start({ legs: ["travel"] });
  const done2 = await runner.wait(j2.id);
  assert.equal(done2.state, "done");
  assert.equal(
    backend.calls.filter((c) => c.path === "/v2/report").length,
    1,
    "同一天的第二个 job 不重发",
  );
  assert.ok(done2.log.some((l) => l.includes("每日活跃：今日已报过")), done2.log.join("\n"));
});

test("runner：每日活跃失败只记日志，绝不阻断后续腿，job 照常 done", async () => {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const backend = wbBackend({
    clock,
    tasks: [task("create_canvas", { reward: 300 })],
    litRules: { wbx_design_canvas_task_create: "create_canvas" },
  });
  // 只让**计费域**（每日活跃）的 /v2/report 失败；腿内的 chat 域上报照常成功 ——
  // 精确验证「每日活跃失败不阻断腿」而不是把整条上报链路打挂。
  const failingReport = async (url, init = {}) => {
    if (new URL(url).host === "www.codebuddy.cn" && new URL(url).pathname === "/v2/report") {
      return { status: 500, text: async () => JSON.stringify({ code: -1, msg: "boom" }) };
    }
    return backend.fetchImpl(url, init);
  };
  const runner = new JobRunner({
    accounts: [makeAcct({ uid: "uid-R3" })],
    now: clock.now,
    sleep: clock.sleep,
    fetch: failingReport,
  });
  const job = runner.start({ legs: ["growth"] });
  const done = await runner.wait(job.id);

  assert.equal(done.state, "done", "每日活跃失败不 fail job");
  assert.ok(done.log.some((l) => l.includes("每日活跃：上报失败")), done.log.join("\n"));
  assert.equal(done.steps[0].state, "ok", "growth 腿照常 ok");
  assert.deepEqual(backend.state.claims, ["create_canvas"], "腿完整跑完");
});

test("runner：dailySentMap/onDailySent 注入 —— 跨实例幂等与落盘回调", async () => {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const backend = wbBackend({ clock, tasks: [], litRules: {} });
  const sentMap = {};
  const persisted = [];
  const mk = () =>
    new JobRunner({
      accounts: [makeAcct({ uid: "uid-R4" })],
      now: clock.now,
      sleep: clock.sleep,
      fetch: backend.fetchImpl,
      dailySentMap: sentMap,
      onDailySent: (uid, key) => persisted.push([uid, key]),
    });
  const r1 = mk();
  const j1 = r1.start({ legs: ["travel"] });
  await r1.wait(j1.id);
  assert.equal(persisted.length, 1);
  const r2 = mk(); // 模拟重启：新 runner、同一份（已持久化）账本
  const j2 = r2.start({ legs: ["travel"] });
  const done2 = await r2.wait(j2.id);
  assert.equal(backend.calls.filter((c) => c.path === "/v2/report").length, 1, "持久化账本命中 → 不重发");
  assert.ok(done2.log.some((l) => l.includes("每日活跃：今日已报过")));
});
