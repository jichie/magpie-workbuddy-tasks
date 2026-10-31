// tests/accountio-import.test.mjs —— 账号 JSON 导入/导出引擎层测试（node --test）。
// 全部纯函数 + 真实 tmp 目录，零网络、零真实凭据。口径见 docs/CONTRACT.md §7.1/§9。

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CN_REALM_MARKERS,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  INTL_REJECT_REASON,
  UNDETECTABLE_REALM_REASON,
  applyImport,
  buildExportDocument,
  coerceImportRows,
  domainForRealm,
  epochToMagpieMs,
  exportFileName,
  jwtExpSec,
  magpieMsToEpoch,
  mergePlanIntoDocument,
  normalizeEpoch,
  officialAddEntry,
  planImport,
  planView,
} from "../engine/accountio.mjs";
import { loadAccounts } from "../engine/store.mjs";
import { CN_ISS, INTL_ISS, cnRow, makeJwt, nineEntryAuth } from "./accountio-fixture.mjs";
import { cleanupAllSandboxes, cleanupSandbox, makeSandbox } from "./helpers.mjs";

const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime(); // 固定本地时间（假时钟）
const DAY = 86400000;
const expSecIn = (days) => Math.floor(NOW / 1000) + days * 86400;

// 每条用例独占一个 temp 沙箱（并发隔离是刻意的：写盘纪律/备份/键序断言都要求
// 干净起点，共享目录会互相踩）；用完即删，兜底见 helpers.mjs 与本文件末尾的 after。
function tmpCfg() {
  return makeSandbox("wb-accountio-").dir;
}

// 兜底：个别用例漏删时在文件收尾统一回收（正常情况下登记簿已是空的）。
after(() => {
  cleanupAllSandboxes();
});

// ---- 1. 四种输入形态 + 信封校验 ---------------------------------------------

