// magpie-workbuddy-tasks —— 常驻守护进程
//
// 职责（契约 §3/§4）：HTTP 看板 + /api + SSE 实时事件 + 小时窗口排程 + 任务执行
//（经 engine 的 JobRunner）。自持生命周期：跟随 magpie（plugins.json / TCP 探测），
// 心跳写 state/daemon.json（0600）+ daemon.heartbeat，control.json desired=off 即退。
//
// 运行方式：`node daemon.mjs` 或 `bun daemon.mjs`（由 lifecycle.ensureDaemon 拉起，
// 也可手动拉起调试）。全部 node: 内置；Node 与 Bun 通用。
//
// 环境变量：
//   WB_STATE_DIR    状态目录（优先）；否则 <WB_CONFIG_DIR|cfg>/workbuddy-tasks/state
//   WB_CONFIG_DIR   magpie 配置目录（读 plugins.json、账号凭据）
//   WB_DAEMON_KEY   API 密钥；缺省时生成并写进 daemon.json
//   WB_DAEMON_PORT  期望端口；缺省 4390，被占用则向后找，再不行用随机端口
//   WB_MANAGED      =1 表示由 magpie 宿主拉起（plugins.json 条目消失时允许自杀）
//   MAGPIE_ADDR     magpie 网关地址（host:port），如 127.0.0.1:3499
// 命令行：--addr <host:port|host|:port>  --port <n>  --cfg <dir>  --state <dir>
// startDaemon 可注入（测试/嵌入用）：{ cfgDir, stateDir, port, key, args, engine,
//   now, sleep, fetch, log, noTimers, skipExistingCheck, managed, runner }。
//   fetch —— 假 fetch 顶替全部上游网络（引擎全程 opts.fetch），零真实请求（契约 §8）。
//
// 铁律：账号 access/refresh token 永不出现在任何响应、SSE 或日志里
//（只出现 uid / 昵称 / 「已登录」掩码）；对外文本一律过 scrub()。

import http from "node:http"
import net from "node:net"
import crypto from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, extname, join, normalize, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  DEFAULT_PORT,
  PLUGIN_NAME,
  pidAlive,
  probeDaemon,
  readControl,
  readDaemonInfo,
  resolveCfgDir,
  stateDirFor,
  writeDaemonInfo,
} from "./lifecycle.mjs"

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8")).version || "0.1.0")
  } catch {
    return "0.1.0"
  }
})()

const LEGS = ["growth", "travel", "night"]
const LEG_NAMES = { growth: "成长任务", travel: "猫猫旅行", night: "夜猫子" }
const HISTORY_CAP = 2000

const DEFAULT_SETTINGS = {
  scheduler: true, // 小时窗口排程总开关
  claim: true, // 完成后自动领奖
  legs: ["growth", "travel"], // 手动运行未指定 legs 时的默认腿
  gapMs: 1500, // 账号之间的基础间隔（手动）；排程时 runner 另加 2–5s 抖动
  jitterMs: [2000, 5000], // 排程运行的账号间抖动（交给 runner，见契约 §0.4）
  hours: { growth: [9, 21], travel: [9, 21], night: [1] }, // 本地小时窗口
  host: { chat: "", bill: "", web: "" }, // 留空 = 用 engine/upstream 的默认
}

// ---- 小工具 ------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()
const dateKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

// scrub：把可能夹带凭据的文本洗一遍再出门（Bearer 头、JWT 形状的串）
const SECRET_RES = [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, /\beyJ[A-Za-z0-9._-]{16,}/g]
function scrub(s) {
  let out = String(s ?? "")
  for (const re of SECRET_RES) out = out.replace(re, "$1***")
  return out
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return fallback
  }
}

function writeJson(file, data, mode) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8")
    if (mode) {
      try {
        chmodSync(tmp, mode) // Windows 上近似空操作；0600 在 Linux/macOS 生效
      } catch {}
    }
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ""))
  const bb = Buffer.from(String(b ?? ""))
  if (ba.length !== bb.length || ba.length === 0) return false
  return crypto.timingSafeEqual(ba, bb)
}

function shortErr(e) {
  return scrub(e?.message ?? String(e)).slice(0, 200)
}

// ---- 启动参数 -----------------------------------------------------------

function parseArgs(argv = process.argv.slice(2)) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--addr" || a === "--port" || a === "--cfg" || a === "--state" || a === "--key") out[a.slice(2)] = argv[++i]
  }
  return out
}

// "0.0.0.0:4390" | "0.0.0.0" | ":4390" | "4390"
function parseAddr(s, fallbackPort) {
  let host = "127.0.0.1"
  let port = fallbackPort
  if (typeof s === "string" && s.trim()) {
    const t = s.trim()
    if (/^\d+$/.test(t)) port = Number(t)
    else {
      const i = t.lastIndexOf(":")
      if (i >= 0) {
        host = t.slice(0, i) || host
        const p = Number(t.slice(i + 1))
        if (Number.isFinite(p) && p > 0) port = p
      } else host = t
    }
  }
  return { host, port }
}

// ---- 引擎装载（engine/* 由另一个 agent 编写；缺失时全部优雅降级） ---------

async function loadEngine(log) {
  const eng = { store: null, runner: null, tasks: null, upstream: null, errors: [] }
  const want = [
    ["store", "./engine/store.mjs"],
    ["runner", "./engine/runner.mjs"],
    ["tasks", "./engine/tasks.mjs"],
    ["upstream", "./engine/upstream.mjs"],
  ]
  for (const [name, spec] of want) {
    try {
      eng[name] = await import(spec)
    } catch (e) {
      eng.errors.push(`${spec} 加载失败：${shortErr(e)}`)
    }
  }
  if (!eng.errors.length && (!eng.store || !eng.runner)) {
    eng.errors.push("engine/store.mjs 或 engine/runner.mjs 没有导出约定接口（契约 §2）")
  }
  eng.ok = eng.errors.length === 0
  if (!eng.ok) for (const m of eng.errors) log("[engine] " + m)
  return eng
}

function makeRunner(engine, ctx, log) {
  const Ctor = engine?.runner?.JobRunner
  if (typeof Ctor !== "function") return null
  try {
    return new Ctor(ctx)
  } catch (e) {
    log("[engine] JobRunner 构造失败：" + shortErr(e))
    engine.errors.push("JobRunner 构造失败：" + shortErr(e))
    return null
  }
}

