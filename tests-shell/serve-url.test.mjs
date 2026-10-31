// tests-shell/serve-url.test.mjs —— /api/state 顶层 serveUrl（看板显示/复制的访问地址）。
// node --test；零真实网络（fake engine；Host 头是本机伪造的，安全）。
//
// 回归：看板顶栏曾把监听值 0.0.0.0:4390 当访问地址显示/复制——0.0.0.0 是监听值不是
// 访问值。现在 serveUrl 按取值链给出用户实际可达地址（docs/CONTRACT.md §3）：
//   ① 当前请求 Host 头（外部输入，白名单校验）→ ② MAGPIE_PUBLIC_URL 的 hostname +
//   守护进程端口 → ③ bindHost（仅具体地址）→ ④ 兜底 http://127.0.0.1:<port>/
// 硬规则：serveUrl 绝不含 0.0.0.0 / :: / *，只有 host[:port]，不拼 key/查询串；
// bindHost/port/reachableHint 字段与语义原样保留（向后兼容）。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import net from "node:net"
import { join } from "node:path"
import { computeServeUrl, sanitizeServeHost, startDaemon } from "../daemon.mjs"
import { addrModel } from "../dashboard/app.js"
import { cleanupAllSandboxes, makeSandbox } from "../tests/helpers.mjs"

const KEY = "serve-url-test-key-0123456789"
const BAD = /0\.0\.0\.0|::|\*/ // serveUrl 任何情况下都不得命中的串

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

async function boot(extra = {}) {
  return startDaemon({
    key: KEY,
    port: 0,
    stateDir: makeSandbox("wb-serve-").dir,
    engine: fakeEngine(),
    noTimers: true,
    skipExistingCheck: true,
    ...extra,
  })
}

// 真实 HTTP 请求、伪造 Host 头（本机连 127.0.0.1，Host 想写谁写谁）
const getWithHost = (port, path, hostValue, extraHeaders = {}) =>
  new Promise((resolve, reject) => {
    const headers = { ...(hostValue !== undefined ? { host: hostValue } : {}), ...extraHeaders }
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers, setHost: false }, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
      )
    })
    req.on("error", reject)
    req.end()
  })

// 原始 socket 请求：node 的 http 客户端会拒绝发出畸形头值（空格/尖括号等），
// 但真实攻击者可以直接裸写报文——用 net 连上后手写请求行验证服务端仍守住白名单。
// http10=true 时发不带任何 Host 头的 HTTP/1.0 请求（HTTP/1.1 缺 Host 会被 llhttp 400）。
const rawGetWithHost = (port, hostValue, http10 = false) =>
  new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        http10
          ? "GET /api/state HTTP/1.0\r\n\r\n"
          : `GET /api/state HTTP/1.1\r\nHost: ${hostValue}\r\nConnection: close\r\n\r\n`,
      )
    })
    const chunks = []
    sock.on("data", (c) => chunks.push(c))
    sock.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8")
      const at = text.indexOf("\r\n\r\n")
      resolve({ head: text.slice(0, at), body: text.slice(at + 4) })
    })
    sock.on("error", reject)
  })

const parseState = (r) => {
  assert.equal(r.status, 200)
  return JSON.parse(r.body)
}

// ---- sanitizeServeHost：Host 头白名单校验（单元） -------------------------

