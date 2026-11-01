// tests-e2e/boundary-throttle.test.mjs —— 跨边界风控红线的确定性回归（真实 daemon）。
//
// 背景：full-loop 的「任意两次上游调用间隔 ≥1000ms」曾偶发失败——真实根因是
// daemon 的多条上游入口各自维护节奏（固定 sleep + 各自的 engine ctx），两个
// 等待窗一旦重叠，两次调用就贴着发出（假时钟上间隔 0ms；真实环境 = 403/11140
// 红线）。修法：engine/upstream.makeSpacer 全局节流器，daemon 创建唯一实例经
// engineOpts()/runnerCtx 注入所有路径（CONTRACT 铁律 4）。
//
// 本文件不靠运气复现两种时序（真实 daemon + 真实引擎 + 假时钟/假上游）：
//   A. job 刚结束 → watchJobTick.finalizeJob → refreshSnapshots，与手动
//      /api/task/claim 并发 —— 正是线上抓到的 0ms 对（accept→energy 同类）。
//   B. 排程 tick（ticks.checkScheduler → startJob）与手动 claim 并发。
// 假时钟的 sleep 在「拨表」后让出事件循环 15ms：两条路径的 pre-call 等待窗
// 必然重叠 —— 没有 spacer 时两次调用落在同一假钟时刻（0ms，测试必挂）；
// 有 spacer 时被排队串行、间隔 ≥gap。全程零真实网络。

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon } from "../daemon.mjs";
import { makeSandbox } from "../tests/helpers.mjs";

const DAEMON_KEY = "bt-e2e-key-0123456789abcdef";
const UID = "u-bt0001";
const DAY = 86400000;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假时钟：sleep 先拨表再让出 15ms —— 两条并发路径的等待窗必然重叠（确定性碰撞窗）
function btClock(startMs) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      await realSleep(Math.min(ms, 15));
    },
    get time() {
      return t;
    },
  };
}

const FAKE_START = (() => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
})(); // 正午：夜猫子窗口外，night 腿诚实跳过

const clock = btClock(FAKE_START);

// ---- 假上游：记录到达时刻（假钟），服务本文件用到的端点 -------------------------
const calls = [];
const stubFetch = async (url, init = {}) => {
  const u = new URL(url);
  const path = decodeURIComponent(u.pathname);
  const method = String(init.method || "GET").toUpperCase();
  const uid = init.headers?.["X-User-Id"] ?? "";
  const at = clock.now();
  calls.push({ at, path, method, uid });
  const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });

  if (path === "/v2/activity/growth/tasks") {
    return respond(200, {
      code: 0,
      data: {
        tasks: [
          { task_code: "first_buddy", title: "领取一只 Buddy", accept_status: "claimed", task_type: "auto", progress: { current: 1, target: 1 }, reward_credit: 300 },
          { task_code: "skill_1", title: "体验技能", accept_status: "completed", task_type: "single", progress: { current: 1, target: 1 }, reward_credit: 100 },
          { task_code: "wb_wechat_oa_subscribe_task", title: "关注官方公众号", accept_status: "not_accepted", task_type: "single", progress: { current: 0, target: 1 }, reward_credit: 100 },
        ],
      },
    });
  }
  if (path === "/v2/activity/growth/energy") return respond(200, { code: 0, data: { balance: 42 } });
  if (path === "/activity/growth/streak") return respond(200, { code: 0, data: { streak: { days: 3 } } });
  if (path === "/activity/growth/buddy/travel/status") return respond(200, { code: 0, data: { state: "traveling" } });
  const claim = /^\/activity\/growth\/tasks\/([^/]+)\/claim$/.exec(path);
  if (claim) {
    const code = claim[1];
    if (code === "skill_1" && !tasksClaimed.has(UID)) {
      tasksClaimed.add(UID);
      return respond(200, { code: 0, data: { credit: 100, energy: 0 } });
    }
    return respond(400, { code: 400, msg: "already claimed" });
  }
  return respond(404, { code: -1, msg: "not found" });
};
const tasksClaimed = new Set(); // skill_1 只成功领一次，之后如实 400（测 web 回退也无妨）

// ---- 夹具 ------------------------------------------------------------------------

