// tests-shell/settings-safety.test.mjs —— C1：scheduler 安全默认回归。
//
// DEFAULT_SETTINGS.scheduler 必须是 false：装好插件（settings.json 缺失/损坏）
// 不会自动往上游打请求；只有 POST /api/settings 显式开启才生效；排程 tick 在
// 关闭时绝不动作（不启动 job、不写 lastFired.json）。node --test，fake engine。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startDaemon } from "../daemon.mjs"
import { cleanupAllSandboxes, cleanupSandbox, makeSandbox } from "../tests/helpers.mjs"

const KEY = "settings-safety-test-key-0123456789"

// 兜底：个别用例漏删时在文件收尾统一回收（每条用例独占沙箱是刻意的并发隔离：
// settings.json/lastFired.json 都以 stateDir 为边界）；见 helpers.mjs 三道卫生线。
after(() => {
  cleanupAllSandboxes()
})

// fake engine：runner 可启动/查询（契约 §2 最小形状），账号 u1 可参与
function fakeEngine() {
  let seq = 0
  let current = null
  const jobs = new Map()
  const eng = {
    store: {
      loadAccounts: () => [
        {
          key: "workbuddy",
          provider: "workbuddy",
          uid: "u1",
          nickname: "阿猫",
          access: "SUPERSECRET-ACCESS-TOKEN-abc123",
          refresh: "SUPERSECRET-REFRESH-TOKEN-xyz789",
          expires: Date.now() + 86400000,
          domain: "workbuddy.cn",
          isApiKey: false,
          enterpriseId: "",
        },
      ],
      eligibleAccounts: (accounts) =>
        accounts.filter((a) => a.provider === "workbuddy" && !a.isApiKey && !a.enterpriseId && a.tasksEnabled !== false),
    },
    runner: {
      JobRunner: class JobRunner {
        start(spec) {
          if (current) throw Object.assign(new Error("runner busy"), { code: 409 })
          const job = {
            id: `job-${++seq}`,
            state: "running",
            startedAt: new Date().toISOString(),
            endedAt: null,
            trigger: spec.trigger ?? "manual",
            legs: spec.legs ?? [],
            totals: { credit: 0, energy: 0, tasksLit: 0, tasksClaimed: 0 },
            steps: [],
            log: [],
          }
          const t = setTimeout(() => {
            job.state = "done"
            job.endedAt = new Date().toISOString()
            if (current?.id === job.id) current = null
          }, 200)
          t.unref?.()
          jobs.set(job.id, job)
          current = job
          return job
        }
        get(id) {
          return jobs.get(id) ?? null
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
  }
  return eng
}

async function boot(stateDir, extra = {}) {
  return startDaemon({
    key: KEY,
    port: 0,
    stateDir,
    engine: fakeEngine(),
    noTimers: true,
    skipExistingCheck: true,
    ...extra,
  })
}

const get = (port, path) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${KEY}` } })
const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))
const waitQuiet = async (h) => {
  for (let i = 0; i < 100 && h.runner.current(); i++) await tick()
}

describe("C1：scheduler 安全默认", () => {
  test("settings.json 缺失 → /api/state scheduler.enabled=false，落盘默认值也是 false", async () => {
    const stateDir = makeSandbox("wb-safe-").dir
    assert.equal(existsSync(join(stateDir, "settings.json")), false, "boot 前不该有 settings.json")
    const h = await boot(stateDir)
    try {
      const s = await (await get(h.port, "/api/state")).json()
      assert.equal(s.scheduler.enabled, false, "缺省必须停用排程")
      assert.ok(existsSync(join(stateDir, "settings.json")), "boot 后写出默认 settings.json")
      const onDisk = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8"))
      assert.equal(onDisk.scheduler, false, "落盘默认 scheduler=false")
      assert.equal(onDisk.claim, true)
    } finally {
      await h.stop()
      cleanupSandbox(stateDir) // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("settings.json 损坏 → 回落安全（scheduler=false），/api/settings 仍可显式开启并持久化", async () => {
    const stateDir = makeSandbox("wb-safe-").dir
    writeFileSync(join(stateDir, "settings.json"), "{ this is not json !!!", "utf8")
    const h = await boot(stateDir)
    try {
      const s = await (await get(h.port, "/api/state")).json()
      assert.equal(s.scheduler.enabled, false, "损坏文件必须回落停用")

      const st = await post(h.port, "/api/settings", { scheduler: true })
      assert.equal(st.status, 200)
      assert.equal((await st.json()).scheduler, true)
      const s2 = await (await get(h.port, "/api/state")).json()
      assert.equal(s2.scheduler.enabled, true, "显式开启后 /api/state 生效")
      assert.equal(JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8")).scheduler, true, "持久化")
    } finally {
      await h.stop()
      cleanupSandbox(stateDir) // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("settings.json 里 truthy 垃圾（scheduler:\"yes\"）也开不了排程", async () => {
    const stateDir = makeSandbox("wb-safe-").dir
    writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ scheduler: "yes", claim: 1 }), "utf8")
    const h = await boot(stateDir)
    try {
      const s = await (await get(h.port, "/api/state")).json()
      assert.equal(s.scheduler.enabled, false, "非布尔 truthy 必须被钉成 false")
    } finally {
      await h.stop()
      cleanupSandbox(stateDir) // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("排程关闭时 tick 绝不动作：窗口命中也不启动 job、不写 lastFired.json", async () => {
    const stateDir = makeSandbox("wb-safe-").dir
    const h = await boot(stateDir)
    try {
      // 把 travel 窗口钉在当前**北京小时**（UTC+8：引擎把窗口小时按北京时间解释，
      // CONTRACT §7/§8），用同一时刻 t0 喂 tick，保证「窗口命中」必然成立且不依赖宿主时区
      const t0 = Date.now()
      const nowHour = new Date(t0 + 8 * 3600 * 1000).getUTCHours()
      const st = await post(h.port, "/api/settings", { scheduler: false, hours: { travel: [nowHour] } })
      assert.equal(st.status, 200)

      const job = h.ticks.checkScheduler(t0)
      assert.equal(job, null, "scheduler=false 时 tick 必须返回 null")
      assert.equal(h.runner.current(), null, "绝不启动 job")
      assert.equal(existsSync(join(stateDir, "lastFired.json")), false, "绝不写触发记录")
    } finally {
      await h.stop()
      cleanupSandbox(stateDir) // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("显式开启后：窗口命中触发一次（trigger=schedule），同窗口去重不二发", async () => {
    const stateDir = makeSandbox("wb-safe-").dir
    const h = await boot(stateDir)
    try {
      // 窗口钉在当前**北京小时**（UTC+8），tick 与取小时用同一时刻 t0，不依赖宿主时区
      const t0 = Date.now()
      const nowHour = new Date(t0 + 8 * 3600 * 1000).getUTCHours()
      await post(h.port, "/api/settings", { scheduler: true, hours: { travel: [nowHour] } })

      const job = h.ticks.checkScheduler(t0)
      assert.ok(job, "开启 + 窗口命中要触发")
      assert.equal(job.trigger, "schedule")
      assert.ok(job.id)

      await waitQuiet(h)
      assert.equal(h.ticks.checkScheduler(t0 + 1000), null, "同一天同窗口不重复")

      const fired = JSON.parse(readFileSync(join(stateDir, "lastFired.json"), "utf8"))
      assert.ok(fired.lastCycle, "触发记录落盘（含 lastCycle）")
    } finally {
      await h.stop()
      cleanupSandbox(stateDir) // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })
})