describe("serveUrl ①：Host 头白名单校验（sanitizeServeHost）", () => {
  test("合法：IPv4 字面量 / localhost / 单标签 LAN 主机名 / [IPv6 全形]，端口规则成立", () => {
    assert.deepEqual(sanitizeServeHost("192.0.2.10:4390"), { host: "192.0.2.10", port: 4390 })
    assert.deepEqual(sanitizeServeHost("127.0.0.1"), { host: "127.0.0.1", port: null })
    assert.deepEqual(sanitizeServeHost("LocalHost:8080"), { host: "localhost", port: 8080 })
    assert.deepEqual(sanitizeServeHost("my-nas_1"), { host: "my-nas_1", port: null })
    assert.deepEqual(sanitizeServeHost("198.51.100.5:65535"), { host: "198.51.100.5", port: 65535 })
    assert.deepEqual(sanitizeServeHost("[2001:db8:0:0:0:0:0:1]:4390"), {
      host: "2001:db8:0:0:0:0:0:1",
      port: 4390,
    })
  })

  test("非法形状一律 null：空格/尖括号/斜杠/@/超长/端口越界/多标签域名/通配监听值", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "   ",
      42,
      "192.0.2.5 :4390", // 内嵌空格
      "192.0.2.5: 4390",
      "<script>alert(1)</script>:1",
      "1.2.3.4/..",
      "localhost/../",
      "user@1.2.3.4",
      "1.2.3.4:0",
      "1.2.3.4:081",
      "1.2.3.4:65536",
      "1.2.3.4:99999",
      "1.2.3.4:",
      "[::]",
      "[::1]:4390",
      "0.0.0.0",
      "0.0.0.0:4390",
      "::",
      "*.lan",
      "evil.com:1",
      "foo.bar.local",
      "a".repeat(254),
      `a${".b".repeat(130)}:4390`,
    ]) {
      assert.equal(sanitizeServeHost(bad), null, `Host ${JSON.stringify(String(bad))} 必须被拒`)
    }
  })
})

// ---- computeServeUrl：取值链（单元） --------------------------------------

describe("serveUrl 取值链（computeServeUrl 纯函数）", () => {
  test("① Host 头最优先：显式端口进 URL；无显式端口 = 走 80/默认映射，URL 不带端口", () => {
    assert.equal(
      computeServeUrl({ hostHeader: "192.0.2.10:4390", bindHost: "0.0.0.0", port: 5000 }),
      "http://192.0.2.10:4390/",
    )
    assert.equal(
      computeServeUrl({ hostHeader: "192.0.2.10", bindHost: "0.0.0.0", port: 5000 }),
      "http://192.0.2.10/",
    )
  })

  test("② Host 无/不合规时用 MAGPIE_PUBLIC_URL 的 hostname + 守护进程自己的端口", () => {
    assert.equal(
      computeServeUrl({ hostHeader: undefined, publicUrl: "http://192.0.2.20:3425", port: 4391 }),
      "http://192.0.2.20:4391/",
    )
    assert.equal(
      computeServeUrl({ hostHeader: "evil.com:1", publicUrl: "http://192.0.2.20:3425", port: 4391 }),
      "http://192.0.2.20:4391/",
      "畸形 Host 丢弃后落到 ②",
    )
    // 运维显式声明允许公网域名；MAGPIE_PUBLIC_URL 自身的端口不采用
    assert.equal(
      computeServeUrl({ publicUrl: "https://nas.example.com:3425", port: 4391 }),
      "http://nas.example.com:4391/",
    )
  })

  test("② 拒绝非法/通配 MAGPIE_PUBLIC_URL：非 http(s) URL、解析失败、0.0.0.0/:: hostname", () => {
    for (const bad of ["不是URL", "", "ftp://1.2.3.4", "http://0.0.0.0:3425", "http://[::]:3425/"]) {
      assert.equal(
        computeServeUrl({ publicUrl: bad, bindHost: "0.0.0.0", port: 4391 }),
        "http://127.0.0.1:4391/",
        `MAGPIE_PUBLIC_URL=${JSON.stringify(bad)} 必须落到兜底`,
      )
    }
  })

  test("③ bindHost 仅当具体地址；④ 通配/畸形一律兜底 127.0.0.1:<port>/", () => {
    assert.equal(computeServeUrl({ bindHost: "127.0.0.1", port: 4392 }), "http://127.0.0.1:4392/")
    assert.equal(computeServeUrl({ bindHost: "localhost", port: 4392 }), "http://localhost:4392/")
    assert.equal(computeServeUrl({ bindHost: "my-nas", port: 4392 }), "http://my-nas:4392/")
    for (const wildcard of ["0.0.0.0", "::", "::1", "", undefined, "a".repeat(300)]) {
      assert.equal(
        computeServeUrl({ bindHost: wildcard, port: 4392 }),
        "http://127.0.0.1:4392/",
        `bindHost=${JSON.stringify(String(wildcard))} 必须兜底`,
      )
    }
  })

  test("IPv6 全形字面量输出加方括号；缩写形（含 ::）与通配一律拒绝", () => {
    assert.equal(
      computeServeUrl({ hostHeader: "[2001:db8:0:0:0:0:0:1]:4390", port: 5000 }),
      "http://[2001:db8:0:0:0:0:0:1]:4390/",
    )
    // MAGPIE_PUBLIC_URL 的 IPv6 会被 WHATWG URL 规范化成缩写形（含 ::）→ 按硬规则拒绝落级
    assert.equal(
      computeServeUrl({ publicUrl: "http://[2001:db8:0:0:0:0:0:1]:3425", port: 4391 }),
      "http://127.0.0.1:4391/",
    )
    assert.equal(
      computeServeUrl({ bindHost: "2001:db8:0:0:0:0:0:1", port: 4392 }),
      "http://[2001:db8:0:0:0:0:0:1]:4392/",
    )
    for (const bad of ["[::1]:4390", "[::]", "::1", "1:2:3"]) {
      assert.equal(sanitizeServeHost(bad), null, `IPv6 缩写形/畸形 ${bad} 必须被拒`)
      assert.equal(BAD.test(computeServeUrl({ hostHeader: bad, port: 4390 })), false)
    }
  })

  test("端口异常输入按默认端口兜底；全链路产物绝不含 0.0.0.0/::/*", () => {
    assert.equal(computeServeUrl({ port: 0, bindHost: "0.0.0.0" }), "http://127.0.0.1:4390/")
    assert.equal(computeServeUrl({ port: Number.NaN, bindHost: "0.0.0.0" }), "http://127.0.0.1:4390/")
    const inputs = [
      { hostHeader: "192.0.2.10:4390", port: 5000 },
      { hostHeader: "0.0.0.0:4390", publicUrl: "http://192.0.2.20:3425", bindHost: "0.0.0.0", port: 5000 },
      { publicUrl: "http://nas.example.com", bindHost: "0.0.0.0", port: 5000 },
      { bindHost: "127.0.0.1", port: 5000 },
      { bindHost: "0.0.0.0", port: 5000 },
      { hostHeader: "[::1]:1", bindHost: "0.0.0.0", port: 5000 },
      { hostHeader: "localhost/../", bindHost: "0.0.0.0", port: 5000 },
    ]
    for (const i of inputs) assert.equal(BAD.test(computeServeUrl(i)), false, JSON.stringify(i))
  })
})

