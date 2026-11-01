import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SCHEDULE_WINDOWS,
  accountGapMs,
  dueWindows,
  inNightWindow,
  legsForHour,
  nextRuns,
  windowsAt,
} from "../engine/schedule.mjs";
import { beijingDateKey, beijingHour } from "../engine/constants.mjs";
import { fakeClock } from "./helpers.mjs";

// 北京墙上时间 → 显式 UTC epoch 毫秒。绝不使用 new Date(y,m,d,h)（那是宿主时区
// 构造，测试结果会随机器时区漂移）；固定 UTC+8 偏移与引擎的北京时间口径一致，
// Date.UTC 对负小时/越界分量自动归一化（h=1 → 前一天 17 点）。
const bj = (y, monthIndex, day, hour, minute = 0) => Date.UTC(y, monthIndex, day, hour - 8, minute);

test("beijingHour：UTC 01:00 = 北京 09:00；UTC 17:00 = 北京次日 01:00（生产 bug 回归）", () => {
  // UTC 容器里 getHours() 曾把北京 09:00 读成 1 —— 这里钉死正确换算
  assert.equal(beijingHour(Date.UTC(2026, 8, 15, 1, 0)), 9);
  assert.equal(beijingHour(Date.UTC(2026, 8, 15, 17, 0)), 1, "UTC 17:00 是北京次日 01:00");
  assert.equal(beijingHour(Date.UTC(2026, 8, 15, 0, 0)), 8, "北京 08:00 夜窗上界");
  assert.equal(beijingHour(Date.UTC(2026, 8, 15, 15, 59)), 23);
  assert.equal(beijingHour(Date.UTC(2026, 8, 15, 16, 0)), 0, "UTC 16:00 整翻北京零点");
  assert.equal(beijingHour(Date.UTC(2026, 8, 15, 23, 0)), 7, "UTC 23:00 是北京次日 07:00");
});

test("beijingDateKey：北京日期 YYYY-MM-DD，UTC 16:00 翻北京日，跨日键正确", () => {
  assert.equal(beijingDateKey(Date.UTC(2026, 8, 14, 15, 59, 59, 999)), "2026-09-14", "北京 23:59:59.999 还是当天");
  assert.equal(beijingDateKey(Date.UTC(2026, 8, 14, 16, 0)), "2026-09-15", "UTC 16:00 整翻到北京次日");
  assert.equal(beijingDateKey(Date.UTC(2026, 8, 14, 17, 0)), "2026-09-15", "北京次日 01:00 的日期键是新的一天");
  assert.equal(beijingDateKey(Date.UTC(2026, 8, 15, 1, 0)), "2026-09-15", "北京 09:00 当天");
  // 月/日补零
  assert.equal(beijingDateKey(Date.UTC(2026, 0, 5, 0, 0)), "2026-01-05", "北京 2026-01-05 08:00");
});

test("窗口表：09:00/21:00 猫猫旅行，01:00 夜猫；growth 不在任何窗口", () => {
  assert.deepEqual(legsForHour(9), ["travel"]);
  assert.deepEqual(legsForHour(21), ["travel"]);
  assert.deepEqual(legsForHour(1), ["night"]);
  assert.deepEqual(legsForHour(12), []);
  assert.deepEqual(SCHEDULE_WINDOWS.map((w) => w.hour).sort((a, b) => a - b), [1, 9, 21]);
  // 排程刻意不触发成长任务（只能手动跑）：全表展开也不该出现 growth
  for (let h = 0; h < 24; h++) assert.ok(!legsForHour(h).includes("growth"), `小时 ${h} 不该有 growth`);
});

test("windowsAt：命中当前北京小时的窗口（UTC 时间戳显式给出）", () => {
  assert.deepEqual(windowsAt(bj(2026, 8, 15, 9, 30)).map((w) => w.hour), [9]);
  assert.deepEqual(windowsAt(bj(2026, 8, 15, 1, 5)).map((w) => w.legs), [["night"]]);
  assert.deepEqual(windowsAt(bj(2026, 8, 15, 12, 0)), []);
});

test("windowsAt 生产 bug 回归：UTC 01:00（北京 09:00）是 travel 绝不是 night；UTC 17:00（北京次日 01:00）是 night", () => {
  // 生产事故现场：容器 UTC，北京 09:00 = UTC 01:00，旧 getHours() 得 1 → 误跑夜猫子
  const w = windowsAt(Date.UTC(2026, 8, 15, 1, 0));
  assert.deepEqual(w.map((x) => x.legs), [["travel"]], "UTC 01:00 = 北京 09:00 → 猫猫旅行");
  assert.ok(!JSON.stringify(w).includes("night"), "绝不能命中夜猫子");
  // UTC 17:00 = 北京次日 01:00 → 夜猫子
  assert.deepEqual(windowsAt(Date.UTC(2026, 8, 14, 17, 0)).map((x) => x.legs), [["night"]]);
});

test("nextRuns：严格未来、按时间排序、格式 [leg, hour]", () => {
  // 北京 10:00 → 下一个窗口是 21:00（travel），再下一天 01:00（night）、09:00…
  const now = bj(2026, 8, 15, 10, 0);
  const runs = nextRuns(now, 5);
  assert.deepEqual(runs, [
    ["travel", 21],
    ["night", 1], ["travel", 9],
    ["travel", 21], ["night", 1],
  ]);
  // 恰好在北京 09:00:00 整点 → 09:00 视为已过（严格未来）
  const now2 = bj(2026, 8, 15, 9, 0);
  assert.deepEqual(nextRuns(now2, 2), [["travel", 21], ["night", 1]]);
  // 北京 23:30 的下一个窗口是次日 01:00（夜猫子）——跨北京日
  assert.deepEqual(nextRuns(bj(2026, 8, 15, 23, 30), 1), [["night", 1]]);
});

