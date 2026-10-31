// tests-shell/daily-activity.test.mjs —— 每日活跃的 daemon 持久化回归（真实
// daemon + 真实引擎 + 假时钟/假上游，零真实网络）。
//
// 钉死（CONTRACT §7「每日活跃」）：
//   1. job 开始前（无论跑哪些腿）每账号发一条 chat 事件到计费域 /v2/report；
//   2. 成功后原子写回 state/daily-activity.json（{uid:"YYYY-MM-DD"}）；
//   3. 同一北京日的第二个 job 不再发（「今日已报过」）；
//   4. 账本文件损坏 → 按空对象起步，不阻断启动，重新上报；
//   5. 上报失败不阻断腿（job 照常 done）。

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon } from "../daemon.mjs";
import { makeSandbox } from "../tests/helpers.mjs";

const DAEMON_KEY = "daily-e2e-key-0123456789abcdef";
const UID = "u-daily001";
const DAY = 86400000;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 与 tests-e2e/boundary-throttle 同款的假时钟：拨表 + 让出事件循环
function dailyClock(startMs) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      await realSleep(Math.min(ms, 15));
    },
    advance: (ms) => {
      t += ms;
    },
    get time() {
      return t;
    },
  };
}

// 锚在一个确定的北京正午（与本地时区无关）：2026-10-15 12:00 北京时间
const FAKE_START = Date.UTC(2026, 9, 15, 4, 0, 0);
const DAY_KEY_1 = "2026-10-15";
const DAY_KEY_2 = "2026-10-16";

const clock = dailyClock(FAKE_START);

// ---- 假上游：只服务 travel 腿所需的最小端点 + 记录 /v2/report ------------------
const reports = [];
const stubFetch = async (url, init = {}) => {
  const u = new URL(url);
  const path = decodeURIComponent(u.pathname);
  const uid = init.headers?.["X-User-Id"] ?? "";
  const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });

  if (path === "/v2/report") {
    let body = null;
    try {
      body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    } catch {}
    for (const ev of Array.isArray(body) ? body : []) reports.push({ uid, ev, host: u.host });
    return respond(200, { code: 0, data: {} });
  }
  if (path === "/v2/activity/growth/tasks") {
    return respond(200, { code: 0, data: { tasks: [] } });
  }
  if (path === "/v2/activity/growth/energy") return respond(200, { code: 0, data: { balance: 7 } });
  if (path === "/activity/growth/streak") return respond(200, { code: 0, data: { streak: { days: 1 } } });
  if (path === "/activity/growth/buddy/travel/status") return respond(200, { code: 0, data: { state: "traveling" } });
  return respond(404, { code: -1, msg: "not found" });
};

// ---- 夹具 ---------------------------------------------------------------------

