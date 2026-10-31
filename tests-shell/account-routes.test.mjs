// tests-shell/account-routes.test.mjs —— 账号导入/导出路由 + 密钥分级自测（node --test）。
// 独立临时 cfg/state + 假 engine（store 用真实的 engine/store.mjs），零真实网络、
// 零真实凭据。口径见 docs/CONTRACT.md §3（门禁表）与 §9（导入导出）。

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startDaemon, routeNeedsKey, KEY_REQUIRED_MSG } from "../daemon.mjs"
import { eligibleAccounts, loadAccounts } from "../engine/store.mjs"
import { cnRow, makeJwt, nineEntryAuth } from "../tests/accountio-fixture.mjs"

const KEY = "account-routes-test-key-0123456789"
const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime()
const DAY = 86400000
const expSecIn = (days) => Math.floor(NOW / 1000) + days * 86400
const sha256 = (s) => createHash("sha256").update(s).digest("hex")

// engine：store 用真实现（读临时 cfg 里的 plugin-auth.json），其余最小 fake
function realStoreEngine() {
  return {
    store: { loadAccounts: (cfg) => loadAccounts(cfg), eligibleAccounts },
    runner: null,
    tasks: null,
    upstream: null,
    errors: [],
    ok: true,
  }
}

async function boot({ authObj = null, authText = null } = {}) {
  const cfg = mkdtempSync(join(tmpdir(), "wb-acct-routes-cfg-"))
  const state = mkdtempSync(join(tmpdir(), "wb-acct-routes-state-"))
  if (authText !== null) writeFileSync(join(cfg, "plugin-auth.json"), authText)
  else if (authObj) writeFileSync(join(cfg, "plugin-auth.json"), JSON.stringify(authObj, null, 2) + "\n")
  const h = await startDaemon({
    key: KEY,
    port: 0,
    cfgDir: cfg,
    stateDir: state,
    engine: realStoreEngine(),
    now: () => NOW,
    noTimers: true,
    skipExistingCheck: true,
  })
  const authFile = join(cfg, "plugin-auth.json")
  return {
    h,
    cfg,
    state,
    authFile,
    cleanup: () => {
      rmSync(cfg, { recursive: true, force: true })
      rmSync(state, { recursive: true, force: true })
    },
  }
}

const base = (port) => `http://127.0.0.1:${port}`
const get = (port, path, key) =>
  fetch(base(port) + path, { headers: key ? { authorization: `Bearer ${key}` } : {} })