test("dueWindows：(prev, now] 之间到点的窗口，每个北京日期+小时只报一次", () => {
  const prev = bj(2026, 8, 14, 20, 0);
  const now = bj(2026, 8, 15, 9, 30);
  const due = dueWindows(prev, now);
  assert.deepEqual(due.map((w) => w.hour), [21, 1, 9]);
  assert.deepEqual(due[0].legs, ["travel"]);
  assert.deepEqual(due[2].legs, ["travel"]);
  // 重复扫描不重复报
  assert.deepEqual(dueWindows(now, bj(2026, 8, 15, 10, 0)), []);
  // prev >= now → 空
  assert.deepEqual(dueWindows(now, prev), []);
});

test("dueWindows 跨北京日边界（UTC 16:00）：夜猫子落在北京次日，同小时两个北京日都报（生产 bug 回归）", () => {
  // 覆盖 北京 09-14 08:00 → 09-15 10:00（UTC 09-14 00:00 → 09-15 02:00，
  // 中间穿过 UTC 16:00 的翻日线）。旧实现（宿主小时 + toDateString 去重）在
  // UTC 容器里会漏掉 UTC 17:00 的夜猫子、把两个北京日的 09:00 去重成一个。
  const due = dueWindows(Date.UTC(2026, 8, 14, 0, 0), Date.UTC(2026, 8, 15, 2, 0));
  assert.deepEqual(
    due.map((w) => w.hour),
    [9, 21, 1, 9],
    "北京 09-14 09:00 / 09-14 21:00 / 09-15 01:00 / 09-15 09:00 四个窗口都要报",
  );
  assert.deepEqual(due[0].legs, ["travel"]); // 北京 09-14 09:00（UTC 09-14 01:00）
  assert.deepEqual(due[1].legs, ["travel"]); // 北京 09-14 21:00（UTC 09-14 13:00）
  assert.deepEqual(due[2].legs, ["night"]); // 北京 09-15 01:00（UTC 09-14 17:00）
  assert.deepEqual(due[3].legs, ["travel"]); // 北京 09-15 09:00（UTC 09-15 01:00）
  // at 是精确的 UTC 整点毫秒
  assert.deepEqual(
    due.map((w) => w.at),
    [
      Date.UTC(2026, 8, 14, 1, 0),
      Date.UTC(2026, 8, 14, 13, 0),
      Date.UTC(2026, 8, 14, 17, 0),
      Date.UTC(2026, 8, 15, 1, 0),
    ],
  );
  // UTC 17:00 那个窗口属于北京 09-15（去重键的日期段 = 北京日期）
  assert.equal(beijingDateKey(due[2].at), "2026-09-15");
});

test("夜猫窗口：只认北京时间 23:00–08:00（显式 UTC 时间戳）", () => {
  assert.equal(inNightWindow(Date.UTC(2026, 8, 15, 15, 30)), true, "北京 23:30");
  assert.equal(inNightWindow(Date.UTC(2026, 8, 15, 15, 59)), true, "北京 23:59");
  assert.equal(inNightWindow(Date.UTC(2026, 8, 15, 16, 0)), true, "北京次日 00:00");
  assert.equal(inNightWindow(Date.UTC(2026, 8, 15, 19, 30)), true, "北京次日 03:30");
  assert.equal(inNightWindow(Date.UTC(2026, 8, 14, 17, 0)), true, "北京次日 01:00");
  assert.equal(inNightWindow(Date.UTC(2026, 8, 14, 23, 59)), true, "北京次日 07:59");
  assert.equal(inNightWindow(Date.UTC(2026, 8, 15, 0, 0)), false, "北京 08:00 出窗");
  // 生产 bug 回归：北京 09:00（UTC 01:00）绝不能算夜间 —— 旧 getHours() 在 UTC
  // 容器里得 1 而误判为夜间
  assert.equal(inNightWindow(Date.UTC(2026, 8, 15, 1, 0)), false, "北京 09:00（UTC 01:00）不是夜间");
  assert.equal(inNightWindow(Date.UTC(2026, 8, 15, 4, 0)), false, "北京 12:00");
  assert.equal(inNightWindow(Date.UTC(2026, 8, 15, 14, 59)), false, "北京 22:59");
});

test("accountGapMs：manual 1.5s；schedule 2–5s 抖动（rand 可注入）", () => {
  assert.equal(accountGapMs("manual"), 1500);
  assert.equal(accountGapMs(), 1500);
  assert.equal(accountGapMs("schedule", 0, () => 0), 2000);
  assert.equal(accountGapMs("schedule", 0, () => 1), 5000);
  assert.equal(accountGapMs("schedule", 0, () => 0.5), 3500);
  assert.equal(accountGapMs("schedule", 0, 0.25), 2750);
});

test("假时钟：sleep 只拨表不真等（整套测试秒级完成的基础）", async () => {
  const clock = fakeClock(Date.UTC(2026, 8, 15, 10, 0));
  const t0 = Date.now();
  await clock.sleep(4000);
  await clock.sleep(3600_000);
  assert.ok(Date.now() - t0 < 100, "sleep 不许真的睡");
  assert.equal(clock.time, Date.UTC(2026, 8, 15, 10, 0) + 3604_000);
});
