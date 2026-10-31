// tests/upstream-spacer.test.mjs —— 全局节流器（makeSpacer）的确定性回归测试。
//
// 背景（e2e 抓到的偶发失败）：daemon 里快照刷新（finalizeJob → refreshSnapshots）
// 与手动操作（/api/task/claim 等）各自新建 opts/ctx、各自固定 sleep(1s)，两个
// 等待窗一旦重叠，两次上游调用就贴着发出去（假时钟上间隔 0ms）—— 铁律 4 红线。
// 修法：engine/upstream.makeSpacer 记录「上次上游调用放行时刻」并排队串行，由
// daemon 创建唯一实例注入所有路径（CONTRACT 铁律 4）。
//
// 这里用纯假时钟（sleep 只拨表、零真实等待）确定性构造两种时序：
//   A. 「job 刚结束 → 立刻触发快照刷新」：上一次调用之后，**全新 opts 对象**
//      （daemon 的 engineOpts() 每次新建 → 全新 ctx）的第一次调用也必须对齐。
//      没有 spacer 时这正是 0ms 间隔的成因，本文件把它钉死为回归测试。
//   B. 「并发入口」（快照刷新撞手动操作 / 排程 job）：同时发起的多路调用必须
//      排队串行 —— 任意两次 start 间隔 ≥ gap，且前一个调用完整结束（含响应）
//      之后才放行下一个（绝不在途并行）。
// 全程零真实网络、零真实等待。

import { test } from "node:test";
import assert from "node:assert/strict";

import { callJSON, makeSpacer, refreshAccount } from "../engine/upstream.mjs";
import { fakeClock, makeAcct } from "./helpers.mjs";

const T0 = 1_700_000_000_000;
const RESP = (status, body) => ({ status, text: async () => JSON.stringify(body) });

// 假上游：记录每次调用的 start/end（假时钟时刻）。latency>0 时响应耗时占假钟
// ——用来断言「前一个调用完整结束后才放行下一个」（绝不在途并行）。
// refresh 端点按引擎的期望形状回 accessToken（refreshAccount 的测试要用）。
function fakeUpstream(clock, { latency = 0 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const start = clock.now();
    if (latency > 0) await clock.sleep(latency);
    const end = clock.now();
    calls.push({ start, end, url: String(url), method: String(init.method || "GET").toUpperCase() });
    if (new URL(url).pathname.endsWith("/refresh")) {
      return RESP(200, { code: 0, msg: "ok", data: { data: { accessToken: "at-new" } } });
    }
    return RESP(200, { code: 0, msg: "ok", data: {} });
  };
  return { fetchImpl, calls };
}

// daemon 的两条路径各有一份全新 opts（engineOpts() 每次新建），但共用同一个
// spacer —— 这就是被测的接线形状。
function pathOpts(clock, upstream, spacer, extra = {}) {
  return {
    now: clock.now,
    sleep: clock.sleep,
    fetch: upstream.fetchImpl,
    gap: 1000,
    spacer,
    ...extra,
  };
}

function assertSpaced(upstream, { minGap = 1000, from = 0 } = {}) {
  const c = upstream.calls.slice(from);
  assert.ok(c.length >= 2, `应有 ≥2 次调用，实际 ${c.length}`);
  for (let i = 1; i < c.length; i++) {
    assert.ok(
      c[i].start - c[i - 1].start >= minGap,
      `第 ${i - 1}→${i} 次调用 start 间隔 ${c[i].start - c[i - 1].start}ms < ${minGap}`,
    );
    // 绝不在途并行：下一次调用发出时，上一次必须已经拿到响应
    assert.ok(
      c[i].start >= c[i - 1].end,
      `第 ${i} 次调用在上一停止前就发出（start ${c[i].start} < 上一次 end ${c[i - 1].end}）—— 在途并行`,
    );
  }
}

// ---- A. 跨边界：job 最后一次调用之后，全新 ctx 的第一脚也对齐 ----------------

