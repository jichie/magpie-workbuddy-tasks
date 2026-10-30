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
import { fakeClock, localTime } from "./helpers.mjs";

test("窗口表：09:00/21:00 成长+旅行，01:00 夜猫", () => {
  assert.deepEqual(legsForHour(9), ["growth", "travel"]);
  assert.deepEqual(legsForHour(21), ["growth", "travel"]);
  assert.deepEqual(legsForHour(1), ["night"]);
  assert.deepEqual(legsForHour(12), []);
  assert.deepEqual(SCHEDULE_WINDOWS.map((w) => w.hour).sort((a, b) => a - b), [1, 9, 21]);
});

test("windowsAt：命中当前本地小时的窗口", () => {
  assert.deepEqual(windowsAt(localTime(2026, 9, 15, 9, 30)).map((w) => w.hour), [9]);
  assert.deepEqual(windowsAt(localTime(2026, 9, 15, 1, 5)).map((w) => w.legs), [["night"]]);
  assert.deepEqual(windowsAt(localTime(2026, 9, 15, 12, 0)), []);
});

test("nextRuns：严格未来、按时间排序、格式 [leg, hour]", () => {
  // 本地 10:00 → 下一个窗口是 21:00（growth, travel），再下一天 01:00（night）、09:00…
  const now = localTime(2026, 9, 15, 10, 0);
  const runs = nextRuns(now, 5);
  assert.deepEqual(runs, [
    ["growth", 21], ["travel", 21],
    ["night", 1], ["growth", 9], ["travel", 9],
  ]);
  // 恰好在 09:00:00 整点 → 09:00 视为已过（严格未来）
  const now2 = localTime(2026, 9, 15, 9, 0);
  assert.deepEqual(nextRuns(now2, 2), [["growth", 21], ["travel", 21]]);
});

test("dueWindows：(prev, now] 之间到点的窗口，每个日期+小时只报一次", () => {
  const prev = localTime(2026, 9, 14, 20, 0);
  const now = localTime(2026, 9, 15, 9, 30);
  const due = dueWindows(prev, now);
  assert.deepEqual(due.map((w) => w.hour), [21, 1, 9]);
  assert.deepEqual(due[0].legs, ["growth", "travel"]);
  assert.deepEqual(due[2].legs, ["growth", "travel"]);
  // 重复扫描不重复报
  assert.deepEqual(dueWindows(now, localTime(2026, 9, 15, 10, 0)), []);
  // prev >= now → 空
  assert.deepEqual(dueWindows(now, prev), []);
});

test("夜猫窗口：只认 23:00–08:00（本地时区）", () => {
  assert.equal(inNightWindow(localTime(2026, 9, 15, 23, 0)), true);
  assert.equal(inNightWindow(localTime(2026, 9, 15, 23, 59)), true);
  assert.equal(inNightWindow(localTime(2026, 9, 16, 0, 0)), true);
  assert.equal(inNightWindow(localTime(2026, 9, 16, 3, 30)), true);
  assert.equal(inNightWindow(localTime(2026, 9, 16, 7, 59)), true);
  assert.equal(inNightWindow(localTime(2026, 9, 16, 8, 0)), false);
  assert.equal(inNightWindow(localTime(2026, 9, 15, 12, 0)), false);
  assert.equal(inNightWindow(localTime(2026, 9, 15, 22, 59)), false);
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
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const t0 = Date.now();
  await clock.sleep(4000);
  await clock.sleep(3600_000);
  assert.ok(Date.now() - t0 < 100, "sleep 不许真的睡");
  assert.equal(clock.time, localTime(2026, 9, 15, 10, 0) + 3604_000);
});
