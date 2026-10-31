// tests-shell/cache-headers.test.mjs —— HTTP 缓存头口径（node --test；零真实网络）。
//
// 回归：守护进程曾对静态文件与 API 响应不发任何缓存头，浏览器拿缓存里的旧 app.js
// 冒充新版（界面显示早已废弃的地址），用户以为「改了没生效」。现在口径（daemon.mjs
// json()/serveStatic 的注释是单一真相）：
//   1. 静态文件与全部 API 响应一律 Cache-Control: no-store（局域网自建看板、文件小、
//      迭代频繁，「重载即最新版」是默认行为；no-store 而非 no-cache——连磁盘副本都不留）
//   2. 刻意不发 ETag / Last-Modified：no-store 之下没有副本可再验证，条件请求纯属
//      增加新的失效模式（本文件把「没有这两类头」也锁进断言）
//   3. 唯一例外 SSE（/api/events）：必须保持 no-cache（no-store 的长连接在部分代理下
//      会断流），且 Content-Type 仍是 text/event-stream
// 断言全部走 fetch Headers API（键名大小写不敏感），另对原始报文做一次小写复核。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { join } from "node:path"
import { startDaemon } from "../daemon.mjs"
import { cleanupAllSandboxes, makeSandbox } from "../tests/helpers.mjs"

const KEY = "cache-headers-test-key-0123"

// 兜底：boot() 内部创建的沙箱（每条用例独占，并发隔离是刻意的 —— 状态文件以
// stateDir 为边界）在文件收尾统一回收；见 helpers.mjs 三道卫生线。
after(() => {
  cleanupAllSandboxes()
})

function fakeEngine() {
  return {
    store: { loadAccounts: () => [], eligibleAccounts: () => [] },
    runner: null,
    tasks: null,
    upstream: null,
    errors: [],
    ok: false,
  }
}

async function boot() {
  return startDaemon({
    key: KEY,
    port: 0,
    stateDir: makeSandbox("wb-cache-").dir,
    engine: fakeEngine(),
    noTimers: true,
    skipExistingCheck: true,
  })
}

// 大小写不敏感取响应头：先用 Headers API（本身不区分大小写），再对原始小写值断言
const headerOf = (res, name) => res.headers.get(name) // Headers.get 键名大小写不敏感

describe("HTTP 缓存头口径：静态与 API 一律 no-store，SSE 例外 no-cache", () => {
  test("静态文件 GET / /app.js /style.css：cache-control: no-store 且 Content-Type 不被改坏", async () => {
    const h = await boot()
    try {
      const home = await fetch(`http://127.0.0.1:${h.port}/`)
      assert.equal(home.status, 200)
      assert.equal((headerOf(home, "cache-control") ?? "").toLowerCase(), "no-store", "GET / 必须 no-store")
      assert.match(headerOf(home, "content-type") ?? "", /text\/html/)

      const appjs = await fetch(`http://127.0.0.1:${h.port}/app.js`)
      assert.equal(appjs.status, 200)
      assert.equal((headerOf(appjs, "cache-control") ?? "").toLowerCase(), "no-store", "GET /app.js 必须 no-store")
      assert.match(headerOf(appjs, "content-type") ?? "", /text\/javascript/)
      assert.equal(headerOf(appjs, "etag"), null, "刻意不发 ETag（no-store 下条件请求纯属新失效模式）")
      assert.equal(headerOf(appjs, "last-modified"), null, "刻意不发 Last-Modified")

      const css = await fetch(`http://127.0.0.1:${h.port}/style.css`)
      assert.equal(css.status, 200)
      assert.equal((headerOf(css, "cache-control") ?? "").toLowerCase(), "no-store", "GET /style.css 必须 no-store")
      assert.match(headerOf(css, "content-type") ?? "", /text\/css/)
    } finally {
      await h.stop()
    }
  })

  test("GET /api/state、/api/history：cache-control: no-store 且 Content-Type 仍是 application/json", async () => {
    const h = await boot()
    try {
      for (const path of ["/api/state", "/api/history"]) {
        const res = await fetch(`http://127.0.0.1:${h.port}${path}`)
        assert.equal(res.status, 200)
        const cc = (headerOf(res, "cache-control") ?? "").toLowerCase()
        assert.equal(cc, "no-store", `${path} 必须 no-store（实际：${cc || "无"}）`)
        assert.match(headerOf(res, "content-type") ?? "", /application\/json/)
      }
    } finally {
      await h.stop()
    }
  })

  test("原始报文复核：小写 cache-control: no-store 真的在响应头里（不依赖 Headers 归一化）", async () => {
    const h = await boot()
    try {
      const head = await new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: h.port, path: "/app.js", method: "GET" }, (res) => {
          res.resume()
          res.on("end", () => {
            // rawHeaders 是 [name, value, name, value...] 扁平数组，先还原成 "name: value" 行
            const lines = []
            for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`)
            resolve(lines.join("\r\n"))
          })
        })
        req.on("error", reject)
        req.end()
      })
      const lower = head.toLowerCase()
      assert.ok(lower.includes("cache-control: no-store"), `原始头里应有小写 cache-control: no-store，实际：\n${head}`)
    } finally {
      await h.stop()
    }
  })

  test("SSE /api/events 例外：text/event-stream + Cache-Control: no-cache（绝不是 no-store）", async () => {
    const h = await boot()
    const ctrl = new AbortController()
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}/api/events`, { signal: ctrl.signal })
      assert.equal(res.status, 200)
      assert.match(headerOf(res, "content-type") ?? "", /text\/event-stream/, "SSE 的 Content-Type 不被缓存改动波及")
      const cc = (headerOf(res, "cache-control") ?? "").toLowerCase()
      assert.equal(cc, "no-cache", `SSE 必须 no-cache（no-store 的长连接在部分代理下会断流），实际：${cc || "无"}`)
      assert.ok(!cc.includes("no-store"), "SSE 不得被统一 no-store 波及")
      res.body?.cancel?.().catch(() => {})
    } finally {
      ctrl.abort()
      await h.stop()
    }
  })
})
