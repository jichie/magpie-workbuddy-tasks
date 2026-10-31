// WorkBuddy 任务看板 —— 纯 vanilla ESM，零依赖、零构建、无内联脚本（对齐 magpie 的 CSP 纪律）。
//
// 数据面（只消费 daemon.mjs 真实存在的路由，绝不发明接口）：
//   GET  /api/hello            -> {name, version, ready}
//   GET  /api/state[?refresh=1|<uid>] -> {serveUrl, bindHost, port, reachableHint,
//                                        accounts, intlSkipped, scheduler, job, stats, settings, notice?, engineErrors?}
//        看板地址块已按需求整块移除：页面不渲染地址块、不复制 serveUrl。
//        接口里的 serveUrl/bindHost/port/reachableHint 保留（守护进程侧兼容），
//        addrModel 纯函数仅为 tests-shell/serve-url.test.mjs 的形状校验而保留。
//        accounts[] 只含国内版（provider === "workbuddy"）；国际版不再出现在列表里。
//        intlSkipped = {count, note}：被忽略的国际版账号数量与说明（只给数字，绝不给账号内容）。
//        scheduler.holds = [{uid, nickname, releasedAt(ISO)}] —— 真正的风控冷却（403/11140）名单
//        accounts[].tasksEnabled 可写（见 /api/account/toggle）；snapshot.tasks[] 为规范化
//        camelCase：{code,title,acceptStatus,progress:{current,target},rewardCredit,rewardEnergy,
//        jumpUrl,taskType("single"|"auto"|"")} + 六个引擎判断字段（daemon.snapTask 投影自
//        engine/taskkind.resolveTaskKind，与流水线决策同一判断源）：
//        {desktopOnly,unforgeable,reason,canAccept,canLight,pinnedExpertId}
//        —— 任务表的所有「能不能自动化」判断只来自这六个字段，前端不再自己拼规则
//        （详见下方 taskFlags）。老后端字段缺失时按 legacy 回退，绝不报错。
//        snapshot.expired 若为 true（后端将来下发）按「快照已过期」渲染；前端不发明字段。
//   GET  /api/events           -> SSE {kind:'job'|'step'|'log'|'scheduler'|'accounts'}（只读流）
//   GET  /api/history?limit=   -> {rows:[{at,uid,nickname,leg,state,detail,credit,energy,jobId,trigger}]}
//   POST /api/run {uids?,legs?,claim?,codes?} -> {job} | 409 busy | 400 无账号 | 503 引擎不可用
//        codes 可选：string[]（对所有账号）或 {[uid]: string[]}（按账号）。看板只发按 uid 的对象，
//        且只把「该账号有勾选任务」的 uid 放进去 —— 未出现的账号 = 不限制（全部任务）。
//   POST /api/stop             -> {job} | 404 没有任务在跑
//   POST /api/task/accept {uid,codes[]}   -> {accepted,already,failed}
//   POST /api/task/claim  {uid,code}      -> {ok,credit,energy,via("chat"|"web"|""),reason}
//   POST /api/checkin     {uids?}         -> [{uid,outcome,credit?,streak?,message}]
//   POST /api/settings    (部分字段)       -> 完整 settings {scheduler,claim,legs,gapMs,hours,host}
//   POST /api/accounts                    -> {count,eligible,added,removed}（重扫本地文件，无副作用）
//   POST /api/account/toggle {uid,tasksEnabled:bool} -> 200 该账号的最新行（accounts[] 元素同形状）
//                                            | 400/404 {error:"…"}（中文）
//   POST /api/shutdown                    -> {ok:true}（随后守护进程退出）
//   GET  /api/accounts/export?secrets=1|0&uid=a,b&download=1
//                                         -> 信封 {format:"workbuddy-accounts",version,exportedAt,count,accounts}
//        不带 realm（或非 intl）时守护进程只导出国内版；secrets=0 脱敏，缺省/1 含 token。
//        download=1 时走 Content-Disposition 附件（文件名取响应头，取不到按 hub 规则本地拼）。
//   POST /api/accounts/import   body = {"blob":<账号数据本体>,"confirm":bool}
//        预览（confirm 缺省/false）不写盘 -> {wrote:false,note,preview:{adds,updates,skips,rejects,totals}}
//        确认（confirm:true）写 plugin-auth.json（写前自动备份）-> {wrote:true,added,updated,skipped,backedUpTo,needReload,reloadHint}
//        409 needRepreview = 预览后 plugin-auth.json 被改动，要求重新预览（契约 §9.2）。
//
// 鉴权：守护进程无鉴权 —— 所有接口都直接放行，fetch 不带 Authorization、URL 不带 ?k=。
// 安全靠网络边界：默认只绑 127.0.0.1；改成 0.0.0.0 后局域网内任何人都能触发写操作，
// 页脚已如实写明。业务错误（400/404/409/503）照常按中文提示透出；SSE 断线回退轮询。
//
// 安全：服务端字符串（任务标题、detail、msg、日志、导入 reason、文件名）一律经
// textContent 进 DOM —— 本文件不使用 innerHTML 注入任何动态内容。token 永不渲染到
// 页面文本（daemon 只给 uid/昵称/掩码；导入响应经后端 planView 剥掉 token；含凭据
// 导出只落下载文件，页面只显示计数/时间/文件名）。

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---- 文案映射（领域词汇对齐 daemon/engine 与 CONTRACT） -----------------------

const LEG_NAMES = { growth: "成长任务", travel: "猫猫旅行", night: "夜猫子" };
const ACCEPT_NAMES = {
  not_accepted: "未接取",
  accepted: "已接取",
  completed: "已完成 · 待领奖",
  claimed: "已领奖",
};
const JOB_STATE_NAMES = { queued: "排队中", running: "运行中", done: "已完成", error: "出错" };
const STEP_STATE_NAMES = {
  pending: "等待",
  running: "进行中",
  ok: "成功",
  skip: "跳过",
  fail: "失败",
  retry: "重试",
  restricted: "风控冷却",
};
const TRIGGER_NAMES = { manual: "手动", schedule: "排程" };
const OUTCOME_NAMES = { claimed: "已签到", done: "今日已签", failed: "失败" };

const LS_THEME = "wbt.theme"; // 主题：localStorage 持久化

// ---- 全局状态 ------------------------------------------------------------------

const state = {
  hello: null,
  conn: "checking", // checking | online | down | stopped
  feed: "idle", // sse | poll | idle
  data: null, // 最近一次 /api/state
  selected: new Set(), // 勾选的 uid
  taskSel: {}, // 任务级勾选：{ [uid]: Set(code) }（内存；跨 renderAll/快照刷新保留）
  expanded: new Set(), // 展开任务表的 uid
  toggling: new Set(), // 「参与任务」开关正在请求中的 uid（期间禁用该行开关）
  creditBusy: new Set(), // 积分查询正在请求中的 uid（期间按钮显示「查询中…」）
  creditErrors: new Map(), // uid -> {error, needRelogin}（查询失败时只放进按钮 title）
  busy: false, // 批量操作进行中
  lastFinished: null, // 最近一个结束的 job（SSE 收尾广播）
  es: null,
  esRetryTimer: 0,
  pollTimer: 0,
  jobTimer: 0,
  history: { rows: [], page: 0, pageSize: 25, limit: 200 },
};

// ---- DOM 小工具（所有服务端文本只走 textContent，天然免注入） --------------------

