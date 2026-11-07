// tests-shell/cn-only.test.mjs —— 纯国内版口径自测（node --test）。
// 用户明确要求「插件内还是有国际版账号」修复后：国际版（workbuddy-ai）账号彻底
// 不出现 —— 不进 /api/state 列表、不进快照/汇总/统计、不进排程与 job、导出默认
// 不含。用含 5 条 workbuddy*（2 cn + 3 intl）的 fixture 证明只剩 2 条，且
// intlSkipped 只给计数与说明、绝不列出 intl 账号内容。
// 口径见 docs/CONTRACT.md §2（层级边界）与 §3（/api/state、导出）。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { startDaemon } from "../daemon.mjs"
import { eligibleAccounts, loadAccounts } from "../engine/store.mjs"
import { nineEntryAuth } from "../tests/accountio-fixture.mjs"
import { cleanupAllSandboxes, makeSandbox } from "../tests/helpers.mjs"

// 兜底：boot() 已在 cleanup() 里即删（finally 调用）；这里再兜一层 —— 个别用例
// 漏删时在文件收尾统一回收（每条用例独占沙箱是刻意的并发隔离）。
after(() => {
  cleanupAllSandboxes()
})

const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime()
const INTL_NOTE = "本插件只服务国内版 workbuddy，国际版账号不列出、不参与任务、不默认导出"
const CN_UIDS = ["cn-uid-a", "cn-uid-b"]
const INTL_UIDS = ["intl-uid-a", "intl-uid-b", "intl-uid-c"]

