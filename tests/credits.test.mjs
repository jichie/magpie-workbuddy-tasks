// tests/credits.test.mjs —— engine/credits.fetchCredits 的单元回归（CONTRACT §2）。
// 全部走假 fetch + 假时钟（fakeClock 的 sleep 只拨表），零真实网络。
//
// 钉死的口径：
//   1. 三个 billing 上游（summary/free/paid）逐字：POST、计费域、头族加
//      X-Client-Platform: web、body 形状、PackageCodes 从 summary 去重；
//   2. 任意两次上游调用间隔 ≥1s（假时钟可断言，铁律 4）；
//   3. AccountId 去重（free+paid 合并）、totals/百分比、earliestExpiring；
//   4. tier：IsPaidUser 缺失 → tier=null 且 isPaidUser=null（不要瞎判免费）；
//   5. summary 失败 → {ok:false,error}；401/403/登录话术 → needRelogin:true；
//      free/paid 单个失败不整体失败；
//   6. 无包明细时回退 summary 的周期容量汇总；
//   7. 跨包过期/不过期哨兵（730 天）；
//   8. **北京时区字符串解析**：naive 的 "YYYY-MM-DD HH:mm:ss" 一律按 +08:00
//      转 epoch 再算 daysLeft（容器时区是 UTC 也不许错），epoch → 文本同样
//      固定北京时区。

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { fakeClock, cleanupAllSandboxes } from "./helpers.mjs";
import {
  beijingTextToMs,
  epochToBeijingText,
  fetchCredits,
  tierFromSummary,
} from "../engine/credits.mjs";
import { BILL_BASE } from "../engine/constants.mjs";

after(() => {
  cleanupAllSandboxes();
});

// 锚在确定的北京正午：2026-10-15 12:00:00 北京时间 = 04:00Z（与本地时区无关）。
const T0 = Date.UTC(2026, 9, 15, 4, 0, 0);

const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });
const okEnvelope = (data) => respond(200, { code: 0, msg: "success", data });

// 假 billing 上游：按路径应答，记录每次调用的时刻/头/body。
function billingStub(clock, { summary, free, paid } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const headers = init.headers ?? {};
    let body = null;
    if (typeof init.body === "string" && init.body.length) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({
      url,
      host: u.host,
      path: u.pathname,
      method: String(init.method || "GET").toUpperCase(),
      headers,
      body,
      rawBody: init.body,
      at: clock.now(),
    });
    if (u.pathname.endsWith("/get-user-resource-summary")) return summary ?? okEnvelope({});
    if (u.pathname.endsWith("/get-user-resource-free-packages")) return free ?? okEnvelope({ Accounts: [] });
    if (u.pathname.endsWith("/get-user-resource-paid-packages")) return paid ?? okEnvelope({ Accounts: [] });
    return respond(404, { code: -1, msg: "not found" });
  };
  return { calls, fetchImpl };
}

const acct = { uid: "u-credit001", access: "tok-credit", refresh: "r", domain: "", provider: "workbuddy" };

// 一个内容充实的 summary + free + paid 夹具（主回归用）。
function richFixtures() {
  const ded = beijingTextToMs("2035-01-01 00:00:00"); // 远超 730 天的抵扣截止哨兵
  const createMs = beijingTextToMs("2026-10-01 08:30:00");
  const summary = {
    IsPaidUser: true,
    SubscriptionPackageName: "Pro 年付",
    SubscriptionPackageCode: "pkg_pro",
    IsProtectedPriceUser: false,
    ProTrialStatus: 2,
    Packages: [{ PackageCode: "pkg_free" }, { PackageCode: "pkg_pro" }, { PackageCode: "pkg_free" }],
  };
  const freeAcctA = {
    AccountId: "a1",
    PackageName: "免费体验包",
    PackageCode: "pkg_free",
    ProductName: "WorkBuddy",
    SubProductName: "翻译助手",
    ResourceId: "res-1",
    DealName: "deal-1",
    AccountAttributes: [{ Key: "other", Value: "x" }, { Key: "grantReason", Value: "官方活动发放" }],
    CreateTime: createMs,
    CapacitySize: 1000,
    CapacityUsed: 600, // remain 缺失 → size-used 补齐 400
    CapacityUnit: "",
    InUsage: true,
    SupportAutoRenew: 1,
    CycleStartTime: "2026-10-01 00:00:00",
    CycleEndTime: "2026-10-31 00:00:00",
    DeductionEndTime: ded, // epoch ms → 北京文本，且超 730 天 → noExpiry
    Status: 0,
  };
  const paidAcctC = {
    AccountId: "a2",
    PackageName: "Pro 权益包",
    PackageCode: "pkg_pro",
    CapacitySizePrecise: 9500,
    CapacityRemainPrecise: 2500.5,
    CapacityUsedPrecise: 7000,
    CycleEndTime: "2026-10-16 12:00:00", // 周期结束 = 明天北京正午 → daysLeft 1
    Status: 3,
  };
  return {
    summary: okEnvelope(summary),
    freeAcctA,
    paidAcctC,
    free: okEnvelope({ Accounts: [freeAcctA] }),
    paid: okEnvelope({ Accounts: [paidAcctC, { ...freeAcctA, AccountId: "a1" }] }), // a1 重复 → 去重
  };
}

