// taskkind.mjs —— 任务 → kind 解析层（P0-1）：引擎对「这个任务能不能自动化、
// 事件 id 钉在谁身上」的唯一判断源（CONTRACT §2 / §7）。
//
// 背景（2026-10-31 真实环境实测）：国内版账号上游每次返回 19 项任务，其中会
// 出现 TASK_SPECS 之外的（expert_use_* 一族，reward 50 积分 + 5 能量）。它们的
// jump_url 是 URL 编码过的 deeplink，查询串里带着真实专家 id：
//   https://www.workbuddy.cn/work/launch/?deeplink=workbuddy%3A%2F%2Fexperts%3F
//     expertId%3Dex_GDl31WahyIH0&buddy_type=workbuddy
// 上游按 (eventCode, id) 去重：这类任务的事件 id 必须钉在解析出的 id 上，
// 专家池里的通用 id 对它不推进进度（Expert hub 文档里 Valorant 的同款坑）。
//
// 解析优先级：
//   1. TASK_SPECS 命中 → 用现有 spec（最高优先；Valorant / lighthouse 的
//      jump_url 只有 workbuddy://expert，钉死常量仍是唯一来源，绝不被
//      jump_url 覆盖）；
//   2. 未命中但 jump_url 能解出 expertId=ex_… → 视为 expert 类可点亮任务，
//      事件 id 钉在解析出的 id 上（expertType=agent，沿用 expert_actual_use）；
//   3. 未命中且派生不出 → unforgeable:true + reason:"未收录任务"：不接取、
//      不上报、不领奖（否则「接了一大堆却一项不亮、领奖报 task not completed」）。
//
// 本模块零依赖副作用：只 import constants 的静态表，绝不发请求；daemon 的
// snapTask 与 engine 流水线共用这里，保证下发给前端的判断与引擎行为一致。

import { DESKTOP_ONLY_TASKS, TASK_SPECS } from "./constants.mjs";

// lighthouse 的钉死专家（wb_tasks.build_event 的同款常量；CONTRACT §7）。
export const LIGHTHOUSE_EXPERT = ["ex_2cvvUZQhDyeJ", "腾讯轻量云专家"];

// 从 jump_url 派生专家 id。规则：
//   - 整条 deeplink 可能被 URL 编码后塞进查询串（expertId 以 %3D 出现），
//     所以先把整串解到不再变化（最多 3 层，防双重编码），再取 expertId=…；
//   - 只认 ex_ 前缀、[A-Za-z0-9_-] 且总长 ≤ 67 的值（与上游真实 id 同形），
//     其余一律返回 ""（调用方按「未收录」处理，宁可少接不错接）。
export function deriveExpertIdFromJumpUrl(jumpUrl) {
  let s = String(jumpUrl ?? "").trim();
  if (!s || s.length > 4096) return "";
  for (let i = 0; i < 3; i++) {
    let dec = s;
    try {
      dec = decodeURIComponent(s);
    } catch {
      break; // 畸形编码：按原串继续匹配
    }
    if (dec === s) break;
    s = dec;
  }
  const m = /expertId=(ex_[A-Za-z0-9_-]{1,64})/.exec(s);
  return m ? m[1] : "";
}

// 专家名兜底：任务标题通常是「体验「某某专家」」——取「」/""里的名字作为
// 事件的 name/expertTitle（进度只看 id，名字是展示字段；取不到就用整个标题）。
export function expertNameFromTitle(title) {
  const s = String(title ?? "");
  const m = /[「"]([^」"]{1,64})[」"]/.exec(s);
  return m ? m[1] : s;
}