function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = String(v);
      else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
      else if (k === "dataset" && typeof v === "object") Object.assign(node.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, "");
      else node.setAttribute(k, String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

// SVG 版本：进度条用 <svg> + shape-rendering="crispEdges" 让边沿对齐设备像素，
// 避免不同行的小数 y 坐标导致同一 4px 高度光栅化成 5/6 设备像素。
function svgEl(tag, props, ...kids) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") node.setAttribute("class", v);
      else if (k === "text") node.textContent = String(v);
      else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
      else if (v === true) node.setAttribute(k, "");
      else node.setAttribute(k, String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

// ---- 格式化 ---------------------------------------------------------------------

function toDate(v) {
  if (v == null || v === "" || v === 0) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function fmtTime(v) {
  const d = toDate(v);
  return d ? d.toLocaleTimeString("zh-CN", { hour12: false }) : "—";
}
function fmtDateTime(v) {
  const d = toDate(v);
  if (!d) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtNum(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toLocaleString("zh-CN") : "—";
}
function legName(leg) {
  return LEG_NAMES[leg] ?? String(leg ?? "—");
}

// 风控冷却「解除时间」：相对（X 小时 Y 分后）+ 绝对（今天/明天/MM-DD HH:mm）
function fmtReleaseRel(d) {
  const diff = d.getTime() - Date.now();
  if (diff <= 0) return "即将解除";
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "不足 1 分后";
  if (mins < 60) return `${mins} 分后`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem ? `${hours} 小时 ${rem} 分后` : `${hours} 小时后`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `${days} 天 ${remH} 小时后` : `${days} 天后`;
}
function fmtReleaseAbs(d) {
  const p = (n) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const dayKey = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const now = new Date();
  if (dayKey(d) === dayKey(now)) return `今天 ${hm}`;
  const tmr = new Date(now.getTime() + 86400000);
  if (dayKey(d) === dayKey(tmr)) return `明天 ${hm}`;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}
function fmtRelease(v) {
  const d = toDate(v);
  if (!d) return "解除时间未知";
  return `${fmtReleaseRel(d)} · ${fmtReleaseAbs(d)}`;
}

// ---- 凭据有效期（token 剩余时间） --------------------------------------------------
// daemon /api/state 账号行字段：
//   expiresInMs   剩余毫秒；API key / 无有效期 → null（新字段，毫秒精度）
//   expiresInDays Math.ceil 的天数；老守护进程只有它（2 小时也会被算成「1 天」）
// 优先用 expiresInMs 渲染人性化剩余时间；字段缺失（undefined）时按 expiresInDays
// 回退；两者都没有 → 「有效期未知」。任一字段缺失/异常都不会抛错。
// warn 色（badge-warn → --warn）规则：已过期、不足 1 小时、≤3 小时、≤3 天。

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

function fmtExpiryAbs(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} 过期`;
}

// 纯函数：账号行 → {text, cls, title}。cls ∈ "badge-warn" | "badge-quiet" | ""；
// title = 由同一来源值算出的绝对过期时间（悬停提示），未知 → null。
// 导出仅为 Node 下单元验证；浏览器里 <script type="module"> 不受影响。
export function expiryInfo(a) {
  const ms = a?.expiresInMs;
  if (typeof ms === "number" && Number.isFinite(ms)) {
    const title = fmtExpiryAbs(Date.now() + ms);
    if (ms <= 0) return { text: "凭据已过期", cls: "badge-warn", title };
    if (ms < HOUR_MS) return { text: "不足 1 小时", cls: "badge-warn", title };
    if (ms < DAY_MS) {
      return {
        text: `剩 ${Math.floor(ms / HOUR_MS)} 小时`,
        cls: ms <= 3 * HOUR_MS ? "badge-warn" : "",
        title,
      };
    }
    return {
      text: `剩 ${Math.ceil(ms / DAY_MS)} 天`,
      cls: ms <= 3 * DAY_MS ? "badge-warn" : "",
      title,
    };
  }
  if (ms === null) return { text: "有效期未知", cls: "badge-quiet", title: null };
  // 回退：老守护进程只给 expiresInDays（null = 未知；0 = 已过期）
  const days = a?.expiresInDays;
  if (typeof days === "number" && Number.isFinite(days)) {
    const title = fmtExpiryAbs(Date.now() + days * DAY_MS);
    if (days <= 0) return { text: "凭据已过期", cls: "badge-warn", title };
    return { text: `剩 ${Math.ceil(days)} 天`, cls: days <= 3 ? "badge-warn" : "", title };
  }
  return { text: "有效期未知", cls: "badge-quiet", title: null };
}

// ---- API 层 -----------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, data) {
    super((data && typeof data.error === "string" && data.error) || `HTTP ${status}`);
    this.status = status;
    this.data = data;
  }
}

// 守护进程无鉴权：fetch 只带 Content-Type，不设 Authorization，URL 不带 ?k=。
async function apiOnce(path, { method = "GET", body, params } = {}) {
  const url = new URL(path, location.href);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    const err = new Error("连不上守护进程");
    err.network = true;
    throw err;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

async function api(path, opts = {}) {
  return await apiOnce(path, opts);
}

// 把异常翻译成人话（后端给的中文原样透出，绝不显示堆栈）
function humanErr(e, prefix = "操作失败") {
  if (e instanceof ApiError) {
    if (e.status === 409) {
      toast("已有批量任务在跑：同一时刻只允许一个 job。等它结束，或先点「停止当前任务」。", "warn", 7000);
      return;
    }
    toast(`${prefix}（HTTP ${e.status}）：${e.message}`, "warn", 8000);
    return;
  }
  if (e && e.network) {
    state.conn = "down";
    renderTop();
    toast("连不上守护进程：它可能已停止。可在 magpie 里重开本插件自动拉起，或用顶栏「启动命令」手动启动。", "warn", 9000);
    return;
  }
  toast(`${prefix}：${e && e.message ? e.message : String(e)}`, "warn", 8000);
}

// ---- 主题（默认跟随系统；显式选择持久化到 localStorage） -----------------------------

function themePref() {
  try {
    return localStorage.getItem(LS_THEME) || "auto";
  } catch {
    return "auto";
  }
}
function applyTheme() {
  const p = themePref();
  const root = document.documentElement;
  if (p === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", p);
  const name = p === "auto" ? "跟随系统" : p === "dark" ? "深色" : "浅色";
  const glyph = $("#themeGlyph");
  const label = $("#themeLabel");
  const btn = $("#themeBtn");
  if (glyph) glyph.textContent = p === "auto" ? "◐" : p === "dark" ? "☾" : "☀";
  if (label) label.textContent = `主题：${name}`;
  if (btn) {
    btn.title = `主题：${name}（点击切换）`;
    btn.setAttribute("aria-label", `切换主题，当前${name}`);
  }
}
function cycleTheme() {
  const order = ["auto", "light", "dark"];
  const next = order[(order.indexOf(themePref()) + 1) % order.length];
  try {
    localStorage.setItem(LS_THEME, next);
  } catch {}
  applyTheme();
}

// ---- Toast -----------------------------------------------------------------------------

function toast(msg, kind = "info", ms = 5200) {
  const box = $("#toasts");
  if (!box) return;
  while (box.children.length >= 4) box.firstChild.remove();
  const t = el("div", { class: kind === "warn" ? "toast toast-warn" : "toast", text: msg });
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  try {
    const ta = el("textarea", { style: { position: "fixed", top: "0", left: "0", opacity: "0" } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// ---- 顶栏渲染 -----------------------------------------------------------------------------

// ---- addrModel（兼容保留；页面不再渲染任何看板地址） ---------------------------------------
// 看板地址块已整块移除：页面不显示地址、不提供复制按钮，也不把地址写进 title。
// 这个纯函数保留下来只为 tests-shell/serve-url.test.mjs 继续校验 serveUrl 的形状
// （http(s)://host[:port]/，绝不含 0.0.0.0/::/*）与老后端兜底逻辑。
// 导出仅为 Node 下单元验证；浏览器里 <script type="module"> 不受影响。

const DEFAULT_PORT = 4390;
// serveUrl 形状防御：http(s) + 主机字面量（字母数字 . - _ []）+ 可选端口 + 结尾 /。
// 不收 @（userinfo）、?、#、空白等——老后端/异常值一律不采用，走原有兜底。
const SERVE_URL_RE = /^https?:\/\/[\w.\-\[\]]+(:\d{1,5})?\/$/;

function isWildcardBind(host) {
  return host === "0.0.0.0" || host === "::";
}
function hostForUrl(host) {
  return host.includes(":") ? `[${host}]` : host; // IPv6 字面量要加方括号
}

// 纯函数：/api/state payload → {mode, url, port, hint, bindHost, docker}。
export function addrModel(d) {
  const rawPort = Number(d?.port);
  const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : null;
  const bindHost = typeof d?.bindHost === "string" && d.bindHost.trim() ? d.bindHost.trim() : "";
  const hint = typeof d?.reachableHint === "string" ? d.reachableHint.trim() : null;
  const served = typeof d?.serveUrl === "string" ? d.serveUrl.trim() : "";
  if (SERVE_URL_RE.test(served)) {
    return { mode: "served", url: served, port, hint: hint || "", bindHost, docker: bindHost === "0.0.0.0" };
  }
  if (port == null || !bindHost || hint == null) {
    let url = "";
    try {
      if (typeof location !== "undefined" && (location.protocol === "http:" || location.protocol === "https:")) {
        url = `${location.origin}/`;
      }
    } catch {}
    return { mode: "fallback", url: url || `http://127.0.0.1:${DEFAULT_PORT}/`, port, hint: "", bindHost, docker: false };
  }
  if (hint || isWildcardBind(bindHost)) {
    return {
      mode: "wildcard",
      url: `http://<本机可达地址>:${port}/`,
      port,
      hint,
      bindHost,
      docker: bindHost === "0.0.0.0",
    };
  }
  return { mode: "loopback", url: `http://${hostForUrl(bindHost)}:${port}/`, port, hint: "", bindHost, docker: false };
}

function jobMentionsRisk(job) {
  if (!job) return false;
  const inSteps = (job.steps || []).some((s) => /风控|restricted/i.test(String(s.detail ?? "")));
  const inLogs = (job.log || []).some((l) => /风控|restricted/i.test(String(l)));
  return inSteps || inLogs;
}

// 顶栏「风控冷却」判定：以 scheduler.holds（daemon 给的真实冷却名单）为准；
// 只有老守护进程没给 holds 字段时才退回日志文本推断。
function holdsActive() {
  const holds = state.data?.scheduler?.holds;
  if (Array.isArray(holds)) return holds.length > 0;
  return jobMentionsRisk(state.data?.job);
}

function renderTop() {
  const pill = $("#daemonPill");
  pill.className = "pill";
  if (state.conn === "checking") {
    pill.classList.add("pill-quiet");
    pill.textContent = "检查中…";
  } else if (state.conn === "stopped") {
    pill.classList.add("pill-off");
    pill.textContent = "已停止";
  } else if (state.conn === "down") {
    pill.classList.add("pill-off");
    pill.textContent = "已停用（连不上）";
  } else if (holdsActive()) {
    pill.classList.add("pill-warn");
    pill.textContent = "风控冷却";
  } else {
    pill.classList.add("pill-ok");
    pill.textContent = "运行中";
  }

  const feed = $("#feedPill");
  feed.className = "pill";
  if (state.conn === "stopped" || state.conn === "down") {
    feed.classList.add("pill-off");
    feed.textContent = "已断开";
  } else if (state.feed === "sse") {
    feed.classList.add("pill-quiet");
    feed.textContent = "实时 · SSE";
  } else if (state.feed === "poll") {
    feed.classList.add("pill-warn");
    feed.textContent = "轮询 · 3s";
  } else {
    feed.classList.add("pill-quiet");
    feed.textContent = "连接中…";
  }

  const st = state.data?.stats;
  $("#statCredits").textContent = st ? fmtNum(st.creditsToday) : "—";
  $("#statEnergy").textContent = st ? fmtNum(st.energyToday) : "—";
  $("#statRuns").textContent = st ? fmtNum(st.runs) : "—";

  const sub = $("#brandSub");
  if (state.hello) {
    sub.textContent = `看板 · v${state.hello.version}${state.hello.ready ? "" : " · 引擎未就绪"}`;
  }
}

// ---- 账号区 -------------------------------------------------------------------------------

function eligibleAccounts() {
  return (state.data?.accounts ?? []).filter((a) => a.eligible);
}
function targetAccounts() {
  const list = eligibleAccounts();
  if (!state.selected.size) return list;
  return list.filter((a) => state.selected.has(a.uid));
}
function accountByUid(uid) {
  return (state.data?.accounts ?? []).find((a) => a.uid === uid) ?? null;
}

function badge(text, cls = "") {
  return el("span", { class: cls ? `badge ${cls}` : "badge", text });
}

function acceptBadge(st) {
  const name = ACCEPT_NAMES[st] ?? (st == null || st === "" ? "未知" : String(st));
  let cls = "";
  if (st === "completed") cls = "badge-warn";
  else if (st === "claimed") cls = "badge-quiet";
  else if (st === "accepted") cls = "badge-strong";
  return badge(name, cls);
}

function stepBadge(st) {
  const name = STEP_STATE_NAMES[st] ?? String(st ?? "—");
  let cls = "";
  if (st === "fail" || st === "skip" || st === "restricted") cls = "badge-warn";
  else if (st === "ok") cls = "badge-strong";
  else if (st === "pending") cls = "badge-quiet";
  return badge(name, cls);
}

function progressCell(prog) {
  const cur = Number(prog?.current) || 0;
  const tgt = Number(prog?.target) || 0;
  const pct = tgt > 0 ? Math.min(100, Math.round((cur / tgt) * 100)) : cur > 0 ? 100 : 0;
  return el(
    "div",
    { class: "prog-cell" },
    el(
      "div",
      {
        class: "prog",
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuemax": String(tgt),
        "aria-valuenow": String(cur),
        "aria-label": `进度 ${cur}/${tgt}`,
      },
      el("div", { class: "prog-fill", style: { width: `${pct}%` } }),
    ),
    el("span", { class: "prog-text", text: tgt > 0 ? `${cur}/${tgt}` : `${cur}` }),
  );
}

function rewardCell(t) {
  const c = Number(t.rewardCredit) || 0;
  const e = Number(t.rewardEnergy) || 0;
  const parts = [];
  if (c > 0) parts.push(`+${fmtNum(c)} 积分`);
  if (e > 0) parts.push(`+${fmtNum(e)} 能量`);
  return el("span", { class: "mono", text: parts.length ? parts.join(" · ") : "—" });
}

// ---- 任务判断字段（P0-2：只消费 daemon 下发的六个字段，前端不自己拼规则） --------------
// daemon.snapTask 把引擎判断（engine/taskkind.resolveTaskKind）投影进 snapshot.tasks[]：
//   desktopOnly    true = 只能在本机桌面 App 完成（伪造事件不推进、领奖必失败）
//   unforgeable    true = 根本无法自动化（关注公众号满 24 小时、真实捐赠，以及未收录任务）
//   reason         unforgeable / desktopOnly 的人话原因（可为空串）
//   canAccept      true = 能进「批量接取」（引擎口径，已排除 auto / unforgeable / 未收录）
//   canLight       true = 能被自动化点亮（上报进度事件）
//   pinnedExpertId 非空 = 事件 id 钉死该专家（ex_…）；空串 = 走池子轮换
// 纪律：**绝不**拿 jumpUrl 形状猜「需桌面端完成」—— 真实账号 19 项 jumpUrl 全部非空
// （14 项 workbuddy:// 深链、5 项 https），其中只有 3 项真是桌面端专属。
// 老后端（六个字段 undefined）→ legacy 回退：不显示桌面端 / 无法自动化标注，接取按钮照旧
// 按状态显示（由后端 400/404 兜底），绝不禁用整列。
// 导出仅为 Node 下单元验证；浏览器里 <script type="module"> 不受影响。
export function taskFlags(t) {
  const isBool = (k) => typeof t?.[k] === "boolean";
  const code = String(t?.code ?? "");
  const status = String(t?.acceptStatus ?? "");
  const unforgeable = t?.unforgeable === true;
  return {
    // 后端给了任一新判断字段 = 新口径；否则整行按 legacy 渲染
    modern: isBool("desktopOnly") || isBool("unforgeable") || isBool("canAccept") || isBool("canLight"),
    desktopOnly: t?.desktopOnly === true,
    unforgeable,
    reason: String(t?.reason ?? "").trim(),
    // canLight 用 null 表示「老后端没给」——与 false（引擎判定不点亮）语义分开
    canLight: isBool("canLight") ? t.canLight === true : null,
    // 接取门控：新后端只认 canAccept（再兜一层缺码 / unforgeable 守卫）；
    // 老后端回退旧口径 not_accepted && 非 auto && 有 code
    canAccept: isBool("canAccept")
      ? t.canAccept === true && code !== "" && !unforgeable
      : status === "not_accepted" && t?.taskType !== "auto" && code !== "",
    pinnedExpertId: String(t?.pinnedExpertId ?? "").trim(),
  };
}

// 领奖门控（维持既有口径）：acceptStatus==="completed"，或进度已达标（current>=target>0）。
// 已领奖（claimed）的不再给按钮 —— 真实快照里 11 项 claimed 都是 1/1，不排除会长出
// 11 个必然失败的按钮。缺码时不给按钮（无从 POST）。
export function claimableTask(t) {
  if (String(t?.code ?? "") === "") return false;
  const status = String(t?.acceptStatus ?? "");
  if (status === "completed") return true;
  if (status === "claimed") return false;
  const cur = Number(t?.progress?.current) || 0;
  const tgt = Number(t?.progress?.target) || 0;
  return tgt > 0 && cur >= tgt;
}

// 快照过期语义：snapshot === null → 「快照为空」；后端将来下发 snapshot.expired === true
// 也按过期处理。只认后端真值字段，前端不发明 expiredAt / stale 之类。
export function snapExpired(snap) {
  return snap?.expired === true;
}

// pinnedExpertId 是次要信息：短串展示（等宽、--ink3），全值走 title。
function pinShort(id) {
  const s = String(id ?? "");
  return s.length > 18 ? `${s.slice(0, 17)}…` : s;
}

// jumpUrl 只决定「用什么方式打开」，不决定任务性质：
//   非 http(s) 深链（workbuddy://…）浏览器打不开 → 只给「复制深链」
//   http(s) → 「打开链接」
// 「需在桌面端完成」徽章由 desktopOnly 字段单独负责（见 taskRow）。
function jumpCell(t) {
  const url = String(t.jumpUrl ?? "");
  if (!url) return el("span", { class: "muted", text: "—" });
  if (!/^https?:/i.test(url)) {
    return el("button", {
      type: "button",
      class: "mini-btn",
      text: "复制深链",
      title: `${url}（浏览器打不开自定义协议，复制到本机桌面 App 用）`,
      onclick: async (ev) => {
        const ok = await copyText(url);
        toast(ok ? `深链已复制：${url}` : `复制失败，请手动复制：${url}`, ok ? "info" : "warn", 7000);
        ev.target.blur();
      },
    });
  }
  return el(
    "a",
    { href: url, target: "_blank", rel: "noopener noreferrer", class: "mini-btn", text: "打开链接" },
  );
}

async function acceptOne(uid, code, btn) {
  btn.disabled = true;
  btn.textContent = "接取中…";
  try {
    const r = await api("api/task/accept", { method: "POST", body: { uid, codes: [code] } });
    const accepted = (r?.accepted ?? []).length;
    const already = (r?.already ?? []).length;
    const f0 = (r?.failed ?? [])[0];
    const reason = typeof f0 === "string" ? f0 : f0?.reason;
    let text;
    let cls;
    if (accepted > 0) {
      text = "已接取";
      cls = "badge-strong";
    } else if (already > 0) {
      text = "早已接取";
      cls = "badge-quiet";
    } else {
      text = `未接取：${reason || "上游未说明原因"}`;
      cls = "badge-warn";
    }
    btn.replaceWith(badge(text, cls));
    toast(`${code}：${text}`, cls === "badge-warn" ? "warn" : "info");
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "接取";
    humanErr(e, "接取失败");
  }
}

async function claimOne(uid, code, btn) {
  btn.disabled = true;
  btn.textContent = "领奖中…";
  try {
    const r = await api("api/task/claim", { method: "POST", body: { uid, code } });
    // via:"web" = 桌面端通道被拒、网页兜底成功 —— 低调标注一下
    const viaNote = r?.via === "web" ? " · 已走网页通道" : "";
    const okBadge = r?.ok
      ? badge(`已领奖 +${fmtNum(r.credit)} 积分${Number(r.energy) > 0 ? ` +${fmtNum(r.energy)} 能量` : ""}${viaNote}`, "badge-strong")
      : badge(`未领到：${r?.reason || "上游未说明原因"}`, "badge-warn");
    btn.replaceWith(okBadge);
    toast(r?.ok ? `领奖成功：+${fmtNum(r.credit)} 积分${viaNote}` : `领奖未成功：${r?.reason || "见任务行提示"}`, r?.ok ? "info" : "warn");
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "领奖";
    humanErr(e, "领奖失败");
  }
}

// ---- 任务级勾选（只收窄批量操作，不影响单任务「接取 / 领奖」按钮） -----------------
// state.taskSel = { [uid]: Set(code) }：按账号保存勾选的任务码，只存在内存里。
// · 跨 renderAll()/快照刷新保留；某账号的集合清空时删掉该键（不勾选 = 全部任务）。
// · 无 code 的行不可勾选（无从提交）；勾选不影响 travel / night 腿（它们没有任务码）。
// · 批量请求只把「有勾选」的 uid 放进 body.codes，未出现的账号 = 全部任务。

function pickedSet(uid) {
  return state.taskSel[uid] ?? null;
}

function isPicked(uid, code) {
  const set = pickedSet(uid);
  return !!set && set.has(String(code ?? ""));
}

// 该账号勾选的任务码（原样，供 /api/run 的 body.codes 用）；没有勾选 → null
function pickedCodes(uid) {
  const set = pickedSet(uid);
  return set && set.size ? [...set] : null;
}

function selectableCodes(a) {
  const tasks = Array.isArray(a?.snapshot?.tasks) ? a.snapshot.tasks : [];
  return tasks.map((t) => String(t?.code ?? "")).filter(Boolean);
}

// 「已选 N 项」只数当前快照里真实存在的任务码；没有快照时才退回集合大小
function pickedVisibleCount(uid) {
  const set = pickedSet(uid);
  if (!set || !set.size) return 0;
  const avail = selectableCodes(accountByUid(uid));
  if (!avail.length) return set.size;
  let n = 0;
  for (const c of avail) if (set.has(c)) n++;
  return n;
}

function totalPickedCount() {
  let n = 0;
  // 只统计真正会进入批量操作的可参与账号（与 targetAccounts 同口径）
  for (const a of eligibleAccounts()) n += pickedVisibleCount(a.uid);
  return n;
}

function setPicked(uid, code, on) {
  const c = String(code ?? "");
  if (!c) return;
  let set = state.taskSel[uid];
  if (on) {
    if (!set) set = state.taskSel[uid] = new Set();
    set.add(c);
  } else if (set) {
    set.delete(c);
    if (!set.size) delete state.taskSel[uid];
  }
  updateTaskSelUI(uid);
}

function setPickedAll(uid, on) {
  const codes = selectableCodes(accountByUid(uid));
  if (on && codes.length) state.taskSel[uid] = new Set(codes);
  else delete state.taskSel[uid];
  updateTaskSelUI(uid);
}

function taskAllBoxes(uid) {
  return $$("input[data-task-all]").filter((i) => i.dataset.taskAll === uid);
}
function taskRowBoxes(uid) {
  return $$("input[data-task-pick]").filter((i) => i.dataset.taskPick === uid);
}

// 同步某账号的勾选控件（行 checkbox / 表头与提示条的「全选」/ 已选计数），不整页重绘
function updateTaskSelUI(uid) {
  const set = pickedSet(uid);
  for (const cb of taskRowBoxes(uid)) {
    cb.checked = !!set && set.has(String(cb.dataset.code ?? ""));
  }
  const avail = selectableCodes(accountByUid(uid));
  const n = pickedVisibleCount(uid);
  for (const box of taskAllBoxes(uid)) {
    box.checked = avail.length > 0 && n >= avail.length;
    box.indeterminate = n > 0 && n < avail.length;
    box.disabled = avail.length === 0;
  }
  for (const bar of $$("[data-task-sel-bar]").filter((b) => b.dataset.taskSelBar === uid)) {
    const out = $(".task-sel-count", bar);
    if (out) out.textContent = `已选 ${n} 项`;
  }
  updateTaskSelNote();
}

// 批量条上的全局提示：有任何任务级勾选时显示「已选 N 项任务」
function updateTaskSelNote() {
  const box = $("#taskSelSummary");
  if (!box) return;
  const n = totalPickedCount();
  box.textContent = n ? `已选 ${n} 项任务` : "";
  box.hidden = n === 0;
}

// 批量请求的 codes 形状：{ [uid]: string[] }；只收目标账号里有勾选的那些
function selectionBody(accounts) {
  const out = {};
  for (const a of accounts) {
    const codes = pickedCodes(a.uid);
    if (codes) out[a.uid] = codes;
  }
  return out;
}

function selectionCount(codes) {
  return Object.values(codes).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
}

// 表格上方的短提示条：全选 + 说明 + 已选计数（窄屏 thead 被隐藏时也能全选）
function taskSelBar(uid) {
  return el(
    "div",
    { class: "task-sel-bar", dataset: { taskSelBar: uid } },
    el(
      "label",
      { class: "check task-sel-all", title: "勾选 / 取消该账号的全部任务" },
      el("input", {
        type: "checkbox",
        dataset: { taskAll: uid },
        "aria-label": "全选该账号任务",
        onchange: (ev) => setPickedAll(uid, ev.target.checked),
      }),
      el("span", { text: "全选" }),
    ),
    el("span", { class: "task-sel-hint", text: "勾选后批量操作只作用于选中任务；不勾选 = 全部" }),
    el("span", { class: "task-sel-count", text: "已选 0 项" }),
  );
}

// 单行任务：所有「能不能自动化」的标注与门控都来自 taskFlags（后端字段），
// 服务端字符串（title / code / reason / id）一律走 textContent。
function taskRow(a, t) {
  const code = String(t.code ?? "");
  const f = taskFlags(t);
  const status = String(t.acceptStatus ?? "");
  const isAuto = t.taskType === "auto";
  const actions = el("div", { class: "row-actions" });

  // 接取：仅当后端 canAccept === true（老后端回退旧口径，见 taskFlags）
  if (f.canAccept) {
    actions.append(
      el("button", {
        type: "button",
        class: "mini-btn",
        text: "接取",
        title: f.desktopOnly
          ? "可以接取，但引擎不会为它伪造进度：需在本机桌面 App 完成后再领奖"
          : null,
        onclick: (ev) => acceptOne(a.uid, code, ev.target),
      }),
    );
  } else if (isAuto && (status === "not_accepted" || status === "accepted")) {
    // taskType:"auto"：上游拒绝接取，不给「接取」按钮
    actions.append(el("span", { class: "muted", text: "自动任务，无需接取" }));
  } else if (f.unforgeable) {
    // 规则 2：unforgeable 行不参与批量（原因原文在任务列显示）
    actions.append(el("span", { class: "muted", text: "不参与批量" }));
  } else if (status === "not_accepted" && code === "") {
    // 窄守卫：快照真缺任务码时才提示（规范化后的快照 code 恒非空）
    actions.append(el("span", { class: "muted", text: "快照缺任务码，无法接取" }));
  } else if (status === "not_accepted" && f.modern) {
    // 引擎判定现在不能接（已接过 / 未收录 / 桌面端族）—— 不静默，给一句说明
    actions.append(el("span", { class: "muted", text: f.reason || "引擎判定不可自动接取" }));
  }

  // 领奖：维持既有条件（completed，或进度已达标；claimed 不再给按钮）
  if (claimableTask(t)) {
    actions.append(
      el("button", {
        type: "button",
        class: "mini-btn",
        text: "领奖",
        onclick: (ev) => claimOne(a.uid, code, ev.target),
      }),
    );
  } else if (status === "completed" && code === "") {
    actions.append(el("span", { class: "muted", text: "快照缺任务码，改用「批量做任务」" }));
  }

  // 规则 3：canLight === false 且既非桌面端也非不可自动化 → 没有「点亮」类操作可给，
  // 说明原因（reason 原文优先）。已领奖的行不再堆提示。
  if (f.canLight === false && !f.desktopOnly && !f.unforgeable && status !== "claimed") {
    actions.append(
      el("span", {
        class: "muted",
        text: f.reason || "引擎暂不点亮这项",
        title: f.reason || "守护进程判定 canLight=false：引擎不会为这项上报进度事件（状态变化后会重新判定）",
      }),
    );
  }

  actions.append(jumpCell(t));

  // 任务列标注：桌面端徽章 ⇐ desktopOnly === true；无法自动化徽章 ⇐ unforgeable === true
  //（附 reason 原文）；pinnedExpertId 非空时给一个等宽短串（次要信息，全值在 title）。
  const marks = [];
  if (f.desktopOnly) {
    const b = badge("需在桌面端完成", "badge-warn");
    b.title = "引擎判定：伪造事件不推进、领奖必失败，只能在本机桌面 App 完成";
    marks.push(b);
  }
  if (f.unforgeable) {
    const b = badge("无法自动化", "badge-warn");
    b.title = "引擎判定：无法自动化，不接取 / 不上报 / 不领奖";
    marks.push(b);
  }
  if (f.pinnedExpertId) {
    marks.push(
      el("span", {
        class: "pin-id",
        text: pinShort(f.pinnedExpertId),
        title: `事件 id 钉死该专家：${f.pinnedExpertId}`,
      }),
    );
  }
  const reasonNote = f.reason && (f.unforgeable || f.desktopOnly) ? f.reason : "";

  return el(
    "tr",
    {},
    el(
      "td",
      { "data-label": "选", class: "pick-cell" },
      el(
        "label",
        { class: "check", title: code ? "勾选后批量操作只作用于选中任务；不勾选 = 全部" : "快照缺任务码，无法勾选" },
        el("input", {
          type: "checkbox",
          dataset: { taskPick: a.uid, code },
          checked: !!code && isPicked(a.uid, code),
          disabled: !code,
          "aria-label": code ? `选择任务 ${String(t.title ?? code)}` : "该任务无任务码，无法勾选",
          onchange: (ev) => setPicked(a.uid, code, ev.target.checked),
        }),
      ),
    ),
    el(
      "td",
      { "data-label": "任务" },
      el("span", { class: "cell-main", text: String(t.title ?? code ?? "（无标题）") }),
      code ? el("span", { class: "cell-sub", text: code }) : null,
      marks.length ? el("div", { class: "cell-badges" }, marks) : null,
      reasonNote ? el("div", { class: "row-note", text: reasonNote }) : null,
    ),
    el("td", { "data-label": "状态" }, acceptBadge(status)),
    el("td", { "data-label": "进度" }, progressCell(t.progress)),
    el("td", { "data-label": "奖励", class: "num" }, rewardCell(t)),
    el("td", { "data-label": "操作" }, actions),
  );
}

// 只读刷新的说明：刷新快照只读取上游，不会接取任务也不会上报进度。
const REFRESH_NOTE = "点账号行右侧「刷新快照」读取（只读，不会接取或上报；守护进程内置限速：两次上游调用至少间隔 1 秒）。";

function taskTable(a) {
  const snap = a.snapshot;
  if (!snap) {
    return el(
      "p",
      { class: "muted", style: { padding: "10px 14px" } },
      `快照为空，${REFRESH_NOTE}`,
    );
  }
  const tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
  const expired = snapExpired(snap);
  if (!tasks.length) {
    return el(
      "p",
      { class: "muted", style: { padding: "10px 14px" } },
      expired
        ? `快照已过期（${fmtDateTime(snap.updatedISO)} 更新），${REFRESH_NOTE}`
        : `快照为空（${fmtDateTime(snap.updatedISO)} 更新）：该账号当前没有成长任务，或上游返回为空。`,
    );
  }
  const head = el(
    "thead",
    {},
    el(
      "tr",
      {},
      el(
        "th",
        { class: "pick-col" },
        el(
          "label",
          { class: "check", title: "全选 / 取消全选该账号的任务" },
          el("input", {
            type: "checkbox",
            dataset: { taskAll: a.uid },
            "aria-label": "全选该账号任务",
            onchange: (ev) => setPickedAll(a.uid, ev.target.checked),
          }),
        ),
      ),
      el("th", { text: "任务" }),
      el("th", { text: "状态" }),
      el("th", { text: "进度" }),
      el("th", { text: "奖励", class: "num" }),
      el("th", { text: "操作" }),
    ),
  );
  const body = el("tbody", {}, tasks.map((t) => taskRow(a, t)));
  const table = el("div", { class: "tbl-wrap" }, el("table", { class: "tbl tbl-tasks" }, head, body));
  // 任务级勾选提示条始终在表格上方：说明「不勾选 = 全部」，并显示已选计数
  const kids = [taskSelBar(a.uid)];
  // 后端标记过期：数据仍展示（比空白有用），但明确说明陈旧并给只读刷新入口
  if (expired) {
    kids.push(
      el("p", { class: "snap-stale", text: `快照已过期（${fmtDateTime(snap.updatedISO)} 更新），${REFRESH_NOTE}` }),
    );
  }
  kids.push(table);
  return el("div", { class: "task-sel-wrap" }, ...kids);
}

// 账号行的轻量汇总：状态分布 + 后端判断字段的计数（共 N 项 · 桌面端 N · 无法自动化 N ·
// 可接取 N）。数字全部来自同一批字段统计，绝不硬编码；老后端没给字段时不追加这三项。
// 导出仅为 Node 下单元验证；浏览器里 <script type="module"> 不受影响。
export function taskSummary(snap) {
  const tasks = snap ? (Array.isArray(snap.tasks) ? snap.tasks : []) : [];
  if (!snap) return "任务快照：无（点「刷新快照」读取，只读，不会接取或上报）";
  const count = (st) => tasks.filter((t) => t.acceptStatus === st).length;
  const parts = [
    `共 ${tasks.length} 项`,
    `未接取 ${count("not_accepted")}`,
    `已接取 ${count("accepted")}`,
    `待领奖 ${count("completed")}`,
    `已领奖 ${count("claimed")}`,
  ];
  const flags = tasks.map(taskFlags);
  if (flags.some((f) => f.modern)) {
    const n = (pred) => flags.filter(pred).length;
    parts.push(
      `桌面端 ${n((f) => f.desktopOnly)}`,
      `无法自动化 ${n((f) => f.unforgeable)}`,
      `可接取 ${n((f) => f.canAccept)}`,
    );
  }
  return `任务快照${snapExpired(snap) ? "（已过期）" : ""}：${parts.join(" · ")}`;
}

// 批量接取计划（规则 4）：codes 只取 canAccept === true 的项（判断只来自后端字段），
// 同时把「未接取但引擎判定不可自动接取」的项数分开统计，好在按钮旁说明，而不是静默少接。
// 导出仅为 Node 下单元验证。
export function acceptPlan(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const codes = [];
  let blocked = 0; // 桌面端 / 未收录 / 引擎判定不可接
  let auto = 0; // taskType:"auto"：上游无需接取
  let noCode = 0; // 快照真缺任务码
  let pending = 0; // 未接取项总数
  for (const t of list) {
    if (String(t?.acceptStatus ?? "") !== "not_accepted") continue;
    pending++;
    const f = taskFlags(t);
    if (!String(t?.code ?? "")) {
      noCode++;
      continue;
    }
    if (f.canAccept) {
      codes.push(String(t.code));
      continue;
    }
    if (t?.taskType === "auto") auto++;
    else blocked++;
  }
  return { codes, blocked, auto, noCode, pending };
}

async function refreshSnap(uid, btn) {
  btn.disabled = true;
  btn.textContent = "刷新中…";
  try {
    const d = await api("api/state", { params: { refresh: uid } });
    state.data = d;
    renderAll();
    toast(`已刷新 ${uid} 的任务快照`);
  } catch (e) {
    humanErr(e, "刷新快照失败");
    const b = $(`[data-snap-refresh="${uid}"]`);
    if (b) {
      b.disabled = false;
      b.textContent = "刷新快照";
    }
  }
}

// 把一行账号数据（/api/account/toggle 的 200 响应 = accounts[] 元素同形状）合并回
// 本地 state —— 不整页重载；失去 eligible 的账号同时从批量勾选里移除。
function mergeAccountRow(row) {
  const list = state.data?.accounts;
  if (!row || !Array.isArray(list)) return;
  const i = list.findIndex((x) => x.uid === row.uid);
  if (i >= 0) list[i] = { ...list[i], ...row };
  if (row.eligible === false) state.selected.delete(row.uid);
}

// 「参与任务」开关：乐观更新 → POST /api/account/toggle → 成功用服务端回读的行合并，
// 失败回滚并原样透出服务端的中文错误。请求期间该行开关禁用（state.toggling）。
async function toggleTasksEnabled(uid, want) {
  if (state.toggling.has(uid)) return;
  const acct = accountByUid(uid);
  if (!acct) return;
  const prev = { ...acct };
  const wasSelected = state.selected.has(uid);
  const isApiKey = String(acct.masked ?? "").startsWith("API key");
  state.toggling.add(uid);
  // 乐观：先本地生效（关闭 → eligible=false → 批量勾选里灰掉并取消勾选）
  mergeAccountRow({ uid, tasksEnabled: want, eligible: want ? !isApiKey : false });
  renderAccounts();
  try {
    const row = await api("api/account/toggle", { method: "POST", body: { uid, tasksEnabled: want } });
    mergeAccountRow(row && typeof row === "object" && row.uid ? row : { uid, tasksEnabled: want });
    toast(
      want
        ? `${acct.nickname || uid}：已恢复参与任务`
        : `${acct.nickname || uid}：已停用任务参与（批量操作与排程都会跳过它）`,
    );
  } catch (e) {
    // 回滚到切换前的整行（含 eligible / selected 语义）
    mergeAccountRow(prev);
    if (wasSelected && prev.eligible) state.selected.add(uid);
    humanErr(e, "切换「参与任务」失败");
  } finally {
    state.toggling.delete(uid);
    renderAccounts();
  }
}

// 单行状态：只给一枚徽章（凭据状态），剩余时间作为 --ink3 次要文本；
// 不再把「已登录 / 有效期未知 / 不参与任务」叠成多枚徽章。
function accountBadge(a) {
  const isApiKey = String(a.masked ?? "").startsWith("API key");
  const info = expiryInfo(a);
  const expired = !isApiKey && info.text === "凭据已过期";
  let node;
  if (isApiKey) node = badge("API key", "badge-quiet");
  else if (expired) node = badge("凭据已过期", "badge-warn");
  else node = badge("已登录", "badge-strong");
  if (!isApiKey && info.title) node.title = info.title;
  return {
    node,
    sub: isApiKey ? "无有效期" : expired ? "需要重新登录" : info.text,
    subWarn: !isApiKey && !expired && info.cls === "badge-warn",
  };
}

// 快照计数（与 taskSummary 同源）：账号行展示「已领奖 / 总数」与「待接取 · 待领奖」两行
function snapCounts(snap) {
  const tasks = snap && Array.isArray(snap.tasks) ? snap.tasks : null;
  if (!tasks) return null;
  const count = (st) => tasks.filter((t) => t.acceptStatus === st).length;
  return {
    total: tasks.length,
    notAccepted: count("not_accepted"),
    accepted: count("accepted"),
    pending: count("completed"),
    claimed: count("claimed"),
  };
}

// 分项小格：数值在上、标签在下；换行只发生在格与格之间，绝不把一句长文案劈开
function metric(value, label) {
  return el(
    "span",
    { class: "metric" },
    el("span", { class: "metric-l", text: label }),
    el("span", { class: "metric-v", text: String(value) }),
  );
}

function snapMetrics(snap) {
  const c = snapCounts(snap);
  if (!c) {
    return el("span", {
      class: "acct-metrics-empty",
      text: "无快照：点「刷新快照」读取（只读，不接取、不上报）",
    });
  }
  const cells = [
    metric(c.total, "任务总量"),
    metric(c.notAccepted, "未接取"),
    metric(c.accepted, "已接取"),
    metric(c.pending, "待领奖"),
    metric(c.claimed, "已领奖"),
  ];
  const flags = (snap.tasks ?? []).map(taskFlags);
  if (flags.some((f) => f.modern)) {
    const n = (pred) => flags.filter(pred).length;
    cells.push(
      metric(n((f) => f.desktopOnly), "桌面端"),
      metric(n((f) => f.unforgeable), "无法自动化"),
      metric(n((f) => f.canAccept), "可接取"),
    );
  }
  return el("span", { class: "acct-metrics" }, ...cells);
}

// 折叠标题只留一行紧凑文字（完整汇总在 title）：任务明细 · 19 项 · 可接取 5 · 待领奖 0。
// 数字与 snapMetrics/taskSummary 同源；老后端没有 canAccept 字段时不硬编造这一项。
function snapBrief(snap) {
  const c = snapCounts(snap);
  if (!c) return "任务明细 · 无快照";
  const parts = ["任务明细", `${c.total} 项`];
  const flags = (snap.tasks ?? []).map(taskFlags);
  if (flags.some((f) => f.modern)) {
    parts.push(`可接取 ${flags.filter((f) => f.canAccept).length}`);
  }
  parts.push(`待领奖 ${c.pending}`);
  return parts.join(" · ");
}

function accountRow(a) {
  const isApiKey = String(a.masked ?? "").startsWith("API key");
  const uid = String(a.uid ?? "");
  const name = String(a.nickname || uid || "（无昵称）");
  const metaBits = [a.domain, uid].filter((x) => x != null && x !== "");
  const metaText = metaBits.length ? metaBits.join(" · ") : "（无 uid）";

  const check = el("input", {
    type: "checkbox",
    class: "acct-check",
    value: uid,
    checked: state.selected.has(uid),
    disabled: !a.eligible,
    "aria-label": `选择账号 ${name}`,
    onchange: (ev) => {
      if (ev.target.checked) state.selected.add(uid);
      else state.selected.delete(uid);
      updateSelectionUI();
    },
  });

  const st = accountBadge(a);
  const statusCell = el(
    "div",
    { class: "acct-cell acct-status", dataset: { label: "凭据" } },
    el(
      "span",
      { class: "cell-stack" },
      st.node,
      el("span", { class: st.subWarn ? "acct-note warn-text" : "acct-note", text: st.sub }),
    ),
  );

  const c = snapCounts(a.snapshot);
  const claimedPct = c && c.total > 0 ? Math.round((c.claimed / c.total) * 100) : 0;
  const progressCell = el(
    "div",
    {
      class: "acct-cell acct-progress",
      dataset: { label: "任务" },
      title: isApiKey ? "API key 账号不参与任务，没有任务快照" : taskSummary(a.snapshot),
    },
    el("span", { class: "acct-prog-main", text: c ? `已领奖 ${c.claimed} / ${c.total}` : "无快照" }),
    c
      ? svgEl(
          "svg",
          {
            class: "acct-bar",
            role: "progressbar",
            "aria-valuemin": "0",
            "aria-valuemax": String(c.total),
            "aria-valuenow": String(c.claimed),
            "aria-label": `已领奖 ${c.claimed} / ${c.total}`,
            width: "100%",
            height: "4",
            "shape-rendering": "crispEdges",
          },
          svgEl("rect", {
            class: "acct-bar-track",
            x: "0",
            y: "0",
            width: "100%",
            height: "100%",
            rx: "2",
            ry: "2",
          }),
          svgEl("rect", {
            class: "acct-bar-fill",
            x: "0",
            y: "0",
            width: `${claimedPct}%`,
            height: "100%",
            rx: "2",
            ry: "2",
            style: { width: `${claimedPct}%` },
          }),
        )
      : null,
    el("span", {
      class: "acct-prog-sub",
      text: c
        ? `待接取 ${c.notAccepted} · 待领奖 ${c.pending}`
        : isApiKey
          ? "不参与任务"
          : "刷新快照后可查看",
    }),
  );

  const toggling = state.toggling.has(uid);
  const toggle = el(
    "label",
    {
      class: "switch-inline acct-toggle",
      title: isApiKey
        ? "API key 账号不参与任务（批量与排程都会跳过）"
        : "参与任务：关闭后该账号不进入批量操作与排程（POST /api/account/toggle，立即生效并持久化）",
    },
    el("input", {
      type: "checkbox",
      checked: isApiKey ? false : !!a.tasksEnabled,
      disabled: toggling || isApiKey,
      "aria-label": `账号 ${name} 参与任务`,
      onchange: (ev) => toggleTasksEnabled(uid, ev.target.checked),
    }),
    el("span", { class: "switch-track", "aria-hidden": "true" }),
    el("span", { class: "toggle-text", text: toggling ? "提交中…" : "参与任务" }),
  );

  const sideCell = el(
    "div",
    { class: "acct-cell acct-side", dataset: { label: "操作" } },
    isApiKey
      ? el("span", { class: "muted", text: "—" })
      : el("button", {
          type: "button",
          class: "mini-btn",
          dataset: { snapRefresh: uid },
          text: "刷新快照",
          title: "只读刷新：读取上游任务快照，不会接取任务也不会上报进度",
          onclick: (ev) => refreshSnap(uid, ev.target),
        }),
  );

  const expired = snapExpired(a.snapshot);
  const snapMetaText = a.snapshot
    ? `${expired ? "已过期" : "快照"} · ${fmtTime(a.snapshot.updatedISO)}`
    : "未读取";
  const tasks = el(
    "details",
    { class: "acct-tasks" },
    el(
      "summary",
      {
        class: "acct-tasks-summary",
        title: a.snapshot ? taskSummary(a.snapshot) : "任务快照：无（点「刷新快照」读取）",
      },
      el("span", {
        class: expired ? "acct-tasks-label warn-text" : "acct-tasks-label",
        text: snapBrief(a.snapshot),
      }),
      el("span", { class: "acct-tasks-meta", text: snapMetaText }),
    ),
    el("div", { class: "acct-tasks-body" }, snapMetrics(a.snapshot), taskTable(a)),
  );
  if (state.expanded.has(uid)) tasks.open = true;
  tasks.addEventListener("toggle", () => {
    if (tasks.open) state.expanded.add(uid);
    else state.expanded.delete(uid);
  });

  return el(
    "div",
    { class: "acct", role: "group", "aria-label": `账号 ${name}` },
    el(
      "div",
      { class: "acct-grid" },
      el("div", { class: "acct-cell acct-pick" }, el("label", { class: "check" }, check)),
      el(
        "div",
        { class: "acct-cell acct-id" },
        el("span", { class: "acct-name", text: name, title: name }),
        el("span", { class: "acct-sub", text: metaText, title: metaText }),
      ),
      statusCell,
      progressCell,
      creditsCell(a),
      el("div", { class: "acct-cell acct-toggle-cell" }, toggle),
      sideCell,
    ),
    tasks,
  );
}

function renderBanners() {
  const box = $("#accountsBanners");
  box.replaceChildren();
  const d = state.data;
  if (!d) return;
  if (d.notice) {
    box.append(
      el("div", { class: "banner banner-warn" },
        el("strong", { text: "账号读取提示" }),
        el("p", { text: String(d.notice) }),
      ),
    );
  }
  if (Array.isArray(d.engineErrors) && d.engineErrors.length) {
    box.append(
      el("div", { class: "banner banner-warn" },
        el("strong", { text: "任务引擎不可用" }),
        el("ul", {}, d.engineErrors.map((m) => el("li", { text: String(m) }))),
        el("p", { class: "muted", text: "批量操作与快照刷新都依赖引擎（engine/*.mjs）。装好完整插件后重启守护进程。" }),
      ),
    );
  }
}

// 国际版只剩一行诊断文字：数字取 /api/state 的 intlSkipped.count；
// 缺失或为 0 时整行不显示，绝不渲染任何国际版账号行。
function renderIntlNote() {
  const box = $("#intlNote");
  if (!box) return;
  const count = Number(state.data?.intlSkipped?.count);
  if (!Number.isFinite(count) || count <= 0) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.textContent = `已忽略 ${count} 个国际版账号（workbuddy-ai）：本插件只服务国内版`;
  box.hidden = false;
}

function renderAccounts() {
  const box = $("#accountsList");
  box.replaceChildren();
  const accounts = state.data?.accounts ?? [];
  const head = $("#acctHead");
  if (head) head.hidden = accounts.length === 0;
  const count = $("#acctCount");
  if (count) {
    const eligible = accounts.filter((a) => a.eligible).length;
    count.textContent = accounts.length ? `${accounts.length} 个账号 · ${eligible} 个参与` : "暂无账号";
  }
  renderIntlNote();
  if (!accounts.length) {
    box.append(
      el(
        "div",
        { class: "empty" },
        el("strong", {}, "还没有账号"),
        "在 magpie 里登录 WorkBuddy 国内版后点「重新扫描」，或从另一台机器导出的账号 JSON 导入。凭据文件：",
        el("code", { text: "<magpie 配置目录>/plugin-auth.json" }),
        "。",
        el(
          "div",
          {},
          el("button", {
            type: "button",
            class: "ghost-btn",
            text: "导入账号…",
            onclick: () => setIoOpen(true, "import"),
          }),
        ),
      ),
    );
    updateSelectionUI();
    return;
  }
  for (const a of accounts) box.append(accountRow(a));
  // 清掉已不存在的勾选（账号级 / 任务级都按 uid 收口）
  const uids = new Set(accounts.map((a) => a.uid));
  for (const s of [...state.selected]) if (!uids.has(s)) state.selected.delete(s);
  for (const uid of Object.keys(state.taskSel)) if (!uids.has(uid)) delete state.taskSel[uid];
  // 重建 DOM 后把勾选控件同步回 state（表头全选/半选、已选计数）
  for (const a of accounts) updateTaskSelUI(a.uid);
  updateSelectionUI();
}

// ---- 积分（账号行余额列 + 明细弹窗） ------------------------------------------------
// 数据面：
//   GET /api/credits?uid=<uid>&refresh=0|1
//     成功      -> {ok:true, uid, nickname, credits}
//     上游失败  -> {ok:false, uid, nickname, error, needRelogin?}（HTTP 200）
//     404       -> 未知账号
//     409       -> {error:"busy"}（批量任务运行中）
//   /api/state 的 accounts[].credits 是同一形状的缓存（对象或 null）。
// credits 全部为 camelCase；数值一律先经 creditNum/parsePercent，缺字段不抛错。
// 行内只做「余额 + 明细入口」；完整权益包表格、筛选、排序都在弹窗里。

const SOON_DAYS = 7;
const CREDITS_FILTERS = ["all", "remain", "soon", "dead"];
const CREDITS_SORTS = ["expiry", "remain", "used", "size"];

const creditCache = new Map(); // uid -> credits：跨 /api/state 轮询保留本地已查到的值
const creditAutoTried = new Set(); // 自动查询过的 uid：失败后不再反复打上游
const creditQueue = { list: [], active: 0, max: 2 }; // 页面加载后的自动查询最多 2 并发
let lastBusyToastAt = 0;

function creditNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 后端时间形如 "2026-11-04 00:22:56"（本地时间）；Safari 不认空格分隔，换成 T。
function creditDate(v) {
  if (v == null || v === "") return null;
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(" ", "T");
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtMonthDay(v) {
  const d = creditDate(v);
  if (!d) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function creditDaysLeft(daysLeft, dateStr) {
  if (typeof daysLeft === "number" && Number.isFinite(daysLeft)) return daysLeft;
  if (typeof daysLeft === "string" && daysLeft.trim() !== "" && Number.isFinite(Number(daysLeft))) {
    return Number(daysLeft);
  }
  const d = creditDate(dateStr);
  if (!d) return null;
  return Math.ceil((d.getTime() - Date.now()) / DAY_MS);
}

function parsePercent(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.min(100, v));
  const m = String(v ?? "").match(/-?\d+(?:\.\d+)?/);
  if (!m) return 0;
  const n = Number(m[0]);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function fmtPctNum(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "0%";
  return `${Number.isInteger(x) ? x : x.toFixed(1)}%`;
}

function creditUsagePct(c) {
  const raw = String(c?.usedPercent ?? "").trim();
  if (raw !== "") return parsePercent(raw);
  const size = creditNum(c?.size);
  return size > 0 ? Math.max(0, Math.min(100, (creditNum(c?.used) / size) * 100)) : 0;
}

function creditUsageText(c) {
  const raw = String(c?.usedPercent ?? "").trim();
  if (/^-?\d+(?:\.\d+)?%$/.test(raw)) return raw;
  return fmtPctNum(creditUsagePct(c));
}

function creditTierName(c) {
  const pkg = String(c?.tier?.package ?? "").trim();
  if (pkg) return pkg;
  return c?.isPaidUser ? "付费用户" : "普通用户";
}

function creditsPkgExpired(p) {
  if (!p || p.noExpiry) return false;
  if (p.isExpired === true) return true;
  const d = creditDate(p.expireTime || p.cycleEndTime);
  return d ? d.getTime() <= Date.now() : false;
}

function creditPkgDaysLeft(p) {
  return creditDaysLeft(p?.daysLeft, p?.expireTime || p?.cycleEndTime);
}

function creditPkgExpiryTs(p) {
  if (p?.noExpiry) return Number.POSITIVE_INFINITY;
  const d = creditDate(p?.expireTime || p?.cycleEndTime);
  return d ? d.getTime() : Number.POSITIVE_INFINITY;
}

function creditPkgUsagePct(p) {
  const size = creditNum(p?.size);
  if (size <= 0) return null;
  return Math.max(0, Math.min(100, (creditNum(p?.used) / size) * 100));
}

function creditBusyFor(uid) {
  return state.creditBusy.has(uid) || creditQueue.list.includes(uid);
}

// 行内「N 天内到期」小徽章：只认 earliestExpiring.daysLeft（缺失时用到期日期算）；
// ≤3 天 warn，4–7 天 quiet，>7 天不显示。
function creditsSoonBadge(c) {
  const ee = c?.earliestExpiring;
  if (!ee) return null;
  const days = creditDaysLeft(ee.daysLeft, ee.cycleEndTime || ee.expireTime);
  if (days == null || days > SOON_DAYS) return null;
  const n = Math.max(1, Math.ceil(days));
  return el("span", {
    class: `badge credits-soon ${n <= 3 ? "badge-warn" : "badge-quiet"}`,
    text: `${n} 天内到期`,
    title: ee.name
      ? `${ee.name}：${String(ee.cycleEndTime || ee.expireTime || "").trim() || "到期时间未知"}`
      : "最近将过期的权益包",
  });
}

function creditsCellContent(a) {
  const uid = String(a.uid ?? "");
  const c = a.credits;
  const busy = creditBusyFor(uid);
  const err = state.creditErrors.get(uid);
  if (!c || typeof c !== "object") {
    const errText = err ? `${err.error}${err.needRelogin ? "（需要重新登录 WorkBuddy）" : ""}` : "";
    return [
      el("span", { class: "credits-main credits-main-empty", text: "未查询" }),
      el("div", { class: "credits-actions" },
        el("button", {
          type: "button",
          class: "mini-btn",
          dataset: { creditsQuery: uid },
          text: busy ? "查询中…" : "查询",
          disabled: busy,
          title: busy ? "正在查询积分…" : errText || "查询该账号的积分余额（只读）",
          onclick: () => queryCredits(uid),
        }),
      ),
    ];
  }
  const remain = creditNum(c.remain);
  const size = creditNum(c.size);
  const updated = String(c.updatedIso ?? "").trim();
  return [
    el("span", {
      class: "credits-main",
      title: `剩余 ${fmtNum(remain)} / 总额度 ${fmtNum(size)}${updated ? ` · 更新于 ${updated}` : ""}`,
    },
      el("b", { class: "credits-remain", text: fmtNum(remain) }),
      el("span", { class: "credits-dim", text: " / " }),
      el("span", { class: "credits-size", text: fmtNum(size) }),
    ),
    el("div", { class: "credits-actions" },
      el("button", {
        type: "button",
        class: "mini-btn",
        dataset: { creditsOpen: uid },
        text: "明细",
        title: `查看积分明细${updated ? `（数据更新于 ${updated}）` : ""}`,
        onclick: () => openCreditsDialog(uid),
      }),
      creditsSoonBadge(c),
    ),
  ];
}

function creditsCell(a) {
  const uid = String(a.uid ?? "");
  return el(
    "div",
    { class: "acct-cell acct-credits", dataset: { label: "积分", creditsCell: uid } },
    ...creditsCellContent(a),
  );
}

// 只重绘积分列（不整页 renderAccounts），避免轮询/查询时打断任务勾选与展开状态。
function updateCreditsCell(uid) {
  const cell = $(`[data-credits-cell="${uid}"]`);
  if (!cell) return;
  const acct = accountByUid(uid);
  if (!acct) return;
  cell.replaceChildren(...creditsCellContent(acct));
}

function applyCredits(uid, credits, nickname) {
  const acct = accountByUid(uid);
  if (acct) {
    acct.credits = credits;
    if (nickname && !acct.nickname) acct.nickname = String(nickname);
  }
  if (credits && typeof credits === "object") creditCache.set(uid, credits);
  state.creditErrors.delete(uid);
  updateCreditsCell(uid);
  if (creditsDialog.uid === uid && $("#creditsDialog")?.open) {
    creditsDialog.credits = credits;
    renderCreditsDialog();
  }
}

// 统一把 HTTP 错误 / 200 里的 ok:false 转成可渲染的结果；绝不抛给调用方。
async function requestCredits(uid, refresh = false) {
  try {
    const d = await api("api/credits", { params: { uid, refresh: refresh ? 1 : 0 } });
    if (d && d.ok && d.credits && typeof d.credits === "object") {
      return { ok: true, credits: d.credits, nickname: d.nickname };
    }
    if (d && d.ok === false) {
      return {
        ok: false,
        kind: "upstream",
        error: String(d.error || "上游查询失败"),
        needRelogin: !!d.needRelogin,
        nickname: d.nickname,
      };
    }
    return { ok: false, kind: "bad", error: "返回数据不完整（缺少 credits）" };
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 409) return { ok: false, kind: "busy", error: "批量任务运行中，稍后再查" };
      if (e.status === 404) return { ok: false, kind: "notfound", error: "未知账号（可能已被移除）" };
      return { ok: false, kind: "http", error: e.message || `HTTP ${e.status}` };
    }
    if (e && e.network) return { ok: false, kind: "network", error: "连不上守护进程" };
    return { ok: false, kind: "error", error: String((e && e.message) || e) };
  }
}

function toastCreditsBusy() {
  const now = Date.now();
  if (now - lastBusyToastAt < 6000) return; // 多个账号同时 409 时只提示一次
  lastBusyToastAt = now;
  toast("批量任务运行中，稍后再查", "warn", 6500);
}

// 行内查询：refresh=0（读缓存/只读查询），失败只写按钮 title，不弹错。
async function loadCredits(uid, { refresh = false } = {}) {
  if (state.creditBusy.has(uid)) return null;
  state.creditBusy.add(uid);
  updateCreditsCell(uid);
  try {
    const r = await requestCredits(uid, refresh);
    if (r.ok) {
      applyCredits(uid, r.credits, r.nickname);
    } else {
      state.creditErrors.set(uid, { error: r.error, needRelogin: !!r.needRelogin });
      if (r.kind === "busy") toastCreditsBusy();
    }
    return r;
  } finally {
    state.creditBusy.delete(uid);
    updateCreditsCell(uid);
  }
}

function queryCredits(uid) {
  const queued = creditQueue.list.indexOf(uid);
  if (queued >= 0) creditQueue.list.splice(queued, 1);
  if (state.creditBusy.has(uid)) return;
  loadCredits(uid, { refresh: false });
}

// 页面加载后：对 credits === null 的可参与账号自动查一次（最多 2 并发）。
// 失败不重试（creditAutoTried 记账），避免每次 /api/state 轮询都打上游。
function autoFetchCredits() {
  for (const a of eligibleAccounts()) {
    const uid = String(a.uid ?? "");
    if (!uid || a.credits != null) continue;
    if (creditAutoTried.has(uid) || state.creditBusy.has(uid) || creditQueue.list.includes(uid)) continue;
    creditAutoTried.add(uid);
    creditQueue.list.push(uid);
    updateCreditsCell(uid);
  }
  pumpCreditQueue();
}

function pumpCreditQueue() {
  while (creditQueue.active < creditQueue.max && creditQueue.list.length) {
    const uid = creditQueue.list.shift();
    creditQueue.active++;
    loadCredits(uid, { refresh: false }).finally(() => {
      creditQueue.active--;
      pumpCreditQueue();
    });
  }
}

// ---- 积分明细弹窗 ----------------------------------------------------------------

const creditsDialog = {
  uid: "",
  nickname: "",
  credits: null,
  filter: "all",
  sort: "expiry",
  query: "",
  loading: false,
  error: "",
  needRelogin: false,
  req: 0, // 刷新序号：关闭/重新打开后让在途请求的结果失效
};

function creditsAllPackages() {
  const list = creditsDialog.credits?.packages;
  return Array.isArray(list) ? list : [];
}

function creditPkgMatchesFilter(p) {
  const remain = creditNum(p?.remain);
  const expired = creditsPkgExpired(p);
  switch (creditsDialog.filter) {
    case "remain":
      return remain > 0;
    case "soon": {
      const days = creditPkgDaysLeft(p);
      return !expired && remain > 0 && days != null && days <= SOON_DAYS;
    }
    case "dead":
      return expired || remain <= 0;
    default:
      return true;
  }
}

function creditPkgMatchesQuery(p, q) {
  if (!q) return true;
  const fields = [p?.name, p?.packageCode, p?.productName, p?.subProductName, p?.grantReason, p?.resourceId, p?.dealName];
  return fields.some((x) => String(x ?? "").toLowerCase().includes(q));
}

function creditsFilteredPackages() {
  const q = creditsDialog.query.trim().toLowerCase();
  const rows = creditsAllPackages().filter((p) => creditPkgMatchesFilter(p) && creditPkgMatchesQuery(p, q));
  if (creditsDialog.sort === "remain") rows.sort((a, b) => creditNum(b.remain) - creditNum(a.remain));
  else if (creditsDialog.sort === "used") rows.sort((a, b) => creditNum(b.used) - creditNum(a.used));
  else if (creditsDialog.sort === "size") rows.sort((a, b) => creditNum(b.size) - creditNum(a.size));
  else {
    rows.sort(
      (a, b) =>
        creditPkgExpiryTs(a) - creditPkgExpiryTs(b) ||
        creditNum(b.remain) - creditNum(a.remain),
    );
  }
  return rows;
}

function creditsPkgRow(p) {
  const remain = creditNum(p?.remain);
  const size = creditNum(p?.size);
  const used = creditNum(p?.used);
  const expired = creditsPkgExpired(p);
  const days = creditPkgDaysLeft(p);

  const name = String(p?.name ?? "").trim() || "（未命名套餐）";
  const source = [p?.productName, p?.subProductName]
    .map((x) => String(x ?? "").trim())
    .filter((x) => x && x !== name);
  const sourceText = [...new Set(source)].join(" · ");
  const code = String(p?.packageCode ?? "").trim();
  const grant = String(p?.grantReason ?? "").trim();

  let expiryText;
  let expiryCls;
  if (p?.noExpiry) {
    expiryText = "长期有效";
    expiryCls = "badge-quiet";
  } else if (expired) {
    expiryText = "已过期";
    expiryCls = "badge-warn";
  } else if (days != null) {
    const n = Math.max(0, Math.ceil(days));
    expiryText = `剩 ${n} 天`;
    expiryCls = n <= 3 ? "badge-warn" : n <= SOON_DAYS ? "badge-quiet" : "";
  } else {
    expiryText = "有效期未知";
    expiryCls = "badge-quiet";
  }

  const expireTime = String(p?.expireTime ?? "").trim();
  const createTime = String(p?.createTime ?? "").trim();
  const pct = creditPkgUsagePct(p);

  return el(
    "tr",
    {},
    el("td", { dataset: { label: "套餐包" } },
      el("span", {
        class: "credits-pkg-main",
        text: name,
        title: String(p?.resourceId ?? "").trim() || undefined,
      }),
      sourceText ? el("span", { class: "credits-pkg-sub", text: sourceText }) : null,
      code ? el("span", { class: "credits-pkg-sub", text: code }) : null,
      grant ? el("span", { class: "credits-pkg-note", text: grant }) : null,
    ),
    el("td", { dataset: { label: "有效期" } },
      el("span", { class: `badge ${expiryCls}`.trim(), text: expiryText }),
      expireTime ? el("span", { class: "credits-exp-main", text: `到期 ${expireTime}` }) : null,
      createTime ? el("span", { class: "credits-exp-sub", text: `创建 ${createTime}` }) : null,
    ),
    el("td", { class: "num", text: fmtNum(size) }),
    el("td", { class: "num", text: fmtNum(used) }),
    el("td", {
      class: `num credits-remain-cell${remain <= 0 ? " credits-zero" : ""}`,
      text: fmtNum(remain),
    }),
    el("td", { dataset: { label: "利用率" } },
      pct == null
        ? el("span", { class: "credits-mini-text", text: "—" })
        : el("span", { class: "credits-mini" },
            el("span", { class: "credits-mini-bar", "aria-hidden": "true" },
              el("span", { class: "credits-mini-fill", style: { width: `${pct}%` } }),
            ),
            el("span", { class: "credits-mini-text", text: fmtPctNum(pct) }),
          ),
    ),
  );
}

function renderCreditsPkgs() {
  const tbody = $("#creditsPkgRows");
  if (!tbody) return;
  const rows = creditsFilteredPackages();
  tbody.replaceChildren(...rows.map(creditsPkgRow));
  const table = $("#creditsTable");
  const empty = $("#creditsEmpty");
  if (table) table.hidden = rows.length === 0;
  if (empty) empty.hidden = rows.length !== 0;
}

function creditsMetricCard(label, value, sub, valueCls) {
  return el("div", { class: "credits-metric" },
    el("span", { class: "credits-metric-l", text: label }),
    el("span", { class: valueCls ? `credits-metric-v ${valueCls}` : "credits-metric-v", text: String(value) }),
    sub ? el("span", { class: "credits-metric-sub", text: sub }) : null,
  );
}

function renderCreditsMetrics(c) {
  const box = $("#creditsMetrics");
  if (!box) return;
  const cards = [
    creditsMetricCard("剩余可用积分", fmtNum(creditNum(c.remain)), "当前可用", "is-remain"),
    creditsMetricCard("已消耗积分", fmtNum(creditNum(c.used)), "累计消耗"),
    creditsMetricCard("总额度容量", fmtNum(creditNum(c.size)), "全部权益包合计"),
  ];
  const ee = c.earliestExpiring;
  if (!ee) {
    cards.push(creditsMetricCard("最近将过期", "无", "没有即将到期的权益包", "is-muted"));
  } else {
    const days = creditDaysLeft(ee.daysLeft, ee.cycleEndTime || ee.expireTime);
    const n = days == null ? null : Math.max(1, Math.ceil(days));
    const date = fmtMonthDay(ee.cycleEndTime || ee.expireTime);
    const sub = [date ? `${date} 到期` : "", `${fmtNum(creditNum(ee.remain))} 积分`].filter(Boolean).join(" · ");
    cards.push(creditsMetricCard("最近将过期", n == null ? "即将到期" : `剩 ${n} 天`, sub));
  }
  box.replaceChildren(...cards);
}

function renderCreditsUsage(c) {
  const box = $("#creditsUsage");
  if (!box) return;
  const pct = creditUsagePct(c);
  const text = creditUsageText(c);
  const updated = String(c.updatedIso ?? "").trim() || "—";
  box.replaceChildren(
    el("div", { class: "credits-usage-row" },
      el("div", {
        class: "credits-bar",
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": String(Math.round(pct)),
        "aria-label": `额度利用率 ${text}`,
        title: `已消耗 ${fmtNum(creditNum(c.used))} / 总额度 ${fmtNum(creditNum(c.size))}`,
      },
        el("span", { class: "credits-bar-fill", style: { width: `${pct}%` } }),
      ),
      el("div", { class: "credits-usage-meta" },
        el("span", { class: "credits-usage-pct", text: `额度利用率: ${text}` }),
        el("span", { text: `更新时间: ${updated}` }),
      ),
    ),
  );
}

function renderCreditsStatus() {
  const box = $("#creditsStatus");
  if (!box) return;
  let text = "";
  let cls = "credits-status";
  if (creditsDialog.error) {
    text = creditsDialog.error;
    if (creditsDialog.needRelogin) text += "（需要重新登录 WorkBuddy）";
    if (creditsDialog.credits) text = `刷新失败，显示缓存数据：${text}`;
    cls += " credits-status-error";
  } else if (creditsDialog.loading) {
    text = creditsDialog.credits ? "刷新中…" : "加载中…";
    cls += " credits-status-loading";
  }
  box.className = cls;
  box.textContent = text;
  box.hidden = !text;
}

function syncCreditsControls() {
  for (const b of $$("[data-credits-filter]")) {
    const on = b.dataset.creditsFilter === creditsDialog.filter;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }
  const search = $("#creditsSearch");
  if (search) search.value = creditsDialog.query;
  const sort = $("#creditsSort");
  if (sort) sort.value = creditsDialog.sort;
}

function renderCreditsDialog() {
  const dlg = $("#creditsDialog");
  if (!dlg) return;
  const acct = creditsDialog.uid ? accountByUid(creditsDialog.uid) : null;
  const nick = creditsDialog.nickname || String(acct?.nickname ?? "") || creditsDialog.uid || "账号";
  const c = creditsDialog.credits && typeof creditsDialog.credits === "object" ? creditsDialog.credits : null;

  const title = $("#creditsTitle");
  if (title) title.textContent = `${nick} · 积分明细`;

  const badges = $("#creditsBadges");
  if (badges) {
    badges.replaceChildren(badge("国内版", "badge-quiet"));
    if (c) {
      const paid = !!c.isPaidUser || !!c.tier?.paid;
      badges.append(badge(creditTierName(c), paid ? "badge-strong" : "badge-quiet"));
    } else {
      badges.append(badge("会员类型未知", "badge-quiet"));
    }
  }

  renderCreditsStatus();

  const has = !!c;
  const metrics = $("#creditsMetrics");
  const usage = $("#creditsUsage");
  const filters = $("#creditsFilters");
  const tableWrap = $("#creditsTableWrap");
  if (metrics) metrics.hidden = !has;
  if (usage) usage.hidden = !has;
  if (filters) filters.hidden = !has;
  if (tableWrap) tableWrap.hidden = !has;
  if (has) {
    renderCreditsMetrics(c);
    renderCreditsUsage(c);
    renderCreditsPkgs();
  } else {
    const tbody = $("#creditsPkgRows");
    if (tbody) tbody.replaceChildren();
  }

  const refreshBtn = $("#creditsRefreshBtn");
  if (refreshBtn) {
    refreshBtn.disabled = creditsDialog.loading;
    refreshBtn.textContent = creditsDialog.loading ? "刷新中…" : "刷新明细";
  }
}

async function refreshCreditsInDialog() {
  const uid = creditsDialog.uid;
  if (!uid || creditsDialog.loading) return;
  const req = ++creditsDialog.req;
  creditsDialog.loading = true;
  creditsDialog.error = "";
  creditsDialog.needRelogin = false;
  renderCreditsDialog();
  const r = await requestCredits(uid, true);
  // 请求期间弹窗已关闭/切换账号/发起了更新的一次刷新：丢弃本次结果。
  if (creditsDialog.req !== req || creditsDialog.uid !== uid) return;
  if (r.ok) applyCredits(uid, r.credits, r.nickname);
  creditsDialog.loading = false;
  if (r.ok) {
    creditsDialog.credits = r.credits;
    if (r.nickname) creditsDialog.nickname = String(r.nickname);
    creditsDialog.error = "";
    creditsDialog.needRelogin = false;
  } else {
    creditsDialog.error = r.error;
    creditsDialog.needRelogin = !!r.needRelogin;
    if (r.kind === "busy") toastCreditsBusy();
  }
  renderCreditsDialog();
}

function openCreditsDialog(uid) {
  const acct = accountByUid(uid);
  const dlg = $("#creditsDialog");
  if (!acct || !dlg) return;
  creditsDialog.uid = uid;
  creditsDialog.nickname = String(acct.nickname || uid);
  creditsDialog.credits =
    acct.credits && typeof acct.credits === "object" ? acct.credits : creditCache.get(uid) ?? null;
  creditsDialog.filter = "all";
  creditsDialog.sort = "expiry";
  creditsDialog.query = "";
  creditsDialog.loading = false;
  creditsDialog.error = "";
  creditsDialog.needRelogin = false;
  syncCreditsControls();
  renderCreditsDialog();
  if (!dlg.open) {
    try {
      dlg.showModal();
    } catch {}
  }
  // 秒开后立刻 refresh=1 一次：缓存可能已被后端更新（与 hub 行为一致）。
  refreshCreditsInDialog();
}

function closeCreditsDialog() {
  const dlg = $("#creditsDialog");
  creditsDialog.req++; // 关闭后在途刷新结果一律丢弃
  if (dlg?.open) dlg.close();
  creditsDialog.uid = "";
  creditsDialog.loading = false;
}

function wireCreditsDialog() {
  const dlg = $("#creditsDialog");
  if (!dlg) return;
  $("#creditsCloseBtn").addEventListener("click", closeCreditsDialog);
  $("#creditsDoneBtn").addEventListener("click", closeCreditsDialog);
  $("#creditsRefreshBtn").addEventListener("click", () => refreshCreditsInDialog());
  for (const b of $$("[data-credits-filter]")) {
    b.addEventListener("click", () => {
      const f = b.dataset.creditsFilter;
      if (!CREDITS_FILTERS.includes(f)) return;
      creditsDialog.filter = f;
      syncCreditsControls();
      renderCreditsPkgs();
    });
  }
  const search = $("#creditsSearch");
  if (search) {
    search.addEventListener("input", () => {
      creditsDialog.query = search.value;
      renderCreditsPkgs();
    });
  }
  const sort = $("#creditsSort");
  if (sort) {
    sort.addEventListener("change", () => {
      creditsDialog.sort = CREDITS_SORTS.includes(sort.value) ? sort.value : "expiry";
      renderCreditsPkgs();
    });
  }
  // 原生 close 事件是异步排队的：若已重新打开（快速切换账号），不要清掉新状态。
  dlg.addEventListener("close", () => {
    if (dlg.open) return;
    creditsDialog.req++;
    creditsDialog.uid = "";
    creditsDialog.loading = false;
  });
  // 点遮罩关闭（内容在 .credits-body 里，点中 dialog 本身即遮罩区域）
  dlg.addEventListener("click", (ev) => {
    if (ev.target === dlg) closeCreditsDialog();
  });
}

// 「批量接任务」按钮旁的常驻说明（规则 4）：勾选范围内有多少未接取项被引擎判定为
// 不可自动接取（桌面端 / 未收录）。数字只来自后端 canAccept 字段；老后端没给字段、
// 或计数为 0 时不显示（不猜、不静默少接）。
function renderAcceptNote() {
  const box = $("#acceptNote");
  if (!box) return;
  let blocked = 0;
  let noSnap = 0;
  let modern = false;
  for (const a of targetAccounts()) {
    const all = a.snapshot?.tasks;
    if (!Array.isArray(all)) {
      noSnap++;
      continue;
    }
    // 只看当前勾选（没勾选 = 全部）——说明文字与实际会提交的范围保持一致
    const set = pickedSet(a.uid);
    const tasks = set && set.size ? all.filter((t) => set.has(String(t?.code ?? ""))) : all;
    if (tasks.some((t) => taskFlags(t).modern)) modern = true;
    blocked += acceptPlan(tasks).blocked;
  }
  const parts = [];
  if (modern && blocked > 0) parts.push(`${blocked} 项不可自动接取（桌面端/未收录）`);
  if (noSnap > 0) parts.push(`${noSnap} 个账号无快照（接取前会先只读刷新）`);
  box.textContent = parts.join(" · ");
  box.hidden = parts.length === 0;
}

function updateSelectionUI() {
  const elig = eligibleAccounts();
  const selCount = state.selected.size;
  $("#selCount").textContent = selCount
    ? `已选 ${selCount} 个账号`
    : `未选择 = 全部可参与账号（${elig.length} 个）`;
  const all = $("#selectAll");
  all.checked = elig.length > 0 && selCount === elig.length;
  all.indeterminate = selCount > 0 && selCount < elig.length;
  all.disabled = elig.length === 0;

  const jobRunning = !!state.data?.job;
  const offline = state.conn !== "online";
  const noElig = elig.length === 0;
  for (const id of ["#btnAccept", "#btnRun", "#btnClaim", "#btnCheckin"]) {
    const b = $(id);
    b.disabled = state.busy || jobRunning || offline || noElig;
  }
  $("#btnRun").textContent = jobRunning ? "任务运行中…" : "批量做任务";
  if (noElig && !offline) {
    $("#btnRun").title = "没有可参与任务的账号";
  } else if (totalPickedCount() > 0) {
    $("#btnRun").title = "完整流水线：接取 → 点亮（上报进度）→ 领奖；只做各账号勾选的任务（旅行/夜猫子腿不受影响）";
  } else {
    $("#btnRun").title = "完整流水线：接取 → 点亮（上报进度）→ 领奖";
  }
  // 批量接取只提交 canAccept === true 的 codes；不可接取的项数在按钮旁说明
  $("#btnAccept").title = "只接取守护进程判定 canAccept 的任务（桌面端 / 未收录 / 自动任务不会进名单）；有任务勾选时只接勾选项";
  renderAcceptNote();
  updateTaskSelNote();
}

// ---- 实时进度区 --------------------------------------------------------------------------

function stepRow(s) {
  const gain = [];
  if (Number(s.credit) > 0) gain.push(`+${fmtNum(s.credit)} 积分`);
  if (Number(s.energy) > 0) gain.push(`+${fmtNum(s.energy)} 能量`);
  return el(
    "tr",
    {},
    el("td", { "data-label": "账号" },
      el("span", { class: "cell-main", text: String(s.nickname || s.uid || "—") }),
      s.uid ? el("span", { class: "cell-sub", text: String(s.uid) }) : null,
    ),
    el("td", { "data-label": "腿", text: legName(s.leg) }),
    el("td", { "data-label": "状态" }, stepBadge(s.state)),
    el("td", { "data-label": "详情", class: "detail-cell", text: String(s.detail ?? "") || "—" }),
    el("td", { "data-label": "收益", class: "num", text: gain.length ? gain.join(" · ") : "—" }),
    el("td", { "data-label": "时间", class: "num", text: fmtTime(s.at) }),
  );
}

function renderJobLogs() {
  const pane = $("#jobLogPane");
  if (!pane) return;
  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 30;
  const job = state.data?.job ?? state.lastFinished;
  const lines = Array.isArray(job?.log) ? job.log : [];
  pane.replaceChildren(...lines.map((l) => document.createTextNode(String(l) + "\n")));
  if (atBottom) pane.scrollTop = pane.scrollHeight;
}

function renderJob() {
  const box = $("#jobBody");
  const actions = $("#jobActions");
  actions.replaceChildren();
  const job = state.data?.job ?? state.lastFinished;

  if (!job) {
    box.replaceChildren(
      el(
        "div",
        { class: "empty job-empty" },
        el("strong", { text: "当前没有任务在跑" }),
        "勾选账号与任务腿后点「批量做任务」启动一轮：接取 → 点亮 → 领奖；排程到点也会自动运行。",
      ),
    );
    return;
  }

  const finished = job.state === "done" || job.state === "error";
  if (!finished) {
    actions.append(
      el("button", {
        type: "button",
        class: "ghost-btn ghost-danger",
        text: "停止当前任务",
        onclick: stopJob,
      }),
    );
  }

  const totals = job.totals ?? {};
  const meta = el(
    "div",
    { class: "job-meta" },
    finished && !state.data?.job ? badge("最近一轮（已结束）", "badge-quiet") : null,
    badge(JOB_STATE_NAMES[job.state] ?? String(job.state ?? "—"), job.state === "error" ? "badge-warn" : "badge-strong"),
    job.stopped ? badge("已被要求停止", "badge-warn") : null,
    el("span", { class: "mono muted", text: String(job.id ?? "") }),
    el("span", { class: "muted", text: `触发：${TRIGGER_NAMES[job.trigger] ?? job.trigger ?? "—"}` }),
    el("span", { class: "muted", text: `开始 ${fmtDateTime(job.startedAt)}` }),
    job.endedAt ? el("span", { class: "muted", text: `结束 ${fmtDateTime(job.endedAt)}` }) : null,
    job.error ? el("span", { class: "warn-text", text: String(job.error) }) : null,
  );

  const totalsBar = el(
    "dl",
    { class: "job-totals", "aria-label": "本轮累计" },
    el("div", {}, el("dt", { text: "本轮积分" }), el("dd", { text: `+${fmtNum(totals.credit)}` })),
    el("div", {}, el("dt", { text: "本轮能量" }), el("dd", { text: `+${fmtNum(totals.energy)}` })),
    el("div", {}, el("dt", { text: "点亮" }), el("dd", { text: fmtNum(totals.tasksLit) })),
    el("div", {}, el("dt", { text: "领奖" }), el("dd", { text: fmtNum(totals.tasksClaimed) })),
  );

  const steps = Array.isArray(job.steps) ? job.steps : [];
  const stepsTable = steps.length
    ? el(
        "div",
        { class: "tbl-wrap" },
        el(
          "table",
          { class: "tbl tbl-steps" },
          el("thead", {},
            el("tr", {},
              el("th", { text: "账号" }),
              el("th", { text: "腿" }),
              el("th", { text: "状态" }),
              el("th", { text: "详情" }),
              el("th", { text: "收益", class: "num" }),
              el("th", { text: "时间", class: "num" }),
            ),
          ),
          el("tbody", {}, steps.map(stepRow)),
        ),
      )
    : el("p", { class: "muted", text: "还没有步骤产出。" });

  const logPane = el("div", { class: "logpane", id: "jobLogPane", "aria-label": "运行日志" });

  box.replaceChildren(
    meta,
    totalsBar,
    el("div", { class: "subhead" }, el("span", { class: "label", text: "步骤" })),
    stepsTable,
    el("div", { class: "subhead" }, el("span", { class: "label", text: "日志" })),
    logPane,
  );
  renderJobLogs();
}

// ---- 批量操作 ------------------------------------------------------------------------------

function setBatchStatus(text) {
  $("#batchStatus").textContent = text ?? "";
}

// 顶部「任务腿」是唯一选择源：勾选由 settings.legs 回写，HTML 里不再写死 checked。
// settings.legs 缺失/为空时回退到旧版出厂默认（成长任务），与后端「未指定 legs 时补 growth」一致。
const DEFAULT_LEGS = ["growth"];
let syncedLegsKey = null; // 最近一次从 settings.legs 同步到顶部的值（排序后拼接）

function legsFromSettings(v) {
  const legs = Array.isArray(v) ? v.filter((l) => typeof l === "string" && l) : [];
  return legs.length ? legs : DEFAULT_LEGS;
}

// 按 settings.legs 同步顶部 .leg-check。默认只在服务端值变化（或 force）时覆盖：
// 3s/5s 的后台轮询也会走 renderScheduler，不能把用户尚未保存的勾选改回去。
function syncLegChecks(legs, { force = false } = {}) {
  const list = legsFromSettings(legs);
  const key = [...list].sort().join(",");
  if (!force && key === syncedLegsKey) return;
  syncedLegsKey = key;
  for (const cb of $$(".leg-check")) setChecked(cb, list.includes(cb.value));
}

function selectedLegs() {
  return $$(".leg-check:checked").map((i) => i.value);
}

function withBusy(fn) {
  if (state.busy) return Promise.resolve();
  state.busy = true;
  updateSelectionUI();
  return Promise.resolve()
    .then(fn)
    .catch((e) => humanErr(e, "批量操作失败"))
    .finally(() => {
      state.busy = false;
      updateSelectionUI();
    });
}

async function runFull() {
  const legs = selectedLegs();
  if (!legs.length) {
    toast("请至少勾选一条任务腿（成长任务 / 猫猫旅行 / 夜猫子）。", "warn");
    return;
  }
  await withBusy(async () => {
    const uids = [...state.selected];
    // 任务级勾选按 uid 提交：只有「该账号有勾选」的 uid 进 codes，未出现的账号 = 全部任务。
    // travel / night 腿没有任务码，后端会忽略 codes，不受勾选影响。
    const codes = selectionBody(targetAccounts());
    const picked = selectionCount(codes);
    const body = { legs, claim: $("#claimToggle").checked };
    if (uids.length) body.uids = uids;
    if (picked) body.codes = codes;
    setBatchStatus(
      `正在启动批量任务：${legs.map(legName).join(" + ")}，${uids.length ? `${uids.length} 个账号` : "全部可参与账号"}，` +
        `${picked ? `仅选中任务（${picked} 项），` : ""}${body.claim ? "自动领奖" : "手动领奖（做完不领，之后可「只领奖」）"}…`,
    );
    try {
      const r = await api("api/run", { method: "POST", body });
      setBatchStatus(`已启动 ${r?.job?.id ?? "批量任务"}：进度见「实时进度」区（SSE 推送）。`);
      state.lastFinished = null;
      await loadState();
      connectSSE();
    } catch (e) {
      setBatchStatus("");
      humanErr(e, "启动批量任务失败");
    }
  });
}

// 拿账号的可操作任务码：没有快照就先刷一次（?refresh=<uid>，走上游、daemon 自带限速）
async function ensureSnapshot(a) {
  if (a.snapshot) return a;
  const d = await api("api/state", { params: { refresh: a.uid } });
  state.data = d;
  renderAll();
  return accountByUid(a.uid) ?? a;
}

async function acceptSelected() {
  await withBusy(async () => {
    const targets = targetAccounts();
    if (!targets.length) return toast("没有可参与任务的账号。", "warn");
    let accepted = 0,
      already = 0,
      failed = 0;
    const noCode = [];
    const blockedNotes = [];
    const pickedEmpty = [];
    const notes = [];
    let usedPicked = false;
    for (let i = 0; i < targets.length; i++) {
      const a0 = targets[i];
      setBatchStatus(`批量接取（${i + 1}/${targets.length}）：${a0.nickname || a0.uid} …`);
      let a = a0;
      try {
        a = await ensureSnapshot(a0);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setBatchStatus("已有批量任务在跑，接取中止（守护进程限速保护）。");
          return;
        }
        notes.push(`${a0.nickname || a0.uid}：快照刷新失败（${e.message}）`);
        continue;
      }
      const plan = acceptPlan(a.snapshot?.tasks);
      // 任务级勾选：只提交与 acceptPlan.codes 的交集；勾选项全被过滤掉时明确说明，
      // 绝不静默退回「接该账号全部」（未勾选的账号不受影响 = 全部）。
      const picked = pickedCodes(a.uid);
      const pickedSet = picked ? new Set(picked) : null;
      if (pickedSet) usedPicked = true;
      const codes = pickedSet ? plan.codes.filter((c) => pickedSet.has(c)) : plan.codes;
      // 规则 4：不可自动接取的项要说出来，不能静默少接
      if (plan.blocked) {
        blockedNotes.push(`${a.nickname || a.uid}：${plan.blocked} 项不可自动接取（桌面端/未收录）`);
      }
      if (pickedSet && !codes.length) {
        pickedEmpty.push(`${a.nickname || a.uid}：已选任务都不可自动接取/无待接`);
        continue;
      }
      if (!codes.length) {
        const why = plan.noCode
          ? "快照缺任务码"
          : plan.blocked
            ? `${plan.blocked} 项不可自动接取（桌面端/未收录）`
            : plan.auto
              ? `仅 ${plan.auto} 项自动任务，无需接取`
              : "无未接任务";
        noCode.push(`${a.nickname || a.uid}（${why}）`);
        continue;
      }
      try {
        const r = await api("api/task/accept", { method: "POST", body: { uid: a.uid, codes } });
        accepted += (r?.accepted ?? []).length;
        already += (r?.already ?? []).length;
        failed += (r?.failed ?? []).length;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setBatchStatus("已有批量任务在跑，接取中止（守护进程限速保护）。");
          return;
        }
        notes.push(`${a.nickname || a.uid}：${e.message}`);
      }
    }
    const parts = [
      `批量接取完成${usedPicked ? "（仅选中任务）" : ""}：新接 ${accepted} · 已接过 ${already} · 失败 ${failed}`,
    ];
    if (blockedNotes.length) parts.push(`不可自动接取：${blockedNotes.join("、")}`);
    if (pickedEmpty.length) parts.push(`按勾选跳过：${pickedEmpty.join("、")}`);
    if (noCode.length) parts.push(`跳过：${noCode.join("、")}`);
    if (notes.length) parts.push(notes.join("；"));
    setBatchStatus(parts.join("。"));
    await loadState();
  });
}

