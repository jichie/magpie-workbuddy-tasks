// tests-shell/credits-routes.test.mjs —— GET /api/credits 路由与 state/credits.json
// 缓存的守护进程回归（真实 daemon + 真实引擎 + 假时钟/假上游，零真实网络）。
//
// 钉死（CONTRACT §3「积分余额」）：
//   1. uid 找不到 / API key 账号 → 404（可参与口径与 eligibleAccounts 一致）；
//   2. 首次 GET 拉取上游（3 次 billing 调用）→ 200 {ok:true,uid,nickname,credits}
//      并原子写回 state/credits.json；
//   3. 缓存 < CREDITS_TTL_MS 且未 refresh → 直接回缓存，一次上游都不发；
//      TTL 过期后重新拉取；refresh=1 强制拉取；
//   4. job 在跑（runner.current()）→ 没缓存或 refresh=1 时 409 busy；
//      有缓存且未 refresh → 仍直接回缓存（哪怕已过期）；
//   5. 上游失败（401）→ 200 {ok:false,needRelogin}，旧缓存保留并一并带回；
//   6. /api/state 的 accounts[].credits 只读投影（绝不在 state 请求里打上游）；
//   7. 损坏的 credits.json → 按空对象起步，不阻断启动。

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon, CREDITS_TTL_MS, API_ROUTE_AUTH } from "../daemon.mjs";
import { makeSandbox, cleanupAllSandboxes } from "../tests/helpers.mjs";

const DAEMON_KEY = "credits-shell-key-0123456789";
const UID = "u-credit001";
const DAY = 86400000;
// 锚在确定的北京正午：2026-10-15 12:00 北京 = 04:00Z（与本地时区无关）。
const NOW = Date.UTC(2026, 9, 15, 4, 0, 0);
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 与 tests-shell/daily-activity 同款的假时钟：拨表 + 让出事件循环。
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
const clock = dailyClock(NOW);

// ---- 假上游：三个 billing 积分端点 + 最小 travel/任务应答 -----------------------
const CREDITS_FIXTURE = {
  remain: 2900.5,
  used: 7600,
  size: 10500,
  packages: 2,
};
function makeStub({ summaryStatus = 200, summaryBody } = {}) {
  const calls = [];
  const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  const ok = (data) => respond(200, { code: 0, msg: "success", data });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const uid = init.headers?.["X-User-Id"] ?? "";
    calls.push({ uid, path: u.pathname, host: u.host, at: clock.now() });
    if (u.pathname.endsWith("/get-user-resource-summary")) {
      if (summaryStatus !== 200) return respond(summaryStatus, { code: 12153, msg: "unauthorized" });
      return (
        summaryBody ??
        ok({
          IsPaidUser: true,
          SubscriptionPackageName: "Pro 年付",
          SubscriptionPackageCode: "pkg_pro",
          IsProtectedPriceUser: false,
          ProTrialStatus: 0,
          Packages: [{ PackageCode: "pkg_free" }, { PackageCode: "pkg_pro" }],
        })
      );
    }
    if (u.pathname.endsWith("/get-user-resource-free-packages")) {
      return ok({
        Accounts: [
          {
            AccountId: "a1",
            PackageName: "免费体验包",
            PackageCode: "pkg_free",
            CapacitySize: 1000,
            CapacityUsed: 600,
            CycleEndTime: "2026-10-31 00:00:00",
            Status: 0,
          },
        ],
      });
    }
    if (u.pathname.endsWith("/get-user-resource-paid-packages")) {
      return ok({
        Accounts: [
          {
            AccountId: "a2",
            PackageName: "Pro 权益包",
            PackageCode: "pkg_pro",
            CapacitySizePrecise: 9500,
            CapacityRemainPrecise: 2500.5,
            CapacityUsedPrecise: 7000,
            CycleEndTime: "2026-10-16 12:00:00",
            Status: 3,
          },
        ],
      });
    }
    if (u.pathname === "/v2/activity/growth/tasks") return ok({ tasks: [] });
    return respond(404, { code: -1, msg: "not found" });
  };
  return { calls, fetchImpl };
}

