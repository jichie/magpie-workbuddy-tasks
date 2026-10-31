// tests-shell/run-codes.test.mjs —— POST /api/run 的任务级勾选（CONTRACT §3）外壳回归。
//
// body.codes 的两种形状都要被 daemon.startJob 归一成 runner 的 taskCodes
//（{uid: string[]} | null）再启动 job：
//   - 数组 → 对 job 内每个选中账号都只做这些 code；
//   - 对象 → 按 uid；未出现的 uid / 空数组 = 该账号全部任务；不在选中名单的
//     uid 丢弃；
//   - 不传 / 空清单 / 非法类型 → null（全部任务，兼容现状；非法输入绝不 500）；
//   - 每个 uid 的清单去重、只留非空字符串、上限 500。
// 归一结果通过 fake runner 捕获的 start(spec) 断言（零真实网络）。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { startDaemon } from "../daemon.mjs"
import { cleanupAllSandboxes, cleanupSandbox, makeSandbox } from "../tests/helpers.mjs"

// fake engine：runner 记录每次 start(spec) 的完整 spec（daemon 只经它传参）
function fakeEngine() {
  const specs = []
  let current = null
  const eng = {
    store: {
      loadAccounts: () => [
        { key: "workbuddy", provider: "workbuddy", uid: "u1", nickname: "阿猫", access: "a", refresh: "r", expires: Date.now() + 86400000, domain: "", isApiKey: false, enterpriseId: "" },
        { key: "workbuddy#b", provider: "workbuddy", uid: "u2", nickname: "阿狗", access: "a", refresh: "r", expires: Date.now() + 86400000, domain: "", isApiKey: false, enterpriseId: "" },
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
        get(id) {
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

async function boot() {
  const stateDir = makeSandbox("wb-codes-").dir
  const engine = fakeEngine()
  const h = await startDaemon({
    key: "run-codes-key-0123456789abcdef",
    port: 0,
    stateDir,
    engine,
    noTimers: true,
    skipExistingCheck: true,
  })
  return { h, engine, stateDir }
}

const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms))

describe("POST /api/run 的 codes 归一（CONTRACT §3）", () => {
  const sb = {}
  let engine

  after(async () => {
    if (sb.h) await sb.h.stop().catch(() => {})
    if (sb.dir) cleanupSandbox(sb.dir)
    cleanupAllSandboxes()
  })

  test("数组形状 → 对 job 内每个选中账号生效；去重/剔非字符串/非空保留", async () => {
    Object.assign(sb, await boot())
    engine = sb.engine
    const r = await post(sb.h.port, "/api/run", { codes: ["a", "a", " b ", "", 7, null, false] })
    assert.equal(r.status, 200)
    await tick()
    const spec = engine.__specs.at(-1)
    assert.deepEqual(spec.taskCodes, { u1: ["a", "b"], u2: ["a", "b"] }, "数组形状平铺到两个选中账号")
  })

  test("对象形状 → 按 uid；未点名的账号 = 全部任务；不在选中名单的 uid 丢弃", async () => {
    const r = await post(sb.h.port, "/api/run", { uids: ["u1"], codes: { u1: ["a"], u2: ["b"], u9: ["c"] } })
    assert.equal(r.status, 200)
    await tick()
    const spec = engine.__specs.at(-1)
    assert.deepEqual(spec.taskCodes, { u1: ["a"] }, "只保留选中名单内的 uid 条目")

    // 未点名 = 该账号全部任务（整份映射为 null）
    const r2 = await post(sb.h.port, "/api/run", { uids: ["u1"], codes: { u9: ["c"] } })
    assert.equal(r2.status, 200)
    await tick()
    assert.equal(engine.__specs.at(-1).taskCodes, null)

    // 空数组 = 全部任务
    const r3 = await post(sb.h.port, "/api/run", { uids: ["u1"], codes: { u1: [] } })
    assert.equal(r3.status, 200)
    await tick()
    assert.equal(engine.__specs.at(-1).taskCodes, null)
  })

  test("不传 / 空 / 非法类型 → null（旧行为；非法输入绝不 500）", async () => {
    for (const codes of [undefined, [], {}, "a b c", 42, true, { u1: "a" }, { u1: 123 }, [123, null, ""]]) {
      const r = await post(sb.h.port, "/api/run", { uids: ["u1"], codes })
      assert.equal(r.status, 200, `codes=${JSON.stringify(codes)} 不该报错`)
      await tick()
      assert.equal(engine.__specs.at(-1).taskCodes, null, `codes=${JSON.stringify(codes)} 应归一成 null`)
    }
    // 不带 codes 的调用（含排程触发的同一条 startJob 路径）照旧
    const r = await post(sb.h.port, "/api/run", { uids: ["u1"] })
    assert.equal(r.status, 200)
    await tick()
    assert.equal(engine.__specs.at(-1).taskCodes, null)
  })

  test("每个账号清单上限 500（超出的丢弃）", async () => {
    const big = Array.from({ length: 600 }, (_, i) => `code_${i}`)
    const r = await post(sb.h.port, "/api/run", { uids: ["u1"], codes: big })
    assert.equal(r.status, 200)
    await tick()
    const spec = engine.__specs.at(-1)
    assert.equal(spec.taskCodes.u1.length, 500)
    assert.deepEqual(spec.taskCodes.u1[0], "code_0")
    assert.deepEqual(spec.taskCodes.u1[499], "code_499")
  })

  test("codes 与 legs/uids/claim 组合正常，job 响应形状不变", async () => {
    const r = await post(sb.h.port, "/api/run", { uids: ["u1"], legs: ["growth"], claim: false, codes: ["a"] })
    assert.equal(r.status, 200)
    const { job } = await r.json()
    assert.ok(job.id)
    await tick()
    const spec = engine.__specs.at(-1)
    assert.deepEqual(spec.legs, ["growth"])
    assert.equal(spec.claim, false)
    assert.deepEqual(spec.taskCodes, { u1: ["a"] })
  })
})