async function claimSelected() {
  await withBusy(async () => {
    const targets = targetAccounts();
    if (!targets.length) return toast("没有可参与任务的账号。", "warn");
    let okCount = 0,
      credit = 0,
      energy = 0,
      viaWeb = 0;
    const failNotes = [];
    const noCode = [];
    const pickedEmpty = [];
    let usedPicked = false;
    for (let i = 0; i < targets.length; i++) {
      const a0 = targets[i];
      setBatchStatus(`只领奖（${i + 1}/${targets.length}）：${a0.nickname || a0.uid} …`);
      let a = a0;
      try {
        a = await ensureSnapshot(a0);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setBatchStatus("已有批量任务在跑，领奖中止。");
          return;
        }
        failNotes.push(`${a0.nickname || a0.uid}：快照刷新失败`);
        continue;
      }
      // 任务级勾选：pending 任务按勾选过滤；有勾选但无匹配待领奖时明确说明
      const picked = pickedCodes(a.uid);
      const pickedSet = picked ? new Set(picked) : null;
      if (pickedSet) usedPicked = true;
      const pending = (a.snapshot?.tasks ?? []).filter((t) => t.acceptStatus === "completed");
      const scoped = pickedSet ? pending.filter((t) => pickedSet.has(String(t?.code ?? ""))) : pending;
      const codes = scoped.filter((t) => t.code).map((t) => t.code);
      if (pickedSet && !scoped.length) {
        pickedEmpty.push(`${a.nickname || a.uid}：已选任务都不可领奖/无待领奖`);
        continue;
      }
      if (scoped.length && !codes.length) noCode.push(a.nickname || a.uid);
      for (const code of codes) {
        try {
          const r = await api("api/task/claim", { method: "POST", body: { uid: a.uid, code } });
          if (r?.ok) {
            okCount++;
            credit += Number(r.credit) || 0;
            energy += Number(r.energy) || 0;
            if (r?.via === "web") viaWeb++;
          } else {
            failNotes.push(`${a.nickname || a.uid}/${code}：${r?.reason || "上游未说明"}`);
          }
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            setBatchStatus("已有批量任务在跑，领奖中止。");
            return;
          }
          failNotes.push(`${a.nickname || a.uid}/${code}：${e.message}`);
        }
      }
    }
    const parts = [
      `领奖完成${usedPicked ? "（仅选中任务）" : ""}：成功 ${okCount} 项，+${fmtNum(credit)} 积分，+${fmtNum(energy)} 能量`,
    ];
    if (viaWeb) parts.push(`其中 ${viaWeb} 项已走网页通道（桌面端领奖被拒，网页兜底成功）`);
    if (pickedEmpty.length) parts.push(`按勾选跳过：${pickedEmpty.join("、")}`);
    if (noCode.length) parts.push(`无法领取（快照缺任务码）：${noCode.join("、")}`);
    if (failNotes.length) parts.push(`未成功：${failNotes.slice(0, 6).join("；")}${failNotes.length > 6 ? " 等" : ""}`);
    parts.push("任务表里的状态以快照为准，可点账号旁「刷新快照」查看最新。");
    setBatchStatus(parts.join("。"));
    await loadState();
  });
}