// ---- 夹具 ---------------------------------------------------------------------
const rootSb = makeSandbox("wb-tasks-credits-");
const root = rootSb.dir;
const cfgDir = join(root, "config");
const stateDir = join(cfgDir, "workbuddy-tasks", "state");
mkdirSync(stateDir, { recursive: true });
writeFileSync(
  join(cfgDir, "plugin-auth.json"),
  JSON.stringify({
    workbuddy: {
      type: "oauth",
      access: "wb-access-CREDIT-0001",
      refresh: "wb-refresh-CREDIT-0001",
      expires: NOW + 30 * DAY,
      accountId: "cred-acct",
      uid: UID,
      domain: "copilot.tencent.com",
      tokenType: "Bearer",
    },
    "workbuddy#apikey1": { type: "api", key: "ck_credit.abcdef", accountId: "cred-key" },
  }),
);
writeFileSync(join(cfgDir, "plugins.json"), JSON.stringify({ plugins: [{ spec: "github:me/magpie-workbuddy-tasks" }] }));
writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ scheduler: false }));

const daemonLogs = [];
let h = null;
let stub = makeStub();
const creditsFile = join(stateDir, "credits.json");

const base = () => `http://127.0.0.1:${h.port}`;
const creditsUrl = (uid, refresh) => `${base()}/api/credits?uid=${encodeURIComponent(uid)}${refresh ? `&refresh=${refresh}` : ""}`;

async function boot({ runner, stubOverrides } = {}) {
  stub = makeStub(stubOverrides ?? {});
  return startDaemon({
    args: { cfg: cfgDir, state: stateDir, port: "0", key: DAEMON_KEY },
    now: clock.now,
    sleep: clock.sleep,
    fetch: stub.fetchImpl,
    log: (...a) => daemonLogs.push(a.join(" ")),
    noTimers: true,
    skipExistingCheck: true,
    ...(runner ? { runner } : {}),
  });
}

after(async () => {
  try {
    await h?.stop();
  } catch {}
  cleanupAllSandboxes();
});

test("路由登记表包含 GET /api/credits（全路由免密钥口径）", () => {
  const row = API_ROUTE_AUTH.find((r) => r.path === "/api/credits");
  assert.ok(row, "/api/credits 已登记");
  assert.equal(row.method, "GET");
  assert.ok(row.re.test("/api/credits"));
});

test("404：未知 uid 与 API key 账号都不参与积分查询", async () => {
  h = await boot();
  const r1 = await fetch(creditsUrl("u-nosuch"));
  assert.equal(r1.status, 404);
  const j1 = await r1.json();
  assert.match(j1.error, /u-nosuch/);

  // API key 账号的 uid 从 /api/state 读出（避免对派生规则硬编码）
  const st = await (await fetch(`${base()}/api/state`)).json();
  const keyRow = st.accounts.find((a) => a.masked.startsWith("API key"));
  assert.ok(keyRow, "API key 账号出现在列表里");
  const r2 = await fetch(creditsUrl(keyRow.uid));
  assert.equal(r2.status, 404);
  assert.equal(stub.calls.length, 0, "两次 404 都没打上游");
});

