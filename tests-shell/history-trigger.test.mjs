// tests-shell/history-trigger.test.mjs —— 历史行 trigger 口径回归（看板「触发」列）。
//
// 生产缺陷：daemon.appendHistory 写的是 `trigger: job.trigger ?? "manual"`，但真实
// 引擎（engine/runner.JobRunner.start）的 job 顶层没有 trigger 字段 —— 触发方式住
// 在 job.spec.trigger（normalizeSpec 已归一为 "schedule" | "manual"）。结果排程自动
// 触发的 job 在 /api/history 里全被写成 manual，看板「触发」列显示「手动」。
//
// 本文件用假时钟（显式 UTC 毫秒 → 北京 09:00 = UTC 01:00 的 travel 窗口）+ 假引擎
// 驱动 checkScheduler，钉死：
//   - 排程触发的 job 落历史后 trigger === "schedule"；
//   - 手动 POST /api/run 的行仍为 "manual"；
//   - 历史行只出 "schedule" | "manual" 两种拼写（脏值一律按 manual）；
//   - 旧式外壳「顶层 job.trigger、无 spec」的 job 继续兼容读取。
// 关键：默认假引擎的 job 形状对齐真实 runner —— trigger 只在 job.spec.trigger，
// 故意不带顶层 trigger；若假引擎也把 trigger 挂顶层，旧代码 `job.trigger ?? "manual"`
// 同样能蒙混过关，就失去回归意义了。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { startDaemon } from "../daemon.mjs"
import { cleanupAllSandboxes, cleanupSandbox, makeSandbox } from "../tests/helpers.mjs"

// fakeEngine(opts) —— 假 runner 的 job 形状按 opts 变体：
//   默认          ：trigger 只住 spec.trigger（= 真实 engine/runner 的形状，回归主体）
//   dirtyTrigger  : spec.trigger = "weekly"（非法拼写）→ 历史必须按 manual 兜底
//   legacyTrigger : 无 spec、只有顶层 trigger（旧式外壳/假引擎的形状）→ 兼容读取
function fakeEngine(opts = {}) {
  const jobs = new Map()
  let seq = 0
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
          const id = `job-${++seq}`
          const specTrigger = opts.dirtyTrigger ? "weekly" : spec.trigger === "schedule" ? "schedule" : "manual"
          const base = {
            id,
            state: "running",
            startedAt: new Date().toISOString(),
            endedAt: 0,
            totals: { credit: 20, energy: 5, tasksLit: 2, tasksClaimed: 1 },
            steps: [
              { uid: "u1", nickname: "阿猫", leg: "travel", state: "ok", detail: "猫猫旅行完成", credit: 20, energy: 5, at: new Date().toISOString() },
            ],
            log: ["[runner] 假任务开始"],
            stopped: false,
            error: null,
          }
          const job = opts.legacyTrigger
            ? { ...base, trigger: "schedule" } // 旧式形状：无 spec，只有顶层 trigger
            : {
                ...base,
                spec: {
                  uids: spec.uids ?? null,
                  legs: spec.legs ?? [],
                  claim: spec.claim !== false,
                  trigger: specTrigger,
                  taskCodes: spec.taskCodes ?? null,
                },
              }
          jobs.set(id, job)
          current = job
          // 50ms 后自然完成（模拟 fire-and-poll 的对端）
          const t = setTimeout(() => {
            job.state = "done"
            job.endedAt = new Date().toISOString()
            if (current?.id === id) current = null
          }, 50)
          t.unref?.()
          return job
        }
        get(id) {
          return jobs.get(id) ?? null
        }
        current() {
          return current && current.state === "running" ? current : null
        }
        holds() {
          return []
        }
      },
    },
    // tasks 留空：finalizeJob → refreshSnapshots 里 typeof fetchTasks !== "function" 直接早退
    tasks: null,
    upstream: null,
    errors: [],
    ok: true,
  }
  return eng
}

// daemon 只认 stateDir 里的 settings.json：先写盘再启动（与真实用户路径一致）。
// 排程窗口只留 travel:[9]，配合假时钟的 UTC 01:00（= 北京 09:00）确定性命中。
async function bootWith(stateDir, engine) {
  writeFileSync(
    join(stateDir, "settings.json"),
    JSON.stringify({ scheduler: true, hours: { travel: [9], night: [1] } }),
    "utf8",
  )
  return startDaemon({
    key: "hist-trigger-key-0123456789abcdef",
    port: 0,
    stateDir,
    engine,
    noTimers: true,
    skipExistingCheck: true,
  })
}