const rootSb = makeSandbox("wb-tasks-daily-");
const root = rootSb.dir;
const cfgDir = join(root, "config");
const stateDir = join(cfgDir, "workbuddy-tasks", "state");
mkdirSync(stateDir, { recursive: true });
writeFileSync(join(cfgDir, "plugin-auth.json"), JSON.stringify({
  workbuddy: {
    type: "oauth",
    access: "wb-access-DAILY-0001",
    refresh: "wb-refresh-DAILY-0001",
    expires: FAKE_START + 30 * DAY,
    accountId: "daily-cat",
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
  post: (path, body) =>
    fetch(api.base() + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  json: async (p) => {
    const res = await p;
    return { status: res.status, data: await res.json().catch(() => null) };
  },
};

async function waitJobDone(jobId, what = "job 结束") {
  const t0 = Date.now();
  for (;;) {
    const res = await fetch(`${api.base()}/api/jobs/${jobId}`);
    const j = await res.json().catch(() => null);
    if (j && (j.state === "done" || j.state === "error")) return j;
    if (Date.now() - t0 > 15000) throw new Error(`等待 ${what} 超时`);
    await realSleep(2);
  }
}

async function boot() {
  return startDaemon({
    args: { cfg: cfgDir, state: stateDir, port: "0", key: DAEMON_KEY },
    now: clock.now,
    sleep: clock.sleep,
    fetch: stubFetch,
    log: (...a) => daemonLogs.push(a.join(" ")),
    noTimers: true,
  });
}

test("每日活跃：job 前发计费域 chat 事件 + 原子写回 daily-activity.json", async () => {
  h = await boot();
  const hello = await (await fetch(`${api.base()}/api/hello`)).json();
  assert.equal(hello.ready, true);

  reports.length = 0;
  const r = await api.json(api.post("/api/run", { uids: [UID], legs: ["travel"] }));
  assert.equal(r.status, 200);
  const job = await waitJobDone(r.data.job.id);
  assert.equal(job.state, "done", JSON.stringify(job.log));

  // 计费域一条 chat 事件（travel 腿本身不打 /v2/report）
  assert.equal(reports.length, 1, `应恰好一条每日活跃事件：${JSON.stringify(reports)}`);
  assert.equal(reports[0].host, "www.codebuddy.cn", "打计费域");
  assert.equal(reports[0].uid, UID);
  assert.equal(reports[0].ev.eventCode, "chat_request_send");
  assert.equal(reports[0].ev.userId, UID, "事件含 userId");
  assert.ok(job.log.some((l) => l.includes("每日活跃：已上报")), job.log.join("\n"));

  // 原子写回 state/daily-activity.json：{uid: 北京日键}
  const file = join(stateDir, "daily-activity.json");
  assert.ok(existsSync(file), "daily-activity.json 已落盘");
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(ledger, { [UID]: DAY_KEY_1 }, `账本内容：${JSON.stringify(ledger)}`);
});

test("每日活跃：同一北京日的第二个 job 不再发；跨日（注入时钟前进）再发", async () => {
  reports.length = 0;
  const r1 = await api.json(api.post("/api/run", { uids: [UID], legs: ["travel"] }));
  const job1 = await waitJobDone(r1.data.job.id);
  assert.equal(reports.length, 0, "同一天不重发");
  assert.ok(job1.log.some((l) => l.includes("每日活跃：今日已报过")), job1.log.join("\n"));

  // 时钟前进一天（注入 now，daemon 全程用它）→ 新北京日 → 再发一条并更新账本
  clock.advance(DAY);
  reports.length = 0;
  const r2 = await api.json(api.post("/api/run", { uids: [UID], legs: ["travel"] }));
  await waitJobDone(r2.data.job.id);
  assert.equal(reports.length, 1, "跨日再发");
  const ledger = JSON.parse(readFileSync(join(stateDir, "daily-activity.json"), "utf8"));
  assert.deepEqual(ledger, { [UID]: DAY_KEY_2 });

  await h.stop();
  h = null;
});

test("每日活跃：账本文件损坏 → 按空对象起步，不阻断启动，重新上报", async () => {
  writeFileSync(join(stateDir, "daily-activity.json"), "{corrupted json!!");
  daemonLogs.length = 0;

  h = await boot(); // 损坏文件不许把启动搞挂
  const hello = await (await fetch(`${api.base()}/api/hello`)).json();
  assert.equal(hello.ready, true, "引擎照常就绪");

  reports.length = 0;
  const r = await api.json(api.post("/api/run", { uids: [UID], legs: ["travel"] }));
  const job = await waitJobDone(r.data.job.id);
  assert.equal(job.state, "done");
  assert.equal(reports.length, 1, "账本作废 → 视作未报过 → 重发（上游按北京日幂等，无害）");
  // 下一次成功写回把文件修回合法 JSON
  const ledger = JSON.parse(readFileSync(join(stateDir, "daily-activity.json"), "utf8"));
  assert.deepEqual(ledger, { [UID]: DAY_KEY_2 });

  await h.stop();
  h = null;
});

after(async () => {
  try {
    await h?.stop();
  } catch {}
  try {
    rootSb.cleanup();
  } catch {}
});