const post = (port, path, body, key) =>
  fetch(base(port) + path, {
    method: "POST",
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

// ---- 门禁表（routeNeedsKey 单元断言）-----------------------------------------

describe("路由→密钥表（单一数据源 API_ROUTE_AUTH / routeNeedsKey）", () => {
  test("免密钥路由", () => {
    assert.equal(routeNeedsKey("GET", "/api/hello"), false)
    assert.equal(routeNeedsKey("GET", "/api/state"), false)
    assert.equal(routeNeedsKey("GET", "/api/history"), false)
    assert.equal(routeNeedsKey("GET", "/api/jobs/abc_123"), false)
    assert.equal(routeNeedsKey("GET", "/api/events"), false)
    assert.equal(routeNeedsKey("POST", "/api/accounts"), false)
    assert.equal(routeNeedsKey("GET", "/api/accounts/export", { secrets: "0" }), false)
    assert.equal(routeNeedsKey("GET", "/api/accounts/export", { secrets: "false" }), false)
    assert.equal(routeNeedsKey("GET", "/api/accounts/export", { secrets: "no" }), false)
    assert.equal(routeNeedsKey("POST", "/api/accounts/import", { confirm: false }), false)
  })

  test("必须密钥路由（写操作与凭据红线）", () => {
    for (const [method, p] of [
      ["POST", "/api/run"],
      ["POST", "/api/stop"],
      ["POST", "/api/task/claim"],
      ["POST", "/api/task/accept"],
      ["POST", "/api/checkin"],
      ["POST", "/api/settings"],
      ["POST", "/api/account/toggle"],
      ["POST", "/api/shutdown"],
    ]) {
      assert.equal(routeNeedsKey(method, p), true, `${method} ${p} 必须密钥`)
    }
    // 红线：secrets 缺省/1 = 含凭据 → 必须密钥
    assert.equal(routeNeedsKey("GET", "/api/accounts/export"), true)
    assert.equal(routeNeedsKey("GET", "/api/accounts/export", { secrets: "1" }), true)
    assert.equal(routeNeedsKey("GET", "/api/accounts/export", { secrets: "whatever" }), true)
    assert.equal(routeNeedsKey("POST", "/api/accounts/import", { confirm: true }), true)
    // 未登记路由默认关死
    assert.equal(routeNeedsKey("GET", "/api/whatever"), true)
    assert.equal(routeNeedsKey("POST", "/api/state"), true, "方法不符也按需密钥")
  })
})

// ---- HTTP 实测：免密钥可用、写操作 401、免密钥拿不到 token ---------------------

describe("密钥分级 HTTP 实测", () => {
  test("免密钥路由无 key 全部可用（用户口径：打开看板不再弹密钥）", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      assert.equal((await get(env.h.port, "/api/hello")).status, 200)
      assert.equal((await get(env.h.port, "/api/state")).status, 200)
      assert.equal((await get(env.h.port, "/api/history")).status, 200)
      // 免密钥但资源不存在 → 404（不是 401）
      assert.equal((await get(env.h.port, "/api/jobs/nope")).status, 404)
      // 重扫本地文件无副作用
      const rescan = await post(env.h.port, "/api/accounts", undefined, null)
      assert.equal(rescan.status, 200)
      const rescanBody = await rescan.json()
      assert.equal(rescanBody.count, 5, "count = workbuddy* 条目（fixture 里 5 个；qoder/qwenwork 系不算）")
      // 脱敏导出免密钥
      assert.equal((await get(env.h.port, "/api/accounts/export?secrets=0")).status, 200)
      // 预览免密钥（合法 blob）
      const preview = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [cnRow({ uid: "fresh-1", expSec: expSecIn(5) })] } }, null)
      assert.equal(preview.status, 200)
      assert.equal((await preview.json()).wrote, false)
    } finally {
      env.cleanup()
      await env.h.stop()
    }
  })

  test("写操作/凭据路由无 key 一律 401，文案指向「解锁写操作」", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      const cases = [
        () => post(env.h.port, "/api/run", {}, null),
        () => post(env.h.port, "/api/stop", undefined, null),
        () => post(env.h.port, "/api/task/claim", { uid: "x", code: "y" }, null),
        () => post(env.h.port, "/api/task/accept", { uid: "x", codes: ["y"] }, null),
        () => post(env.h.port, "/api/checkin", {}, null),
        () => post(env.h.port, "/api/settings", { claim: true }, null),
        () => post(env.h.port, "/api/account/toggle", { uid: "x", tasksEnabled: true }, null),
        () => post(env.h.port, "/api/shutdown", undefined, null),
        () => get(env.h.port, "/api/accounts/export"), // 缺省 = 含凭据
        () => get(env.h.port, "/api/accounts/export?secrets=1"),
        () => post(env.h.port, "/api/accounts/import", { blob: { accounts: [cnRow({ uid: "x", expSec: expSecIn(5) })] }, confirm: true }, null),
        () => post(env.h.port, "/api/accounts/import?confirm=true", { blob: { accounts: [cnRow({ uid: "x", expSec: expSecIn(5) })] } }, null),
      ]
      for (const [i, c] of cases.entries()) {
        const res = await c()
        assert.equal(res.status, 401, `case ${i} 必须 401`)
        const body = await res.json()
        assert.equal(body.error, KEY_REQUIRED_MSG)
        assert.match(body.error, /此操作会改动账号或涉及凭据/)
        assert.match(body.error, /「解锁写操作」/)
        assert.match(body.error, /state\/daemon\.json/)
      }
      // 错 key 同样 401
      assert.equal((await post(env.h.port, "/api/run", {}, "wrong-key")).status, 401)
      assert.equal((await get(env.h.port, "/api/accounts/export?secrets=1", "wrong-key")).status, 401)
    } finally {
      env.cleanup()
      await env.h.stop()
    }
  })

  test("红线实测：免密钥路径拿不到 token（逐个免密钥端点扫一遍）", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      const before = JSON.parse(readFileSync(env.authFile, "utf8"))
      const secrets = Object.values(before)
        .map((e) => [e.access, e.refresh])
        .flat()
        .filter((v) => typeof v === "string" && v.length > 8)

      const freeBodies = []
      freeBodies.push(await (await get(env.h.port, "/api/state")).text())
      freeBodies.push(await (await get(env.h.port, "/api/history")).text())
      freeBodies.push(await (await get(env.h.port, "/api/accounts/export?secrets=0")).text())
      freeBodies.push(await (await post(env.h.port, "/api/accounts", undefined, null)).text())
      freeBodies.push(
        await (
          await post(env.h.port, "/api/accounts/import", {
            blob: { accounts: [cnRow({ uid: "cn-uid-a", expSec: expSecIn(5) })] }, // uid 撞现有 → skip，报告里也不该有 token
          }, null)
        ).text(),
      )
      const all = freeBodies.join("\n")
      for (const s of secrets) {
        assert.ok(!all.includes(s), "免密钥响应里绝不出现 token 值")
      }
      assert.ok(!all.includes("eyJ"), "免密钥响应里不出现 JWT 形状的串")
      // 脱敏导出的每一行都根本没有 token 字段
      const maskedDoc = JSON.parse(freeBodies[2])
      assert.equal(maskedDoc.count, 5)
      for (const row of maskedDoc.accounts) {
        assert.ok(!("accessToken" in row) && !("refreshToken" in row))
      }
      // 预览的 skip 报告也不含 token
      assert.ok(!freeBodies[4].includes("eyJ"))
    } finally {
      env.cleanup()
      await env.h.stop()
    }
  })
})