test("首次 GET 拉取上游并写 state/credits.json；/api/state 只读投影该缓存", async () => {
  const r = await fetch(creditsUrl(UID));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.uid, UID);
  assert.equal(j.nickname, "cred-acct");
  assert.equal(j.credits.remain, CREDITS_FIXTURE.remain);
  assert.equal(j.credits.size, CREDITS_FIXTURE.size);
  assert.equal(j.credits.packages.length, CREDITS_FIXTURE.packages);
  assert.equal(stub.calls.length, 3, "恰好 3 次 billing 上游");
  assert.ok(stub.calls.every((c) => c.uid === UID));

  assert.ok(existsSync(creditsFile), "credits.json 已落盘");
  const persisted = JSON.parse(readFileSync(creditsFile, "utf8"));
  assert.deepEqual(persisted[UID], j.credits, "落盘内容 = 响应里的 credits");
  assert.ok(persisted[UID].updatedAt > 0 && persisted[UID].updatedIso, "带 updatedAt/updatedIso");

  // /api/state 投影：accounts[].credits = 缓存（不发上游）
  const n = stub.calls.length;
  const st = await (await fetch(`${base()}/api/state`)).json();
  const row = st.accounts.find((a) => a.uid === UID);
  assert.deepEqual(row.credits, j.credits, "state 投影缓存");
  assert.equal(stub.calls.length, n, "/api/state 没有打上游");
});

test("缓存 TTL 内不发上游；refresh=1 强制拉取；TTL 过期后重新拉取", async () => {
  const n0 = stub.calls.length;
  const r1 = await fetch(creditsUrl(UID));
  const j1 = await r1.json();
  assert.equal(j1.ok, true);
  assert.equal(stub.calls.length, n0, "TTL 内直接回缓存");

  const r2 = await fetch(creditsUrl(UID, 1));
  const j2 = await r2.json();
  assert.equal(j2.ok, true);
  assert.equal(stub.calls.length, n0 + 3, "refresh=1 强制重新拉取");
  assert.ok(j2.credits.updatedAt > j1.credits.updatedAt, "新缓存时间戳更新");

  clock.advance(CREDITS_TTL_MS + 1);
  const n2 = stub.calls.length;
  const r3 = await fetch(creditsUrl(UID));
  const j3 = await r3.json();
  assert.equal(j3.ok, true);
  assert.equal(stub.calls.length, n2 + 3, "TTL 过期 → 重新拉取");
  assert.deepEqual(j3.credits.packages.length, CREDITS_FIXTURE.packages);
});

