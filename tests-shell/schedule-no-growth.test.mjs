// tests-shell/schedule-no-growth.test.mjs —— 排程去掉「成长任务」（CONTRACT §7/§8）外壳回归。
//
// 排程小时窗口只认 buddy|travel|night：
//   - engine/schedule.SCHEDULE_WINDOWS 只有 09:00/21:00 travel、01:00 night
//     （buddy 默认无窗口：开盲盒消耗成长能量，默认不自动跑）；
//   - daemon 的 DEFAULT_SETTINGS.hours = { buddy:[], travel:[9,21], night:[1] }；
//   - 旧 settings.json 里遗留的 hours.growth 在读取时丢弃（/api/state 的
//     scheduler.nextRuns 与 settings.hours 都不再出现 growth），tick 因此不会
//     触发 growth job；
//   - POST /api/settings 的 hours 只收 buddy|travel|night（写 growth 也不报错、
//     不生效；buddy 显式配了小时才会排程）；
//   - 手动运行不受影响：POST /api/run {legs:["growth"]} 照常启动 growth job
//     （LEGS 常量含 growth|buddy|travel|night，settings.legs 默认也仍含 growth）。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startDaemon, normalizeScheduleHours } from "../daemon.mjs"
import { cleanupAllSandboxes, cleanupSandbox, makeSandbox } from "../tests/helpers.mjs"

function fakeEngine() {
  const specs = []
  let current = null
  const eng = {
    store: {
      loadAccounts: () => [
        { key: "workbuddy", provider: "workbuddy", uid: "u1", nickname: "阿猫", access: "a", refresh: "r", expires: Date.now() + 86400000, domain: "", isApiKey: false, enterpriseId: "" },
      ],
      eligibleAccounts: (accounts) =>
        accounts.filter((a) => a.provider === "workbuddy" && !a.isApiKey && !a.enterpriseId && a.tasksEnabled !== false),
    },
    runner: {
      JobRunner: class JobRunner {
        start(spec) {
          if (current) throw Object.assign(new Error("runner busy"), { code: 409 })
          specs.push(spec)
          const job = {
            id: `job-${specs.length}`,
            state: "running",
            startedAt: new Date().toISOString(),
            endedAt: null,
            trigger: spec.trigger ?? "manual",
            legs: spec.legs ?? [],
            spec,
            totals: { credit: 0, energy: 0, tasksLit: 0, tasksClaimed: 0 },
            steps: [],
            log: [],
          }
          const t = setTimeout(() => {
            job.state = "done"
            job.endedAt = new Date().toISOString()
            if (current?.id === job.id) current = null
          }, 50)
          t.unref?.()
          current = job
          return job
        }
        get() {
          return null
        }
        current() {
          return current && current.state === "running" ? current : null
        }
      },
    },
    tasks: null,
    upstream: null,
    errors: [],
    ok: true,
    __specs: specs,
  }
  return eng
}

async function boot(stateDir) {
  return startDaemon({
    key: "sched-growth-key-0123456789abcdef",
    port: 0,
    stateDir,
    engine: fakeEngine(),
    noTimers: true,
    skipExistingCheck: true,
  })
}

const get = (port, path) => fetch(`http://127.0.0.1:${port}${path}`)
const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms))

describe("normalizeScheduleHours（纯函数）", () => {
  test("growth 与未知键丢弃、0–23 整数去重升序、非法输入落空表（buddy 键保留）", () => {
    // 旧 settings.json 的形状：growth 原样存在 → 归一后消失；buddy 是合法键
    assert.deepEqual(normalizeScheduleHours({ growth: [9], travel: [21, 9, 9], night: [1, "x", 24, -1], buddy: [3, 3, "y", 25] }), {
      buddy: [3],
      travel: [9, 21],
      night: [1],
    })
    assert.deepEqual(normalizeScheduleHours({ growth: [1, 2, 3] }), { buddy: [], travel: [], night: [] })
    assert.deepEqual(normalizeScheduleHours(null), { buddy: [], travel: [], night: [] })
    assert.deepEqual(normalizeScheduleHours([9, 21]), { buddy: [], travel: [], night: [] })
    assert.deepEqual(normalizeScheduleHours({ travel: "9,21" }), { buddy: [], travel: [], night: [] })
  })
})

