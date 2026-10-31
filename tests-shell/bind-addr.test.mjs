// tests-shell/bind-addr.test.mjs —— 绑定地址口径（A）与 /api/state 绑定信息（B）、
// WB_DAEMON_ADDR → parseAddr 链路（C3）。node --test；零真实网络（fake engine）。
//
// A 回归：WB_DAEMON_ADDR=0.0.0.0 时宿主日志曾打印「守护进程就绪：127.0.0.1:4390」
// —— 现在 daemon.json 落真实 host，index.mjs / daemon.mjs / reachableHint 三处同口径。
//
// 通配绑定（0.0.0.0/::）的端到端断言在容器里做（本机不给 node 绑通配地址，
// 避免 Windows 防火墙弹窗）；这里覆盖 parseAddr/bindHint 单元 + 127.0.0.1 集成。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { startDaemon, parseAddr } from "../daemon.mjs"
import { WILDCARD_HINT, bindHint, isWildcardHost, readDaemonInfo } from "../lifecycle.mjs"
import { cleanupAllSandboxes, makeSandbox } from "../tests/helpers.mjs"

const KEY = "bind-addr-test-key-0123456789"

// 兜底：boot() 内部创建的沙箱（每条用例独占，并发隔离是刻意的 —— 状态文件以
// stateDir 为边界）在文件收尾统一回收；见 helpers.mjs 三道卫生线。
after(() => {
  cleanupAllSandboxes()
})

function fakeEngine() {
  return {
    store: {
      loadAccounts: () => [],
      eligibleAccounts: () => [],
    },
    runner: null,
    tasks: null,
    upstream: null,
    errors: [],
    ok: false,
  }
}

async function boot(extra = {}) {
  const h = await startDaemon({
    key: KEY,
    port: 0,
    stateDir: makeSandbox("wb-bind-").dir,
    engine: fakeEngine(),
    noTimers: true,
    skipExistingCheck: true,
    ...extra,
  })
  return h
}

const get = (port, path, key) =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {} })

describe("C3：WB_DAEMON_ADDR → parseAddr 链路", () => {
  test("设 WB_DAEMON_ADDR=0.0.0.0 → parseAddr 返回该 host；未设仍 127.0.0.1", () => {
    const prev = process.env.WB_DAEMON_ADDR
    try {
      process.env.WB_DAEMON_ADDR = "0.0.0.0"
      assert.deepEqual(parseAddr(undefined, 4390), { host: "0.0.0.0", port: 4390 })

      delete process.env.WB_DAEMON_ADDR
      assert.deepEqual(parseAddr(undefined, 4390), { host: "127.0.0.1", port: 4390 })
    } finally {
      if (prev === undefined) delete process.env.WB_DAEMON_ADDR
      else process.env.WB_DAEMON_ADDR = prev
    }
  })

  test("--addr 显式 host 覆盖环境；\":port\" 只改端口、host 跟随环境", () => {
    const prev = process.env.WB_DAEMON_ADDR
    try {
      process.env.WB_DAEMON_ADDR = "0.0.0.0"
      assert.deepEqual(parseAddr("127.0.0.1:5000", 4390), { host: "127.0.0.1", port: 5000 })
      assert.deepEqual(parseAddr(":6000", 4390), { host: "0.0.0.0", port: 6000 })
      assert.deepEqual(parseAddr("7000", 4390), { host: "0.0.0.0", port: 7000 })
      assert.deepEqual(parseAddr("0.0.0.0", 4390), { host: "0.0.0.0", port: 4390 })
    } finally {
      if (prev === undefined) delete process.env.WB_DAEMON_ADDR
      else process.env.WB_DAEMON_ADDR = prev
    }
  })
})

describe("A：绑定地址口径（bindHint 三处同源）", () => {
  test("0.0.0.0 与 :: 给出 SSH 隧道提示；127.0.0.1/localhost 为空串", () => {
    assert.equal(isWildcardHost("0.0.0.0"), true)
    assert.equal(isWildcardHost("::"), true)
    assert.equal(isWildcardHost("127.0.0.1"), false)
    assert.equal(isWildcardHost("203.0.113.2"), false)
    assert.equal(isWildcardHost(undefined), false)

    for (const h of ["0.0.0.0", "::"]) {
      const hint = bindHint(h)
      assert.ok(hint.includes("SSH"), `${h} 的提示要指到 SSH 隧道：${hint}`)
      assert.ok(hint.includes("公网"), `${h} 的提示要警示公网：${hint}`)
    }
    assert.equal(bindHint("127.0.0.1"), "")
    assert.equal(bindHint(""), "")
    assert.equal(WILDCARD_HINT.length > 10, true)
  })

  test("startDaemon 启动日志打印真实绑定地址；127.0.0.1 时无通配提示", async () => {
    const lines = []
    const h = await boot({ log: (...a) => lines.push(a.join(" ")) })
    try {
      const ready = lines.find((l) => l.includes("守护进程就绪"))
      assert.ok(ready, "要有一条就绪日志")
      assert.ok(ready.includes(`http://${h.host}:${h.port}`), `就绪日志要用真实绑定地址：${ready}`)
      assert.ok(!lines.some((l) => l.includes("监听") && l.includes(WILDCARD_HINT)), "回环绑定不该出通配提示")
    } finally {
      await h.stop()
    }
  })

  test("daemon.json 落真实 host；旧格式（无 host 字段）读出默认 127.0.0.1", async () => {
    const h = await boot()
    try {
      const raw = JSON.parse(readFileSync(join(h.stateDir, "daemon.json"), "utf8"))
      assert.equal(raw.host, "127.0.0.1")
      assert.equal(readDaemonInfo(h.stateDir).host, "127.0.0.1")
    } finally {
      await h.stop()
    }
  })
})

describe("B：/api/state 顶层绑定信息", () => {
  test("bindHost/port/reachableHint 出现且口径正确；既有字段不受影响", async () => {
    const h = await boot()
    try {
      const s = await (await get(h.port, "/api/state", KEY)).json()
      assert.equal(s.bindHost, h.host)
      assert.equal(s.bindHost, "127.0.0.1")
      assert.equal(s.port, h.port)
      assert.equal(s.reachableHint, "", "回环绑定的 reachableHint 必须是空串")
      // 既有字段语义不变（抽查）
      assert.ok(Array.isArray(s.accounts))
      assert.equal(typeof s.scheduler.enabled, "boolean")
      assert.ok(s.settings)
    } finally {
      await h.stop()
    }
  })
})