// 全文件共用一个 temp 沙箱：单 daemon 单账号的连续时序故事，共享目录是有意设计
// （与 tests/、tests-shell/ 的「每用例独立沙箱」并发隔离不冲突 —— 用例间零共享
// 状态）。登记进 helpers 卫生线（after 兜底 + exit 钩子都回收它）。
const rootSb = makeSandbox("wb-tasks-bt-");
const root = rootSb.dir;
const cfgDir = join(root, "config");
const stateDir = join(cfgDir, "workbuddy-tasks", "state");
mkdirSync(stateDir, { recursive: true });
writeFileSync(join(cfgDir, "plugin-auth.json"), JSON.stringify({
  workbuddy: {
    type: "oauth",
    access: "wb-access-BT-0001",
    refresh: "wb-refresh-BT-0001",
    expires: FAKE_START + 30 * DAY,
    accountId: "bt-cat",
    uid: UID,
    domain: "copilot.tencent.com",
    tokenType: "Bearer",
  },
}));
writeFileSync(join(cfgDir, "plugins.json"), JSON.stringify({ plugins: [{ spec: "github:me/magpie-workbuddy-tasks" }] }));
writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ scheduler: false }));

const daemonLogs = [];
let h = null;

const api = {
  base: () => `http://127.0.0.1:${h.port}`,
  get: (path) => fetch(api.base() + path, { headers: { authorization: `Bearer ${DAEMON_KEY}` } }),
  post: (path, body) =>
    fetch(api.base() + path, {
      method: "POST",
      headers: { authorization: `Bearer ${DAEMON_KEY}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  json: async (p) => {
    const res = await p;
    return { status: res.status, data: await res.json().catch(() => null) };
  },
};

async function waitFor(pred, timeoutMs = 10000, what = "条件") {
  const t0 = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待 ${what} 超时`);
    await realSleep(2); // 密集轮询：tick 要在 15ms 碰撞窗内开火
  }
}

// 红线断言：窗口内任意两次上游调用 start 间隔 ≥1000ms（假时钟戳）
function assertRedLine(from, to = calls.length, what = "") {
  for (let i = from + 1; i < to; i++) {
    const d = calls[i].at - calls[i - 1].at;
    assert.ok(
      d >= 1000,
      `${what}第 ${i - 1 - from}→${i - from} 次上游调用间隔 ${d}ms < 1000ms：` +
        `${calls[i - 1].method} ${calls[i - 1].path} → ${calls[i].method} ${calls[i].path}`,
    );
  }
}

test("启动：真实 daemon（noTimers，手动驱动 tick）+ 真实引擎 + 假时钟/假上游", async () => {
  h = await startDaemon({
    args: { cfg: cfgDir, state: stateDir, port: "0", key: DAEMON_KEY },
    now: clock.now,
    sleep: clock.sleep,
    fetch: stubFetch,
    log: (...a) => daemonLogs.push(a.join(" ")),
    noTimers: true, // 全部定时器手动驱动：排程 tick 用 ticks.checkScheduler 精确点火
  });
  const hello = await (await fetch(api.base() + "/api/hello")).json();
  assert.equal(hello.ready, true);
});

// ---- A. job 刚结束 → 立刻触发快照刷新，撞上手动 claim ---------------------------

test("跨边界 A：job 收尾的 finalizeJob→refreshSnapshots 与手动 claim 并发，全程间隔 ≥1000ms", async () => {
  // 1. 跑一个最小的 travel job（traveling 状态 → 恰好一次上游调用）
  const r = await api.json(api.post("/api/run", { uids: [UID], legs: ["travel"] }));
  assert.equal(r.status, 200);
  const jobId = r.data.job.id;
  await waitFor(async () => {
    const j = (await api.json(api.get(`/api/jobs/${jobId}`))).data;
    return j.state === "done" || j.state === "error";
  }, 10000, "travel job 结束");
  const jobLastAt = calls[calls.length - 1].at;
  const from = calls.length - 1;

  // 2. job 刚结束：watchJobTick → finalizeJob → refreshSnapshots（fire-and-forget，
  //    生产里由 1s tick 驱动，这里手动调一次，等价于 tick 恰好落在 job 结束后）
  h.ticks.watchJob();

  // 3. 紧接着（几毫秒内）看板用户点了「领奖」→ 手动 claim 与快照刷新的等待窗重叠。
  //    修法之前：两条路径各自的固定 sleep 在共享假钟上同时到点 → 0ms 对（必挂）。
  await realSleep(3);
  const claimP = api.json(api.post("/api/task/claim", { uid: UID, code: "skill_1" }));

  // 4. 等快照刷新走完（streak 是 refreshSnapshots 对该账号的最后一次上游调用）
  const snapFrom = from;
  await waitFor(
    () => calls.slice(snapFrom).some((c) => c.path === "/activity/growth/streak"),
    10000,
    "快照刷新的 streak 调用",
  );
  await realSleep(30); // 尾部 1500ms 账号间隔拨表完成
  const claim = await claimP;
  assert.equal(claim.status, 200, "手动 claim 不应被 409/500 挡掉");
  assert.equal(claim.data.ok, true, "skill_1 已完成 → 领奖成功");

  // 5. 红线：从 job 的最后一次调用起，任意两次上游调用间隔 ≥1000ms
  assertRedLine(from, calls.length, "A（job 结束 → 快照刷新 × 手动 claim）：");
  assert.ok(calls[from].at >= jobLastAt, "窗口锚点即 job 最后一次调用");

  // 6. 快照确实刷新落库（两条路径都真正走完，而不是被闸门丢掉）
  const st = (await api.json(api.get("/api/state"))).data;
  const snap = st.accounts.find((a) => a.uid === UID)?.snapshot;
  assert.ok(snap?.tasks?.length >= 3, "快照刷新落库");
  assert.equal(snap.energy, 42);
});

// ---- B. 排程 tick 与手动 claim 并发 ----------------------------------------------

test("跨边界 B：排程 tick（checkScheduler→startJob）与手动 claim 并发，全程间隔 ≥1000ms", async () => {
  // 排程窗口设在当前**北京小时**（UTC+8）的 travel 腿 —— 引擎把窗口小时按北京
  // 时间解释（CONTRACT §7/§8，与容器时区无关），所以这里也按北京小时取值；
  // 再带上下一小时，钉死「设置 → 点火」之间跨北京整点也不会偶发不触发。
  // growth 已不在排程窗口里——排程只触发 travel/night，growth 只能手动跑。
  const hour = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
  const set = await api.json(api.post("/api/settings", { scheduler: true, hours: { travel: [hour, (hour + 1) % 24], night: [] } }));
  assert.equal(set.status, 200);
  assert.equal(set.data.scheduler, true);

  const from = calls.length;

  // 1. 先发手动 claim（manualOp 的 1500ms 节奏睡眠开始 → 假钟 +1500）
  const tBefore = clock.time;
  const claimP = api.json(api.post("/api/task/claim", { uid: UID, code: "skill_1" }));
  await waitFor(() => clock.time >= tBefore + 1500, 3000, "manualOp 进入节奏睡眠");
  //    此时 claim 尚未真正打上游（响应让出 15ms）——在这个碰撞窗内点火排程 tick
  const job = h.ticks.checkScheduler();
  assert.ok(job?.id, "排程窗口应触发 job");

  // 2. 等 job 结束 + claim 返回
  await waitFor(async () => {
    const j = (await api.json(api.get(`/api/jobs/${job.id}`))).data;
    return j.state === "done" || j.state === "error";
  }, 20000, "排程 job 结束");
  const claim = await claimP;
  assert.equal(claim.status, 200, "claim 在 job 启动前已被受理（非 409）");

  // 3. 红线：claim 与排程 job 的所有上游调用（travel 腿全程）两两间隔 ≥1000ms
  assertRedLine(from, calls.length, "B（排程 tick × 手动 claim）：");
  // 窗口锚点：claim 或排程 job 的第一条调用。runner 的「每日活跃」（CONTRACT §7）
  // 让排程 job 在腿之前多了一条计费域 /v2/report —— 它在 claim 还在 manualOp 的
  // 1500ms 节奏睡眠里时就已进入 spacer 队列，FIFO 下可能先于 claim 放行；两种
  // 次序都合法（spacer 保证串行 + ≥gap，红线断言在上面已经全窗校验过）。
  assert.ok(
    calls[from].path === "/activity/growth/tasks/skill_1/claim" || calls[from].path === "/v2/report",
    `窗口从 claim 或排程 job 的每日活跃开始，实际：${calls[from].path}`,
  );

  // 4. 排程 job 的 travel 腿真跑完了（traveling 状态 → 如实报告，腿本身 ok）
  const j = (await api.json(api.get(`/api/jobs/${job.id}`))).data;
  assert.equal(j.state, "done");
  assert.deepEqual(j.steps.map((s) => s.leg), ["travel"]);
  assert.equal(j.steps[0].state, "ok");
});

after(async () => {
  try {
    await h?.stop();
  } catch {}
  try {
    rootSb.cleanup();
  } catch {}
});