// resolveTaskKind(t) -> 判定结果。输入是规范 Task（CONTRACT §2 camelCase），
// 也容忍上游 raw（task_code/jump_url 拼写）——只读 code/jumpUrl/acceptStatus/
// taskType/title 五个字段，绝不发请求。
//
// 返回：
//   source          "spec" | "jump_url" | "none"
//   kind            buildEvent 的事件族（"expert" 等）；未收录为 null
//   spec            TASK_SPECS 条目（source==="spec" 时），否则 null
//   desktopOnly     DESKTOP_ONLY_TASKS 命中（伪造事件不推进、领奖必 400）
//   desktopReason   desktopOnly 的说明文案（DESKTOP_ONLY_TASKS 的值，否则 ""）
//   unforgeable     不可自动化（spec.unforgeable 或 未收录任务）
//   reason          不可自动化的原因（"需在微信关注…" / "未收录任务" / ""）
//   acceptible      kind 级：可进接取批次（unforgeable 一律 false）
//   lightable       kind 级：可上报事件点亮（desktopOnly / unforgeable / 无 kind → false）
//   canAccept       收敛结论（含状态）：现在就能点「接取」
//                   = acceptible && 非 auto && acceptStatus==="not_accepted"
//   canLight        收敛结论（含状态）：引擎能/会用事件点亮
//                   = lightable &&（accepted；auto 另认 not_accepted）
//                   注：black_cat 的 23:00–08:00 夜间窗口是运行时判断，不含在内
//   pinnedExpertId  非空 = 事件 id 钉死该专家（spec 钉死或 jump_url 派生）；
//                   空串 = 不钉 id（expert/team 类走池子轮换，其它 kind 无专家 id）
//   expertName      事件 name/expertTitle 用的专家名（spec 提供或从标题提取，可为 ""）
export function resolveTaskKind(t) {
  const code = String(t?.code ?? t?.task_code ?? "");
  const status = String(t?.acceptStatus ?? "");
  const isAuto = String(t?.taskType ?? "") === "auto";
  const desktopOnly = !!code && Object.hasOwn(DESKTOP_ONLY_TASKS, code);

  // 1. TASK_SPECS 命中：最高优先，钉死 id 不被 jump_url 覆盖。
  if (code && Object.hasOwn(TASK_SPECS, code)) {
    const spec = TASK_SPECS[code];
    const kind = typeof spec.kind === "string" ? spec.kind : null;
    const unforgeable = spec.unforgeable === true;
    let pinnedExpertId = "";
    let expertName = "";
    if (Array.isArray(spec.expert)) [pinnedExpertId, expertName] = spec.expert;
    else if (kind === "lighthouse") [pinnedExpertId, expertName] = LIGHTHOUSE_EXPERT;
    const acceptible = !unforgeable;
    const lightable = !!kind && !unforgeable && !desktopOnly;
    return {
      source: "spec",
      kind,
      spec,
      desktopOnly,
      desktopReason: desktopOnly ? DESKTOP_ONLY_TASKS[code] : "",
      unforgeable,
      reason: spec.reason || "",
      acceptible,
      lightable,
      pinnedExpertId,
      expertName,
      canAccept: acceptible && !isAuto && status === "not_accepted",
      canLight:
        lightable &&
        (isAuto ? status === "not_accepted" || status === "accepted" : status === "accepted"),
    };
  }

  // 2. 未收录但 jump_url 解得出专家 id → expert 类可点亮，事件 id 钉死。
  const derived = deriveExpertIdFromJumpUrl(t?.jumpUrl ?? t?.jump_url);
  if (derived) {
    const autoOk = status === "not_accepted" || status === "accepted";
    return {
      source: "jump_url",
      kind: "expert",
      spec: null,
      desktopOnly,
      desktopReason: desktopOnly ? DESKTOP_ONLY_TASKS[code] : "",
      unforgeable: false,
      reason: "",
      acceptible: true,
      lightable: true,
      pinnedExpertId: derived,
      expertName: expertNameFromTitle(t?.title),
      canAccept: !isAuto && status === "not_accepted",
      canLight: isAuto ? autoOk : status === "accepted",
    };
  }

  // 3. 未收录且派生不出：诚实标注，绝不接取/上报/领奖。
  return {
    source: "none",
    kind: null,
    spec: null,
    desktopOnly,
    desktopReason: desktopOnly ? DESKTOP_ONLY_TASKS[code] : "",
    unforgeable: true,
    reason: "未收录任务",
    acceptible: false,
    lightable: false,
    pinnedExpertId: "",
    expertName: "",
    canAccept: false,
    canLight: false,
  };
}