describe("coerceImportRows：四种输入形态", () => {
  test("导出信封 / 裸数组 / 单对象 / 桌面端凭据 都解析出行", () => {
    const row = cnRow({ uid: "u-shape-1", expSec: expSecIn(10) });
    const envelope = { format: EXPORT_FORMAT, version: EXPORT_VERSION, count: 1, accounts: [row] };
    assert.deepEqual(coerceImportRows(envelope).rows, [row]);
    assert.deepEqual(coerceImportRows([row, row]).rows, [row, row]);
    assert.deepEqual(coerceImportRows(row).rows, [row]);
    // 桌面端凭据：token 在 auth 层、身份在 account 层（hub pick() 的分层读取）
    const desktop = {
      auth: { accessToken: makeJwt({ sub: "u-desk", expSec: expSecIn(10) }), refreshToken: "rt-desk", expiresAt: expSecIn(10), domain: "copilot.tencent.com" },
      account: { uid: "u-desk", nickname: "桌面号" },
    };
    assert.deepEqual(coerceImportRows(desktop).rows, [desktop]);
  });

  test("blob 包装的解包在 daemon 层；engine 层对 {blob:…} 按「单对象」拒绝（无 token 字段）", () => {
    const r = coerceImportRows({ blob: [] });
    assert.ok(r.error);
    assert.match(r.error, /not an account document/);
  });

  test("信封校验：format / version / count 不符一律拒绝", () => {
    const row = cnRow({ uid: "u-env", expSec: expSecIn(10) });
    assert.match(coerceImportRows({ format: "other-tool", accounts: [row] }).error, /format 不是/);
    assert.match(coerceImportRows({ format: EXPORT_FORMAT, version: 2, accounts: [row] }).error, /不支持的导出版本/);
    assert.match(
      coerceImportRows({ format: EXPORT_FORMAT, version: 1, count: 3, accounts: [row] }).error,
      /count=3 与 accounts 数量 1 不符/,
    );
    // 没带这些字段的信封宽容（hub 兼容：任何带 accounts 数组的对象都收）
    assert.deepEqual(coerceImportRows({ accounts: [row] }).rows, [row]);
  });

  test("错误文案逐字对齐 hub：空文档/非对象行/怪形状/非对象非数组", () => {
    assert.match(coerceImportRows([]).error, /^no accounts found in the document$/);
    assert.match(coerceImportRows([cnRow({ uid: "x", expSec: 1 }), "oops"]).error, /^account #2 is not an object$/);
    assert.match(coerceImportRows({ hello: 1 }).error, /^not an account document \(expected an accounts array, a list, or an account object; got keys: hello\)$/);
    assert.match(coerceImportRows("nope").error, /^expected an object or a list of accounts$/);
    assert.match(coerceImportRows(null).error, /^expected an object or a list of accounts$/);
  });
});

// ---- 2. 行归一：cockpit 行 / 区域判定 / 拒收形状 -----------------------------

describe("normalizeImportRow（经 planImport.rejets 观察）", () => {
  const planOf = (row, existing = {}) => planImport([row], existing, { now: NOW });

  test("cockpit snake_case 行：expires_at 毫秒被归一成秒（hub :5413 注释口径）", () => {
    const msValue = (expSecIn(10) + 0.5) * 1000; // 毫秒值（带亚秒）
    const plan = planImport(
      [{ access_token: makeJwt({ sub: "u-cock", expSec: expSecIn(10) }), refresh_token: "rt-c", expires_at: msValue, uid: "u-cock", email: "c@x.cn" }],
      {},
      { now: NOW },
    );
    assert.equal(plan.totals.adds, 1);
    const entry = plan.ops[0].entry;
    assert.equal(entry.expires, expSecIn(10) * 1000, "毫秒入口 → 秒 → 写 magpie 时回毫秒整");
    assert.equal(entry.accountId, "c@x.cn", "cockpit 行 nickname 取 email");
  });

  test("API Key 行 / 非 JWT / 无 token：拒收并给可读 reason", () => {
    const cases = [
      [{ accessToken: "ck_abc123.def456" }, /API Key 行不导入/],
      [{ accessToken: "not-a-jwt" }, /accessToken is not a JWT/],
      [{ refreshToken: "only-refresh" }, /no accessToken/],
    ];
    for (const [row, re] of cases) {
      const plan = planOf(row);
      assert.equal(plan.totals.rejects, 1);
      assert.match(plan.rejects[0].reason, re);
    }
  });

  test("uid：优先行字段，净化 [^A-Za-z0-9_-]；没有 uid 时取 JWT sub；都没有拒收", () => {
    const p1 = planOf(cnRow({ uid: "weIRD/uid ok", expSec: expSecIn(10) }));
    assert.equal(p1.adds[0].uid, "weIRD_uid_ok");
    const p2 = planImport([{ accessToken: makeJwt({ sub: "sub-only-uid", expSec: expSecIn(10) }), realm: "cn" }], {}, { now: NOW });
    assert.equal(p2.adds[0].uid, "sub-only-uid");
    const token = makeJwt({ sub: "", expSec: expSecIn(10) });
    const p3 = planImport([{ accessToken: token, realm: "cn" }], {}, { now: NOW });
    assert.match(p3.rejects[0].reason, /cannot determine uid/);
  });

  test("区域：token 签发方优先于行内 realm（行带错区域不能把请求带回错出口）", () => {
    // 行自称 cn，但 token 是国际版签发 → intl → 拒
    const intlToken = makeJwt({ sub: "u-x", iss: INTL_ISS, expSec: expSecIn(10) });
    const p1 = planImport([{ accessToken: intlToken, realm: "cn", uid: "u-x" }], {}, { now: NOW });
    assert.equal(p1.totals.rejects, 1);
    assert.equal(p1.rejects[0].reason, INTL_REJECT_REASON);
    // 行没写 realm，域名是国内 → cn
    const p2 = planImport([{ accessToken: makeJwt({ sub: "u-y", iss: "", expSec: expSecIn(10) }), uid: "u-y", domain: "workbuddy.cn" }], {}, { now: NOW });
    assert.equal(p2.totals.adds, 1);
    // 行没写 realm、token/域名都认不出 → 拒（不瞎猜）
    const p3 = planImport([{ accessToken: makeJwt({ sub: "u-z", iss: "https://elsewhere.example/oauth", expSec: expSecIn(10) }), uid: "u-z" }], {}, { now: NOW });
    assert.equal(p3.totals.rejects, 1);
    assert.equal(p3.rejects[0].reason, UNDETECTABLE_REALM_REASON);
  });

  test("国际版一律进 rejects，reason 逐字；index 从 1 起；inputHint 不含 token", () => {
    const rows = [
      cnRow({ uid: "cn-ok", expSec: expSecIn(10) }),
      { ...cnRow({ uid: "intl-1", expSec: expSecIn(10) }), realm: "intl", accessToken: makeJwt({ sub: "intl-1", iss: INTL_ISS, expSec: expSecIn(10) }) },
      "garbage-row",
    ];
    const plan = planImport(rows, {}, { now: NOW });
    assert.equal(plan.totals.adds, 1);
    assert.equal(plan.totals.rejects, 2);
    assert.equal(plan.rejects[0].index, 2, "index 从 1 起（hub 口径）");
    assert.equal(plan.rejects[0].reason, INTL_REJECT_REASON);
    assert.equal(plan.rejects[1].index, 3);
    assert.ok(plan.rejects[1].inputHint.length > 0);
    assert.ok(!JSON.stringify(plan.rejects).includes("eyJ"), "inputHint 不含 JWT 片段");
  });

  test("domain 对齐：写另一区域的过期域名 → 换成该区域规范域名（hub domain_for_realm）", () => {
    const p = planImport(
      [{ ...cnRow({ uid: "u-dom", expSec: expSecIn(10) }), domain: "www.workbuddy.ai" }],
      {},
      { now: NOW },
    );
    assert.equal(p.ops[0].entry.domain, "copilot.tencent.com");
    // 域名看不出区域时原样保留
    const p2 = planImport([{ ...cnRow({ uid: "u-dom2", expSec: expSecIn(10) }), domain: "my-proxy.example" }], {}, { now: NOW });
    assert.equal(p2.ops[0].entry.domain, "my-proxy.example");
    assert.deepEqual(CN_REALM_MARKERS, ["copilot.tencent.com", "codebuddy.cn", "workbuddy.cn"]);
    assert.equal(domainForRealm("cn", ""), "copilot.tencent.com");
  });
});

// ---- 3. expiresAt 单位（契约 §7.1 专门防混淆）--------------------------------

describe("时间单位：hub 秒 ↔ magpie 毫秒（搞错=永不过期/立刻过期）", () => {
  test("normalizeEpoch：>1e11 视为毫秒除以 1000；秒值原样；垃圾=0", () => {
    assert.equal(normalizeEpoch(1795332707225), 1795332707); // 毫秒 → 秒
    assert.equal(normalizeEpoch("1795332707225"), 1795332707); // 数字串也行
    assert.equal(normalizeEpoch(1795332707), 1795332707); // 秒值不动
    assert.equal(normalizeEpoch(1795332707.9), 1795332707); // 亚秒截断
    assert.equal(normalizeEpoch(0), 0);
    assert.equal(normalizeEpoch("abc"), 0);
    assert.equal(normalizeEpoch(undefined), 0);
    assert.equal(normalizeEpoch(null), 0);
    // 1e11 是分界：hub 是严格大于（number > 1e11 才除），1e11 本身按秒处理
    assert.equal(normalizeEpoch(1e11), 1e11);
    assert.equal(normalizeEpoch(1e11 + 1), 100000000);
  });

  test("双向换算：magpie 毫秒 → hub 秒 → magpie 毫秒（亚秒内误差可接受）", () => {
    const ms = 1795332707225;
    const sec = magpieMsToEpoch(ms);
    assert.equal(sec, 1795332707);
    assert.equal(epochToMagpieMs(sec), 1795332707000);
    assert.ok(Math.abs(epochToMagpieMs(sec) - ms) < 1000, "双向换算误差 < 1 秒");
    assert.equal(magpieMsToEpoch(0), 0, "0=未知，不当代 1970");
    assert.equal(epochToMagpieMs(0), 0);
  });

  test("jwtExpSec：JWT exp 是秒（RFC 口径），解不开=0", () => {
    assert.equal(jwtExpSec(makeJwt({ sub: "x", expSec: 1900000000 })), 1900000000);
    assert.equal(jwtExpSec("garbage"), 0);
  });

  test("防混淆主断言：同一账号用「hub 秒」与「cockpit 毫秒」两种表达 → 写入 magpie 的 expires 一致，合并结论一致", () => {
    const uid = "u-unit";
    const expSec = expSecIn(20);
    const jwt = makeJwt({ sub: uid, expSec });
    const inSec = { uid, realm: "cn", accessToken: jwt, refreshToken: "rt", expiresAt: expSec };
    const inMs = { access_token: jwt, refresh_token: "rt", expires_at: expSec * 1000, uid }; // cockpit 行
    const existing = { workbuddy: { type: "oauth", access: "old", refresh: "old-rt", expires: epochToMagpieMs(expSecIn(-5)), uid } };
    const p1 = planImport([inSec], existing, { now: NOW });
    const p2 = planImport([inMs], existing, { now: NOW });
    assert.equal(p1.totals.updates, 1);
    assert.equal(p2.totals.updates, 1, "两种单位表达下智能合并结论一致（都判 update）");
    assert.equal(p1.ops[0].patch.expires, expSec * 1000);
    assert.equal(p2.ops[0].patch.expires, expSec * 1000, "两种单位表达写入的毫秒值一致");
    // 反向：把秒值错当毫秒（×1000）会得到「5 万年后」的假未过期 → 现有过期也会被误判 skip；
    // 本测试钉死正确换算，防止回归
    assert.equal(p1.updates[0].toExpires, expSec * 1000);
  });

  test("导出行：magpie 毫秒 → hub 秒（floor），回灌后再导出数值不变", () => {
    const ms = NOW + 10 * DAY + 555; // 带亚秒
    const doc = buildExportDocument([{ key: "workbuddy", provider: "workbuddy", uid: "u-e", nickname: "n", access: "a", refresh: "r", expires: ms, domain: "", enterpriseId: "", isApiKey: false, tasksEnabled: true }], { now: NOW });
    assert.equal(doc.accounts[0].expiresAt, Math.floor(ms / 1000));
    assert.equal(doc.accounts[0].expiresAt, magpieMsToEpoch(ms));
  });
});

// ---- 4. planImport 智能合并全分支 --------------------------------------------

describe("planImport 智能合并（uid 已存在）", () => {
  const uid = "cn-uid-a"; // fixture 里 workbuddy 裸键的 uid
  const mkExisting = (expiresMs, extra = {}) => ({
    workbuddy: { type: "oauth", access: "EXISTING-ACCESS", refresh: "EXISTING-REFRESH", expires: expiresMs, accountId: "阿猫", uid, domain: "copilot.tencent.com", ...extra },
  });

  test("现有未过期 → skip（绝不把在用新 token 换成 JSON 里的旧 token）", () => {
    const plan = planImport([cnRow({ uid, expSec: expSecIn(40) })], mkExisting(NOW + 10 * DAY), { now: NOW });
    assert.equal(plan.totals.adds, 0);
    assert.equal(plan.totals.updates, 0);
    assert.equal(plan.totals.skips, 1);
    assert.match(plan.skips[0].reason, /现有 token 未过期/);
    assert.equal(plan.skips[0].uid, uid);
    assert.deepEqual(plan.ops, [], "skip 不产生写操作");
  });

  test("现有已过期且导入更新 → update（只覆盖 access/refresh/expires，其余原样保留）", () => {
    const existing = mkExisting(NOW - DAY, { myCustom: "keep-me", accountId: "旧名字" });
    const plan = planImport([cnRow({ uid, expSec: expSecIn(30) })], existing, { now: NOW });
    assert.equal(plan.totals.updates, 1);
    assert.equal(plan.updates[0].key, "workbuddy");
    assert.equal(plan.updates[0].fromExpires, NOW - DAY);
    assert.equal(plan.updates[0].toExpires, expSecIn(30) * 1000);
    assert.match(plan.updates[0].reason, /现有 token 已过期/);
    const patch = plan.ops[0].patch;
    assert.deepEqual(Object.keys(patch).sort(), ["access", "expires", "importedFrom", "refresh"]);
    const merged = mergePlanIntoDocument(existing, plan);
    assert.equal(merged.workbuddy.access, cnRow({ uid, expSec: expSecIn(30) }).accessToken);
    assert.equal(merged.workbuddy.accountId, "旧名字", "显示名不覆盖");
    assert.equal(merged.workbuddy.myCustom, "keep-me", "未知字段保留");
    assert.equal(merged.workbuddy.domain, "copilot.tencent.com", "domain 不覆盖");
  });

  test("现有已过期但导入不更新（相等/更旧）→ skip", () => {
    const expiredAtSec = expSecIn(-2);
    const same = planImport([cnRow({ uid, expSec: expiredAtSec })], mkExisting(expiredAtSec * 1000), { now: NOW });
    assert.equal(same.totals.skips, 1);
    assert.match(same.skips[0].reason, /并不比现有的新/);
    const older = planImport([cnRow({ uid, expSec: expSecIn(-9) })], mkExisting(expiredAtSec * 1000), { now: NOW });
    assert.equal(older.totals.skips, 1);
    assert.equal(older.totals.updates, 0);
  });

  test("导入项无 refresh 而现有有 → skip（削弱续期能力；即使导入 token 更新、现有已过期）", () => {
    const row = cnRow({ uid, expSec: expSecIn(30), refresh: "" });
    const plan = planImport([row], mkExisting(NOW - DAY), { now: NOW });
    assert.equal(plan.totals.skips, 1);
    assert.match(plan.skips[0].reason, /削弱续期能力/);
    assert.equal(plan.totals.updates, 0);
  });

  test("两边都没有 refresh 且现有过期、导入更新 → 仍 update（不削弱）", () => {
    const row = cnRow({ uid, expSec: expSecIn(30), refresh: "" });
    const plan = planImport([row], mkExisting(NOW - DAY, { refresh: "" }), { now: NOW });
    assert.equal(plan.totals.updates, 1);
    assert.equal("refresh" in plan.ops[0].patch, false, "导入没有 refresh 就不写 refresh 键");
  });

  test("现有条目缺 expires（0）且导入带有效期 → update，reason 说明「有效期未知」", () => {
    const plan = planImport([cnRow({ uid, expSec: expSecIn(30) })], mkExisting(0), { now: NOW });
    assert.equal(plan.totals.updates, 1);
    assert.match(plan.updates[0].reason, /缺 expires/);
  });

  test("文档内重复 uid → 只导入第一条", () => {
    const plan = planImport([cnRow({ uid: "dup-1", expSec: expSecIn(10) }), cnRow({ uid: "dup-1", expSec: expSecIn(11) })], {}, { now: NOW });
    assert.equal(plan.totals.adds, 1);
    assert.equal(plan.totals.skips, 1);
    assert.match(plan.skips[0].reason, /重复 uid/);
  });

  test("匹配只认 provider workbuddy 的条目：同 uid 的 workbuddy-ai 条目不挡导入", () => {
    const existing = { "workbuddy-ai#x": { type: "oauth", access: "intl-a", refresh: "rt", expires: NOW + 10 * DAY, uid, accountId: "intl" } };
    const plan = planImport([cnRow({ uid, expSec: expSecIn(10) })], existing, { now: NOW });
    assert.equal(plan.totals.adds, 1, "国际版条目不参与国内版合并");
  });

  test("报告零凭据：planView/序列化结果绝不含 access/refresh 值", () => {
    const secretAccess = makeJwt({ sub: uid, expSec: expSecIn(30) });
    const plan = planImport([cnRow({ uid, expSec: expSecIn(30) })], mkExisting(NOW - DAY), { now: NOW });
    const view = planView(plan);
    assert.deepEqual(Object.keys(view).sort(), ["adds", "rejects", "skips", "totals", "updates"], "planView 剥掉 ops");
    assert.ok(!JSON.stringify(view).includes("EXISTING-ACCESS"));
    assert.ok(!JSON.stringify(view).includes("EXISTING-REFRESH"));
    assert.ok(!JSON.stringify({ adds: plan.adds, updates: plan.updates, skips: plan.skips, rejects: plan.rejects, totals: plan.totals }).includes(secretAccess));
  });
});

// ---- 5. key 分配 ---------------------------------------------------------------

describe("key 分配（官方规则：首个裸 id，其余 #+6 位）", () => {
  test("空库首个 add 拿裸键 workbuddy", () => {
    const plan = planImport([cnRow({ uid: "k-1", expSec: expSecIn(10) })], {}, { now: NOW });
    assert.equal(plan.adds[0].key, "workbuddy");
    assert.equal(plan.ops[0].entry.uid, "k-1");
  });

  test("workbuddy 已被占 → 新增走 workbuddy#<6位>，绝不与任何已有键撞", () => {
    const existing = nineEntryAuth({ nowMs: NOW });
    const rows = Array.from({ length: 50 }, (_, i) => cnRow({ uid: `k-new-${i}`, expSec: expSecIn(10) }));
    const plan = planImport(rows, existing, { now: NOW });
    assert.equal(plan.totals.adds, 50);
    const keys = plan.adds.map((a) => a.key);
    assert.equal(new Set(keys).size, 50, "彼此不撞");
    for (const k of keys) {
      assert.match(k, /^workbuddy#[0-9a-z]{6}$/, "官方后缀形状：#+6 位小写数字字母");
      assert.ok(!(k in existing), "不与已有键撞");
    }
  });

  test("官方条目形状（写进 plugin-auth.json 的行用官方字段名）", () => {
    const entry = officialAddEntry({
      uid: "u-o", nickname: "昵称", domain: "copilot.tencent.com", realm: "cn", platform: "CLI",
      enterpriseId: "", accessToken: "ACC", refreshToken: "REF", expiresSec: 1900000000,
      refreshExpiresSec: 0, tokenType: "", source: "import",
    });
    assert.deepEqual(Object.keys(entry), ["type", "access", "refresh", "expires", "domain", "tokenType", "uid", "accountId", "importedFrom"]);
    assert.equal(entry.type, "oauth");
    assert.equal(entry.access, "ACC");
    assert.equal(entry.refresh, "REF");
    assert.equal(entry.expires, 1900000000000, "毫秒");
    assert.equal(entry.tokenType, "Bearer");
    assert.equal(entry.accountId, "昵称", "accountId 填可读昵称（magpie 显示名）");
    assert.equal(entry.importedFrom, "hub-json");
    // hub 名绝不出现
    assert.ok(!("accessToken" in entry) && !("refreshToken" in entry) && !("expiresAt" in entry));
  });
});

// ---- 6. applyImport 写盘纪律（备份/原子/保留/拒写）----------------------------

describe("applyImport：写前备份、逐字节保留其它 provider、坏 JSON 拒写", () => {
  test("9 条目 fixture：新增 1 个国内账号，其余 8 条逐字节原样保留、键序不变", () => {
    const cfg = tmpCfg();
    try {
      const before = nineEntryAuth({ nowMs: NOW });
      writeFileSync(join(cfg, "plugin-auth.json"), JSON.stringify(before, null, 2) + "\n");
      const beforeBytes = readFileSync(join(cfg, "plugin-auth.json"), "utf8");

      const plan = planImport([cnRow({ uid: "cn-new-1", expSec: expSecIn(10) })], before, { now: NOW });
      const r = applyImport(cfg, plan, { existingData: before, now: NOW });
      assert.match(r.backedUpTo, /^plugin-auth\.json\.bak-hubimport-\d{8}-\d{6}$/);

      // 备份 = 写入前的逐字节快照
      assert.equal(readFileSync(join(cfg, r.backedUpTo), "utf8"), beforeBytes);

      const after = JSON.parse(readFileSync(join(cfg, "plugin-auth.json"), "utf8"));
      // 键序：原 9 个位置不动，新增的排在最后
      assert.deepEqual(Object.keys(after).slice(0, 9), Object.keys(before));
      assert.equal(Object.keys(after).length, 10);
      for (const k of Object.keys(before)) {
        assert.equal(JSON.stringify(after[k]), JSON.stringify(before[k]), `条目 ${k} 必须逐字节原样保留`);
      }
      // 新条目是官方形状
      const newKey = Object.keys(after).find((k) => !(k in before));
      assert.match(newKey, /^workbuddy#[0-9a-z]{6}$/);
      assert.equal(after[newKey].type, "oauth");
      assert.equal(after[newKey].importedFrom, "hub-json");
      // 无 tmp 残留
      assert.deepEqual(readdirSync(cfg).filter((f) => f.includes(".tmp-")), []);
      if (process.platform !== "win32") {
        assert.equal(statSync(join(cfg, "plugin-auth.json")).mode & 0o777, 0o600);
      }
    } finally {
      cleanupSandbox(cfg);
    }
  });

  test("更新分支：只动目标条目的 token 字段，其余 8 条逐字节不变", () => {
    const cfg = tmpCfg();
    try {
      const before = nineEntryAuth({ nowMs: NOW });
      // 把 workbuddy（cn-uid-a）的 token 置为已过期
      before.workbuddy.expires = NOW - DAY;
      writeFileSync(join(cfg, "plugin-auth.json"), JSON.stringify(before, null, 2) + "\n");

      const plan = planImport([cnRow({ uid: "cn-uid-a", expSec: expSecIn(30) })], before, { now: NOW });
      assert.equal(plan.totals.updates, 1);
      applyImport(cfg, plan, { existingData: before, now: NOW });
      const after = JSON.parse(readFileSync(join(cfg, "plugin-auth.json"), "utf8"));
      assert.equal(Object.keys(after).length, 9);
      for (const k of Object.keys(before)) {
        if (k === "workbuddy") continue;
        assert.equal(JSON.stringify(after[k]), JSON.stringify(before[k]), `条目 ${k} 未被触碰`);
      }
      assert.equal(after.workbuddy.accountId, "阿猫", "显示名不覆盖");
      assert.equal(after.workbuddy.access, cnRow({ uid: "cn-uid-a", expSec: expSecIn(30) }).accessToken);
      assert.equal(after.workbuddy.expires, expSecIn(30) * 1000);
      assert.equal(after.workbuddy.importedFrom, "hub-json");
    } finally {
      cleanupSandbox(cfg);
    }
  });

  test("坏 JSON 拒写（WB_AUTH_PARSE），文件一个字节都不动", () => {
    const cfg = tmpCfg();
    try {
      writeFileSync(join(cfg, "plugin-auth.json"), "{broken");
      const plan = planImport([cnRow({ uid: "u-bad", expSec: expSecIn(10) })], {}, { now: NOW });
      assert.throws(() => applyImport(cfg, plan), (e) => e.code === "WB_AUTH_PARSE");
      assert.equal(readFileSync(join(cfg, "plugin-auth.json"), "utf8"), "{broken");
      assert.equal(readdirSync(cfg).filter((f) => f.startsWith("plugin-auth.json.bak-")).length, 0, "失败不留备份");
    } finally {
      cleanupSandbox(cfg);
    }
  });

  test("顶层不是对象（数组）也拒写；文件不存在 = 空库可建", () => {
    const cfg = tmpCfg();
    const cfg2 = tmpCfg();
    try {
      writeFileSync(join(cfg, "plugin-auth.json"), "[]");
      const plan = planImport([cnRow({ uid: "u-arr", expSec: expSecIn(10) })], {}, { now: NOW });
      assert.throws(() => applyImport(cfg, plan), (e) => e.code === "WB_AUTH_PARSE");

      const plan2 = planImport([cnRow({ uid: "u-fresh", expSec: expSecIn(10) })], {}, { now: NOW });
      const r = applyImport(cfg2, plan2, { existingData: {} });
      assert.equal(r.backedUpTo, null, "没有旧文件就没有备份");
      assert.equal(JSON.parse(readFileSync(join(cfg2, "plugin-auth.json"), "utf8")).workbuddy.type, "oauth");
    } finally {
      cleanupSandbox(cfg);
      cleanupSandbox(cfg2);
    }
  });
});

// ---- 7. 导出 ------------------------------------------------------------------

describe("buildExportDocument（hub 形状导出）", () => {
  const accounts = [
    { key: "workbuddy", provider: "workbuddy", uid: "cn-1", nickname: "阿猫", access: "ACC-CN-1", refresh: "REF-CN-1", expires: NOW + 10 * DAY, domain: "copilot.tencent.com", enterpriseId: "", isApiKey: false, tasksEnabled: true },
    { key: "workbuddy#aaa", provider: "workbuddy", uid: "cn-2", nickname: "阿狗", access: "ACC-CN-2", refresh: "REF-CN-2", expires: NOW + 20 * DAY, domain: "", enterpriseId: "", isApiKey: false, tasksEnabled: false },
    { key: "workbuddy-ai", provider: "workbuddy-ai", uid: "intl-1", nickname: "G1", access: "ACC-INTL", refresh: "REF-INTL", expires: NOW + 30 * DAY, domain: "www.workbuddy.ai", enterpriseId: "", isApiKey: false, tasksEnabled: true },
    { key: "workbuddy#api1", provider: "workbuddy", uid: "api-1", nickname: "K", access: "", refresh: "", expires: 0, domain: "", enterpriseId: "", isApiKey: true, tasksEnabled: true },
  ];

  test("信封形状：format/version/exportedAt(本地时间)/count/accounts", () => {
    const doc = buildExportDocument(accounts, { now: NOW });
    assert.equal(doc.format, "workbuddy-accounts");
    assert.equal(doc.version, 1);
    assert.equal(doc.count, 3, "API Key 条目不导出");
    assert.match(doc.exportedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(doc.exportedAt, "2026-10-31 12:00:00");
    assert.deepEqual(Object.keys(doc), ["format", "version", "exportedAt", "count", "accounts"]);
  });

  test("行字段 = hub 名（accessToken/refreshToken/expiresAt 秒），从 magpie 条目反向映射", () => {
    const doc = buildExportDocument(accounts, { now: NOW });
    const cn = doc.accounts[0];
    assert.deepEqual(
      Object.keys(cn).sort(),
      ["accessToken", "apiKey", "domain", "enabled", "enterpriseId", "expiresAt", "nickname", "platform", "product", "realm", "refreshToken", "source", "tasksEnabled", "uid"].sort(),
    );
    assert.equal(cn.realm, "cn");
    assert.equal(cn.accessToken, "ACC-CN-1");
    assert.equal(cn.refreshToken, "REF-CN-1");
    assert.equal(cn.expiresAt, Math.floor((NOW + 10 * DAY) / 1000));
    assert.equal(cn.source, "magpie");
    assert.equal(cn.platform, "CLI");
    assert.equal(cn.product, "workbuddy");
    assert.equal(doc.accounts[2].realm, "intl");
  });

  test("realm 过滤 / uid 过滤 / secrets=0 删 token 两键", () => {
    assert.deepEqual(buildExportDocument(accounts, { realm: "cn", now: NOW }).accounts.map((r) => r.uid), ["cn-1", "cn-2"]);
    assert.deepEqual(buildExportDocument(accounts, { realm: "intl", now: NOW }).accounts.map((r) => r.uid), ["intl-1"]);
    assert.deepEqual(buildExportDocument(accounts, { uids: ["cn-2"], now: NOW }).accounts.map((r) => r.uid), ["cn-2"]);
    const masked = buildExportDocument(accounts, { includeSecrets: false, now: NOW });
    assert.equal(masked.count, 3);
    for (const row of masked.accounts) {
      assert.ok(!("accessToken" in row), "secrets=0 删 accessToken");
      assert.ok(!("refreshToken" in row), "secrets=0 删 refreshToken");
      assert.ok(row.uid, "其余字段保留");
    }
  });

  test("下载文件名规则（hub :19347）：单 uid=uid 前 8 位；多 uid=realm-；净化 [^A-Za-z0-9._-]", () => {
    assert.equal(exportFileName({ uids: ["abcdef1234567890"], realm: "cn", now: NOW }), `workbuddy-accounts-abcdef12${formatStampAt(NOW)}.json`);
    assert.equal(exportFileName({ uids: ["a", "b"], realm: "cn", now: NOW }), `workbuddy-accounts-cn-${formatStampAt(NOW)}.json`);
    assert.equal(exportFileName({ uids: [], realm: null, now: NOW }), `workbuddy-accounts-${formatStampAt(NOW)}.json`);
    assert.equal(exportFileName({ uids: ["a", "b"], realm: null, now: NOW }), `workbuddy-accounts-${formatStampAt(NOW)}.json`);
    assert.equal(exportFileName({ uids: ["怪/字*符"], now: NOW }), `workbuddy-accounts-_____${formatStampAt(NOW)}.json`, "净化成 _");
  });

  function formatStampAt(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
});

// ---- 8. 导出 → 导入 round-trip 幂等 -------------------------------------------

describe("round-trip：导出 → 导入 → 再导出 幂等", () => {
  test("经真实 plugin-auth.json 文件与 loadAccounts 走完整闭环", () => {
    const cfg = tmpCfg();
    try {
      const nowMs = NOW;
      const first = nineEntryAuth({ nowMs });
      writeFileSync(join(cfg, "plugin-auth.json"), JSON.stringify(first, null, 2) + "\n");

      // 1) 从真实文件载入账号并导出（含 secrets）
      const accts1 = loadAccounts(cfg);
      const doc1 = buildExportDocument(accts1, { now: nowMs });
      assert.equal(doc1.count, accts1.filter((a) => !a.isApiKey).length);

      // 2) 导入到空库（预览 → 应用）
      const { rows } = coerceImportRows(doc1);
      // 国际版会被我们的口径拒收；只有国内版行进来
      const plan = planImport(rows, {}, { now: nowMs });
      assert.equal(plan.totals.rejects, 3, "3 个国际版条目按口径拒收");
      assert.equal(plan.totals.adds, 2, "2 个国内版 OAuth 条目");
      const doc2 = mergePlanIntoDocument({}, plan);
      const cfg2 = tmpCfg();
      try {
        writeFileSync(join(cfg2, "plugin-auth.json"), JSON.stringify(doc2, null, 2) + "\n");
        const accts2 = loadAccounts(cfg2);
        // 3) 再导出 → 国内版行与第一次导出的国内版行逐字段一致（幂等）
        const doc3 = buildExportDocument(accts2.filter((a) => a.provider === "workbuddy"), { now: nowMs });
        const cnRows1 = doc1.accounts.filter((r) => r.realm === "cn");
        const byUid1 = Object.fromEntries(cnRows1.map((r) => [r.uid, r]));
        for (const row of doc3.accounts) {
          const orig = byUid1[row.uid];
          assert.ok(orig, `uid ${row.uid} 应在首轮导出中存在`);
          for (const f of ["uid", "nickname", "domain", "realm", "accessToken", "refreshToken", "expiresAt", "apiKey"]) {
            assert.equal(row[f], orig[f], `round-trip 后 ${f} 不变`);
          }
        }
        assert.equal(doc3.count, 2);
        // 写入的是官方字段名，导入回灌 uid/expires 无损
        assert.equal(doc2.workbuddy.expires, first.workbuddy.expires);
      } finally {
        cleanupSandbox(cfg2);
      }
    } finally {
      cleanupSandbox(cfg);
    }
  });
});