describe("fetchCredits：上游形状与节奏", () => {
  test("三个 billing 上游逐字对齐：POST/计费域/头族/body，PackageCodes 去重，间隔 ≥1s", async () => {
    const clock = fakeClock(T0);
    const { calls, fetchImpl } = billingStub(clock, richFixtures());
    const r = await fetchCredits(acct, { fetch: fetchImpl, now: clock.now, sleep: clock.sleep });
    assert.equal(r.ok, true);

    assert.equal(calls.length, 3, "恰好三次上游调用");
    for (const c of calls) {
      assert.equal(c.host, new URL(BILL_BASE).host, "全部打计费域");
      assert.equal(c.method, "POST");
      assert.equal(c.headers["X-Client-Platform"], "web", "billing 头族 + X-Client-Platform: web");
      assert.equal(c.headers["X-User-Id"], acct.uid);
      assert.equal(c.headers["Authorization"], `Bearer ${acct.access}`, "带凭据头");
      assert.ok(c.headers["X-Machine-ID"], "X-Machine-ID 由 billing 头族按账号派生");
      assert.ok(c.headers["X-Session-ID"], "X-Session-ID 同上");
    }
    assert.ok(calls[0].path.endsWith("/billing/meter/get-user-resource-summary"));
    assert.equal(calls[0].rawBody, "{}", "summary body 是字面 {}");
    assert.deepEqual(calls[0].body, {});
    assert.ok(calls[1].path.endsWith("/billing/meter/get-user-resource-free-packages"));
    assert.deepEqual(calls[1].body, { PackageCodes: ["pkg_free", "pkg_pro"], PageNumber: 1, PageSize: 200, Status: [0] });
    assert.ok(calls[2].path.endsWith("/billing/meter/get-user-resource-paid-packages"));
    assert.deepEqual(calls[2].body, {
      PackageCodes: ["pkg_free", "pkg_pro"],
      PageNumber: 1,
      PageSize: 200,
      Status: [0, 3],
      NeedRenewInfo: true,
    });

    // 铁律 4：相邻两次调用 start-to-start ≥1000ms（假时钟下 sleep 只拨表）
    assert.ok(calls[1].at - calls[0].at >= 1000, `free 与 summary 间隔 ${calls[1].at - calls[0].at}`);
    assert.ok(calls[2].at - calls[1].at >= 1000, `paid 与 free 间隔 ${calls[2].at - calls[1].at}`);
  });

  test("无 Packages 的 summary：不发 free/paid，一次上游都不多发", async () => {
    const clock = fakeClock(T0);
    const { calls, fetchImpl } = billingStub(clock, { summary: okEnvelope({}) });
    const r = await fetchCredits(acct, { fetch: fetchImpl, now: clock.now, sleep: clock.sleep });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(r.credits.packages, []);
    assert.equal(r.credits.size, 0);
    assert.equal(r.credits.usedPercent, "0.0%");
    assert.equal(r.credits.remainPercent, "100.0%");
    assert.equal(r.credits.earliestExpiring, null);
  });
});