// runner 替身：只记录 start() 收到的 spec（证明排程/运行的账号名单只含国内版）
function capturingRunnerEngine(started) {
  return {
    JobRunner: class JobRunner {
      constructor(ctx) {
        this.ctx = ctx
      }
      start(spec) {
        started.push(spec)
        return { id: `job-${started.length}`, state: "running", steps: [], log: [], totals: { credit: 0, energy: 0, tasksLit: 0, tasksClaimed: 0 } }
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

// store 用真实现（读临时 cfg 里的 plugin-auth.json），runner 用捕获替身
function realStoreEngine(started = []) {
  return {
    store: { loadAccounts: (cfg) => loadAccounts(cfg), eligibleAccounts },
    runner: capturingRunnerEngine(started),
    tasks: null,
    upstream: null,
    errors: [],
    ok: true,
  }
}

async function boot({ authObj = null } = {}) {
  const cfg = makeSandbox("wb-cn-only-cfg-") // 每条用例独占 temp 沙箱，用完即删（见 helpers.mjs）
  const state = makeSandbox("wb-cn-only-state-")
  if (authObj) writeFileSync(join(cfg.dir, "plugin-auth.json"), JSON.stringify(authObj, null, 2) + "\n")
  const started = []
  const h = await startDaemon({
    port: 0,
    cfgDir: cfg.dir,
    stateDir: state.dir,
    engine: realStoreEngine(started),
    now: () => NOW,
    noTimers: true,
    skipExistingCheck: true,
  })
  return {
    h,
    started,
    cfg: cfg.dir,
    state: state.dir,
    cleanup: () => {
      cfg.cleanup()
      state.cleanup()
    },
  }
}

const base = (port) => `http://127.0.0.1:${port}`
const get = (port, path) => fetch(base(port) + path)
const post = (port, path, body) =>
  fetch(base(port) + path, {
    method: "POST",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

describe("纯国内版口径：国际版账号彻底不出现", () => {
  test("/api/state：5 条 workbuddy* 的 fixture 只剩 2 条 cn；intlSkipped 只给计数+说明", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      const st = await (await get(env.h.port, "/api/state")).json()
      assert.equal(st.accounts.length, 2, "列表只剩国内版 2 条（3 条国际版不出现）")
      assert.deepEqual(
        st.accounts.map((a) => a.uid).sort(),
        CN_UIDS,
      )
      const text = JSON.stringify(st)
      for (const uid of INTL_UIDS) {
        assert.ok(!text.includes(uid), `国际版 uid ${uid} 绝不出现在 /api/state`)
      }
      assert.ok(!text.includes("GlobalA"), "国际版昵称绝不出现")
      assert.ok(!text.includes("workbuddy.ai"), "国际版域名绝不出现")
      // 顶层只读诊断计数：count 正确 + note 逐字
      assert.ok(st.intlSkipped, "/api/state 顶层要有 intlSkipped")
      assert.equal(st.intlSkipped.count, 3)
      assert.equal(st.intlSkipped.note, INTL_NOTE)
      // 国内版行的 eligible 判定不受影响
      assert.ok(st.accounts.every((a) => a.eligible), "2 条国内版 OAuth 都可参与")
    } finally {
      await env.h.stop()
      env.cleanup() // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("导出默认只含 cn；显式 realm=intl 才出国际版（逃生口）；rescan 计数同口径", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      const def = await (await get(env.h.port, "/api/accounts/export")).json()
      assert.deepEqual(def.accounts.map((r) => r.uid).sort(), CN_UIDS, "不带 realm 只出 cn")
      assert.equal(def.count, 2)

      const intl = await (await get(env.h.port, "/api/accounts/export?realm=intl")).json()
      assert.deepEqual(intl.accounts.map((r) => r.uid).sort(), INTL_UIDS, "显式 realm=intl 才出国际版")
      assert.ok(!JSON.stringify(await (await get(env.h.port, "/api/accounts/export")).json()).includes("intl-uid"), "默认导出绝不含国际版 uid")

      const rescan = await (await post(env.h.port, "/api/accounts")).json()
      assert.equal(rescan.count, 2, "rescan count 与列表同口径（只算国内版）")
      assert.equal(rescan.eligible, 2)
      assert.ok(!JSON.stringify(rescan).includes("intl-uid"), "rescan 报告不出现国际版 uid")
    } finally {
      await env.h.stop()
      env.cleanup() // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("运行与排程取数与列表同源：job 账号名单只含国内版（不存在「列表没有、排程却在跑」）", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      // 手动运行：/api/run 的 job 名单只含 cn
      const run = await post(env.h.port, "/api/run", {})
      assert.equal(run.status, 200)
      assert.equal(env.started.length, 1)
      assert.deepEqual([...env.started[0].uids].sort(), CN_UIDS, "job 名单只有国内版 uid")

      // 排程：开排程 + 显式配 travel:[9]（默认 hours 全空 = 默认不排，需求 4）+
      // 拨到北京 09:00（UTC 01:00；引擎把窗口小时按北京时间 UTC+8 解释，
      // CONTRACT §7/§8）→ 触发的 job 同样只含 cn（断言的是 runner.start 收到的
      // spec —— 账号名单）
      const st = await post(env.h.port, "/api/settings", { scheduler: true, hours: { travel: [9] } })
      assert.equal(st.status, 200)
      const at9 = Date.UTC(2026, 9, 31, 1, 0) // 北京 2026-10-31 09:00
      const fired = env.h.ticks.checkScheduler(at9)
      assert.ok(fired, "9 点在显式配置的 travel 窗口内应触发")
      assert.deepEqual([...env.started[1].uids].sort(), CN_UIDS, "排程触发的 job 名单只有国内版 uid")
      assert.equal(env.started.length, 2)
    } finally {
      await env.h.stop()
      env.cleanup() // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("单账号操作同源：intl uid 领奖/接取/开关一律「找不到」（不从侧门进引擎）", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      // 本测试引擎无 tasks 模块：claim/accept 在账号查找之前就 500；toggle 真查列表
      const toggle = await post(env.h.port, "/api/account/toggle", { uid: "intl-uid-a", tasksEnabled: true })
      assert.equal(toggle.status, 404, "intl uid 不在列表里，toggle 404")
      const body = await toggle.json()
      assert.match(body.error, /找不到账号 intl-uid-a/)
      // 引擎就绪等价场景由 account-routes.test.mjs 的 intl toggle 404 与
      // export uid=intl-uid-a 404 共同覆盖（同源：accountByUid 走 loadAccountsCn）
      const text = JSON.stringify([body])
      assert.ok(!text.includes("GlobalA"))
    } finally {
      await env.h.stop()
      env.cleanup() // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })
})