const get = (port, path) => fetch(`http://127.0.0.1:${port}${path}`)
const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms))
async function waitIdle(h) {
  for (let i = 0; i < 100 && h.runner.current(); i++) await tick()
}
async function historyRows(port) {
  return (await (await get(port, "/api/history?limit=50")).json()).rows
}

describe("历史 trigger 口径（排程行曾是 manual 的生产缺陷回归）", () => {
  after(() => {
    cleanupAllSandboxes()
  })

  test("排程触发的 job 落历史 trigger === \"schedule\"", async () => {
    const stateDir = makeSandbox("wb-hist-trig-").dir
    const h = await bootWith(stateDir, fakeEngine())
    try {
      // 假时钟：北京 09:00 = UTC 01:00，命中 travel 窗口
      const job = h.ticks.checkScheduler(Date.UTC(2026, 8, 15, 1, 0))
      assert.ok(job, "窗口到点应触发 job")
      assert.equal(job.spec.trigger, "schedule", "真实形状：触发方式只在 job.spec.trigger")
      assert.equal(job.trigger, undefined, "真实 runner 的 job 顶层没有 trigger —— 旧代码读到的永远是 undefined")
      await waitIdle(h)
      h.ticks.watchJob() // job 收尾 → finalizeJob → appendHistory
      const rows = (await historyRows(h.port)).filter((r) => r.jobId === job.id)
      assert.ok(rows.length >= 1, "该 job 的历史行应已落盘")
      assert.ok(
        rows.every((r) => r.trigger === "schedule"),
        `排程行的 trigger 必须是 schedule，实际：${JSON.stringify(rows.map((r) => r.trigger))}`,
      )
    } finally {
      await h.stop()
      cleanupSandbox(stateDir)
    }
  })

  test("手动 POST /api/run 的行仍为 \"manual\"；历史只出 schedule|manual 两种拼写", async () => {
    const stateDir = makeSandbox("wb-hist-trig-").dir
    const h = await bootWith(stateDir, fakeEngine())
    try {
      const run = await post(h.port, "/api/run", { legs: ["travel"] })
      assert.equal(run.status, 200)
      const job = (await run.json()).job
      await waitIdle(h)
      h.ticks.watchJob()
      const rows = (await historyRows(h.port)).filter((r) => r.jobId === job.id)
      assert.ok(rows.length >= 1, "手动 job 的历史行应已落盘")
      assert.ok(rows.every((r) => r.trigger === "manual"), "手动运行的行必须是 manual")
      const all = await historyRows(h.port)
      for (const r of all) {
        assert.ok(
          r.trigger === "schedule" || r.trigger === "manual",
          `历史行只允许 schedule|manual 两种拼写，实际 ${JSON.stringify(r.trigger)}`,
        )
      }
    } finally {
      await h.stop()
      cleanupSandbox(stateDir)
    }
  })

  test("脏值兜底与旧形状兼容：spec.trigger 非法 → manual；无 spec 只有顶层 trigger → 兼容读取", async () => {
    // 非法拼写（dirtyTrigger）：spec.trigger = "weekly" → 绝不透传，按 manual
    const dirtyDir = makeSandbox("wb-hist-trig-").dir
    const h1 = await bootWith(dirtyDir, fakeEngine({ dirtyTrigger: true }))
    try {
      const run = await post(h1.port, "/api/run", { legs: ["travel"] })
      const job = (await run.json()).job
      await waitIdle(h1)
      h1.ticks.watchJob()
      const rows = (await historyRows(h1.port)).filter((r) => r.jobId === job.id)
      assert.ok(rows.length >= 1)
      assert.ok(rows.every((r) => r.trigger === "manual"), `非法拼写按 manual，实际：${JSON.stringify(rows.map((r) => r.trigger))}`)
    } finally {
      await h1.stop()
      cleanupSandbox(dirtyDir)
    }

    // 旧式形状（legacyTrigger）：无 spec、顶层 trigger="schedule" → 兼容读出 schedule
    const legacyDir = makeSandbox("wb-hist-trig-").dir
    const h2 = await bootWith(legacyDir, fakeEngine({ legacyTrigger: true }))
    try {
      const job = h2.ticks.checkScheduler(Date.UTC(2026, 8, 15, 1, 0))
      assert.ok(job, "窗口到点应触发 job")
      await waitIdle(h2)
      h2.ticks.watchJob()
      const rows = (await historyRows(h2.port)).filter((r) => r.jobId === job.id)
      assert.ok(rows.length >= 1)
      assert.ok(rows.every((r) => r.trigger === "schedule"), "旧式外壳的顶层 trigger 继续兼容")
    } finally {
      await h2.stop()
      cleanupSandbox(legacyDir)
    }
  })
})
