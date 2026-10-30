// schedule.mjs —— 小时窗口排程（CONTRACT §8：09:00/21:00 成长+旅行，01:00 夜猫，
// 夜猫只认 23:00–08:00）与账号间隔（铁律 4：手动 1.5 s，排程 2–5 s 抖动）。

import {
  ACCOUNT_GAP_MANUAL_MS,
  ACCOUNT_JITTER_MAX_MS,
  ACCOUNT_JITTER_MIN_MS,
} from "./constants.mjs";

export { inNightWindow } from "./constants.mjs";

const HOUR_MS = 3600_000;

// 每日本地时间窗口：hour = 本地小时。
export const SCHEDULE_WINDOWS = [
  { hour: 9, legs: ["growth", "travel"] },
  { hour: 21, legs: ["growth", "travel"] },
  { hour: 1, legs: ["night"] },
];

// legsForHour(hour) -> 该本地小时要跑的腿（去重保序）。
export function legsForHour(hour) {
  const out = [];
  for (const w of SCHEDULE_WINDOWS) {
    if (w.hour !== hour) continue;
    for (const leg of w.legs) if (!out.includes(leg)) out.push(leg);
  }
  return out;
}

// windowsAt(nowMs) -> 命中当前本地小时的窗口（daemon 的 tick 用）。
export function windowsAt(nowMs) {
  const h = new Date(nowMs).getHours();
  return SCHEDULE_WINDOWS.filter((w) => w.hour === h).map((w) => ({ hour: w.hour, legs: [...w.legs] }));
}

// nextRuns(nowMs, count) -> [[leg, hour], ...] 严格未来的下一个窗口序列，
// 按时间先后展开成腿（/api/state 的 scheduler.nextRuns）。
export function nextRuns(nowMs, count = 4) {
  const out = [];
  const startHour = Math.floor(nowMs / HOUR_MS);
  for (let k = 1; out.length < count && k <= 48; k++) {
    const t = (startHour + k) * HOUR_MS;
    const hour = new Date(t).getHours();
    for (const leg of legsForHour(hour)) {
      out.push([leg, hour]);
      if (out.length >= count) break;
    }
  }
  return out;
}

// dueWindows(prevMs, nowMs) -> [{hour, legs, at}]
// (prev, now] 之间到点的窗口（每个「日期+小时」只报一次）。daemon 每 tick 用
// 上次巡检时刻调它。按 UTC 整小时步进枚举本地小时——对整小时时区（含 +8）
// 与本地窗口边界重合。
export function dueWindows(prevMs, nowMs, maxDays = 8) {
  const out = [];
  if (!(nowMs > prevMs)) return out;
  const startHour = Math.floor(prevMs / HOUR_MS) + 1;
  const endHour = Math.floor(nowMs / HOUR_MS);
  const lowest = Math.max(startHour, endHour - 24 * maxDays);
  const seen = new Set();
  for (let h = lowest; h <= endHour; h++) {
    const t = h * HOUR_MS;
    const hour = new Date(t).getHours();
    for (const w of SCHEDULE_WINDOWS) {
      if (w.hour !== hour) continue;
      const key = `${new Date(t).toDateString()}#${w.hour}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ hour: w.hour, legs: [...w.legs], at: t });
    }
  }
  return out;
}

// accountGapMs(trigger, nowMs, rand) -> 账号与账号之间的间隔毫秒。
// manual 固定 1500；schedule 在 2000–5000 之间抖动（rand 可注入以便测试）。
export function accountGapMs(trigger = "manual", nowMs = 0, rand = Math.random) {
  void nowMs;
  if (trigger === "schedule") {
    const r = typeof rand === "function" ? rand() : Number(rand) || 0;
    return ACCOUNT_JITTER_MIN_MS + r * (ACCOUNT_JITTER_MAX_MS - ACCOUNT_JITTER_MIN_MS);
  }
  return ACCOUNT_GAP_MANUAL_MS;
}
