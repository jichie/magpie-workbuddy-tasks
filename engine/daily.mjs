// daily.mjs —— 每日活跃上报（点亮成长中心连登）。
//
// 口径（CONTRACT §7「每日活跃」）：每个账号每个**北京日**只发一条 chat 事件，
// 打向**计费域**（www.codebuddy.cn/v2/report，与成长任务的 chat 域上报不同）。
// 上游据此给成长中心记一天的连登。幂等键 = 「uid → 北京日键」，由调用方
// （daemon 的 state/daily-activity.json / 直接构造 runner 的测试）持有 sentMap；
// 上报成功才写入并回调 onSent —— 失败绝不落账，明天/下次重试。
//
// 铁律 4：本模块自己不发 HTTP —— 一律经 tasks.reportEvents（内部 ctx.breathe +
// spacer 排队对齐），全局节流器对它同样生效，绝不绕开。

import { buildEvent, reportEvents } from "./tasks.mjs";
import { billBase } from "./upstream.mjs";

// beijingDayKey(nowMs) -> "YYYY-MM-DD"
// 北京日键（UTC+8）：与上游「连登」的日界一致 —— UTC 16:00 整翻到北京次日。
export function beijingDayKey(nowMs) {
  const d = new Date((nowMs ?? Date.now()) + 8 * 3600 * 1000);
  return (
    `${d.getUTCFullYear()}-` +
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getUTCDate()).padStart(2, "0")}`
  );
}

// reportDailyActivity(acct, opts) -> {sent:true,key} | {sent:false,skipped:true,key}
//                                        | {sent:false,error}
// opts: {now?, sleep?, fetch?, gap?, spacer?, bases?, env?, log?, leg?, signal?,
//        sentMap?  // {uid: "YYYY-MM-DD"} —— 幂等账本（daemon 从
//                  // state/daily-activity.json 读入并经 onSent 原子写回）
//        onSent?   // (uid, key) => void —— 上报成功后回调（daemon 落盘）}
//
// 任何失败（网络/信封非 0/缺 uid）都返回 {sent:false, error} 而不抛 —— 调用方
// （runner 的 job 循环）只记一行日志继续跑腿，绝不阻断 job。
export async function reportDailyActivity(acct, opts = {}) {
  const uid = String(acct?.uid ?? "");
  const nowFn = opts.now ?? (() => Date.now());
  const key = beijingDayKey(nowFn());
  if (!uid) return { sent: false, error: "缺 uid（事件会被服务端静默丢弃）" };

  const sentMap = opts.sentMap && typeof opts.sentMap === "object" ? opts.sentMap : {};
  if (sentMap[uid] === key) return { sent: false, skipped: true, key };

  try {
    // chat 事件（eventCode chat_request_send）：与成长任务的每日对话同族；
    // 打计费域（reportBase=billBase()）—— 参考实现 reportDailyActivity 同款。
    const ev = buildEvent(acct, "chat", 0, null, { now: nowFn });
    const ok = await reportEvents(acct, [ev], { ...opts, reportBase: billBase() });
    if (!ok) return { sent: false, error: "事件上报失败（上游拒绝）" };
    sentMap[uid] = key; // 成功才落账：失败不写，下次重试
    if (typeof opts.onSent === "function") opts.onSent(uid, key);
    return { sent: true, key };
  } catch (err) {
    return { sent: false, error: String(err?.message || err) };
  }
}