// ---- 导出路由 -----------------------------------------------------------------

describe("GET /api/accounts/export（hub 语义）", () => {
  test("secrets=1 带密钥：真值导出（文件必须真值，否则回灌无效）", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      const res = await get(env.h.port, "/api/accounts/export?secrets=1", KEY)
      assert.equal(res.status, 200)
      const doc = await res.json()
      assert.equal(doc.format, "workbuddy-accounts")
      assert.equal(doc.version, 1)
      assert.equal(doc.count, 5)
      assert.equal(doc.exportedAt, "2026-10-31 12:00:00")
      const cn = doc.accounts.find((r) => r.uid === "cn-uid-a")
      const raw = JSON.parse(readFileSync(env.authFile, "utf8"))
      assert.equal(cn.accessToken, raw.workbuddy.access, "access 真值")
      assert.equal(cn.refreshToken, raw.workbuddy.refresh, "refresh 真值")
      assert.equal(cn.expiresAt, Math.floor(raw.workbuddy.expires / 1000), "毫秒 → 秒")
      assert.equal(cn.realm, "cn")
      assert.equal(cn.nickname, "阿猫")
    } finally {
      env.cleanup()
      await env.h.stop()
    }
  })

  test("realm 过滤 / uid 过滤（未知 uid 404）/ download 文件名", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      const intl = await (await get(env.h.port, "/api/accounts/export?realm=intl&secrets=0", KEY)).json()
      assert.deepEqual(intl.accounts.map((r) => r.realm), ["intl", "intl", "intl"])

      const one = await get(env.h.port, "/api/accounts/export?uid=cn-uid-a&secrets=0&download=1", KEY)
      assert.equal(one.status, 200)
      assert.match(one.headers.get("content-disposition") ?? "", /^attachment; filename="workbuddy-accounts-cn-uid-a\d{8}-\d{6}\.json"$/)
      assert.equal(one.headers.get("cache-control"), "no-store")

      const multi = await get(env.h.port, "/api/accounts/export?realm=cn&download=1&secrets=0", KEY)
      assert.match(multi.headers.get("content-disposition") ?? "", /filename="workbuddy-accounts-cn-\d{8}-\d{6}\.json"/)

      const missing = await get(env.h.port, "/api/accounts/export?uid=ghost", KEY)
      assert.equal(missing.status, 404)
      assert.match((await missing.json()).error, /^no such account: ghost$/)

      // 坏 realm 值 = 不过滤（hub 口径）
      const all = await (await get(env.h.port, "/api/accounts/export?realm=moon&secrets=0", KEY)).json()
      assert.equal(all.count, 5)
    } finally {
      env.cleanup()
      await env.h.stop()
    }
  })
})

// ---- 导入路由（两段式 + 竞态 + 拒写）------------------------------------------