describe("fetchCredits：解析与汇总（rich fixture）", () => {
  test("AccountId 去重、字段归一、totals/百分比、earliestExpiring、tier", async () => {
    const clock = fakeClock(T0);
    const { fetchImpl } = billingStub(clock, richFixtures());
    const r = await fetchCredits(acct, { fetch: fetchImpl, now: clock.now, sleep: clock.sleep });
    assert.equal(r.ok, true);
    const c = r.credits;

    assert.equal(c.packages.length, 2, "a1 在 free/paid 各出现一次 → 去重成一条");
    const [a, b] = c.packages;

    // 包 A：免费体验包。remain 缺失由 size-used 补齐；DeductionEndTime 超哨兵 → noExpiry
    assert.equal(a.name, "免费体验包");
    assert.equal(a.packageCode, "pkg_free");
    assert.equal(a.productName, "WorkBuddy");
    assert.equal(a.subProductName, "翻译助手");
    assert.equal(a.grantReason, "官方活动发放");
    assert.equal(a.resourceId, "res-1");
    assert.equal(a.dealName, "deal-1");
    assert.equal(a.createTime, "2026-10-01 08:30:00", "CreateTime epoch ms → 北京时区文本");
    assert.equal(a.size, 1000);
    assert.equal(a.used, 600);
    assert.equal(a.remain, 400);
    assert.equal(a.unit, "credits", "CapacityUnit 为空回退 credits");
    assert.equal(a.inUsage, true);
    assert.equal(a.autoRenew, true, "SupportAutoRenew 真值 → autoRenew");
    assert.equal(a.cycleStartTime, "2026-10-01 00:00:00");
    assert.equal(a.cycleEndTime, "2026-10-31 00:00:00");
    assert.equal(a.expireTime, "2035-01-01 00:00:00", "到期认 DeductionEndTime 的北京文本");
    assert.equal(a.noExpiry, true, "抵扣截止超 730 天 → 不过期哨兵");
    assert.equal(a.daysLeft, null);
    assert.equal(a.isExpired, false);

    // 包 B：Pro 权益包。Precise 字段优先；明天北京正午到期 → daysLeft 1
    assert.equal(b.name, "Pro 权益包");
    assert.equal(b.packageCode, "pkg_pro");
    assert.equal(b.size, 9500);
    assert.equal(b.remain, 2500.5);
    assert.equal(b.used, 7000);
    assert.equal(b.expireTime, "2026-10-16 12:00:00");
    assert.equal(b.noExpiry, false);
    assert.equal(b.daysLeft, 1);
    assert.equal(b.isExpired, false);
    assert.equal(b.inUsage, true, "未过期且 remain>0 && used>0 → 推断在用");
    assert.equal(b.status, 3);

    // 汇总：sum(remain)=2900.5, sum(used)=7600, sum(size)=10500
    assert.equal(c.remain, 2900.5);
    assert.equal(c.used, 7600);
    assert.equal(c.size, 10500);
    assert.equal(c.usedPercent, "72.4%");
    assert.equal(c.remainPercent, "27.6%");

    // earliestExpiring：有剩余 + 未过期 + daysLeft 可算，按 daysLeft 升序第一个
    assert.deepEqual(c.earliestExpiring, {
      name: "Pro 权益包",
      packageCode: "pkg_pro",
      remain: 2500.5,
      cycleEndTime: "2026-10-16 12:00:00",
      daysLeft: 1,
    });

    // tier / isPaidUser
    assert.deepEqual(c.tier, { paid: true, package: "Pro 年付", packageCode: "pkg_pro", protectedPrice: false, trial: 2 });
    assert.equal(c.isPaidUser, true);

    // 时间戳：updatedAt 为注入 now 的终值（两次 breathe 各 +1000ms），updatedIso 北京时区
    assert.equal(c.updatedAt, T0 + 2000);
    assert.equal(c.updatedIso, "2026-10-15 12:00:02");
  });
});