async function checkinSelected() {
  await withBusy(async () => {
    const uids = [...state.selected];
    setBatchStatus("每日签到中…（账号之间守护进程会间隔至少 1.5 秒）");
    try {
      const body = uids.length ? { uids } : {};
      const rows = await api("api/checkin", { method: "POST", body });
      const list = Array.isArray(rows) ? rows : [];
      if (!list.length) {
        setBatchStatus("签到完成：没有可签到的账号。");
        return;
      }
      const lines = list.map((r) => {
        const who = accountByUid(r.uid)?.nickname || r.uid;
        const outcome = OUTCOME_NAMES[r.outcome] ?? String(r.outcome ?? "—");
        const gain = Number(r.credit) > 0 ? `，+${fmtNum(r.credit)} 积分` : "";
        const streak = r.streak != null ? `，连登 ${r.streak} 天` : "";
        const msg = r.message ? `（${r.message}）` : "";
        return `${who}：${outcome}${gain}${streak}${msg}`;
      });
      setBatchStatus(`每日签到完成：\n${lines.join("\n")}`);
      await loadState();
    } catch (e) {
      setBatchStatus("");
      humanErr(e, "签到失败");
    }
  });
}

async function stopJob() {
  try {
    await api("api/stop", { method: "POST" });
    toast("已请求停止：在当前步骤边界生效（不打断进行中的上游调用）。");
    await loadState();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      toast("当前没有正在运行的任务。");
      await loadState();
      return;
    }
    humanErr(e, "停止失败");
  }
}