describe("POST /api/accounts/import（两段式）", () => {
  const freshRow = () => cnRow({ uid: "cn-new-9", nickname: "新号", expSec: expSecIn(9) })

  test("预览不写盘：文件字节不变、目录无新文件", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      const beforeBytes = readFileSync(env.authFile, "utf8")
      const dirBefore = readdirSync(env.cfg).sort()
      const res = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [freshRow()] } }, null)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.wrote, false)
      assert.equal(body.note, "预览未写入任何文件")
      assert.equal(body.preview.totals.adds, 1)
      assert.equal(body.preview.adds[0].uid, "cn-new-9")
      assert.match(body.preview.adds[0].key, /^workbuddy#[0-9a-z]{6}$/)
      assert.equal(readFileSync(env.authFile, "utf8"), beforeBytes, "预览后文件逐字节不变")
      assert.deepEqual(readdirSync(env.cfg).sort(), dirBefore, "预览不产生任何新文件（含备份）")
    } finally {
      env.cleanup()
      await env.h.stop()
    }
  })

  test("确认才写盘：写官方字段、生成备份、needReload 提示、hub-imports 台账", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      const beforeBytes = readFileSync(env.authFile, "utf8")
      // 先预览（免密钥），再带密钥确认
      const pv = await (await post(env.h.port, "/api/accounts/import", { blob: { accounts: [freshRow()] } }, null)).json()
      assert.equal(pv.wrote, false)
      const res = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [freshRow()] }, confirm: true }, KEY)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.wrote, true)
      assert.equal(body.added.length, 1)
      assert.equal(body.added[0].uid, "cn-new-9")
      assert.equal(body.updated.length, 0)
      assert.match(body.backedUpTo, /^plugin-auth\.json\.bak-hubimport-\d{8}-\d{6}$/)
      assert.equal(body.needReload, true)
      assert.match(body.reloadHint, /插件管理/)
      // 备份 = 写入前字节
      assert.equal(readFileSync(join(env.cfg, body.backedUpTo), "utf8"), beforeBytes)
      // 新条目官方形状
      const before = JSON.parse(beforeBytes)
      const after = JSON.parse(readFileSync(env.authFile, "utf8"))
      const newKey = Object.keys(after).find((k) => !(k in before))
      assert.match(newKey, /^workbuddy#[0-9a-z]{6}$/)
      assert.equal(after[newKey].type, "oauth")
      assert.equal(after[newKey].accountId, "新号")
      assert.equal(after[newKey].expires, expSecIn(9) * 1000, "hub 秒 → magpie 毫秒")
      // 其它 9 条原样
      for (const k of Object.keys(before)) {
        assert.equal(JSON.stringify(after[k]), JSON.stringify(before[k]), `${k} 未被触碰`)
      }
      // 台账 + /api/state 的 imported 标记
      assert.ok(existsSync(join(env.state, "hub-imports.json")))
      const stateBody = await (await get(env.h.port, "/api/state", KEY)).json()
      const row = stateBody.accounts.find((a) => a.uid === "cn-new-9")
      assert.equal(row.imported, true)
      const untouched = stateBody.accounts.find((a) => a.uid === "cn-uid-a")
      assert.equal(untouched.imported, false)
    } finally {
      env.cleanup()
      await env.h.stop()
    }
  })

  test("智能合并经 HTTP：未过期 skip / 过期且更新 update（只动 token 三件套）", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      // cn-uid-a 未过期 → skip；cn-uid-b 置为过期 + 导入更新 → update
      const raw = JSON.parse(readFileSync(env.authFile, "utf8"))
      raw["workbuddy#3592pb"].expires = NOW - DAY
      writeFileSync(env.authFile, JSON.stringify(raw, null, 2) + "\n")
      const pv = (
        await (
          await post(env.h.port, "/api/accounts/import", {
            blob: {
              accounts: [
                cnRow({ uid: "cn-uid-a", expSec: expSecIn(1) }), // 现有未过期 → skip
                cnRow({ uid: "cn-uid-b", expSec: expSecIn(40) }),
              ],
            },
          }, null)
        ).json()
      ).preview
      assert.equal(pv.totals.skips, 1)
      assert.match(pv.skips[0].reason, /现有 token 未过期/)
      assert.equal(pv.totals.updates, 1)
      assert.equal(pv.updates[0].key, "workbuddy#3592pb")

      const res = await post(
        env.h.port,
        "/api/accounts/import",
        {
          blob: {
            accounts: [cnRow({ uid: "cn-uid-a", expSec: expSecIn(1) }), cnRow({ uid: "cn-uid-b", expSec: expSecIn(40) })],
          },
          confirm: true,
        },
        KEY,
      )
      const body = await res.json()
      assert.equal(body.wrote, true)
      assert.equal(body.updated.length, 1)
      assert.equal(body.skipped.length, 1)
      const after = JSON.parse(readFileSync(env.authFile, "utf8"))
      const row = after["workbuddy#3592pb"]
      assert.equal(row.expires, expSecIn(40) * 1000)
      assert.equal(row.accountId, "阿狗", "显示名不覆盖")
      assert.equal(row.access, cnRow({ uid: "cn-uid-b", expSec: expSecIn(40) }).accessToken)
      // 更新后 /api/state 的 imported 也亮（台账记了 update 的 key）
      const stateBody = await (await get(env.h.port, "/api/state", KEY)).json()
      assert.equal(stateBody.accounts.find((a) => a.uid === "cn-uid-b").imported, true)
    } finally {
      env.cleanup()
      await env.h.stop()
    }
  })

  test("国际版一律拒收：预览给出逐字 reason；确认 wrote:false 且零写盘", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      const beforeBytes = readFileSync(env.authFile, "utf8")
      const intlRow = { ...cnRow({ uid: "intl-new", expSec: expSecIn(9) }), realm: "intl", accessToken: makeJwt({ sub: "intl-new", iss: "https://www.workbuddy.ai/oauth", expSec: expSecIn(9) }) }
      const pv = await (await post(env.h.port, "/api/accounts/import", { blob: { accounts: [intlRow] } }, null)).json()
      assert.equal(pv.preview.totals.rejects, 1)
      assert.equal(pv.preview.rejects[0].reason, "只同步国内版 workbuddy，国际版账号不导入")
      const res = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [intlRow] }, confirm: true }, KEY)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.wrote, false)
      assert.equal(readFileSync(env.authFile, "utf8"), beforeBytes, "零写盘")
      assert.equal(readdirSync(env.cfg).filter((f) => f.includes(".bak-hubimport")).length, 0, "没有可写变更就不备份")
    } finally {
      env.cleanup()
      await env.h.stop()
    }
  })

  test("竞态守卫：预览后文件被改（magpie 刷新 token）→ 确认 409 要求重新预览", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      const pv = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [freshRow()] } }, null)
      assert.equal(pv.status, 200)
      // 模拟 magpie 刷新：改文件
      const raw = JSON.parse(readFileSync(env.authFile, "utf8"))
      raw.workbuddy.expires = NOW + 5 * DAY
      writeFileSync(env.authFile, JSON.stringify(raw, null, 2) + "\n")
      const res = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [freshRow()] }, confirm: true }, KEY)
      assert.equal(res.status, 409)
      const body = await res.json()
      assert.equal(body.needRepreview, true)
      assert.match(body.error, /预览后发生了变化/)
      // 重新预览后再确认 → 成功
      await post(env.h.port, "/api/accounts/import", { blob: { accounts: [freshRow()] } }, null)
      const ok = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [freshRow()] }, confirm: true }, KEY)
      assert.equal(ok.status, 200)
      assert.equal((await ok.json()).wrote, true)
    } finally {
      env.cleanup()
      await env.h.stop()
    }
  })

  test("坏 JSON 拒写：预览与确认都 409，文件不动", async () => {
    const env = await boot({ authText: "{broken" })
    try {
      const pv = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [freshRow()] } }, null)
      assert.equal(pv.status, 409)
      assert.match((await pv.json()).error, /解析失败/)
      const cf = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [freshRow()] }, confirm: true }, KEY)
      assert.equal(cf.status, 409)
      assert.equal(readFileSync(env.authFile, "utf8"), "{broken")
    } finally {
      env.cleanup()
      await env.h.stop()
    }
  })

  test("错误分支：文档读不出 → 400；无可写变更的确认 → wrote:false 且无备份", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      const bad = await post(env.h.port, "/api/accounts/import", { blob: { hello: 1 } }, null)
      assert.equal(bad.status, 400)
      assert.match((await bad.json()).error, /无法读取账号文档/)

      const empty = await post(env.h.port, "/api/accounts/import", { blob: [] }, null)
      assert.equal(empty.status, 400)
      assert.match((await empty.json()).error, /no accounts found/)

      const none = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [freshRow()] }, confirm: true }, KEY)
      assert.equal(none.status, 200)
      assert.equal((await none.json()).wrote, true, "有效变更正常写")
      // 全 skip 的确认
      const env2 = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
      try {
        const skipConfirm = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [cnRow({ uid: "cn-uid-a", expSec: expSecIn(1) })] }, confirm: true }, KEY)
        assert.equal(skipConfirm.status, 200)
        const body = await skipConfirm.json()
        assert.equal(body.wrote, false)
        assert.match(body.note, /没有需要写入的变更/)
        assert.equal(body.backedUpTo, null)
      } finally {
        env2.cleanup()
        await env2.h.stop()
      }
    } finally {
      env.cleanup()
      await env.h.stop()
    }
  })
})