test("job 在跑：无缓存 → 409 busy；有过期缓存且未 refresh → 回缓存；refresh=1 → 409", async () => {
  await h.stop();
  // 新 state 目录 + 预置一份「已过期」的缓存（updatedAt = NOW - TTL - 1）
  const sb2 = makeSandbox("wb-tasks-credits-busy-");
  const cfg2 = join(sb2.dir, "config");
  const state2 = join(cfg2, "workbuddy-tasks", "state");
  mkdirSync(state2, { recursive: true });
  writeFileSync(join(cfg2, "plugin-auth.json"), readFileSync(join(cfgDir, "plugin-auth.json"), "utf8"));
  writeFileSync(join(cfg2, "plugins.json"), readFileSync(join(cfgDir, "plugins.json"), "utf8"));
  const staleCredits = { remain: 1, used: 2, size: 3, usedPercent: "66.7%", remainPercent: "33.3%", isPaidUser: null, tier: null, earliestExpiring: null, packages: [], updatedAt: NOW - CREDITS_TTL_MS - 1, updatedIso: "2026-10-14 11:59:59" };
  writeFileSync(join(state2, "credits.json"), JSON.stringify({ [UID]: staleCredits }));

  const busyRunner = { current: () => ({ id: "job-busy" }) };
  let h2 = null;
  try {
    stub = makeStub();
    h2 = await startDaemon({
      args: { cfg: cfg2, state: state2, port: "0", key: DAEMON_KEY },
      now: clock.now,
      sleep: clock.sleep,
      fetch: stub.fetchImpl,
      log: (...a) => daemonLogs.push(a.join(" ")),
      noTimers: true,
      skipExistingCheck: true,
      runner: busyRunner,
    });
    const b = `http://127.0.0.1:${h2.port}`;
    const f = (p) => fetch(`${b}${p}`);

    const r1 = await f(`/api/credits?uid=${UID}&refresh=1`);
    assert.equal(r1.status, 409, "refresh=1 且 busy → 409");
    assert.deepEqual(await r1.json(), { error: "busy" });
    assert.equal(stub.calls.length, 0);

    const r2 = await f(`/api/credits?uid=${UID}`);
    assert.equal(r2.status, 200, "有过期缓存且未 refresh → 直接回缓存，不打上游");
    const j2 = await r2.json();
    assert.equal(j2.ok, true);
    assert.deepEqual(j2.credits, staleCredits, "旧缓存原样带回");
    assert.equal(stub.calls.length, 0);

    const r3 = await f(`/api/credits?uid=u-nocache&refresh=1`);
    assert.equal(r3.status, 404, "uid 不存在优先 404");
  } finally {
    try {
      await h2?.stop();
    } catch {}
    sb2.cleanup();
  }

  // 无缓存的 busy → 409（再起一个空 state 的实例）
  const sb3 = makeSandbox("wb-tasks-credits-busy2-");
  const cfg3 = join(sb3.dir, "config");
  const state3 = join(cfg3, "workbuddy-tasks", "state");
  mkdirSync(state3, { recursive: true });
  writeFileSync(join(cfg3, "plugin-auth.json"), readFileSync(join(cfgDir, "plugin-auth.json"), "utf8"));
  writeFileSync(join(cfg3, "plugins.json"), readFileSync(join(cfgDir, "plugins.json"), "utf8"));
  let h3 = null;
  try {
    stub = makeStub();
    h3 = await startDaemon({
      args: { cfg: cfg3, state: state3, port: "0", key: DAEMON_KEY },
      now: clock.now,
      sleep: clock.sleep,
      fetch: stub.fetchImpl,
      log: (...a) => daemonLogs.push(a.join(" ")),
      noTimers: true,
      skipExistingCheck: true,
      runner: { current: () => ({ id: "job-busy" }) },
    });
    const r = await fetch(`http://127.0.0.1:${h3.port}/api/credits?uid=${UID}`);
    assert.equal(r.status, 409, "没缓存且 busy → 409");
    assert.deepEqual(await r.json(), { error: "busy" });
    assert.equal(stub.calls.length, 0);
  } finally {
    try {
      await h3?.stop();
    } catch {}
    sb3.cleanup();
  }
  h = await boot(); // 恢复主实例供后续用例
});

test("上游 401：200 {ok:false, needRelogin}，旧缓存保留并一并带回", async () => {
  const before = JSON.parse(readFileSync(creditsFile, "utf8"));
  await h.stop();
  h = await boot({ stubOverrides: { summaryStatus: 401 } });
  const r = await fetch(creditsUrl(UID, 1)); // 强制拉取，绕开 TTL
  assert.equal(r.status, 200, "上游失败也是 200（ok:false 表达）");
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.needRelogin, true);
  assert.ok(j.error);
  assert.deepEqual(j.credits, before[UID], "旧缓存一并带回");
  const after = JSON.parse(readFileSync(creditsFile, "utf8"));
  assert.deepEqual(after, before, "失败不清掉旧缓存");
});

test("损坏的 credits.json → 按空对象起步，不阻断启动，重新拉取后写回合法 JSON", async () => {
  await h.stop();
  writeFileSync(creditsFile, "{corrupted credits!!");
  h = await boot();
  const st = await (await fetch(`${base()}/api/state`)).json();
  const row = st.accounts.find((a) => a.uid === UID);
  assert.equal(row.credits, null, "损坏缓存视作没有");
  const r = await fetch(creditsUrl(UID));
  const j = await r.json();
  assert.equal(j.ok, true, "照常拉取");
  assert.equal(stub.calls.length, 3);
  const persisted = JSON.parse(readFileSync(creditsFile, "utf8"));
  assert.equal(persisted[UID].remain, CREDITS_FIXTURE.remain, "写回合法 JSON");
});
