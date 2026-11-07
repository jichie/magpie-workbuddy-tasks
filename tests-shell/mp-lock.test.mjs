// tests-shell/mp-lock.test.mjs —— 小程序链式任务「次日锁」（0.3.2 修订版）的外壳回归。
//
// 生产实测（2026-11-07 只读拉取上游清单原始 JSON）：**上游本身就带锁字段** ——
//   实测账号 B 的 Sequential_Tasks_3：`"locked": true, "unlock_at": "2026-11-08T00:00:00+08:00"`
//   （accept_status=not_accepted）；实测账号的 Sequential_Tasks_2：`"locked": false`
//   （not_accepted，说明当天已解锁）；其他任务也都有 `"locked": false`。
// 因此锁的主依据 = 任务自身字段（上游权威）：
//   1. snapTask：任务带自身锁信息（locked 是布尔或 unlockAt 非空）→ 以上游为准；
//      locked:false 必须能覆盖 mp-locks 里的陈旧锁；locked 仅在 not_accepted 时为
//      true（accepted/claimed 即使带 locked:true 也不标锁）；
//   2. lockedUntil 从 unlock_at 解析为北京日期（带时区 ISO，Date.parse + 北京日，
//      绝不 slice 字符串）；解析失败回退 mp-locks 的 until；
//   3. 任务完全没有自身锁字段（旧缓存）→ 回退 mp-locks 锁表；
//   4. 不再做任何「按领奖日期推断链式锁」的逻辑（inferMPLockChain 已删）—— 它会
//      把手动/旧版本已领奖的历史任务多锁一天（实测账号 ST2 上游已 locked:false，
//      推断却会锁到 11-08，属于错误）。mp-locks.json 只剩两个防御/过渡用途：
//      accept 失败消息落盘的显式锁 + doClaim 给下一环记「明天」的即时锁
//      （下一次快照刷新后必被上游字段覆盖）。
// 零真实网络：fetch = wbBackend 假上游（MP 清单口径 mpOnly，可携带 locked/unlock_at
// 种子字段），时钟全注入。
import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { startDaemon } from "../daemon.mjs"
import * as tasksMod from "../engine/tasks.mjs"
import * as mpMod from "../engine/miniprogram.mjs"
import * as upstreamMod from "../engine/upstream.mjs"
import { cleanupAllSandboxes, cleanupSandbox, fakeClock, makeSandbox, task, wbBackend } from "../tests/helpers.mjs"

after(() => {
  cleanupAllSandboxes()
})

const KEY = "test-key-mp-lock"
const account = {
  key: "workbuddy",
  provider: "workbuddy",
  uid: "u1",
  nickname: "阿猫",
  access: "a",
  refresh: "r",
  expires: Date.now() + 86400000,
  domain: "",
  isApiKey: false,
  enterpriseId: "",
}

function storeFake() {
  return {
    readMagpieConfigDir: () => null,
    loadAccounts: () => [account],
    eligibleAccounts: (accounts) =>
      accounts.filter((a) => a.provider === "workbuddy" && !a.isApiKey && !a.enterpriseId && a.tasksEnabled !== false),
  }
}

function runnerFake() {
  return {
    JobRunner: class JobRunner {
      constructor(ctx) {
        this.ctx = ctx
      }
      start() {
        throw new Error("not used")
      }
      get() {
        return null
      }
      current() {
        return null
      }
      holds() {
        return []
      }
    },
  }
}

// 真实引擎模块 + wbBackend 假上游（daemon 的 fetch 注入缝顶替全部上游网络）
function realEngine(backend) {
  return {
    store: storeFake(),
    runner: runnerFake(),
    tasks: tasksMod,
    miniprogram: mpMod,
    upstream: upstreamMod,
    errors: [],
    ok: true,
    __backend: backend,
  }
}

// 时钟基点：UTC 2026-11-05 02:00 = 北京 2026-11-05 10:00（beijingDateKey 口径，
// 与宿主时区无关）→ mp-locks 的「今天」= 2026-11-05、「明天」= 2026-11-06。
const BASE_MS = Date.UTC(2026, 10, 5, 2, 0, 0)