// ---- 集成：真实守护进程 /api/state ---------------------------------------

describe("serveUrl 集成：/api/state 的取值链与向后兼容", () => {
  const env = { MAGPIE_PUBLIC_URL: undefined }

  test("带 Host: 192.0.2.10:4390 → serveUrl 原样采用（用户实际访问地址）", async () => {
    const h = await boot()
    try {
      const s = parseState(await getWithHost(h.port, "/api/state", "192.0.2.10:4390"))
      assert.equal(s.serveUrl, "http://192.0.2.10:4390/")
      assert.equal(BAD.test(s.serveUrl), false)
    } finally {
      await h.stop()
    }
  })

  test("无 Host 头 + MAGPIE_PUBLIC_URL → 该 hostname + 守护进程端口；Host 在场时优先级更高", async () => {
    const prev = process.env.MAGPIE_PUBLIC_URL
    process.env.MAGPIE_PUBLIC_URL = "http://192.0.2.20:3425"
    const h = await boot()
    try {
      const s1 = parseState(
        await rawGetWithHost(h.port, "", true).then((r) => ({ status: 200, body: r.body })),
      )
      assert.equal(s1.serveUrl, `http://192.0.2.20:${h.port}/`, "② 用 MAGPIE_PUBLIC_URL 的 hostname + 本进程端口")
      const s2 = parseState(await getWithHost(h.port, "/api/state", "198.51.100.5:4390"))
      assert.equal(s2.serveUrl, "http://198.51.100.5:4390/", "① 合法 Host 头仍然最优先")
      assert.equal(BAD.test(s1.serveUrl + s2.serveUrl), false)
    } finally {
      if (prev === undefined) delete process.env.MAGPIE_PUBLIC_URL
      else process.env.MAGPIE_PUBLIC_URL = prev
      await h.stop()
    }
  })

  test("畸形/恶意 Host（裸报文可发的那种）不进入 serveUrl，落到下一级兜底", async () => {
    const h = await boot()
    try {
      const fallback = `http://127.0.0.1:${h.port}/`
      for (const host of ["0.0.0.0:4390", "evil.com:1", "<script>alert(1)</script>:4390", "192.0.2.5 :4390", "localhost/../", `${"a".repeat(300)}:4390`]) {
        const s = parseState(await rawGetWithHost(h.port, host).then((r) => ({ status: 200, body: r.body })))
        assert.equal(s.serveUrl, fallback, `Host ${JSON.stringify(host)} 必须被拒并兜底`)
        assert.equal(BAD.test(s.serveUrl), false)
      }
    } finally {
      await h.stop()
    }
  })

  test("向后兼容：bindHost/port/reachableHint 字段与语义原样保留；key 绝不出现在响应里", async () => {
    const h = await boot()
    try {
      const s = parseState(await getWithHost(h.port, "/api/state", "127.0.0.1"))
      assert.equal(s.bindHost, "127.0.0.1")
      assert.equal(s.port, h.port)
      assert.equal(s.reachableHint, "", "回环绑定的 reachableHint 必须仍是空串")
      assert.ok(Array.isArray(s.accounts))
      assert.ok(s.scheduler && s.settings)
      assert.equal(KEY.includes("") && s.serveUrl.includes(KEY), false, "serveUrl 不含 key")
    } finally {
      await h.stop()
    }
  })
})