describe("fetchCredits：失败路径与回退", () => {
  test("summary 401 → {ok:false, needRelogin:true}", async () => {
    const clock = fakeClock(T0);
    const { fetchImpl } = billingStub(clock, { summary: respond(401, { code: 12153, msg: "unauthorized" }) });
    const r = await fetchCredits(acct, { fetch: fetchImpl, now: clock.now, sleep: clock.sleep });
    assert.equal(r.ok, false);
    assert.equal(r.needRelogin, true);
    assert.ok(r.error);
    assert.equal(r.credits, undefined);
  });

  test("summary 403（风控）也按 needRelogin 处理", async () => {
    const clock = fakeClock(T0);
    const { fetchImpl } = billingStub(clock, { summary: respond(403, { code: 11140, msg: "request illegal" }) });
    const r = await fetchCredits(acct, { fetch: fetchImpl, now: clock.now, sleep: clock.sleep });
    assert.equal(r.ok, false);
    assert.equal(r.needRelogin, true);
  });

  test("信封失败但 msg 带「登录已过期」→ needRelogin（状态码不是 401 也认）", async () => {
    const clock = fakeClock(T0);
    const { fetchImpl } = billingStub(clock, { summary: respond(200, { code: 500, msg: "登录已过期，请重新登录" }) });
    const r = await fetchCredits(acct, { fetch: fetchImpl, now: clock.now, sleep: clock.sleep });
    assert.equal(r.ok, false);
    assert.equal(r.needRelogin, true);
    assert.match(r.error, /登录已过期/);
  });

  test("普通信封失败不带 needRelogin；free/paid 单个失败不整体失败", async () => {
    const clock = fakeClock(T0);
    const fx = richFixtures();
    fx.free = respond(400, { code: -1, msg: "bad request" }); // free 来源整体失败
    fx.paid = okEnvelope({ Accounts: [fx.paidAcctC] });
    const { fetchImpl } = billingStub(clock, fx);
    const r = await fetchCredits(acct, { fetch: fetchImpl, now: clock.now, sleep: clock.sleep });
    assert.equal(r.ok, true, "free 挂了不影响整体");
    assert.deepEqual(
      r.credits.packages.map((p) => p.packageCode),
      ["pkg_pro"],
      "只剩 paid 来源的包",
    );
  });

  test("无包明细时回退 summary 的周期容量汇总（CycleTotal/Remain/UsedCapacity）", async () => {
    const clock = fakeClock(T0);
    const { fetchImpl } = billingStub(clock, {
      summary: okEnvelope({
        Packages: [{ PackageCode: "p1", CycleTotalCapacity: 500, CycleRemainCapacity: 200, CycleUsedCapacity: 300 }],
      }),
      free: okEnvelope({ Accounts: [] }),
      paid: okEnvelope({ Accounts: [] }),
    });
    const r = await fetchCredits(acct, { fetch: fetchImpl, now: clock.now, sleep: clock.sleep });
    assert.equal(r.ok, true);
    assert.deepEqual(r.credits.packages, []);
    assert.equal(r.credits.size, 500);
    assert.equal(r.credits.remain, 200);
    assert.equal(r.credits.used, 300);
    assert.equal(r.credits.usedPercent, "60.0%");
    assert.equal(r.credits.remainPercent, "40.0%");
    assert.equal(r.credits.earliestExpiring, null);
  });

  test("summary 没有 IsPaidUser 字段 → tier=null、isPaidUser=null（不要瞎判免费）", async () => {
    const clock = fakeClock(T0);
    const { fetchImpl } = billingStub(clock, {
      summary: okEnvelope({ Packages: [{ PackageCode: "p1", CycleTotalCapacity: 10, CycleRemainCapacity: 10, CycleUsedCapacity: 0 }] }),
    });
    const r = await fetchCredits(acct, { fetch: fetchImpl, now: clock.now, sleep: clock.sleep });
    assert.equal(r.ok, true);
    assert.equal(r.credits.tier, null);
    assert.equal(r.credits.isPaidUser, null);
  });
});