// 旧缓存形态的规范 Task（**不带** locked/unlockAt —— 模拟本修订前落盘的 v2 缓存，
// 投影时走 mp-locks 回退路径）。
function oldCacheTask(code, { status = "not_accepted", current = 0, target = 1, reward = 100 } = {}) {
  return {
    code,
    title: code,
    description: "",
    jumpUrl: "",
    acceptStatus: status,
    taskType: "single",
    progress: { current, target },
    rewardCredit: reward,
    rewardEnergy: 0,
    unforgeable: false,
    reason: "",
  }
}

// 直接写 v2 快照缓存（entry 里可显式补 locked/unlockAt 模拟新缓存）
function seedSnapshot(stateDir, entries) {
  writeFileSync(
    join(stateDir, "snapshots.json"),
    JSON.stringify(
      {
        u1: {
          snapVersion: 2,
          tasks: entries,
          energy: 42,
          streak: 7,
          days: 7,
          updatedISO: "2026-11-05T02:00:00.000Z",
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  )
}

function seedMPLocks(stateDir, locks) {
  writeFileSync(join(stateDir, "mp-locks.json"), JSON.stringify({ locks, claims: {} }, null, 2) + "\n", "utf8")
}

async function boot({ backend, fetchImpl, stateDir } = {}) {
  const clock = fakeClock(BASE_MS) // 单一时钟实例：now 与 sleep 同源（注入口径）
  return startDaemon({
    key: KEY,
    port: 0,
    stateDir,
    engine: realEngine(backend),
    now: clock.now,
    sleep: clock.sleep,
    ...(fetchImpl ? { fetch: fetchImpl } : backend ? { fetch: backend.fetchImpl } : {}),
    noTimers: true,
    skipExistingCheck: true,
  })
}

const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const getState = async (h, path = "/api/state") => {
  const res = await fetch(`http://127.0.0.1:${h.port}${path}`)
  assert.equal(res.status, 200)
  return res.json()
}

const snapByCode = (st) => new Map((st.accounts[0].snapshot?.tasks ?? []).map((t) => [t.code, t]))

describe("次日锁主依据：上游 locked/unlock_at（0.3.2 实测）", () => {
  test("locked:true + unlock_at(+08:00) → 快照 locked/lockedUntil/lockHint 精确到 unlock_at 日期；不再写 mp-locks.json", async () => {
    const clock = fakeClock(BASE_MS) // 仅给 wbBackend 的调用时间戳用（daemon 另有自己的注入时钟）
    const backend = wbBackend({
      clock,
      tasks: [
        task("Sequential_Tasks_2", {
          title: "小程序专家对话",
          status: "not_accepted",
          locked: true,
          unlock_at: "2026-11-08T00:00:00+08:00",
        }),
      ],
      mpOnly: ["Sequential_Tasks_2"],
      litRules: {},
    })
    const sb = makeSandbox("wb-mp-lock-upstream-")
    const h = await boot({ backend, stateDir: sb.dir })
    try {
      const st = await getState(h, "/api/state?refresh=1")
      const t = snapByCode(st).get("Sequential_Tasks_2")
      assert.ok(t, "ST2 进快照")
      assert.equal(t.locked, true, "上游 locked:true → 锁定")
      assert.equal(t.lockedUntil, "2026-11-08", "unlock_at 按北京时间取日（+08:00 零点 → 11-08）")
      assert.equal(t.lockHint, "到第二天才能接取任务（2026-11-08 起可接）")
      assert.equal(t.canAccept, false, "锁定项不可接取（看板不可勾）")
      assert.equal(t.canLight, false, "not_accepted 本就不可点亮（其余字段不变）")

      // 锁来自上游清单本身：不再有任何推断 → mp-locks.json 根本不落盘
      assert.equal(existsSync(join(sb.dir, "mp-locks.json")), false, "无 accept 失败/领奖 → 不产生 mp-locks.json")

      // 上游锁字段随规范 Task 落盘（v2 重投影的输入字段）
      const disk = JSON.parse(readFileSync(join(sb.dir, "snapshots.json"), "utf8"))
      assert.equal(disk.u1.tasks[0].locked, true)
      assert.equal(disk.u1.tasks[0].unlockAt, "2026-11-08T00:00:00+08:00")
    } finally {
      await h.stop()
      cleanupSandbox(sb.dir)
    }
  })

  test("Z 时区 unlock_at 也按北京时间取日（不能 slice 字符串）", async () => {
    const clock = fakeClock(BASE_MS) // 仅给 wbBackend 的调用时间戳用（daemon 另有自己的注入时钟）
    const backend = wbBackend({
      clock,
      tasks: [
        // 与 "2026-11-08T00:00:00+08:00" 同一时刻的 Z 形态 —— slice 会错成 11-07
        task("Sequential_Tasks_2", { status: "not_accepted", locked: true, unlock_at: "2026-11-07T16:00:00Z" }),
      ],
      mpOnly: ["Sequential_Tasks_2"],
      litRules: {},
    })
    const sb = makeSandbox("wb-mp-lock-zoned-")
    const h = await boot({ backend, stateDir: sb.dir })
    try {
      const t = snapByCode(await getState(h, "/api/state?refresh=1")).get("Sequential_Tasks_2")
      assert.equal(t.lockedUntil, "2026-11-08", "Z 时区 ISO → 北京日 11-08（不能 slice）")
      assert.equal(t.lockHint, "到第二天才能接取任务（2026-11-08 起可接）")
    } finally {
      await h.stop()
      cleanupSandbox(sb.dir)
    }
  })

  test("accepted / claimed 即使带 locked:true 也不标锁", async () => {
    const clock = fakeClock(BASE_MS) // 仅给 wbBackend 的调用时间戳用（daemon 另有自己的注入时钟）
    const backend = wbBackend({
      clock,
      tasks: [
        task("Sequential_Tasks_1", { title: "小程序对话", status: "claimed", current: 1, target: 1, locked: true, unlock_at: "2026-11-08T00:00:00+08:00" }),
        task("Sequential_Tasks_2", { title: "小程序专家对话", status: "accepted", locked: true, unlock_at: "2026-11-08T00:00:00+08:00" }),
      ],
      mpOnly: ["Sequential_Tasks_1", "Sequential_Tasks_2"],
      litRules: {},
    })
    const sb = makeSandbox("wb-mp-lock-status-")
    const h = await boot({ backend, stateDir: sb.dir })
    try {
      const snap = snapByCode(await getState(h, "/api/state?refresh=1"))
      for (const code of ["Sequential_Tasks_1", "Sequential_Tasks_2"]) {
        const t = snap.get(code)
        assert.equal(t.locked, false, `${code} 非 not_accepted → 不标锁`)
        assert.equal(t.lockedUntil, "")
        assert.equal(t.lockHint, "")
        assert.equal(t.canAccept, false, `${code} accepted/claimed 本就不可接取`)
      }
    } finally {
      await h.stop()
      cleanupSandbox(sb.dir)
    }
  })
})

describe("mp-locks 回退与上游覆盖", () => {
  test("旧缓存（无锁字段）回退 mp-locks 显示锁；刷新后上游 locked:false 覆盖陈旧锁", async () => {
    // 上游（新一轮清单）明说 ST2 已解锁 —— 实测账号 ST2 实测形态
    const clock = fakeClock(BASE_MS) // 仅给 wbBackend 的调用时间戳用（daemon 另有自己的注入时钟）
    const backend = wbBackend({
      clock,
      tasks: [task("Sequential_Tasks_2", { title: "小程序专家对话", status: "not_accepted", locked: false })],
      mpOnly: ["Sequential_Tasks_2"],
      litRules: {},
    })
    const sb = makeSandbox("wb-mp-lock-override-")
    // 陈旧锁（旧推断/旧版本留下的）+ 旧缓存（无自身锁字段）→ 回退路径先显示锁
    seedMPLocks(sb.dir, {
      u1: { "Sequential_Tasks_2": { until: "2026-11-09", reason: "陈旧锁", at: "2026-11-04T00:00:00.000Z" } },
    })
    seedSnapshot(sb.dir, [oldCacheTask("Sequential_Tasks_2")])
    const h = await boot({ backend, stateDir: sb.dir })
    try {
      const before = snapByCode(await getState(h)).get("Sequential_Tasks_2")
      assert.equal(before.locked, true, "旧缓存无锁字段 → 回退 mp-locks：锁定")
      assert.equal(before.lockedUntil, "2026-11-09")
      assert.equal(before.canAccept, false)

      // 刷新：上游 locked:false 覆盖陈旧锁（locked:false 必须赢）
      const after = snapByCode(await getState(h, "/api/state?refresh=1")).get("Sequential_Tasks_2")
      assert.equal(after.locked, false, "上游 locked:false → 不锁（覆盖 mp-locks 陈旧锁）")
      assert.equal(after.lockedUntil, "")
      assert.equal(after.lockHint, "")
      assert.equal(after.canAccept, true, "not_accepted 且已解锁 → 可接取")

      // 覆盖是投影层面的：mp-locks 记录本身保留（未过期不清理）
      const disk = JSON.parse(readFileSync(join(sb.dir, "mp-locks.json"), "utf8"))
      assert.equal(disk.locks.u1["Sequential_Tasks_2"].until, "2026-11-09")
    } finally {
      await h.stop()
      cleanupSandbox(sb.dir)
    }
  })
})

describe("mp-locks 用途 1：accept 失败消息落盘的显式锁（防御/兼容）", () => {
  test("accept 返回 locked → mp-locks.json 落盘 → 旧缓存快照经回退路径锁定", async () => {
    const clock = fakeClock(BASE_MS) // 仅给 wbBackend 的调用时间戳用（daemon 另有自己的注入时钟）
    const backend = wbBackend({
      clock,
      tasks: [task("Sequential_Tasks_2", { title: "小程序专家对话", status: "not_accepted" })],
      mpOnly: ["Sequential_Tasks_2"],
      litRules: {},
    })
    // 上游对 ST2 的接取回「锁到 2026-11-07」（生产实测消息形态）
    const fetchImpl = async (url, init) => {
      if (new URL(url).pathname.endsWith("/tasks/accept")) {
        return {
          status: 200,
          text: async () => JSON.stringify({
            code: 0,
            data: { results: [{ task_code: "Sequential_Tasks_2", status: "error", message: "task locked until 2026-11-07" }] },
          }),
        }
      }
      return backend.fetchImpl(url, init)
    }
    const sb = makeSandbox("wb-mp-lock-accept-")
    seedSnapshot(sb.dir, [oldCacheTask("Sequential_Tasks_2")]) // 旧缓存：无锁字段
    const h = await boot({ backend, fetchImpl, stateDir: sb.dir })
    try {
      // 手动接取被上游锁拒（响应形状不变）
      const res = await post(h.port, "/api/task/accept", { uid: "u1", codes: ["Sequential_Tasks_2"] })
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { accepted: [], already: [], failed: ["Sequential_Tasks_2"] })

      // mp-locks.json 落盘（engineOpts 回调 + doAccept 防御层都会记，取更晚同值）
      const disk = JSON.parse(readFileSync(join(sb.dir, "mp-locks.json"), "utf8"))
      assert.equal(disk.locks.u1["Sequential_Tasks_2"].until, "2026-11-07")
      assert.match(disk.locks.u1["Sequential_Tasks_2"].reason, /task locked until/)

      // 旧缓存（无上游锁字段）经回退路径显示锁定
      const t = snapByCode(await getState(h)).get("Sequential_Tasks_2")
      assert.equal(t.locked, true)
      assert.equal(t.lockedUntil, "2026-11-07")
      assert.equal(t.lockHint, "到第二天才能接取任务（2026-11-07 起可接）")
      assert.equal(t.canAccept, false, "锁定项不给接取结论")
    } finally {
      await h.stop()
      cleanupSandbox(sb.dir)
    }
  })
})

describe("mp-locks 用途 2：doClaim 给下一环记「明天」的即时锁", () => {
  test("领 ST1 成功 → 旧缓存快照立即锁 ST2；刷新后被上游字段覆盖", async () => {
    const clock = fakeClock(BASE_MS) // 仅给 wbBackend 的调用时间戳用（daemon 另有自己的注入时钟）
    const backend = wbBackend({
      clock,
      tasks: [
        task("Sequential_Tasks_1", { title: "小程序对话", status: "completed", current: 1, target: 1, reward: 100 }),
        task("Sequential_Tasks_2", { title: "小程序专家对话", status: "not_accepted", reward: 200 }),
      ],
      mpOnly: ["Sequential_Tasks_1", "Sequential_Tasks_2"],
      litRules: {},
    })
    const sb = makeSandbox("wb-mp-lock-claim-")
    seedSnapshot(sb.dir, [
      oldCacheTask("Sequential_Tasks_1", { status: "completed", current: 1, target: 1 }),
      oldCacheTask("Sequential_Tasks_2", { reward: 200 }),
    ])
    const h = await boot({ backend, stateDir: sb.dir })
    try {
      // 手动领奖 ST1（MP 头族；响应形状不变）
      const res = await post(h.port, "/api/task/claim", { uid: "u1", code: "Sequential_Tasks_1" })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.ok, true, JSON.stringify(body))
      assert.equal(body.credit, 100)
      assert.deepEqual(Object.keys(body).sort(), ["credit", "energy", "ok", "reason", "via"])

      // 落盘：claims[ST1]=北京今天（2026-11-05）+ 即时锁 ST2 until 明天（2026-11-06）
      const disk = JSON.parse(readFileSync(join(sb.dir, "mp-locks.json"), "utf8"))
      assert.equal(disk.claims.u1["Sequential_Tasks_1"], "2026-11-05")
      assert.equal(disk.locks.u1["Sequential_Tasks_2"].until, "2026-11-06")
      assert.equal(disk.locks.u1["Sequential_Tasks_2"].reason, "完成任务后次日才能接取")

      // 旧缓存（无上游锁字段）→ 回退路径立即显示 ST2 锁定，不必等下一次快照
      const st2 = snapByCode(await getState(h)).get("Sequential_Tasks_2")
      assert.equal(st2.locked, true)
      assert.equal(st2.lockedUntil, "2026-11-06")
      assert.equal(st2.canAccept, false)

      // 下一次快照刷新后：上游字段接管（wbBackend 未带 locked → 归一 locked:false）
      // → 覆盖即时锁
      const after = snapByCode(await getState(h, "/api/state?refresh=1")).get("Sequential_Tasks_2")
      assert.equal(after.locked, false, "刷新后上游 locked:false 覆盖即时锁")
      assert.equal(after.canAccept, true)
    } finally {
      await h.stop()
      cleanupSandbox(sb.dir)
    }
  })

  test("链尾 N=6 止步：领 ST6 不给 ST7（web playbook）记锁", async () => {
    const clock = fakeClock(BASE_MS) // 仅给 wbBackend 的调用时间戳用（daemon 另有自己的注入时钟）
    const backend = wbBackend({
      clock,
      tasks: [task("Sequential_Tasks_6", { title: "小程序对话10次", status: "completed", current: 10, target: 10, reward: 400 })],
      mpOnly: ["Sequential_Tasks_6"],
      litRules: {},
    })
    const sb = makeSandbox("wb-mp-lock-tail-")
    const h = await boot({ backend, stateDir: sb.dir })
    try {
      const res = await post(h.port, "/api/task/claim", { uid: "u1", code: "Sequential_Tasks_6" })
      assert.equal(res.status, 200)
      assert.equal((await res.json()).ok, true)
      const disk = JSON.parse(readFileSync(join(sb.dir, "mp-locks.json"), "utf8"))
      assert.equal(disk.claims.u1["Sequential_Tasks_6"], "2026-11-05", "ST6 领奖已记录")
      assert.equal(disk.locks.u1?.["Sequential_Tasks_7"], undefined, "N=6 不给 ST7 记链式锁")
    } finally {
      await h.stop()
      cleanupSandbox(sb.dir)
    }
  })
})