// =======================================================================
// startDaemon：可被测试导入（注入 fake engine / 固定 key / 端口 0），也可作脚本运行
// =======================================================================

export async function startDaemon(opts = {}) {
  const log = opts.log ?? ((...a) => console.log(new Date().toISOString(), ...a))
  const now = opts.now ?? (() => Date.now())
  const sleepFn = opts.sleep ?? sleep

  // ---- 目录与参数 ----
  const args = opts.args ?? parseArgs()
  const cfgDir = resolve(args.cfg || opts.cfgDir || process.env.WB_CONFIG_DIR || resolveCfgDir(process.env))
  const stateDir = resolve(args.state || opts.stateDir || process.env.WB_STATE_DIR || stateDirFor(cfgDir))
  mkdirSync(stateDir, { recursive: true })
  const dashDir = join(PLUGIN_DIR, "dashboard")

  // 端口优先级：opts.port（测试注入）> --port > WB_DAEMON_PORT > 默认 4390；
  // 0 = 让操作系统挑一个空闲端口
  const wantPort = Number.isFinite(opts.port)
    ? opts.port
    : args.port !== undefined
      ? Number(args.port)
      : Number(process.env.WB_DAEMON_PORT) || DEFAULT_PORT
  const addr = parseAddr(args.addr, wantPort)
  const host = opts.host || addr.host
  const managed = process.env.WB_MANAGED === "1" || opts.managed === true

  // ---- control.json：唯一意图来源；daemon.json：拒双开 ----
  const controlFile = join(stateDir, "control.json")
  if (!existsSync(controlFile)) writeJson(controlFile, { desired: "on" })

  if (opts.skipExistingCheck !== true) {
    const prev = readDaemonInfo(stateDir)
    if (prev && prev.pid !== process.pid && pidAlive(prev.pid)) {
      const alive = await probeDaemon(prev.port, prev.key).catch(() => null)
      if (alive) {
        const err = new Error(`已有守护进程在运行（pid ${prev.pid}，端口 ${prev.port}），拒绝重复启动，避免双写凭据`)
        err.code = "WB_DAEMON_ALREADY_RUNNING"
        throw err
      }
    }
  }

  const key = opts.key || args.key || process.env.WB_DAEMON_KEY || readDaemonInfo(stateDir)?.key || crypto.randomBytes(24).toString("base64url")

  // ---- 引擎 ----
  const engine = opts.engine ?? (await loadEngine(log))

  // ---- 状态文件 ----
  const settingsFile = join(stateDir, "settings.json")
  const snapshotsFile = join(stateDir, "snapshots.json")
  const historyFile = join(stateDir, "history.json")
  const firedFile = join(stateDir, "lastFired.json")
  const accountsFile = join(stateDir, "accounts.json") // uid -> tasksEnabled 布尔（/api/account/toggle 写入）

  let settings = { ...DEFAULT_SETTINGS, ...readJson(settingsFile, {}) }
  settings.hours = { ...DEFAULT_SETTINGS.hours, ...(settings.hours ?? {}) }
  settings.host = { ...DEFAULT_SETTINGS.host, ...(settings.host ?? {}) }
  let snapshots = readJson(snapshotsFile, {})
  let history = Array.isArray(readJson(historyFile, [])) ? readJson(historyFile, []) : []
  let fired = readJson(firedFile, {})
  let tasksEnabledMap = readJson(accountsFile, {})

  function readSettings() {
    return JSON.parse(JSON.stringify(settings))
  }
  const saveSettings = () => writeJson(settingsFile, settings)
  const saveSnapshots = () => writeJson(snapshotsFile, snapshots)
  const saveHistory = () => writeJson(historyFile, history.slice(-HISTORY_CAP))
  const saveFired = () => writeJson(firedFile, fired)
  const saveAccountsState = () => writeJson(accountsFile, tasksEnabledMap)

  if (!existsSync(settingsFile)) saveSettings()

  // ---- runner（settings 就绪后再构造；ctx 只依赖契约 §2 + runner 的可选 opts） ----
  const runnerCtx = {
    cfgDir,
    stateDir,
    settings: () => readSettings(),
    // runner 可选注入（engine/runner.mjs 的 opts）：账号由我们合并好 tasksEnabled 再给
    loadAccounts: () => loadAccountsAll(),
    // 铁律 3：token 刷新后原子回写 plugin-auth.json（engine/store.saveAccountRefresh），
    // 保证 magpie 社区插件与我们用的是同一对凭据。
    saveRefresh: (acctKey, patch) => {
      const save = engine?.store?.saveAccountRefresh
      if (typeof save !== "function") {
        throw new Error("引擎未提供 saveAccountRefresh（engine/store.mjs），拒绝回写凭据")
      }
      return save(cfgDir, acctKey, patch)
    },
    // settings 动态读取（getter：spread 进 legOpts 时取当前值，改设置对下一个 job 生效）
    get gap() {
      return settings.gapMs
    },
    // 看板的 host 覆盖（settings.host）透传给引擎 —— 空串 = 用 engine/upstream 默认
    get bases() {
      return { chat: settings.host.chat || "", bill: settings.host.bill || "", web: settings.host.web || "" }
    },
    env: { WB_CONFIG_DIR: cfgDir, WB_STATE_DIR: stateDir },
    log: (...a) => log(...a.map(scrub)),
    now,
    sleep: sleepFn,
    // 测试/嵌入注入：假 fetch 顶替全部上游网络（engine 全程走 opts.fetch，零真实请求）
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  }
  const runner = opts.runner ?? makeRunner(engine, runnerCtx, log)

  // ---- 账号（经 engine/store 读 plugin-auth.json；缺引擎时空列表） --------
  let accountsError = ""

  function cfgEnvLike() {
    const envLike = { ...process.env, WB_CONFIG_DIR: cfgDir, WB_STATE_DIR: stateDir }
    return envLike
  }

  function loadAccountsAll() {
    accountsError = ""
    const load = engine?.store?.loadAccounts
    if (typeof load !== "function") {
      accountsError = "引擎未就绪：engine/store.mjs 不可用，读不到 magpie 的 WorkBuddy 账号"
      return []
    }
    try {
      const list = load(cfgDir) || []
      // tasksEnabled 生效值：accounts.json 里的显式条目（/api/account/toggle 写入）
      // 优先；没有条目时用 engine/store 的 tasks-accounts.json；两边都没有 = 参与。
      return list.map((a) => {
        const override = tasksEnabledMap[a.uid]
        return { ...a, tasksEnabled: override === undefined ? a.tasksEnabled !== false : override !== false }
      })
    } catch (e) {
      accountsError = `读取账号失败：${shortErr(e)}（plugin-auth.json 在 ${cfgDir}，Docker 里通常是 /config/magpie）`
      return []
    }
  }

  function eligibleNow() {
    const accts = loadAccountsAll()
    const filter = engine?.store?.eligibleAccounts
    if (typeof filter !== "function") return []
    try {
      return filter(accts) || []
    } catch {
      // 兜底：按契约 §2 的过滤规则本地再筛一遍
      return accts.filter((a) => a.provider === "workbuddy" && !a.isApiKey && !a.enterpriseId && a.tasksEnabled !== false)
    }
  }

  // 引擎调用的公共注入（契约 §2 的 opts 形状）：手动操作与快照刷新也必须走同一套
  // fetch/时钟/bases —— 否则会绕开注入的 fetch 替身与防风控节奏。
  function engineOpts() {
    return {
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      now,
      sleep: sleepFn,
      gap: settings.gapMs,
      bases: { chat: settings.host.chat || "", bill: settings.host.bill || "", web: settings.host.web || "" },
      env: { WB_CONFIG_DIR: cfgDir, WB_STATE_DIR: stateDir },
    }
  }

  function accountByUid(uid) {
    return loadAccountsAll().find((a) => a.uid === uid) || null
  }

  // ---- 快照（/api/state 的 tasks/energy/streak；只在闲时刷新，限流） ------
  let snapBusy = false

  // 快照投影：engine/tasks.fetchTasks 返回的规范 Task（CONTRACT §2）到这里
  // 已经是 camelCase —— 这里只做「取字段 + 数值化」，绝不再猜第二种键名拼写
  //（否则上游改名时两种拼写会同时静默变空）。
  function snapTask(t) {
    const p = t?.progress ?? {}
    return {
      code: t?.code ?? "",
      title: t?.title ?? "",
      acceptStatus: t?.acceptStatus ?? "",
      progress: { current: Number(p.current) || 0, target: Number(p.target) || 0 },
      rewardCredit: Number(t?.rewardCredit) || 0,
      rewardEnergy: Number(t?.rewardEnergy) || 0,
      jumpUrl: t?.jumpUrl ?? "",
      taskType: t?.taskType ?? "",
    }
  }

  async function refreshSnapshots(uids, budgetMs = 12000) {
    const fetchTasks = engine?.tasks?.fetchTasks
    if (typeof fetchTasks !== "function" || snapBusy) return
    if (runner?.current()) return // 有 job 在跑就让路，别跟它抢限速窗口
    snapBusy = true
    try {
      const deadline = now() + budgetMs
      for (const uid of uids.slice(0, 5)) {
        if (now() > deadline || runner?.current()) break
        const acct = accountByUid(uid)
        if (!acct) continue
        try {
          await sleepFn(1000) // 限速红线：与上一轮上游调用（可能是刚结束的 job）之间 ≥1s
          const tasks = await fetchTasks(acct, engineOpts())
          let energy
          let days
          const up = engine?.upstream
          if (typeof up?.callJSON === "function" && typeof up?.growthBase === "function" && now() < deadline) {
            await sleepFn(1000) // 限速红线：两次上游调用 ≥1s
            const e = await up.callJSON(acct, "chat", `${up.growthBase()}/v2/activity/growth/energy`, {}, engineOpts())
            // 字段口径与 engine/tasks.fetchEnergy 对齐：上游是 data.balance
            if (e?.ok && e?.code === 0) energy = e.data?.energy ?? e.data?.balance ?? e.data?.value
            await sleepFn(1000)
            const s = await up.callJSON(acct, "chat", `${up.growthBase()}/activity/growth/streak`, {}, engineOpts())
            // 字段口径与 engine/tasks.fetchGrowthSummary 对齐：data.streak.days
            if (s?.ok && s?.code === 0) days = s.data?.days ?? s.data?.streakDays ?? s.data?.streak?.days
          }
          snapshots[uid] = {
            tasks: (Array.isArray(tasks) ? tasks : []).map(snapTask),
            energy: energy ?? snapshots[uid]?.energy ?? null,
            streak: days ?? snapshots[uid]?.streak ?? null,
            days: days ?? snapshots[uid]?.days ?? null,
            updatedISO: nowIso(),
          }
          saveSnapshots()
        } catch (e) {
          log(`[snapshot] ${uid} 刷新失败：${shortErr(e)}`)
        }
        await sleepFn(1500) // 账号间隔
      }
    } finally {
      snapBusy = false
    }
  }

  // ---- 历史（每次尝试一行） ----------------------------------------------

  function appendHistory(job) {
    const steps = Array.isArray(job?.steps) ? job.steps : []
    for (const s of steps) {
      history.push({
        // 契约 §2 的 Step.at 是毫秒数（engine），老式引擎/外壳给 ISO 串 —— 统一成 ISO
        at: typeof s.at === "number" ? new Date(s.at).toISOString() : s.at ?? nowIso(),
        uid: s.uid ?? "",
        nickname: s.nickname ?? "",
        leg: s.leg ?? "",
        state: s.state ?? "",
        detail: scrub(s.detail ?? ""),
        credit: s.credit ?? 0,
        energy: s.energy ?? 0,
        jobId: job.id,
        trigger: job.trigger ?? "manual",
      })
    }
    if (history.length > HISTORY_CAP) history = history.slice(-HISTORY_CAP)
    saveHistory()
  }

  function computeStats() {
    const today = dateKey()
    let credit = 0
    let energy = 0
    const jobIds = new Set()
    for (const r of history) {
      if (String(r.at ?? "").slice(0, 10) !== today) continue
      if (r.state === "ok" || r.state === "skip") {
        credit += Number(r.credit) || 0
        energy += Number(r.energy) || 0
      }
      if (r.jobId) jobIds.add(r.jobId)
    }
    const cur = runner?.current?.() ?? null
    if (cur) jobIds.add(cur.id)
    return { creditsToday: credit, energyToday: energy, runs: jobIds.size }
  }

  // ---- SSE ---------------------------------------------------------------

  const sseClients = new Set()
  function broadcast(obj) {
    const line = `data: ${JSON.stringify(obj)}\n\n`
    for (const res of sseClients) {
      try {
        res.write(line)
      } catch {
        sseClients.delete(res)
      }
    }
  }

  // job 观察者：轮询 runner 的 Job，把新增 step / log 行 / 状态变化推给 SSE，
  // job 结束时落历史、刷新快照。只依赖契约 §2 的 get()/current()。
  let watchedJobId = null
  let watchedSteps = 0
  let watchedLog = 0
  let watchedState = ""
  let pendingJobId = null // 刚启动还没被 tick 看到的 job；结束时兜底落历史

  function resetWatch() {
    watchedJobId = null
    watchedSteps = 0
    watchedLog = 0
    watchedState = ""
  }

  function safeJob(job) {
    if (!job) return null
    const j = { ...job }
    if (Array.isArray(j.log)) j.log = j.log.map(scrub)
    if (Array.isArray(j.steps)) j.steps = j.steps.map((s) => ({ ...s, detail: scrub(s.detail ?? "") }))
    return j
  }

  function finalizeJob(job) {
    if (!job) return
    pendingJobId = null
    appendHistory(job)
    // 与 /api/run、/api/stop 一致：出门前过 safeJob（洗日志 + 不带内部字段）
    broadcast({ kind: "job", job: safeJob(job) })
    const steps = Array.isArray(job.steps) ? job.steps : []
    const uids = [...new Set(steps.map((s) => s.uid).filter(Boolean))]
    if (uids.length) refreshSnapshots(uids, 12000).catch(() => {})
  }

  function watchJobTick() {
    try {
      const cur = runner?.current?.() ?? null
      if (!cur) {
        // job 结束（或两次 tick 之间开始又结束）：runner.current() 对 done/error
        // 一律返回 null，所以这里要同时认领「刚启动还没被看过」（pendingJobId）
        // 和「曾被看过运行中、现已结束」（watchedJobId）两种落历史时机 —— 否则
        // 跑得比 tick 久的 job 永远不会落历史/刷新快照/发收尾 SSE。
        const finishedId = pendingJobId ?? watchedJobId
        if (finishedId) {
          const job = safeJob(runner?.get?.(finishedId) ?? null)
          if (!job || job.state === "done" || job.state === "error") {
            if (job) finalizeJob(job)
            else pendingJobId = null
          }
        }
        if (watchedJobId) resetWatch()
        return
      }
      if (cur.id !== watchedJobId) {
        watchedJobId = cur.id
        pendingJobId = null
        watchedSteps = 0
        watchedLog = 0
        watchedState = ""
        broadcast({ kind: "job", job: safeJob(cur) })
      }
      const steps = Array.isArray(cur.steps) ? cur.steps : []
      for (; watchedSteps < steps.length; watchedSteps++) {
        const s = steps[watchedSteps]
        broadcast({ kind: "step", jobId: cur.id, step: { ...s, detail: scrub(s.detail ?? "") } })
      }
      const logLines = Array.isArray(cur.log) ? cur.log : []
      for (; watchedLog < logLines.length; watchedLog++) {
        broadcast({ kind: "log", jobId: cur.id, line: scrub(logLines[watchedLog]) })
      }
      if (cur.state !== watchedState) {
        watchedState = cur.state
        if (cur.state === "done" || cur.state === "error") finalizeJob(cur)
        else broadcast({ kind: "job", job: safeJob(cur) })
      }
    } catch (e) {
      log("[watch] " + shortErr(e))
    }
  }

  // ---- 排程（小时窗口；同一天同一窗口只发一次；有 job 在跑就让路） --------
  let lastCycle = fired.lastCycle ?? null

  function schedulerNextRuns() {
    const out = []
    for (const [leg, hours] of Object.entries(settings.hours)) {
      for (const h of Array.isArray(hours) ? hours : []) out.push([leg, h])
    }
    out.sort((a, b) => a[1] - b[1])
    return out
  }

  // scheduler.holds = 真正的风控冷却名单（403/11140），不是「没进 job 的账号」。
  // runner.holds() 是唯一事实来源（[{uid, releasedAt}]，releasedAt 为 epoch ms），
  // 这里拼上昵称并把时刻转成 ISO 串，看板直接渲染「解除时间」。
  function schedulerHolds() {
    const fn = runner?.holds
    if (typeof fn !== "function") return []
    let list = null
    try {
      list = fn.call(runner)
    } catch {
      return []
    }
    if (!Array.isArray(list)) return []
    const nick = new Map(loadAccountsAll().map((a) => [a.uid, a.nickname || a.uid]))
    return list
      .filter((h) => h && typeof h === "object" && h.uid)
      .map((h) => ({
        uid: String(h.uid),
        nickname: nick.get(String(h.uid)) ?? String(h.uid),
        releasedAt:
          Number.isFinite(h.releasedAt) && h.releasedAt > 0 ? new Date(h.releasedAt).toISOString() : null,
      }))
  }

  function checkScheduler(nowMs = Date.now()) {
    try {
      if (!settings.scheduler) return null
      const cur = runner?.current?.() ?? null
      if (cur) return null
      const d = new Date(nowMs)
      const h = d.getHours()
      const legs = Object.entries(settings.hours)
        .filter(([, hs]) => (Array.isArray(hs) ? hs : []).includes(h))
        .map(([leg]) => leg)
        .filter((leg) => LEGS.includes(leg))
      if (!legs.length) return null
      const fireKey = `${legs.join("+")}@${h}@${dateKey(d)}`
      if (fired[fireKey]) return null
      const eligible = eligibleNow()
      if (!eligible.length) {
        // 没账号就不算「触发过」，但也不必 30s 一试：标记掉，明天的窗口再说
        fired[fireKey] = nowIso()
        saveFired()
        log(`[scheduler] 窗口 ${fireKey} 到点但没有可参与任务的账号，跳过`)
        broadcast({ kind: "scheduler", event: "skip", legs, hour: h, reason: "无可参与账号" })
        return null
      }
      // 先启动，成功才标记「已触发」；引擎瞬时不可用时窗口内还会重试
      const job = startJob({
        uids: eligible.map((a) => a.uid),
        legs,
        claim: settings.claim,
        trigger: "schedule",
        jitterMs: settings.jitterMs,
      })
      fired[fireKey] = nowIso()
      fired.lastCycle = fired[fireKey]
      lastCycle = fired[fireKey]
      saveFired()
      broadcast({ kind: "scheduler", event: "fire", legs, hour: h, jobId: job?.id ?? null })
      log(`[scheduler] 窗口触发：${legs.map((l) => LEG_NAMES[l] ?? l).join(" + ")}，job ${job?.id ?? "?"}`)
      return job
    } catch (e) {
      log("[scheduler] " + shortErr(e))
      return null
    }
  }

  // ---- job 控制 -----------------------------------------------------------

  function startJob(spec = {}) {
    if (!runner) {
      const err = new Error(engineErrorsText())
      err.code = "WB_ENGINE_UNAVAILABLE"
      throw err
    }
    const legs = (Array.isArray(spec.legs) && spec.legs.length ? spec.legs : settings.legs).filter((l) => LEGS.includes(l))
    if (!legs.length) legs.push("growth")
    const eligible = eligibleNow()
    const known = new Set(eligible.map((a) => a.uid))
    let uids = Array.isArray(spec.uids) && spec.uids.length ? spec.uids.filter((u) => known.has(u)) : eligible.map((a) => a.uid)
    if (!uids.length) {
      const err = new Error(
        accountsError ||
          "没有可参与任务的账号：需要 magpie 里已登录的 workbuddy（国内版）oauth 账号，且未关闭任务参与",
      )
      err.code = "WB_NO_ACCOUNTS"
      throw err
    }
    const job = runner.start({
      uids,
      legs,
      claim: spec.claim !== undefined ? !!spec.claim : settings.claim,
      trigger: spec.trigger === "schedule" ? "schedule" : "manual",
      gapMs: settings.gapMs,
      jitterMs: Array.isArray(spec.jitterMs) ? spec.jitterMs : settings.jitterMs,
    })
    if (job?.id) pendingJobId = job.id
    return job
  }

  function engineErrorsText() {
    const errs = engine?.errors?.length ? engine.errors.join("；") : "engine/*.mjs 缺失或不可用"
    return `任务引擎不可用：${errs}（引擎文件由 engine/ 提供，装好完整插件后重试）`
  }

  async function stopCurrentJob() {
    const cur = runner?.current?.() ?? null
    if (!cur) return null
    let job = cur
    try {
      if (typeof runner.stop === "function") {
        const r = await Promise.race([runner.stop(cur.id), sleepFn(2000).then(() => null)])
        if (r) job = r
      } else if (typeof cur.stop === "function") {
        await Promise.race([cur.stop(), sleepFn(2000).then(() => null)])
      } else {
        log("[job] runner 未实现 stop()，只能等当前 job 自然结束（契约 §8 要求 runner 支持步骤边界中止）")
      }
    } catch (e) {
      log("[job] 停止失败：" + shortErr(e))
    }
    return safeJob(job)
  }

  // ---- 手动单账号操作（领奖 / 接取 / 签到） -------------------------------
  // 这些也走上游，跑 job 期间一律 409，避免跟批量任务抢限速与凭据。

  async function manualOp(handler) {
    if (runner?.current()) {
      return { status: 409, body: { error: "busy" } }
    }
    // 限速红线：手动操作与上一次上游调用（可能是刚结束的 job）之间也 ≥1s
    await sleepFn(Math.max(1000, Number(settings.gapMs) || 0))
    try {
      return { status: 200, body: await handler() }
    } catch (e) {
      return { status: 500, body: { error: shortErr(e) } }
    }
  }

  async function doClaim(uid, code) {
    const fn = engine?.tasks?.claimTask
    if (typeof fn !== "function") throw new Error(engineErrorsText())
    const acct = accountByUid(uid)
    if (!acct) throw new Error(`找不到账号 ${uid}（重新扫描账号或检查 plugin-auth.json）`)
    const r = await fn(acct, String(code || ""), engineOpts())
    return {
      ok: !!r?.ok,
      credit: r?.credit ?? 0,
      energy: r?.energy ?? 0,
      via: r?.via ?? "",
      reason: scrub(r?.reason ?? ""),
    }
  }

  async function doAccept(uid, codes) {
    const fn = engine?.tasks?.acceptTasks
    if (typeof fn !== "function") throw new Error(engineErrorsText())
    const acct = accountByUid(uid)
    if (!acct) throw new Error(`找不到账号 ${uid}`)
    const list = (Array.isArray(codes) ? codes : []).map(String).filter(Boolean)
    if (!list.length) throw new Error("codes 不能为空")
    const r = await fn(acct, list, engineOpts())
    return {
      accepted: r?.accepted ?? [],
      already: r?.already ?? [],
      failed: (r?.failed ?? []).map((f) => (typeof f === "string" ? f : { ...f, reason: scrub(f?.reason ?? "") })),
    }
  }

  async function doCheckin(uids) {
    const up = engine?.upstream
    if (typeof up?.callJSON !== "function" || typeof up?.billBase !== "function") {
      throw new Error(engineErrorsText())
    }
    const targets = (Array.isArray(uids) && uids.length ? uids : eligibleNow().map((a) => a.uid)).slice(0, 20)
    const out = []
    for (const uid of targets) {
      const acct = accountByUid(uid)
      if (!acct) {
        out.push({ uid, outcome: "failed", message: "找不到账号" })
        continue
      }
      try {
        const r = await up.callJSON(acct, "billing", `${up.billBase()}/billing/meter/daily-checkin`, { method: "POST" }, engineOpts())
        if (r?.ok && r?.code === 0) {
          const d = r.data ?? {}
          const already = d.already === true || d.signed === true || /已签/.test(String(r.msg ?? ""))
          out.push({
            uid,
            outcome: already ? "done" : "claimed",
            credit: Number(d.credit ?? d.points ?? d.point ?? 0) || 0,
            streak: d.streak ?? d.days,
            message: scrub(r.msg ?? ""),
          })
        } else {
          out.push({ uid, outcome: "failed", message: scrub(r?.msg || `HTTP ${r?.status ?? "?"} code ${r?.code ?? "?"}`) })
        }
      } catch (e) {
        out.push({ uid, outcome: "failed", message: shortErr(e) })
      }
      await sleepFn(1500) // 账号间隔（手动节奏）
    }
    return out
  }

  // ---- /api/state ----------------------------------------------------------

  function accountRow(a) {
    const exp = Number(a.expires) || 0
    const snap = snapshots[a.uid] ?? null
    return {
      uid: a.uid ?? "",
      nickname: a.nickname ?? a.accountId ?? a.uid ?? "",
      masked: a.isApiKey ? "API key（不参与任务）" : "已登录",
      domain: a.domain ?? "",
      // expiresInMs 是原始剩余毫秒（可为负 = 已过期），expiresInDays 是天花板
      // 取整（ceil，最小 0）——「还剩 2 小时」在 days 里显示 1 天，用 ms 才能区分。
      expiresInMs: exp ? exp - now() : null,
      expiresInDays: exp ? Math.max(0, Math.ceil((exp - now()) / 86400000)) : null,
      tasksEnabled: a.tasksEnabled !== false,
      eligible:
        a.provider === "workbuddy" && !a.isApiKey && !a.enterpriseId && a.tasksEnabled !== false,
      snapshot: snap,
    }
  }

  function statePayload() {
    const accts = loadAccountsAll()
    const cur = runner?.current?.() ?? null
    const payload = {
      accounts: accts.map(accountRow),
      scheduler: {
        enabled: !!settings.scheduler,
        nextRuns: schedulerNextRuns(),
        lastCycle,
        holds: schedulerHolds(),
      },
      job: safeJob(cur),
      stats: computeStats(),
      settings: {
        claim: settings.claim,
        legs: settings.legs,
        gapMs: settings.gapMs,
        hours: settings.hours,
        host: effectiveHosts(),
      },
    }
    if (accountsError) payload.notice = accountsError
    if (engine?.errors?.length) payload.engineErrors = engine.errors.map(scrub)
    return payload
  }

  function effectiveHosts() {
    const up = engine?.upstream
    const safe = (fn, fb) => {
      try {
        return (typeof fn === "function" && fn()) || fb
      } catch {
        return fb
      }
    }
    return {
      chat: settings.host.chat || safe(up?.growthBase, "https://copilot.tencent.com"),
      bill: settings.host.bill || safe(up?.billBase, "https://www.codebuddy.cn"),
      web: settings.host.web || safe(up?.webBase, "https://www.workbuddy.cn"),
    }
  }

  // ---- HTTP ---------------------------------------------------------------

  const serverOf = (handler) => http.createServer(handler)
  let server = null
  let port = 0
  let stopped = false
  let whenStoppedResolve = null
  const whenStopped = new Promise((r) => (whenStoppedResolve = r))

  function json(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) })
    res.end(text)
  }

  function authorized(req, u) {
    const header = String(req.headers.authorization ?? "")
    const tok = header.replace(/^Bearer\s+/i, "").trim() || u.searchParams.get("k") || ""
    return timingSafeEqual(tok, key)
  }

  const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
  }

  function fallbackPage() {
    return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>WorkBuddy 任务</title>
<body style="font-family:system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1rem;color:#333">
<h2>看板尚未构建</h2>
<p>本插件的 <code>dashboard/</code> 目录还没有前端文件。任务 API、排程与守护进程已在运行。</p>
<p>把看板文件放进 <code>dashboard/</code> 后刷新本页即可。<code>/api/hello</code> 可确认服务状态；其余 <code>/api/*</code> 需要密钥（见 <code>state/daemon.json</code>）。</p>
</body></html>`
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { error: "只支持 GET" })
      return
    }
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
    const full = normalize(join(dashDir, decodeURIComponent(rel)))
    if (full !== dashDir && !full.startsWith(dashDir + sep)) {
      json(res, 403, { error: "路径不合法" })
      return
    }
    if (existsSync(full) && statSync(full).isFile()) {
      const body = readFileSync(full)
      res.writeHead(200, { "Content-Type": MIME[extname(full).toLowerCase()] ?? "application/octet-stream", "Content-Length": body.length })
      res.end(req.method === "HEAD" ? undefined : body)
      return
    }
    if (pathname === "/" || pathname === "/index.html") {
      const body = Buffer.from(fallbackPage())
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length })
      res.end(body)
      return
    }
    json(res, 404, { error: "文件不存在" })
  }

  async function readBody(req, cap = 1024 * 1024) {
    const chunks = []
    let n = 0
    for await (const c of req) {
      n += c.length
      if (n > cap) throw new Error("请求体过大")
      chunks.push(c)
    }
    const text = Buffer.concat(chunks).toString("utf8").trim()
    if (!text) return {}
    return JSON.parse(text)
  }

  async function handleApi(req, res, u) {
    const p = u.pathname

    if (p === "/api/hello") {
      json(res, 200, { name: PLUGIN_NAME, version: VERSION, ready: !!engine?.ok })
      return
    }

    if (!authorized(req, u)) {
      json(res, 401, { error: "需要守护进程密钥：Authorization: Bearer <key> 或 ?k=<key>（密钥见 state/daemon.json）" })
      return
    }

    if (p === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      })
      res.write("retry: 3000\n\n")
      sseClients.add(res)
      req.on("close", () => sseClients.delete(res))
      return
    }

    if (p === "/api/state" && req.method === "GET") {
      const refresh = u.searchParams.get("refresh")
      if (refresh && !runner?.current()) {
        const uids = refresh === "1" || refresh === "true" ? eligibleNow().map((a) => a.uid) : [refresh]
        await refreshSnapshots(uids, 12000)
      }
      json(res, 200, statePayload())
      return
    }

    if (p === "/api/run" && req.method === "POST") {
      if (runner?.current()) {
        json(res, 409, { error: "busy" })
        return
      }
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        json(res, 400, { error: `请求体不是合法 JSON：${shortErr(e)}` })
        return
      }
      try {
        const job = safeJob(startJob(body))
        json(res, 200, { job })
        broadcast({ kind: "job", job })
      } catch (e) {
        // runner 自身的并发闸门抛 {status:409}（检查与 start 之间的竞态），如实映射
        const code =
          e?.code === "WB_ENGINE_UNAVAILABLE"
            ? 503
            : e?.code === "WB_NO_ACCOUNTS"
              ? 400
              : e?.status === 409
                ? 409
                : 500
        json(res, code, { error: shortErr(e) })
      }
      return
    }

    if (p === "/api/stop" && req.method === "POST") {
      const job = await stopCurrentJob()
      if (!job) {
        json(res, 404, { error: "当前没有正在运行的任务" })
        return
      }
      json(res, 200, { job })
      broadcast({ kind: "job", job })
      return
    }

    if (p === "/api/task/claim" && req.method === "POST") {
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        json(res, 400, { error: `请求体不是合法 JSON：${shortErr(e)}` })
        return
      }
      if (!body.uid || !body.code) {
        json(res, 400, { error: "需要 uid 与 code" })
        return
      }
      const r = await manualOp(() => doClaim(body.uid, body.code))
      json(res, r.status, r.body)
      return
    }

    if (p === "/api/task/accept" && req.method === "POST") {
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        json(res, 400, { error: `请求体不是合法 JSON：${shortErr(e)}` })
        return
      }
      if (!body.uid) {
        json(res, 400, { error: "需要 uid" })
        return
      }
      const r = await manualOp(() => doAccept(body.uid, body.codes))
      json(res, r.status, r.body)
      return
    }

    if (p === "/api/checkin" && req.method === "POST") {
      let body = {}
      try {
        body = await readBody(req)
      } catch (e) {
        json(res, 400, { error: `请求体不是合法 JSON：${shortErr(e)}` })
        return
      }
      const r = await manualOp(() => doCheckin(body.uids))
      json(res, r.status, r.body)
      return
    }

    if (p === "/api/settings" && req.method === "POST") {
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        json(res, 400, { error: `请求体不是合法 JSON：${shortErr(e)}` })
        return
      }
      if (typeof body.scheduler === "boolean") settings.scheduler = body.scheduler
      if (typeof body.claim === "boolean") settings.claim = body.claim
      if (Array.isArray(body.legs)) settings.legs = body.legs.filter((l) => LEGS.includes(l))
      if (Number.isFinite(Number(body.gapMs))) settings.gapMs = Math.min(10000, Math.max(500, Number(body.gapMs)))
      if (Array.isArray(body.jitterMs)) {
        const [a, b] = body.jitterMs.map(Number)
        if (Number.isFinite(a) && Number.isFinite(b)) settings.jitterMs = [Math.max(0, a), Math.max(a, b)]
      }
      if (body.hours && typeof body.hours === "object") {
        for (const leg of LEGS) {
          const hs = body.hours[leg]
          if (Array.isArray(hs)) settings.hours[leg] = hs.map(Number).filter((h) => Number.isFinite(h) && h >= 0 && h <= 23)
        }
      }
      if (body.host && typeof body.host === "object") {
        for (const k of ["chat", "bill", "web"]) {
          if (typeof body.host[k] === "string") settings.host[k] = body.host[k].trim()
        }
      }
      saveSettings()
      json(res, 200, {
        scheduler: settings.scheduler,
        claim: settings.claim,
        legs: settings.legs,
        gapMs: settings.gapMs,
        hours: settings.hours,
        host: effectiveHosts(),
      })
      return
    }

    if (p === "/api/accounts" && req.method === "POST") {
      // 重新读 plugin-auth.json，按 uid 报告增删；eligible = 可参与任务的 OAuth 账号数
      const before = new Set(loadAccountsAll().map((a) => a.uid))
      const after = loadAccountsAll()
      const afterIds = new Set(after.map((a) => a.uid))
      let eligible = 0
      try {
        const filter = engine?.store?.eligibleAccounts
        if (typeof filter === "function") eligible = (filter(after) ?? []).length
      } catch {}
      json(res, 200, {
        count: after.length,
        eligible,
        added: [...afterIds].filter((x) => !before.has(x)),
        removed: [...before].filter((x) => !afterIds.has(x)),
      })
      return
    }

    if (p === "/api/account/toggle" && req.method === "POST") {
      // 参与任务开关（hub 的 task_active）：写 state/accounts.json 并回读生效行。
      // 不挡运行中的 job——runner 在 job 启动时就定好了账号名单，开关只影响
      // 下一轮 startJob/eligibleAccounts 的筛选，绝不会动正在跑的 job。
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        json(res, 400, { error: `请求体不是合法 JSON：${shortErr(e)}` })
        return
      }
      const uid = String(body?.uid ?? "").trim()
      if (!uid) {
        json(res, 400, { error: "需要 uid" })
        return
      }
      if (typeof body?.tasksEnabled !== "boolean") {
        json(res, 400, { error: "需要布尔型 tasksEnabled（true=参与任务，false=停用）" })
        return
      }
      const acct = accountByUid(uid)
      if (!acct) {
        json(res, 404, { error: `找不到账号 ${uid}（重新扫描账号或检查 plugin-auth.json）` })
        return
      }
      tasksEnabledMap[uid] = body.tasksEnabled
      if (!saveAccountsState()) {
        json(res, 500, { error: "写入账号状态文件失败（state/accounts.json）" })
        return
      }
      log(`[account] ${uid} 参与任务开关 → ${body.tasksEnabled ? "参与" : "停用"}`)
      json(res, 200, accountRow(accountByUid(uid) ?? acct))
      return
    }

    const m = p.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)$/)
    if (m && req.method === "GET") {
      const get = runner?.get?.bind(runner)
      const job = typeof get === "function" ? get(m[1]) : null
      if (!job) {
        json(res, 404, { error: `找不到 job ${m[1]}` })
        return
      }
      json(res, 200, safeJob(job))
      return
    }

    if (p === "/api/history" && req.method === "GET") {
      const limit = Math.min(2000, Math.max(1, Number(u.searchParams.get("limit")) || 200))
      json(res, 200, { rows: history.slice(-limit).reverse() })
      return
    }

    if (p === "/api/shutdown" && req.method === "POST") {
      json(res, 200, { ok: true })
      shutdown("收到 /api/shutdown")
      return
    }

    json(res, 404, { error: `未知 API：${req.method} ${p}` })
  }

  const handler = async (req, res) => {
    let u
    try {
      u = new URL(req.url ?? "/", "http://localhost")
    } catch {
      json(res, 400, { error: "URL 不合法" })
      return
    }
    try {
      if (u.pathname.startsWith("/api/")) await handleApi(req, res, u)
      else serveStatic(req, res, u.pathname)
    } catch (e) {
      // 永不给浏览器看堆栈；详情只进本地日志
      log("[http] " + shortErr(e))
      try {
        json(res, 500, { error: "守护进程内部错误：" + shortErr(e) })
      } catch {}
    }
  }

  // ---- 绑定端口（被占用则向后找，最后随机） --------------------------------

  async function bind(hostName, startPort) {
    const candidates = startPort > 0 ? [startPort, ...Array.from({ length: 9 }, (_, i) => startPort + 1 + i), 0] : [0]
    for (const p of candidates) {
      const s = serverOf(handler)
      try {
        await new Promise((ok, bad) => {
          s.once("error", bad)
          s.listen(p, hostName, () => ok())
        })
        return { server: s, port: s.address().port }
      } catch (e) {
        try {
          s.close()
        } catch {}
        if (p === 0) throw e
        log(`端口 ${p} 被占用，换下一个…`)
      }
    }
    throw new Error("找不到可用端口")
  }
  ;({ server, port } = await bind(host, addr.port))

  // ---- 生命周期杂务 ---------------------------------------------------------

  const timers = []
  function every(ms, fn) {
    const t = setInterval(() => {
      try {
        fn()
      } catch (e) {
        log("[tick] " + shortErr(e))
      }
    }, ms)
    t.unref?.()
    timers.push(t)
  }

  function heartbeat() {
    writeDaemonInfo(stateDir, { pid: process.pid, port, key, version: VERSION, startedAt })
    try {
      writeFileSync(join(stateDir, "daemon.heartbeat"), String(now()), "utf8")
    } catch {}
  }

  // plugins.json：条目 off:true → 优雅退出；托管模式下条目消失（插件被移除）也退
  function checkPluginsFile() {
    try {
      const file = join(cfgDir, "plugins.json")
      if (!existsSync(file)) return
      const raw = readJson(file, null)
      if (!raw || !Array.isArray(raw.plugins)) return
      const mine = raw.plugins.filter((x) => String(x?.spec ?? "").includes(PLUGIN_NAME))
      if (mine.some((x) => x.off === true)) {
        shutdown("插件在 magpie 里已关闭（plugins.json off:true）")
        return
      }
      if (managed && !mine.length) shutdown("插件已从 magpie 移除（plugins.json 无本插件条目）")
    } catch (e) {
      log("[plugins.json] " + shortErr(e))
    }
  }

  // magpie TCP 探测：MAGPIE_ADDR（host:port），否则 127.0.0.1:3425 再试 :3430；
  // 连续 4 次失败 → magpie 停了 → 退出
  let magpieFails = 0
  function magpieCandidates() {
    const addrEnv = String(process.env.MAGPIE_ADDR ?? "").trim()
    if (addrEnv) {
      const i = addrEnv.lastIndexOf(":")
      if (i > 0) return [{ host: addrEnv.slice(0, i), port: Number(addrEnv.slice(i + 1)) || 3425 }]
      if (/^\d+$/.test(addrEnv)) return [{ host: "127.0.0.1", port: Number(addrEnv) }]
    }
    return [
      { host: "127.0.0.1", port: 3425 },
      { host: "127.0.0.1", port: 3430 },
    ]
  }

  function tcpProbe(hostName, portNo, timeoutMs = 2000) {
    return new Promise((ok) => {
      const s = net.connect({ host: hostName, port: portNo })
      let done = false
      const finish = (v) => {
        if (done) return
        done = true
        s.destroy()
        ok(v)
      }
      s.setTimeout(timeoutMs, () => finish(false))
      s.on("connect", () => finish(true))
      s.on("error", () => finish(false))
    })
  }

  async function checkMagpie() {
    try {
      const cands = magpieCandidates()
      for (const c of cands) {
        if (await tcpProbe(c.host, c.port)) {
          magpieFails = 0
          return
        }
      }
      magpieFails++
      if (magpieFails >= 4) shutdown(`连续 ${magpieFails} 次探测不到 magpie（${cands.map((c) => `${c.host}:${c.port}`).join(" / ")}），退出`)
    } catch (e) {
      log("[magpie probe] " + shortErr(e))
    }
  }

  function checkControl() {
    try {
      const c = readControl(stateDir)
      if (c.desired === "off") {
        shutdown("control.json desired=off")
        return true
      }
    } catch (e) {
      log("[control] " + shortErr(e))
    }
    return false
  }

  function shutdown(reason) {
    if (stopped) return whenStopped
    stopped = true
    log("[shutdown] " + reason)
    for (const t of timers) clearInterval(t)
    broadcast({ kind: "scheduler", event: "shutdown", reason: scrub(reason) })
    for (const res of [...sseClients]) {
      try {
        res.end()
      } catch {}
    }
    sseClients.clear()
    Promise.race([stopCurrentJob(), sleepFn(1500)])
      .catch(() => {})
      .finally(() => {
        try {
          server.close(() => whenStoppedResolve())
        } catch {
          whenStoppedResolve()
        }
        // 保险：close 回调万一不触发
        setTimeout(whenStoppedResolve, 1000).unref?.()
      })
    return whenStopped
  }

  // ---- 启动落盘 + 定时器 -----------------------------------------------------

  const startedAt = nowIso()
  heartbeat()
  if (opts.noTimers !== true) {
    every(5000, heartbeat)
    every(5000, checkControl)
    every(10000, checkPluginsFile)
    every(15000, checkMagpie)
    every(30000, checkScheduler)
    every(1000, watchJobTick)
  }

  log(`守护进程就绪：http://${host}:${port}（state: ${stateDir}）`)
  if (!engine?.ok) log("[warn] " + engineErrorsText())

  return {
    port,
    host,
    key,
    stateDir,
    cfgDir,
    version: VERSION,
    engine,
    runner, // 便于测试观察 job 状态
    whenStopped,
    get stopped() {
      return stopped
    },
    stop: () => shutdown("stop() 被调用"),
    // 测试钩子：手动驱动各路检查（noTimers 模式下用）
    ticks: {
      heartbeat,
      checkControl,
      checkPluginsFile,
      checkMagpie,
      checkScheduler,
      watchJob: watchJobTick,
    },
  }
}

// ---- 作为脚本运行 -----------------------------------------------------------

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href
  } catch {
    return false
  }
})()

if (isMain) {
  const log = (...a) => console.log(new Date().toISOString(), ...a)
  startDaemon({ log })
    .then((h) => {
      log(`看板地址：http://${h.host}:${h.port}/  （API 需要密钥，见 state/daemon.json）`)
      const bye = (sig) => () => {
        log(`收到 ${sig}，退出`)
        h.stop()
        setTimeout(() => process.exit(0), 1500)
      }
      process.on("SIGINT", bye("SIGINT"))
      process.on("SIGTERM", bye("SIGTERM"))
      process.on("exit", () => log("daemon 退出"))
      process.on("uncaughtException", (e) => log("[uncaught] " + shortErr(e)))
      process.on("unhandledRejection", (e) => log("[unhandled] " + shortErr(e)))
    })
    .catch((e) => {
      log("启动失败：" + shortErr(e))
      process.exit(1)
    })
}