async function rescanAccounts() {
  const btn = $("#rescanBtn");
  btn.disabled = true;
  try {
    const r = await api("api/accounts", { method: "POST" });
    toast(`账号扫描完成：workbuddy 条目 ${r?.count ?? 0} 个，可参与 ${r?.eligible ?? 0} 个`);
    await loadState();
    await loadHistory();
  } catch (e) {
    humanErr(e, "扫描失败");
  } finally {
    btn.disabled = false;
  }
}

// ---- 账号导出 / 导入（契约 §9；hub 移植口径）------------------------------------------
// 纪律：
//   - 守护进程无鉴权：导出走 fetch，不带 Authorization，URL 不带 ?k=。
//     下载走 fetch → Blob → URL.createObjectURL。
//   - token 只出现在下载的导出文件里：页面文本绝不渲染 accessToken/refreshToken
//     （导入响应经后端 planView 本就剥掉 token；导出只读 count/exportedAt 做摘要）。
//   - uid / 目标 key / 文件名 / 备份名一律等宽（.mono / code）。
//   - 服务端字符串（note/reason/reloadHint/inputHint/error）全部经 el() 的 textContent。

// 纯函数：解析 Content-Disposition 里的文件名（后端 download=1 时给
// attachment; filename="workbuddy-accounts-….json"，已净化为 ASCII）。
// RFC 5987 的 filename*=UTF-8''… 优先；解析不出返回 ""（调用方按 hub 规则本地拼）。
// 顺手再挡一遍路径分隔符（纵深防御，正常后端不会给）。导出仅为 Node 下单元验证。
export function filenameFromDisposition(cd) {
  const s = String(cd ?? "");
  if (!s) return "";
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(s);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim()).replace(/^"|"$/g, "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
    } catch {}
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(s);
  const name = plain ? plain[1].trim() : "";
  return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
}

