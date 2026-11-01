// schedule.mjs —— 小时窗口排程（CONTRACT §7/§8：09:00/21:00 猫猫旅行，01:00 夜猫，
// 夜猫只认 23:00–08:00）与账号间隔（铁律 4：手动 1.5 s，排程 2–5 s 抖动）。
//
// 时区口径（生产 bug 修正）：窗口小时与去重日界一律按**北京时间（UTC+8）**解释，
// 与容器/宿主时区无关 —— 生产 magpie 容器是 UTC，new Date().getHours() 会把
// 北京 09:00 读成 1 点而误触夜猫子。小时取 constants.beijingHour，去重日期取
// constants.beijingDateKey（与 engine/daily.beijingDayKey 同一日界：UTC 16:00 翻北京日）。
// settings.hours 的数字含义不变：仍是北京小时。
//
// 成长任务（growth）不在任何排程窗口里：到点自动跑的是无任务码、对账号零写入
// 风险的腿；growth 只能手动发起（看板「立即运行」/ POST /api/run / 工具
// workbuddy_tasks_run，可再配合 codes 勾选任务）。手动运行的默认 settings.legs
// 仍可含 growth（daemon 的 LEGS 常量不变），这里只是排程不触发它。

import {
  ACCOUNT_GAP_MANUAL_MS,
  ACCOUNT_JITTER_MAX_MS,
  ACCOUNT_JITTER_MIN_MS,
  beijingDateKey,
  beijingHour,
} from "./constants.mjs";

export { inNightWindow } from "./constants.mjs";

const HOUR_MS = 3600_000;

// 每日窗口表：hour = 北京小时（UTC+8）。growth 刻意缺席（见文件头注释）。
export const SCHEDULE_WINDOWS = [
  { hour: 9, legs: ["travel"] },
  { hour: 21, legs: ["travel"] },
  { hour: 1, legs: ["night"] },
];

// legsForHour(hour) -> 该北京小时要跑的腿（去重保序）。纯函数：入参是小时数字，
// 不读时钟、不做任何时区换算。
export function legsForHour(hour) {
  const out = [];
  for (const w of SCHEDULE_WINDOWS) {
    if (w.hour !== hour) continue;
    for (const leg of w.legs) if (!out.includes(leg)) out.push(leg);
  }
  return out;
}

// windowsAt(nowMs) -> 命中当前北京小时的窗口（daemon 的 tick 用）。
export function windowsAt(nowMs) {
  const h = beijingHour(nowMs);
  return SCHEDULE_WINDOWS.filter((w) => w.hour === h).map((w) => ({ hour: w.hour, legs: [...w.legs] }));
}

// nextRuns(nowMs, count) -> [[leg, hour], ...] 严格未来的下一个窗口序列，
// 按时间先后展开成腿（/api/state 的 scheduler.nextRuns）。按 UTC 整小时步进、
// 每步取北京小时 —— +8 是整小时偏移，北京小时恰在 UTC 整点翻面。
export function nextRuns(nowMs, count = 4) {
  const out = [];
  const startHour = Math.floor(nowMs / HOUR_MS);
  for (let k = 1; out.length < count && k <= 48; k++) {
    const t = (startHour + k) * HOUR_MS;
    const hour = beijingHour(t);
    for (const leg of legsForHour(hour)) {
      out.push([leg, hour]);
      if (out.length >= count) break;
    }
  }
  return out;
}

// dueWindows(prevMs, nowMs) -> [{hour, legs, at}]
// (prev, now] 之间到点的窗口（每个「北京日期+小时」只报一次）。daemon 每 tick 用
// 上次巡检时刻调它。按 UTC 整小时步进枚举北京小时 —— +8 是整小时偏移，北京小时
// 恰在 UTC 整点翻面，与窗口边界重合。去重键的日期段是北京日期（UTC 16:00 翻日），
// 绝不用 toDateString()（宿主时区，UTC 容器下会把北京次日 01:00 的窗口并进前一天）。
export function dueWindows(prevMs, nowMs, maxDays = 8) {
  const out = [];
  if (!(nowMs > prevMs)) return out;
  const startHour = Math.floor(prevMs / HOUR_MS) + 1;
  const endHour = Math.floor(nowMs / HOUR_MS);
  const lowest = Math.max(startHour, endHour - 24 * maxDays);
  const seen = new Set();
  for (let h = lowest; h <= endHour; h++) {
    const t = h * HOUR_MS;
    const hour = beijingHour(t);
    for (const w of SCHEDULE_WINDOWS) {
      if (w.hour !== hour) continue;
      const key = `${beijingDateKey(t)}#${w.hour}`;
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