test("spacer 跨边界：上一次调用之后，全新 opts/ctx 的第一次调用仍对齐 ≥gap（job 结束 → 快照刷新的确定性回归）", async () => {
  const clock = fakeClock(T0);
  const upstream = fakeUpstream(clock);
  const spacer = makeSpacer({ now: clock.now, sleep: clock.sleep, gap: 1000 });

  // 「job」的最后一次上游调用（带 spacer 的 opts —— daemon 的 runnerCtx 形状）
  await callJSON(makeAcct(), "chat", "https://copilot.tencent.com/x", {}, pathOpts(clock, upstream, spacer));
  assert.equal(upstream.calls.length, 1);

  // 「job 收尾 → refreshSnapshots」：daemon 的 engineOpts() 每次都新建 opts 对象
  // → 全新 ctx（其局部 last = now-gap，breathe 不会等）—— 没有 spacer 时这一脚
  // 会贴着上一次调用发出（0ms，正是 e2e 抓到的偶发失败）。
  const freshOpts = pathOpts(clock, upstream, spacer);
  assert.ok(freshOpts.__ctx === undefined, "前置：这次调用必须是全新 ctx");
  await callJSON(makeAcct(), "chat", "https://copilot.tencent.com/y", {}, freshOpts);

  assert.equal(upstream.calls[1].start - upstream.calls[0].start >= 1000, true);
  assertSpaced(upstream);
});

test("spacer 跨边界（负对照）：不带 spacer 的新 ctx 第一脚不等 —— 这就是必须注入 spacer 的原因", async () => {
  const clock = fakeClock(T0);
  const upstream = fakeUpstream(clock);
  await callJSON(makeAcct(), "chat", "https://copilot.tencent.com/x", {}, pathOpts(clock, upstream, null));
  await callJSON(makeAcct(), "chat", "https://copilot.tencent.com/y", {}, pathOpts(clock, upstream, null));
  // 旧行为：两个独立 ctx 各自「首调不空等」→ 贴着发。钉住这个形状，
  // 防止有人以为 ctx 局部 breathe 已经足够、悄悄拆掉 spacer。
  assert.equal(upstream.calls[1].start - upstream.calls[0].start, 0);
});

// ---- B. 并发入口：排队串行，绝不在途并行 --------------------------------------

test("spacer 并发串行：两路入口同时要打 → 排队，start 间隔 ≥gap 且上一调用完整结束后才放行", async () => {
  const clock = fakeClock(T0);
  const upstream = fakeUpstream(clock, { latency: 300 }); // 响应占 300ms 假钟
  const spacer = makeSpacer({ now: clock.now, sleep: clock.sleep, gap: 1000 });

  // 快照刷新路径与手动操作路径同时发起（各自全新 opts，共用一个 spacer）
  const p1 = callJSON(makeAcct(), "chat", "https://copilot.tencent.com/snap", {}, pathOpts(clock, upstream, spacer));
  const p2 = callJSON(makeAcct(), "chat", "https://copilot.tencent.com/claim", {}, pathOpts(clock, upstream, spacer));
  await Promise.all([p1, p2]);

  assertSpaced(upstream); // start 间隔 ≥1000 且 start ≥ 上一次 end（绝不在途并行）
  assert.equal(upstream.calls[0].start, T0); // 第一路立即放行（上次放行时刻为空）
});

test("spacer 并发串行：三路并发（job 腿 + 快照刷新 + 手动操作）也全部串行对齐", async () => {
  const clock = fakeClock(T0);
  const upstream = fakeUpstream(clock, { latency: 300 });
  const spacer = makeSpacer({ now: clock.now, sleep: clock.sleep, gap: 1000 });

  const ps = ["job", "snapshot", "manual"].map((tag) =>
    callJSON(makeAcct(), "chat", `https://copilot.tencent.com/${tag}`, {}, pathOpts(clock, upstream, spacer)),
  );
  await Promise.all(ps);
  assertSpaced(upstream);
  assert.equal(upstream.calls.length, 3);
});

test("spacer：gap 可以是函数（daemon 传 () => settings.gapMs，改设置即时生效）", async () => {
  const clock = fakeClock(T0);
  const upstream = fakeUpstream(clock);
  let gapMs = 1000;
  const spacer = makeSpacer({ now: clock.now, sleep: clock.sleep, gap: () => gapMs });

  await callJSON(makeAcct(), "chat", "https://copilot.tencent.com/a", {}, pathOpts(clock, upstream, spacer));
  await callJSON(makeAcct(), "chat", "https://copilot.tencent.com/b", {}, pathOpts(clock, upstream, spacer));
  assert.equal(upstream.calls[1].start - upstream.calls[0].start, 1000);

  gapMs = 1500; // /api/settings 改大 → 下一脚按新 gap 对齐
  await callJSON(makeAcct(), "chat", "https://copilot.tencent.com/c", {}, pathOpts(clock, upstream, spacer));
  assert.equal(upstream.calls[2].start - upstream.calls[1].start, 1500);
});