// Content-Disposition 取不到时的本地兜底文件名：与 hub 规则
//（engine/accountio.exportFileName）逐字同款。导出仅为 Node 下单元验证。
export function localExportFileName({ uids = [], realm = null, now = Date.now() } = {}) {
  const p = (n) => String(n).padStart(2, "0");
  const d = new Date(Number(now) || Date.now());
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const label = Array.isArray(uids) && uids.length === 1 ? String(uids[0]).slice(0, 8) : realm ? `${realm}-` : "";
  const safe = `workbuddy-accounts-${label}${stamp}.json`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return safe || "export.json";
}

const SCOPE_NAMES = { all: "全部（国内版）", selected: "仅勾选的账号" };

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename, style: { display: "none" } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// 后端不带 realm 时只导出国内版；「仅勾选」用 uid 列表收窄。
function exportScope() {
  const radio = $('input[name="expScope"]:checked');
  const scope = radio ? radio.value : "all";
  if (scope === "selected") return { scope, realm: null, uids: [...state.selected] };
  return { scope: "all", realm: null, uids: [] };
}

// 「含凭据」勾选联动：默认勾上（与 hub 一致）；勾/取消各自给一行说明
function syncExportHints() {
  const secrets = $("#expSecrets").checked;
  $("#expSecretsWarn").hidden = !secrets;
  $("#expSanitizedNote").hidden = secrets;
  $("#expCredHint").textContent = secrets
    ? "含凭据导出会下载含 accessToken / refreshToken 的文件（等同钥匙，别外发）。"
    : "脱敏导出删掉 accessToken / refreshToken 两个键，只能看不能登录。";
}