describe("fetchCredits：到期语义（跨包过期 / noExpiry / 北京时区）", () => {
  const fixtures = (extra) => ({
    summary: okEnvelope({ Packages: [{ PackageCode: "p1" }] }),
    free: okEnvelope({
      Accounts: [{ AccountId: "x", PackageCode: "p1", CapacitySize: 100, CapacityRemain: 50, CapacityUsed: 50, ...extra }],
    }),
    paid: okEnvelope({ Accounts: [] }),
  });

  test("过期的包：daysLeft 为负、isExpired=true，且不进 earliestExpiring", async () => {
    const clock = fakeClock(T0);
    const { fetchImpl } = billingStub(clock, fixtures({ CycleEndTime: "2026-10-01 12:00:00" })); // 14 天前（北京）
    const r = await fetchCredits(acct, { fetch: fetchImpl, now: clock.now, sleep: clock.sleep });
    const p = r.credits.packages[0];
    assert.equal(p.isExpired, true);
    assert.equal(p.daysLeft, -14);
    assert.equal(p.inUsage, false, "过期包不推断在用");
    assert.equal(r.credits.earliestExpiring, null, "earliest 只要没过期的");
  });

  test("naive 字符串按北京时区（+08:00）解析：错按 UTC 会差 8 小时", async () => {
    // now = 北京 15 日正午（04:00Z）；到期串 "2026-10-15 11:30:00" 是北京 03:30Z
    // → 已过期 30 分钟。若被错按宿主/UTC 解析成 11:30Z，则还剩 7.5 小时（未过期）。
    const clock = fakeClock(T0);
    const { fetchImpl } = billingStub(clock, fixtures({ CycleEndTime: "2026-10-15 11:30:00" }));
    const r = await fetchCredits(acct, { fetch: fetchImpl, now: clock.now, sleep: clock.sleep });
    const p = r.credits.packages[0];
    assert.equal(p.isExpired, true, "按北京时间解析 → 已过期");
    assert.equal(p.daysLeft, 0, "-0.02 天四舍五入到 1 位 = 0");
  });

  test("解析不出的到期字符串：daysLeft=null、isExpired=false，宁缺毋错", async () => {
    const clock = fakeClock(T0);
    const { fetchImpl } = billingStub(clock, fixtures({ CycleEndTime: "not-a-date" }));
    const r = await fetchCredits(acct, { fetch: fetchImpl, now: clock.now, sleep: clock.sleep });
    const p = r.credits.packages[0];
    assert.equal(p.daysLeft, null);
    assert.equal(p.isExpired, false);
    assert.equal(p.noExpiry, false);
  });

  test("DeductionEndTime 优先于 CycleEndTime；秒值 epoch（<1e11）也能解析", async () => {
    const clock = fakeClock(T0);
    const dedSec = Math.floor(beijingTextToMs("2026-10-18 20:00:00") / 1000); // 秒
    const { fetchImpl } = billingStub(clock, fixtures({ CycleEndTime: "2026-10-31 00:00:00", DeductionEndTime: dedSec }));
    const r = await fetchCredits(acct, { fetch: fetchImpl, now: clock.now, sleep: clock.sleep });
    const p = r.credits.packages[0];
    assert.equal(p.expireTime, "2026-10-18 20:00:00");
    assert.equal(p.daysLeft, 3.3, "15 日正午 → 18 日 20:00 = 3 天 8 小时（1 位小数）");
    assert.equal(p.noExpiry, false);
  });

  test("noExpiry：抵扣截止远超 730 天 → daysLeft=null，不参与 earliest", async () => {
    const clock = fakeClock(T0);
    const { fetchImpl } = billingStub(clock, fixtures({ CycleEndTime: "2026-10-16 12:00:00", DeductionEndTime: beijingTextToMs("2034-06-01 00:00:00") }));
    const r = await fetchCredits(acct, { fetch: fetchImpl, now: clock.now, sleep: clock.sleep });
    const p = r.credits.packages[0];
    assert.equal(p.noExpiry, true, "DeductionEndTime 落在 2034 → 哨兵");
    assert.equal(p.daysLeft, null);
    assert.equal(p.expireTime, "2034-06-01 00:00:00");
    assert.equal(r.credits.earliestExpiring, null);
  });
});

describe("时间工具与 tier（导出的纯函数）", () => {
  test("epochToBeijingText / beijingTextToMs 互逆且与宿主时区无关", () => {
    const ms = Date.UTC(2026, 0, 1, 20, 30, 5); // 北京 2026-01-02 04:30:05
    assert.equal(epochToBeijingText(ms), "2026-01-02 04:30:05");
    assert.equal(beijingTextToMs("2026-01-02 04:30:05"), ms);
    assert.equal(beijingTextToMs("2026-01-02T04:30:05"), ms, "T 分隔也认");
    assert.equal(beijingTextToMs("2026-01-02 04:30"), null, "不完整格式拒绝");
    assert.equal(beijingTextToMs("2026-13-99 99:99:99"), null, "非法分量拒绝");
    assert.equal(epochToBeijingText(NaN), "");
  });

  test("tierFromSummary：缺 IsPaidUser → null；trial 非数值归 0", () => {
    assert.equal(tierFromSummary({}), null);
    assert.equal(tierFromSummary(null), null);
    assert.equal(tierFromSummary("x"), null);
    assert.deepEqual(tierFromSummary({ IsPaidUser: false, ProTrialStatus: "abc" }), {
      paid: false,
      package: "",
      packageCode: "",
      protectedPrice: false,
      trial: 0,
    });
  });
});