describe("旧 settings.json 含 hours.growth 的升级读径", () => {
  const keep = []
  after(() => {
    for (const d of keep) cleanupSandbox(d)
    cleanupAllSandboxes()
  })

  test("/api/state 的 settings.hours 与 scheduler.nextRuns 不含 growth；tick 不触发 growth job", async () => {
    const stateDir = makeSandbox("wb-sched-").dir
    keep.push(stateDir)
    // 老版写盘的形状：growth 窗口钉在当前**北京小时**（引擎把窗口小时按北京时间
    // UTC+8 解释，CONTRACT §7/§8）——升级后 tick 绝不能因为它点火。取「对照触发」
    // 那一脚的时间戳 t0+1000 来钉窗口，保证跨整点也必然命中。
    const t0 = Date.now()
    const nowHour = new Date(t0 + 1000 + 8 * 3600 * 1000).getUTCHours()
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({ scheduler: true, hours: { growth: [nowHour], travel: [], night: [] } }),
      "utf8",
    )
    const h = await boot(stateDir)
    try {
      const s = await (await get(h.port, "/api/state")).json()
      assert.equal(s.scheduler.enabled, true)
      assert.deepEqual(Object.keys(s.settings.hours).sort(), ["buddy", "night", "travel"], "hours 键限制为 buddy|travel|night")
      assert.ok(!JSON.stringify(s.settings.hours).includes("growth"), "settings.hours 不含 growth")
      assert.ok(
        !s.scheduler.nextRuns.some(([leg]) => leg === "growth"),
        `scheduler.nextRuns 不含 growth: ${JSON.stringify(s.scheduler.nextRuns)}`,
      )

      // tick：当前小时只有（已被丢弃的）growth 窗口 → 不触发任何 job
      const job = h.ticks.checkScheduler(t0)
      assert.equal(job, null, "growth 窗口被丢弃后，tick 不该触发 growth job")

      // 对照：把 travel 窗口钉在同一北京小时 → tick 正常触发，且腿是 travel
      const st = await post(h.port, "/api/settings", { hours: { travel: [nowHour] } })
      assert.equal(st.status, 200)
      const job2 = h.ticks.checkScheduler(t0 + 1000)
      assert.ok(job2, "travel 窗口命中 → 触发")
      assert.deepEqual(job2.legs, ["travel"])
      await tick()
    } finally {
      await h.stop()
    }
  })

  test("POST /api/settings 的 hours 只收 buddy|travel|night（growth 写进来不生效、不落盘；buddy 可配）", async () => {
    const stateDir = makeSandbox("wb-sched-").dir
    keep.push(stateDir)
    const h = await boot(stateDir)
    try {
      const st = await post(h.port, "/api/settings", { hours: { growth: [3], travel: [5], night: [2], buddy: [7] } })
      assert.equal(st.status, 200)
      const body = await st.json()
      assert.deepEqual(Object.keys(body.hours).sort(), ["buddy", "night", "travel"])
      assert.deepEqual(body.hours.travel, [5])
      assert.deepEqual(body.hours.night, [2])
      assert.deepEqual(body.hours.buddy, [7], "buddy 窗口可显式配置")
      assert.ok(!JSON.stringify(body.hours).includes("growth"), "响应的 hours 不含 growth")

      const onDisk = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8"))
      assert.ok(!("growth" in (onDisk.hours ?? {})), "落盘的 settings.json 不含 growth")
      assert.deepEqual(onDisk.hours, { buddy: [7], travel: [5], night: [2] })
    } finally {
      await h.stop()
    }
  })

  test("DEFAULT_SETTINGS.hours = { buddy:[], travel:[9,21], night:[1] }（缺省 boot 即此值，buddy 不排程）", async () => {
    const stateDir = makeSandbox("wb-sched-").dir
    keep.push(stateDir)
    const h = await boot(stateDir)
    try {
      const s = await (await get(h.port, "/api/state")).json()
      assert.deepEqual(s.settings.hours, { buddy: [], travel: [9, 21], night: [1] })
      assert.ok(!JSON.stringify(s.scheduler.nextRuns).includes("growth"))
      assert.ok(!s.scheduler.nextRuns.some(([leg]) => leg === "buddy"), "buddy 默认空窗口 → nextRuns 不含 buddy")
      // settings.legs 默认仍含 growth（手动默认腿不变）
      assert.deepEqual(s.settings.legs, ["growth", "travel"])
    } finally {
      await h.stop()
    }
  })

  test("buddy 显式配了小时 → nextRuns 含 buddy、tick 触发 buddy 腿", async () => {
    const stateDir = makeSandbox("wb-sched-").dir
    keep.push(stateDir)
    const h = await boot(stateDir)
    try {
      const t0 = Date.now()
      const nowHour = new Date(t0 + 1000 + 8 * 3600 * 1000).getUTCHours()
      const st = await post(h.port, "/api/settings", { scheduler: true, hours: { buddy: [nowHour] } })
      assert.equal(st.status, 200)
      const s = await (await get(h.port, "/api/state")).json()
      assert.ok(
        s.scheduler.nextRuns.some(([leg, hh]) => leg === "buddy" && hh === nowHour),
        `schedulerNextRuns 含 buddy: ${JSON.stringify(s.scheduler.nextRuns)}`,
      )
      const job = h.ticks.checkScheduler(t0)
      assert.ok(job, "buddy 窗口命中 → 触发")
      assert.deepEqual(job.legs, ["buddy"], "排程触发的腿就是 buddy")
      await tick()
    } finally {
      await h.stop()
    }
  })

  test("手动 growth job 仍能启动（LEGS 与手动路径不受排程收窄影响）", async () => {
    const stateDir = makeSandbox("wb-sched-").dir
    keep.push(stateDir)
    const h = await boot(stateDir)
    const specs = h.engine.__specs
    try {
      const r = await post(h.port, "/api/run", { legs: ["growth", "bogus"] })
      assert.equal(r.status, 200)
      const { job } = await r.json()
      assert.ok(job.id)
      await tick()
      const spec = specs.at(-1)
      assert.deepEqual(spec.legs, ["growth"], "未知腿剔除，growth 照常进入 spec")
      assert.equal(spec.taskCodes, null, "手动不传 codes → taskCodes 为 null（全部任务）")

      // 手动默认腿（不传 legs）：settings.legs = ["growth","travel"] 照旧生效
      await tick()
      const r2 = await post(h.port, "/api/run", {})
      assert.equal(r2.status, 200)
      await tick()
      assert.deepEqual(specs.at(-1).legs, ["growth", "travel"])
    } finally {
      await h.stop()
    }
  })
})