async function exportAccounts(btn) {
  const secrets = $("#expSecrets").checked;
  const { scope, realm, uids } = exportScope();
  const status = $("#expStatus");
  if (scope === "selected" && !uids.length) {
    toast("「仅勾选的账号」需要先在下方账号区勾选至少一个账号。", "warn", 6500);
    return;
  }
  btn.disabled = true;
  status.textContent = `正在导出（${SCOPE_NAMES[scope] ?? scope} · ${secrets ? "含凭据" : "脱敏"}）…`;
  const doFetch = async () => {
    const url = new URL("api/accounts/export", location.href);
    url.searchParams.set("secrets", secrets ? "1" : "0");
    url.searchParams.set("download", "1");
    if (uids.length) url.searchParams.set("uid", uids.join(","));
    let res;
    try {
      res = await fetch(url);
    } catch {
      const err = new Error("连不上守护进程");
      err.network = true;
      throw err;
    }
    if (!res.ok) {
      let data = null;
      try {
        data = await res.json();
      } catch {}
      throw new ApiError(res.status, data);
    }
    return res;
  };
  try {
    const res = await doFetch();
    const name = filenameFromDisposition(res.headers.get("Content-Disposition")) || localExportFileName({ uids, realm });
    const blob = await res.blob();
    // 摘要只取 count / exportedAt（绝不把账号行、token 渲染进页面）
    let doc = null;
    try {
      doc = JSON.parse(await blob.text());
    } catch {}
    triggerBlobDownload(blob, name);
    const count = Number(doc?.count);
    const parts = [
      Number.isFinite(count) ? `已导出 ${count} 个账号` : "已导出",
      `${SCOPE_NAMES[scope] ?? scope} · ${secrets ? "含凭据" : "脱敏"}`,
    ];
    if (typeof doc?.exportedAt === "string" && doc.exportedAt) parts.push(doc.exportedAt);
    status.replaceChildren(
      el("span", { text: `${parts.join(" · ")}：` }),
      el("code", { class: "mono", text: name }),
      secrets
        ? el("span", { class: "warn-text", text: " · 文件内含 accessToken/refreshToken，等同钥匙，别外发。" })
        : el("span", { class: "muted", text: " · 脱敏清单不能用于登录，只能用来看。" }),
    );
  } catch (e) {
    if (e && e.network) {
      status.textContent = "";
      humanErr(e, "导出失败");
    } else if (e instanceof ApiError) {
      // 后端中文 error 原样透出（如 404 no such account），不显示堆栈
      status.textContent = `导出失败（HTTP ${e.status}）：${e.message}`;
    } else {
      status.textContent = `导出失败：${e?.message ?? e}`;
    }
  } finally {
    btn.disabled = false;
  }
}

// ---- 导入（两段式：预览只读不写盘 → 确认写入 plugin-auth.json）-----------------------
// impState.blob = 预览用的已解析对象（确认必须与预览同一份内容）；previewOk = 预览
// 成功才显示「确认写入」。textarea / 文件的任何变动都让预览失效 —— 后端的哈希竞态
// 守卫只盯 plugin-auth.json 的变化，「导入内容改了没重新预览」只能前端挡。
const impState = { blob: null, previewOk: false, totals: null };

function impInvalidate(note) {
  const wasOk = impState.previewOk;
  impState.blob = null;
  impState.previewOk = false;
  impState.totals = null;
  $("#impConfirmBtn").hidden = true;
  if (wasOk && note) setImpStatus(note);
}

function setImpStatus(text) {
  $("#impStatus").textContent = text ?? "";
}

function readImportJson() {
  const text = $("#impText").value.trim();
  if (!text) {
    setImpStatus("请先粘贴账号 JSON，或选择本地 .json 文件读入。");
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    setImpStatus(`本地 JSON 解析失败（还没有发请求）：${e?.message ?? e}`);
    return undefined;
  }
}

async function importPreview() {
  const btn = $("#impPreviewBtn");
  const parsed = readImportJson();
  if (parsed === undefined) return;
  btn.disabled = true;
  $("#impConfirmBtn").hidden = true;
  $("#impResult").replaceChildren();
  setImpStatus("正在预览…（只读，不写盘）");
  try {
    // body = {"blob":<账号数据本体>}：confirm 缺省 = 预览分支（只读）
    const r = await api("api/accounts/import", { method: "POST", body: { blob: parsed, confirm: false } });
    impState.blob = parsed;
    impState.previewOk = true;
    impState.totals = r?.preview?.totals ?? null;
    renderImportPreview(r);
    setImpStatus(String(r?.note ?? "预览未写入任何文件"));
    $("#impConfirmBtn").hidden = false;
  } catch (e) {
    impInvalidate();
    renderImportError(e, "预览失败");
  } finally {
    btn.disabled = false;
  }
}

// 预览四组列表：adds/updates 常规色；skips 用 --ink3（muted）；rejects 用 --warn ——
// 不用刺眼的红。每条显示 uid、昵称、目标 key 与 reason 原文（全部 textContent）。
function impWho(x) {
  return String(x?.nickname || x?.uid || "—");
}

function impUidKeyCells(x) {
  const cells = [];
  if (x?.uid != null && x.uid !== "") cells.push(el("span", { class: "mono imp-uid", text: String(x.uid) }));
  if (x?.key) cells.push(el("span", { class: "mono imp-key", text: String(x.key) }));
  return cells;
}

function impGroup(title, rows, rowCls) {
  if (!rows.length) return null;
  return el(
    "div",
    { class: "imp-group" },
    el("p", { class: "label imp-group-title", text: `${title}（${rows.length}）` }),
    ...rows.map((x) => el("div", { class: `imp-row ${rowCls}`.trim() }, ...x)),
  );
}

function renderImportPreview(r) {
  const box = $("#impResult");
  box.replaceChildren();
  const pv = r?.preview ?? {};
  const t = pv.totals ?? {};
  const adds = Array.isArray(pv.adds) ? pv.adds : [];
  const updates = Array.isArray(pv.updates) ? pv.updates : [];
  const skips = Array.isArray(pv.skips) ? pv.skips : [];
  const rejects = Array.isArray(pv.rejects) ? pv.rejects : [];

  box.append(
    el("p", {
      class: "imp-totals",
      text: `新增 ${Number(t.adds) || 0} · 更新 ${Number(t.updates) || 0} · 跳过 ${Number(t.skips) || 0} · 拒绝 ${Number(t.rejects) || 0}`,
    }),
  );

  const groups = [
    impGroup(
      "新增",
      adds.map((x) => [
        el("span", { class: "imp-name", text: impWho(x) }),
        ...impUidKeyCells(x),
      ]),
      "",
    ),
    impGroup(
      "更新（覆盖 access/refresh/expires）",
      updates.map((x) => [
        el("span", { class: "imp-name", text: impWho(x) }),
        ...impUidKeyCells(x),
        el("span", {
          class: "mono imp-expiry",
          text: `${fmtDateTime(x?.fromExpires)} → ${fmtDateTime(x?.toExpires)}`,
        }),
        el("span", { class: "imp-reason", text: String(x?.reason ?? "") }),
      ]),
      "",
    ),
    impGroup(
      "跳过（不写入）",
      skips.map((x) => [
        el("span", { class: "imp-name", text: impWho(x) }),
        ...impUidKeyCells(x),
        el("span", { class: "imp-reason", text: String(x?.reason ?? "") }),
      ]),
      "imp-row-skip",
    ),
    impGroup(
      "拒绝（不导入）",
      rejects.map((x) => [
        el("span", { class: "mono imp-index", text: `#${Number(x?.index) || 0}` }),
        el("span", { class: "imp-reason", text: String(x?.reason ?? "") }),
        x?.inputHint ? el("span", { class: "mono imp-hint", text: String(x.inputHint) }) : null,
      ]),
      "imp-row-reject",
    ),
  ].filter(Boolean);

  if (!groups.length) {
    box.append(el("p", { class: "muted", text: "文档里没有可解析的行。" }));
    return;
  }
  box.append(...groups);
}

async function importConfirm() {
  const btn = $("#impConfirmBtn");
  if (!impState.previewOk || impState.blob == null) {
    setImpStatus("请先「预览」成功后再确认写入。");
    return;
  }
  const t = impState.totals ?? {};
  // 明示三行后果（备份名规则来自后端 applyImport：bak-hubimport-<YYYYMMDD-HHMMSS>）
  const ok = confirm(
    "确认写入 magpie？\n\n" +
      `· 将写入 <magpie 配置目录>/plugin-auth.json：新增 ${Number(t.adds) || 0} · 更新 ${Number(t.updates) || 0}` +
      `（跳过 ${Number(t.skips) || 0} · 拒绝 ${Number(t.rejects) || 0} 不写入）\n` +
      "· 写前自动逐字节备份为 plugin-auth.json.bak-hubimport-<YYYYMMDD-HHMMSS>\n" +
      "· 国际版（intl）账号不会写入（已在拒绝列表里）\n\n" +
      "写入后需要在 magpie「插件管理」里把 WorkBuddy 关掉再打开，新账号才会被认到。",
  );
  if (!ok) return;
  btn.disabled = true;
  setImpStatus("正在写入 plugin-auth.json…");
  try {
    // confirm:true 写盘（写前自动备份）
    const r = await api("api/accounts/import", { method: "POST", body: { blob: impState.blob, confirm: true } });
    impInvalidate(); // 本次预览已被消耗：再写必须重新预览
    $("#impResult").replaceChildren();
    renderImportResult(r);
    setImpStatus("");
    await loadState(); // 账号列表变了：重拉只读 state（SSE 的 accounts 广播也会触发一次，无害）
  } catch (e) {
    renderImportError(e, "确认写入失败");
  } finally {
    btn.disabled = false;
  }
}

function renderImportResult(r) {
  const box = $("#impResult");
  box.replaceChildren();
  if (!r || typeof r !== "object") {
    box.append(el("div", { class: "banner" }, el("p", { text: "写入完成（守护进程未返回详情）。" })));
    return;
  }
  if (r.wrote !== true) {
    // 无变更分支：{wrote:false, note:"没有需要写入的变更…"}
    box.append(
      el("div", { class: "banner" },
        el("strong", { text: "未写入" }),
        el("p", { text: String(r.note ?? "没有需要写入的变更（新增/更新均为 0）。") }),
      ),
    );
    return;
  }
  const added = Array.isArray(r.added) ? r.added.length : 0;
  const updated = Array.isArray(r.updated) ? r.updated.length : 0;
  const skipped = Array.isArray(r.skipped) ? r.skipped.length : 0;
  box.append(
    el("p", { class: "imp-totals", text: `已写入：新增 ${added} · 更新 ${updated} · 跳过 ${skipped}` }),
    r.backedUpTo
      ? el("p", { class: "imp-line" },
          el("span", { text: "写前已备份：" }),
          el("code", { class: "mono", text: String(r.backedUpTo) }),
        )
      : el("p", { class: "imp-line muted", text: "本次没有生成备份（原 plugin-auth.json 不存在，从零建）。" }),
    el("p", { class: "imp-line", text: String(r.reloadHint ?? "在 magpie「插件管理」里把 WorkBuddy 关掉再打开，新账号才会被 magpie 认到") }),
    el("div", { class: "banner banner-warn imp-reload" },
      el("strong", { text: "导入后需要重载" }),
      el("p", { text: "magpie 只有重启插件宿主才会认到新账号（插件管理里关掉再打开 WorkBuddy）。" }),
    ),
  );
}

function renderImportError(e, prefix) {
  const box = $("#impResult");
  if (e instanceof ApiError && e.status === 409 && e.data?.needRepreview) {
    // 竞态守卫：预览后 plugin-auth.json 被改动（magpie 可能刷新过 token）→ 一键重预览
    impState.previewOk = false;
    $("#impConfirmBtn").hidden = true;
    setImpStatus("凭据文件在预览后被改动，请重新预览后再确认。");
    box.replaceChildren(
      el("div", { class: "banner banner-warn" },
        el("strong", { text: "需要重新预览" }),
        el("p", { text: String(e.message || "plugin-auth.json 在预览后发生了变化，为防覆盖已拒绝写入。") }),
        el("p", {},
          el("button", {
            type: "button",
            class: "ghost-btn",
            text: "重新预览",
            onclick: () => importPreview(),
          }),
        ),
      ),
    );
    return;
  }
  box.replaceChildren();
  if (e instanceof ApiError) {
    // 400 无可导入账号 / 409 auth 解析失败 等：后端中文 error 原样透出，不显示堆栈
    setImpStatus(`${prefix}（HTTP ${e.status}）：${e.message}`);
    return;
  }
  if (e && e.network) {
    setImpStatus("");
    humanErr(e, prefix);
    return;
  }
  setImpStatus(`${prefix}：${e?.message ?? e}`);
}

// ---- 导入 / 导出抽屉（已合并进账号卡片） ------------------------------------------------
// 账号卡片右上角按钮控制 ioPanel 的开合；内部两个标签页共用同一套导出/导入逻辑，
// 任何 DOM 文案都还是走 textContent，不新增注入面。

const ioUi = { tab: "export" };

function selectIoTab(tab, { focus = false } = {}) {
  const want = tab === "import" ? "import" : "export";
  ioUi.tab = want;
  const isImport = want === "import";
  const tabExport = $("#ioTabExport");
  const tabImport = $("#ioTabImport");
  const paneExport = $("#ioExportPane");
  const paneImport = $("#ioImportPane");
  if (!tabExport || !tabImport || !paneExport || !paneImport) return;
  tabExport.classList.toggle("is-active", !isImport);
  tabImport.classList.toggle("is-active", isImport);
  tabExport.setAttribute("aria-selected", String(!isImport));
  tabImport.setAttribute("aria-selected", String(isImport));
  tabExport.tabIndex = isImport ? -1 : 0;
  tabImport.tabIndex = isImport ? 0 : -1;
  paneExport.hidden = isImport;
  paneImport.hidden = !isImport;
  if (focus) (isImport ? tabImport : tabExport).focus();
}

function setIoOpen(open, tab) {
  const panel = $("#ioPanel");
  const btn = $("#ioToggleBtn");
  if (!panel || !btn) return;
  panel.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  btn.classList.toggle("is-open", open);
  if (open && tab) selectIoTab(tab);
  if (open) {
    const active = ioUi.tab === "import" ? $("#impText") : $("#expBtn");
    if (active) active.focus({ preventScroll: true });
  }
}

function toggleIo() {
  const panel = $("#ioPanel");
  if (!panel) return;
  setIoOpen(panel.hidden, ioUi.tab);
}

function wireIoTabs() {
  const list = $(".tabs");
  if (!list) return;
  list.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    selectIoTab(ioUi.tab === "export" ? "import" : "export", { focus: true });
  });
}

function wireImportFile() {
  $("#impFile").addEventListener("change", (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = ""; // 允许再次选择同一文件
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      $("#impText").value = String(reader.result ?? "");
      $("#impFileNote").textContent = `已读入 ${f.name}（${f.size} 字节）`;
      $("#impResult").replaceChildren();
      impInvalidate();
      setImpStatus("文件已读入：点「预览（不写入）」看看会写入什么。");
    };
    reader.onerror = () => {
      $("#impFileNote").textContent = "";
      setImpStatus(`读取文件失败：${f.name}`);
    };
    reader.readAsText(f);
  });
  $("#impText").addEventListener("input", () => {
    if (impState.previewOk) {
      $("#impResult").replaceChildren();
      impInvalidate("内容已修改：上次预览已失效，请重新预览后再确认。");
    }
  });
}

// ---- 排程区 ----------------------------------------------------------------------------------

function setVal(elm, v) {
  if (elm && document.activeElement !== elm) elm.value = v ?? "";
}
function setChecked(elm, v) {
  if (elm && document.activeElement !== elm) elm.checked = !!v;
}

function nextRunItems(runs) {
  // runs: [[leg, hour], ...]（daemon 已按小时排序）→ 按小时分组，算下一次到点时间
  const byHour = new Map();
  for (const r of runs ?? []) {
    const [leg, hour] = Array.isArray(r) ? r : [];
    const h = Number(hour);
    if (!Number.isFinite(h)) continue;
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h).push(leg);
  }
  const now = new Date();
  const items = [];
  for (const [h, legs] of byHour) {
    const d = new Date(now);
    d.setHours(h, 0, 0, 0);
    let dayLabel = "今天";
    if (d.getTime() <= now.getTime()) {
      d.setDate(d.getDate() + 1);
      dayLabel = "明天";
    }
    items.push({ at: d, dayLabel, legs: legs.map(legName).join(" + ") });
  }
  items.sort((a, b) => a.at - b.at);
  return items;
}