// ---- 前端 addrModel：serveUrl 显示/复制，老后端回退 -----------------------

describe("前端 addrModel：serveUrl 优先，缺字段回退老逻辑", () => {
  test("serveUrl 合法 → 直接显示/复制这一串；通绑定的安全提示仍随 reachableHint 保留", () => {
    const m = addrModel({ serveUrl: "http://192.0.2.10:4390/", bindHost: "0.0.0.0", port: 4390, reachableHint: "仅容器网桥/局域网可达，请用 SSH 隧道或局域网地址访问，切勿发布到公网" })
    assert.equal(m.mode, "served")
    assert.equal(m.url, "http://192.0.2.10:4390/")
    assert.equal(m.docker, true, "0.0.0.0 监听时保留 docker inspect 提示位")
    assert.ok(m.hint.includes("SSH"))
  })

  test("serveUrl 形状不合规（查询串/凭据/非 http）→ 一律不采用", () => {
    for (const bad of ["http://1.2.3.4:4390/?key=x", "http://u:p@1.2.3.4:4390/", "javascript:alert(1)", "http://1.2.3.4:4390/path", 42, null]) {
      const m = addrModel({ serveUrl: bad, bindHost: "127.0.0.1", port: 4390, reachableHint: "" })
      assert.equal(m.mode === "served", false, `serveUrl=${JSON.stringify(bad)} 不得采用`)
    }
  })

  test("老后端（缺 serveUrl）→ 原 loopback/wildcard/fallback 逻辑，绝不报错", () => {
    const loop = addrModel({ bindHost: "127.0.0.1", port: 4390, reachableHint: "" })
    assert.equal(loop.mode, "loopback")
    assert.equal(loop.url, "http://127.0.0.1:4390/")
    const wild = addrModel({ bindHost: "0.0.0.0", port: 4390, reachableHint: "仅容器网桥/局域网可达" })
    assert.equal(wild.mode, "wildcard")
    assert.ok(wild.url.includes("<本机可达地址>"), "老后端通绑定的占位写法保留")
    const legacy = addrModel({})
    assert.equal(legacy.mode, "fallback")
    assert.ok(legacy.url.startsWith("http"))
  })
})