// ---- C. refreshAccount（token 临期刷新）也过同一个 spacer ----------------------

test("spacer 覆盖 refreshAccount：刷新请求与上一次调用对齐 ≥gap；作为首调不空等", async () => {
  const clock = fakeClock(T0);
  const upstream = fakeUpstream(clock);
  const spacer = makeSpacer({ now: clock.now, sleep: clock.sleep, gap: 1000 });

  // 首调是 refresh（runner._maybeRefresh 的形状）：上次放行时刻为空 → 立即放行
  const r1 = await refreshAccount(makeAcct({ refresh: "rt" }), pathOpts(clock, upstream, spacer));
  assert.equal(r1.ok, true);
  assert.equal(upstream.calls[0].start, T0);

  // 另一路径刚打过上游 → 刷新必须对齐
  await callJSON(makeAcct(), "chat", "https://copilot.tencent.com/x", {}, pathOpts(clock, upstream, spacer));
  await refreshAccount(makeAcct({ refresh: "rt" }), pathOpts(clock, upstream, spacer));
  assertSpaced(upstream);
});

// ---- D. 调用内的重试/回退也是「两次上游调用」 ----------------------------------

test("铁律 4：chat 主机回退这一脚与第 3 次尝试之间也 ≥1000ms（此前是 0ms —— 同类洞）", async () => {
  const clock = fakeClock(T0);
  const attempts = []; // 每次 HTTP 尝试（含抛错的）都算一次线上调用
  const recording = (url, init = {}) => {
    const start = clock.now();
    attempts.push({ start, end: start, url: String(url) });
    if (new URL(url).host === "copilot.tencent.com") throw new Error("TLS reset");
    return RESP(200, { code: 0, msg: "ok", data: { tasks: [] } });
  };
  const spacer = makeSpacer({ now: clock.now, sleep: clock.sleep, gap: 1000 });

  const res = await callJSON(makeAcct(), "chat", "https://copilot.tencent.com/x", {}, {
    ...pathOpts(clock, { fetchImpl: recording }, spacer),
  });
  assert.equal(res.ok, true, "回退成功");
  // 线上共 4 次尝试：3 次原主机（退避 1s/2s）+ 1 次回退主机 —— 任意相邻两次 ≥1000
  assert.equal(attempts.length, 4);
  for (let i = 1; i < attempts.length; i++) {
    assert.ok(
      attempts[i].start - attempts[i - 1].start >= 1000,
      `第 ${i - 1}→${i} 次尝试间隔 ${attempts[i].start - attempts[i - 1].start}ms < 1000`,
    );
  }
  assert.match(attempts[3].url, /www\.workbuddy\.cn/);
});

// ---- E. spacer 的健壮性 --------------------------------------------------------

test("spacer：前一路调用失败也照常放行下一路（finally 释放，不卡死队列）", async () => {
  const clock = fakeClock(T0);
  const upstream = fakeUpstream(clock);
  const spacer = makeSpacer({ now: clock.now, sleep: clock.sleep, gap: 1000 });

  // callJSON 把网络错误结算成 ok:false（不抛出），spacer 必须照常释放
  const failing = async () => { throw new Error("boom"); };
  const r1 = await callJSON(makeAcct(), "billing", "https://www.codebuddy.cn/a", {}, {
    ...pathOpts(clock, { fetchImpl: failing }, spacer),
  });
  assert.equal(r1.ok, false);
  assert.equal(upstream.calls.length, 0, "失败路径没有成功调用");

  const r2 = await callJSON(makeAcct(), "chat", "https://copilot.tencent.com/b", {}, pathOpts(clock, upstream, spacer));
  assert.equal(r2.ok, true, "失败之后的下一路照常放行");

  // 直接经 spacer.run 的调用者抛错 → 队列照样前进
  await assert.rejects(() => spacer.run(async () => { throw new Error("boom2"); }));
  const r3 = await spacer.run(async () => "ok");
  assert.equal(r3, "ok");
});