function renderScheduler() {
  const d = state.data;
  if (!d) return;
  const sch = d.scheduler ?? {};
  const settings = d.settings ?? {};

  setChecked($("#schedEnabled"), sch.enabled);
  // 小时窗口只保留猫猫旅行 / 夜猫子；settings.hours.growth 即使老后端还带也一律忽略。
  const hours = settings.hours ?? {};
  setVal($("#hoursTravel"), (hours.travel ?? []).join(","));
  setVal($("#hoursNight"), (hours.night ?? []).join(","));
  setChecked($("#defClaim"), settings.claim);
  setVal($("#gapMs"), settings.gapMs);
  // 顶部任务腿跟 settings.legs 同步（唯一选择源；不再有独立的默认腿控件）
  syncLegChecks(settings.legs);

  $("#lastCycle").textContent = sch.lastCycle ? `上次触发 ${fmtDateTime(sch.lastCycle)}` : "尚未触发过";

  // 下一次运行预览
  const nr = $("#nextRuns");
  nr.replaceChildren();
  if (!sch.enabled) {
    nr.append(el("p", { class: "muted", text: "排程已停用：打开上方开关后，到点会自动跑一轮。" }));
  } else {
    // 防御性过滤：后端不再返回 growth，但老/脏数据里若带 [ "growth", h ] 也不展示
    const runs = (Array.isArray(sch.nextRuns) ? sch.nextRuns : []).filter(
      (r) => Array.isArray(r) && String(r[0]) !== "growth",
    );
    const items = nextRunItems(runs);
    if (!items.length) {
      nr.append(el("p", { class: "muted", text: "没有配置任何小时窗口。" }));
    } else {
      for (const it of items) {
        const p = (n) => String(n).padStart(2, "0");
        nr.append(
          el("div", { class: "next-run" },
            el("time", { text: `${it.dayLabel} ${p(it.at.getHours())}:00` }),
            el("span", { text: it.legs }),
          ),
        );
      }
    }
  }

  // holds：daemon.mjs 给的是真实风控冷却（403/11140）名单
  // [{uid, nickname, releasedAt(ISO)}]；冷却期内批量运行会跳过这些账号。
  const holdsBox = $("#holdsBox");
  holdsBox.replaceChildren();
  const holds = Array.isArray(sch.holds) ? sch.holds : [];
  if (!holds.length) {
    holdsBox.append(el("span", { class: "muted", text: "无账号处于风控冷却" }));
  } else {
    for (const h of holds) {
      if (h && typeof h === "object") {
        holdsBox.append(
          el("div", { class: "hold-item" },
            el("span", { class: "hold-name", text: String(h.nickname || h.uid || "—") }),
            el("span", { class: "hold-uid mono", text: String(h.uid ?? "") }),
            el("span", { class: "hold-release", text: `解除时间：${fmtRelease(h.releasedAt)}` }),
          ),
        );
      } else {
        // 老守护进程给裸 uid 字符串：至少别丢掉信息
        holdsBox.append(el("div", { class: "hold-item" }, el("span", { class: "hold-uid mono", text: String(h) })));
      }
    }
  }

  // hosts（生效值，只读）
  const hostsBox = $("#hostsBox");
  hostsBox.replaceChildren();
  const host = settings.host ?? {};
  for (const k of ["chat", "bill", "web"]) {
    hostsBox.append(el("span", { text: `${k}: ${host[k] || "（引擎默认）"}` }));
  }
}

function parseHoursInput(v) {
  return String(v ?? "")
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 23 && Number.isInteger(n));
}

async function saveHours() {
  // 排程只服务两条无任务码的腿；成长任务已从排程里移除（手工运行仍可选它）。
  const hours = {
    travel: parseHoursInput($("#hoursTravel").value),
    night: parseHoursInput($("#hoursNight").value),
  };
  try {
    const s = await api("api/settings", { method: "POST", body: { hours } });
    applySettings(s);
    toast("小时窗口已保存，排程立即生效。");
  } catch (e) {
    humanErr(e, "保存窗口失败");
  }
}

async function saveDefaults() {
  // 顶部 .leg-check 是唯一选择源：「保存默认」保存的就是此刻顶部的勾选。
  const legs = selectedLegs();
  if (!legs.length) {
    toast("请至少勾选一条任务腿（成长任务 / 猫猫旅行 / 夜猫子）。", "warn");
    return;
  }
  const gapMs = Number($("#gapMs").value);
  const body = { legs, claim: $("#defClaim").checked };
  if (Number.isFinite(gapMs)) body.gapMs = gapMs;
  try {
    const s = await api("api/settings", { method: "POST", body });
    applySettings(s);
    toast("运行默认已保存（对下一次运行生效）。");
  } catch (e) {
    humanErr(e, "保存默认失败");
  }
}

async function toggleScheduler(ev) {
  const want = ev.target.checked;
  try {
    const s = await api("api/settings", { method: "POST", body: { scheduler: want } });
    applySettings(s);
    toast(want ? "排程已启用：到点自动运行。" : "排程已停用：只保留手动运行。");
  } catch (e) {
    ev.target.checked = !want;
    humanErr(e, "切换排程失败");
  }
}

// POST /api/settings 的响应就是完整 settings（{scheduler,claim,legs,gapMs,hours,host}）
function applySettings(s) {
  if (!s || !state.data) return;
  state.data.settings = {
    claim: s.claim,
    legs: s.legs,
    gapMs: s.gapMs,
    hours: s.hours,
    host: s.host,
  };
  if (typeof s.scheduler === "boolean") {
    state.data.scheduler = { ...(state.data.scheduler ?? {}), enabled: s.scheduler };
  }
  // 保存后强制用服务端返回的 settings.legs 回写顶部勾选（保存的是顶部选择，这里保证两边一致）。
  syncLegChecks(state.data.settings.legs, { force: true });
  renderScheduler();
}

// ---- 历史区 -----------------------------------------------------------------------------------

async function loadHistory() {
  try {
    const limit = state.history.limit;
    const r = await api("api/history", { params: { limit } });
    state.history.rows = Array.isArray(r?.rows) ? r.rows : [];
    const maxPage = Math.max(0, Math.ceil(state.history.rows.length / state.history.pageSize) - 1);
    if (state.history.page > maxPage) state.history.page = maxPage;
    renderHistory();
  } catch (e) {
    renderHistoryError(e);
  }
}

function renderHistoryError(e) {
  $("#histBody").replaceChildren(
    el("div", { class: "empty", text: `历史读取失败：${e?.message ?? e}` }),
  );
  $("#histPager").replaceChildren();
}

function historyRow(r) {
  const gain = [];
  if (Number(r.credit) > 0) gain.push(`+${fmtNum(r.credit)} 积分`);
  if (Number(r.energy) > 0) gain.push(`+${fmtNum(r.energy)} 能量`);
  return el(
    "tr",
    {},
    el("td", { "data-label": "时间", class: "num", text: fmtDateTime(r.at) }),
    el("td", { "data-label": "账号" },
      el("span", { class: "cell-main", text: String(r.nickname || r.uid || "—") }),
      r.uid ? el("span", { class: "cell-sub", text: String(r.uid) }) : null,
    ),
    el("td", { "data-label": "腿", text: legName(r.leg) }),
    el("td", { "data-label": "结果" }, stepBadge(r.state)),
    el("td", { "data-label": "说明", class: "detail-cell", text: String(r.detail ?? "") || "—" }),
    el("td", { "data-label": "收益", class: "num", text: gain.length ? gain.join(" · ") : "—" }),
    el("td", { "data-label": "触发", text: TRIGGER_NAMES[r.trigger] ?? String(r.trigger ?? "—") }),
  );
}

function renderHistory() {
  const box = $("#histBody");
  const pager = $("#histPager");
  const rows = state.history.rows;
  if (!rows.length) {
    box.replaceChildren(
      el("div", { class: "empty", text: "还没有历史记录。跑一轮批量任务后，每次尝试（成功 / 跳过 / 失败）都会记一行。" }),
    );
    pager.replaceChildren();
    return;
  }
  const { page, pageSize } = state.history;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const slice = rows.slice(page * pageSize, (page + 1) * pageSize);
  box.replaceChildren(
    el(
      "table",
      { class: "tbl tbl-history" },
      el("thead", {},
        el("tr", {},
          el("th", { text: "时间" }),
          el("th", { text: "账号" }),
          el("th", { text: "腿" }),
          el("th", { text: "结果" }),
          el("th", { text: "说明" }),
          el("th", { text: "收益", class: "num" }),
          el("th", { text: "触发" }),
        ),
      ),
      el("tbody", {}, slice.map(historyRow)),
    ),
  );
  pager.replaceChildren(
    el("button", {
      type: "button",
      class: "mini-btn",
      text: "上一页",
      disabled: page <= 0,
      onclick: () => {
        state.history.page--;
        renderHistory();
      },
    }),
    el("span", { class: "mono", text: `${page + 1} / ${pages}` }),
    el("button", {
      type: "button",
      class: "mini-btn",
      text: "下一页",
      disabled: page >= pages - 1,
      onclick: () => {
        state.history.page++;
        renderHistory();
      },
    }),
    el("span", { text: `共 ${rows.length} 条` }),
  );
}

// ---- SSE + 轮询回退 ------------------------------------------------------------------------------

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(() => {
    loadState({ quiet: true });
  }, 3000);
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = 0;
}

// job 运行期间即使 SSE 正常，也每 5s 拉一次 /api/state：daemon 只在步骤「新增」时推 step
// 事件，步骤完成态与 totals 的变化要靠 state 里的 job 快照拿到（纯本地读取，不触发上游）。
function syncJobTimer() {
  const active = !!state.data?.job && state.feed === "sse";
  if (active && !state.jobTimer) {
    state.jobTimer = setInterval(() => loadState({ quiet: true }), 5000);
  } else if (!active && state.jobTimer) {
    clearInterval(state.jobTimer);
    state.jobTimer = 0;
  }
}

function disconnectSSE() {
  if (state.esRetryTimer) {
    clearTimeout(state.esRetryTimer);
    state.esRetryTimer = 0;
  }
  if (state.es) {
    state.es.onopen = state.es.onerror = state.es.onmessage = null;
    try {
      state.es.close();
    } catch {}
    state.es = null;
  }
}

function connectSSE() {
  disconnectSSE();
  if (state.conn === "stopped") return;
  // 守护进程无鉴权：SSE 地址不带任何鉴权参数。
  const url = new URL("api/events", location.href);
  let es;
  try {
    es = new EventSource(url);
  } catch {
    state.feed = "poll";
    startPolling();
    renderTop();
    return;
  }
  state.es = es;
  let opened = false;
  let errs = 0;
  es.onopen = () => {
    opened = true;
    state.feed = "sse";
    stopPolling();
    renderTop();
    syncJobTimer();
  };
  es.onmessage = (e) => {
    try {
      handleSSE(JSON.parse(e.data));
    } catch {}
  };
  es.onerror = () => {
    if (state.feed !== "poll") {
      state.feed = "poll";
      renderTop();
    }
    startPolling();
    errs++;
    if (!opened && errs >= 2) {
      // 守护进程没起来：别再无限重连，30s 后再试一次（此间用 3s 轮询）
      disconnectSSE();
      state.esRetryTimer = setTimeout(() => {
        state.esRetryTimer = 0;
        connectSSE();
      }, 30000);
    }
  };
}

function handleSSE(evt) {
  if (!evt || typeof evt !== "object") return;
  if (evt.kind === "job" && evt.job) {
    const j = evt.job;
    if (j.state === "done" || j.state === "error") {
      state.lastFinished = j;
      if (state.data) state.data.job = null;
      renderJob();
      renderTop();
      syncJobTimer();
      loadState({ quiet: true });
      loadHistory();
    } else {
      state.lastFinished = null;
      if (state.data) state.data.job = j;
      else state.data = { job: j };
      renderJob();
      renderTop();
      updateSelectionUI();
      syncJobTimer();
    }
    return;
  }
  if (evt.kind === "step" && evt.step) {
    const j = state.data?.job;
    if (j) {
      j.steps = [...(j.steps ?? []), evt.step];
      renderJob();
    }
    return;
  }
  if (evt.kind === "log") {
    const j = state.data?.job;
    if (j) {
      j.log = [...(j.log ?? []), String(evt.line ?? "")];
      renderJobLogs();
    }
    return;
  }
  if (evt.kind === "accounts") {
    // daemon 的账号变更广播（导入写入 / 重扫）：账号列表走只读 state 重拉
    if (evt.event === "import") {
      toast(`账号导入已写入：新增 ${Number(evt.added) || 0} · 更新 ${Number(evt.updated) || 0}`);
    }
    loadState({ quiet: true });
    return;
  }
  if (evt.kind === "scheduler") {
    const legs = (evt.legs ?? []).map(legName).join(" + ");
    if (evt.event === "fire") {
      toast(`排程触发：${evt.hour}:00 窗口 · ${legs}`);
      loadState({ quiet: true });
    } else if (evt.event === "skip") {
      toast(`排程跳过 ${evt.hour}:00 窗口（${legs || "—"}）：${evt.reason || "无可参与账号"}`, "warn", 7000);
    } else if (evt.event === "shutdown") {
      state.conn = "stopped";
      disconnectSSE();
      stopPolling();
      if (state.jobTimer) clearInterval(state.jobTimer);
      state.jobTimer = 0;
      state.feed = "idle";
      renderTop();
      toast(`守护进程已退出：${evt.reason || ""}`, "warn", 10000);
    }
  }
}

// ---- state 加载与总渲染 -------------------------------------------------------------------------

function renderAll() {
  renderTop();
  renderBanners();
  renderAccounts();
  renderJob();
  renderScheduler();
  updateSelectionUI();
  syncJobTimer();
}

async function loadState({ quiet = false } = {}) {
  try {
    const d = await api("api/state");
    state.data = d;
    // 老后端/后端并行实现期间 /api/state 可能暂时没带 credits：用本地已查到的值兜底，
    // 避免 3s 轮询把刚查到的余额刷回「未查询」。
    for (const a of Array.isArray(d?.accounts) ? d.accounts : []) {
      if (a.credits == null) {
        const cached = creditCache.get(String(a.uid ?? ""));
        if (cached) a.credits = cached;
      }
    }
    if (state.conn !== "stopped") state.conn = "online";
    renderAll();
    autoFetchCredits();
  } catch (e) {
    if (e && e.network) {
      if (state.conn !== "stopped") state.conn = "down";
      state.feed = "idle";
      renderTop();
    } else if (!quiet) {
      humanErr(e, "读取状态失败");
    }
  }
}

// ---- 守护进程启停 --------------------------------------------------------------------------------

async function stopDaemon() {
  const ok = confirm(
    "停止守护进程？\n\n正在运行的批量任务会在步骤边界中止，排程停止。\n注意：若 magpie 仍开启本插件，守护进程可能在下次加载时被重新拉起；要长期停用，请在 magpie 插件管理里关闭本插件（control.json 会写 desired=off）。",
  );
  if (!ok) return;
  try {
    await api("api/shutdown", { method: "POST" });
    state.conn = "stopped";
    state.feed = "idle";
    disconnectSSE();
    stopPolling();
    renderTop();
    toast("守护进程已停止。需要时用「启动命令」里的命令手动拉起，或在 magpie 里重开本插件。");
  } catch (e) {
    humanErr(e, "停止守护进程失败");
  }
}

// ---- 初始化 ------------------------------------------------------------------------------------

function wireStatic() {
  $("#themeBtn").addEventListener("click", cycleTheme);
  $("#daemonStopBtn").addEventListener("click", stopDaemon);
  $("#daemonStartBtn").addEventListener("click", () => $("#cmdDialog").showModal());
  $("#cmdCopyBtn").addEventListener("click", async () => {
    const ok = await copyText("node daemon.mjs");
    toast(ok ? "已复制：node daemon.mjs" : "复制失败，请手动选择文本复制。", ok ? "info" : "warn");
  });

  $("#selectAll").addEventListener("change", (ev) => {
    const elig = eligibleAccounts();
    state.selected.clear();
    if (ev.target.checked) for (const a of elig) state.selected.add(a.uid);
    for (const cb of $$(".acct-check")) cb.checked = state.selected.has(cb.value);
    updateSelectionUI();
  });
  $("#rescanBtn").addEventListener("click", rescanAccounts);

  $("#btnRun").addEventListener("click", runFull);
  $("#btnAccept").addEventListener("click", acceptSelected);
  $("#btnClaim").addEventListener("click", claimSelected);
  $("#btnCheckin").addEventListener("click", checkinSelected);

  // 账号导出 / 导入（合并在账号卡片内的抽屉里）
  $("#ioToggleBtn").addEventListener("click", toggleIo);
  $("#ioTabExport").addEventListener("click", () => selectIoTab("export"));
  $("#ioTabImport").addEventListener("click", () => selectIoTab("import"));
  wireIoTabs();
  $("#expBtn").addEventListener("click", (ev) => exportAccounts(ev.currentTarget));
  $("#expSecrets").addEventListener("change", syncExportHints);
  $("#impPreviewBtn").addEventListener("click", importPreview);
  $("#impConfirmBtn").addEventListener("click", importConfirm);
  wireImportFile();

  $("#schedEnabled").addEventListener("change", toggleScheduler);
  $("#saveHoursBtn").addEventListener("click", saveHours);
  $("#saveDefaultsBtn").addEventListener("click", saveDefaults);

  $("#histRefreshBtn").addEventListener("click", loadHistory);
  $("#histLimit").addEventListener("change", (ev) => {
    state.history.limit = Number(ev.target.value) || 200;
    state.history.page = 0;
    loadHistory();
  });

  wireCreditsDialog();

  // 系统主题变化时（跟随系统模式下）刷新一次渲染即可（CSS 媒体查询自动换色）
  try {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme());
  } catch {}
}

async function boot() {
  renderTop();
  // 守护进程无鉴权：首屏直接渲染，hello / state / history / SSE 都不需要任何凭据。
  try {
    state.hello = await api("api/hello");
  } catch (e) {
    if (e.network) {
      state.conn = "down";
      renderTop();
      $("#accountsList").replaceChildren(
        el("div", { class: "empty" },
          el("strong", {}, "连不上守护进程。"),
          "它可能没有启动：magpie 开启本插件时会自动拉起；也可在插件目录手动执行 ",
          el("code", { text: "node daemon.mjs" }),
          "，启动后刷新本页。实际端口与绑定地址写在 ",
          el("code", { text: "<状态目录>/daemon.json" }),
          "。",
        ),
      );
      return;
    }
    // 其余错误：继续读 state，让它把话说全
  }
  if (state.conn !== "stopped") state.conn = "checking";
  await loadState();
  if (state.conn === "online") {
    connectSSE();
    loadHistory();
  }
}

function init() {
  applyTheme();
  wireStatic();
  syncExportHints(); // 「含凭据」默认勾上：警示/提示行按初始状态就位
  boot();
}

// Node 下 import 本模块（tests-shell 校验 addrModel 等纯函数）时没有 document：跳过启动。
// 浏览器行为不变。
if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}
