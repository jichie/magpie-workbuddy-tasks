import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  authFile,
  eligibleAccounts,
  loadAccounts,
  readMagpieConfigDir,
  saveAccountRefresh,
  stateDir,
  tasksStateFile,
} from "../engine/store.mjs";
import { cleanupAllSandboxes, cleanupSandbox, makeSandbox } from "./helpers.mjs";

// 每条用例独占一个 temp 沙箱（并发隔离：node --test 多进程并行 + 用例交错，
// daemon 状态文件以 stateDir 为边界，共享目录会互相踩）；用完即删，见 helpers.mjs。
function tmpCfg() {
  return makeSandbox("wb-store-").dir;
}

// 兜底：个别用例漏删时在文件收尾统一回收（正常情况下登记簿已是空的）。
after(() => {
  cleanupAllSandboxes();
});

const AUTH = {
  workbuddy: {
    type: "oauth", access: "at-1", refresh: "rt-1", expires: 111111,
    accountId: "小明", uid: "uid-1", domain: "copilot.tencent.com",
    refreshTokenNote: "未知字段要原样保留", labels: ["a"],
  },
  "workbuddy#deadbeef": {
    type: "oauth", access: "at-2", refresh: "rt-2", expires: 222222,
    accountId: "小明·二号", uid: "uid-2", domain: "copilot.tencent.com",
  },
  "workbuddy#api1": { type: "api", key: "ck_abc.def", accountId: "key 账号" },
  "workbuddy-ai#cafe": {
    type: "oauth", access: "at-3", refresh: "rt-3", expires: 333333,
    accountId: "Global", uid: "uid-3", domain: "www.workbuddy.ai",
  },
  "workbuddy-tasks": { type: "success", key: "shared" },
  "other-provider": { type: "oauth", access: "xx", uid: "uid-9" },
  "workbuddy#empty": { type: "oauth", access: "", uid: "" },
};

function seedAuth(cfg) {
  writeFileSync(authFile(cfg), JSON.stringify(AUTH, null, 2));
}

test("readMagpieConfigDir：显式环境变量优先；无显式时回默认目录（存在才返回）", () => {
  assert.equal(readMagpieConfigDir({ MAGPIE_CONFIG_DIR: "/custom/magpie" }), "/custom/magpie");
  const fallback = join(homedir(), ".config", "magpie");
  const expected = existsSync(fallback) ? fallback : null;
  assert.equal(readMagpieConfigDir({}), expected);
});

test("loadAccounts：只吃 workbuddy* 条目，映射成内部形状", () => {
  const cfg = tmpCfg();
  try {
    seedAuth(cfg);
    const accounts = loadAccounts(cfg);
    const byKey = Object.fromEntries(accounts.map((a) => [a.key, a]));
    assert.deepEqual(Object.keys(byKey).sort(), ["workbuddy", "workbuddy#api1", "workbuddy#deadbeef", "workbuddy-ai#cafe"]);

    const a = byKey.workbuddy;
    assert.equal(a.provider, "workbuddy");
    assert.equal(a.uid, "uid-1");
    assert.equal(a.nickname, "小明");
    assert.equal(a.access, "at-1");
    assert.equal(a.refresh, "rt-1");
    assert.equal(a.expires, 111111);
    assert.equal(a.domain, "copilot.tencent.com");
    assert.equal(a.isApiKey, false);
    assert.equal(a.tasksEnabled, true);

    const api = byKey["workbuddy#api1"];
    assert.equal(api.isApiKey, true);
    assert.equal(api.provider, "workbuddy");

    const ai = byKey["workbuddy-ai#cafe"];
    assert.equal(ai.provider, "workbuddy-ai");

    // 文件缺失 / 坏 JSON → 空数组而不是抛
    assert.deepEqual(loadAccounts(join(cfg, "nope")), []);
    const bad = tmpCfg();
    try {
      writeFileSync(authFile(bad), "{not json");
      assert.deepEqual(loadAccounts(bad), []);
    } finally {
      cleanupSandbox(bad);
    }
  } finally {
    cleanupSandbox(cfg);
  }
});

test("eligibleAccounts：workbuddy 个人 OAuth 且 tasksEnabled!==false", () => {
  const accounts = [
    { key: "workbuddy", provider: "workbuddy", uid: "u1", isApiKey: false, enterpriseId: "", tasksEnabled: true },
    { key: "workbuddy#2", provider: "workbuddy", uid: "u2", isApiKey: false, enterpriseId: "", tasksEnabled: false },
    { key: "workbuddy#3", provider: "workbuddy", uid: "u3", isApiKey: true, enterpriseId: "", tasksEnabled: true },
    { key: "workbuddy#4", provider: "workbuddy", uid: "u4", isApiKey: false, enterpriseId: "ent-1", tasksEnabled: true },
    { key: "workbuddy-ai#5", provider: "workbuddy-ai", uid: "u5", isApiKey: false, enterpriseId: "", tasksEnabled: true },
    { key: "workbuddy#6", provider: "workbuddy", uid: "u6", isApiKey: false, enterpriseId: "", tasksEnabled: true },
  ];
  const picked = eligibleAccounts(accounts);
  assert.deepEqual(picked.map((a) => a.uid), ["u1", "u6"]);
});

test("loadAccounts：tasksEnabled 来自本插件状态文件（uid 或 acctKey 关掉都行）", () => {
  const cfg = tmpCfg();
  try {
    seedAuth(cfg);
    mkdirSync(stateDir(cfg), { recursive: true });
    writeFileSync(tasksStateFile(cfg), JSON.stringify({ "uid-1": false, "workbuddy#deadbeef": false }));
    const accounts = loadAccounts(cfg);
    const enabled = accounts.filter((a) => a.tasksEnabled).map((a) => a.uid);
    // api key 账号默认参与（eligibleAccounts 会再把 provider=workbuddy-ai 与
    // isApiKey 的滤掉），这里只验证 uid-1/uid-2 被状态文件关掉
    assert.deepEqual(enabled.includes("uid-3"), true);
    assert.deepEqual(enabled.includes("uid-1"), false);
    assert.deepEqual(enabled.includes("uid-2"), false);
  } finally {
    cleanupSandbox(cfg);
  }
});

test("saveAccountRefresh：只改 token 字段，未知字段与兄弟条目原样保留", () => {
  const cfg = tmpCfg();
  try {
    seedAuth(cfg);
    saveAccountRefresh(cfg, "workbuddy", {
      access: "at-1-new",
      refresh: "rt-1-new",
      expires: 999999,
      refreshExpiresAt: 888888,
      domain: "copilot.tencent.com",
      tokenType: "Bearer",
      uid: "HACKED", // 非 TOKEN_FIELDS，必须被忽略
      accountId: "HACKED",
    });
    const raw = JSON.parse(readFileSync(authFile(cfg), "utf8"));
    const entry = raw.workbuddy;
    assert.equal(entry.access, "at-1-new");
    assert.equal(entry.refresh, "rt-1-new");
    assert.equal(entry.expires, 999999);
    assert.equal(entry.refreshExpiresAt, 888888);
    assert.equal(entry.uid, "uid-1", "非 token 字段不许改");
    assert.equal(entry.accountId, "小明");
    assert.equal(entry.refreshTokenNote, "未知字段要原样保留");
    assert.deepEqual(entry.labels, ["a"]);
    // 兄弟条目一个不少
    assert.deepEqual(Object.keys(raw).sort(), Object.keys(AUTH).sort());
    assert.equal(raw["other-provider"].access, "xx");
    assert.equal(raw["workbuddy-tasks"].key, "shared");
  } finally {
    cleanupSandbox(cfg);
  }
});

test("saveAccountRefresh：原子落盘（无 tmp 残留）、合法 JSON、权限 600", () => {
  const cfg = tmpCfg();
  try {
    seedAuth(cfg);
    saveAccountRefresh(cfg, "workbuddy#deadbeef", { access: "at-2b" });
    const raw = JSON.parse(readFileSync(authFile(cfg), "utf8")); // 合法 JSON
    assert.equal(raw["workbuddy#deadbeef"].access, "at-2b");
    assert.equal(raw["workbuddy#deadbeef"].refresh, "rt-2", "未给的字段不碰");
    const leftovers = readdirSync(cfg).filter((f) => f.includes(".tmp-"));
    assert.deepEqual(leftovers, [], "tmp 文件必须已改名不留残留");
    if (process.platform !== "win32") {
      // Windows 的 chmod 只映射只读位，这里只对 POSIX 断言 600
      const mode = statSync(authFile(cfg)).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  } finally {
    cleanupSandbox(cfg);
  }
});

test("saveAccountRefresh：文件不存在时创建（不丢其它 provider——本来就没有）", () => {
  const cfg = tmpCfg();
  try {
    saveAccountRefresh(cfg, "workbuddy", { access: "at-new", refresh: "rt-new", expires: 5 });
    const raw = JSON.parse(readFileSync(authFile(cfg), "utf8"));
    assert.deepEqual(raw, { workbuddy: { access: "at-new", refresh: "rt-new", expires: 5 } });
  } finally {
    cleanupSandbox(cfg);
  }
});

test("saveAccountRefresh：坏 JSON 拒绝回写（不冒丢数据的风险）", () => {
  const cfg = tmpCfg();
  try {
    writeFileSync(authFile(cfg), "{broken");
    assert.throws(() => saveAccountRefresh(cfg, "workbuddy", { access: "x" }), /拒绝回写/);
    assert.equal(readFileSync(authFile(cfg), "utf8"), "{broken");
  } finally {
    cleanupSandbox(cfg);
  }
});

test("目录布局：stateDir 在 magpie 配置目录下的 workbuddy-tasks/state", () => {
  assert.equal(stateDir("/cfg"), join("/cfg", "workbuddy-tasks", "state"));
  assert.equal(tasksStateFile("/cfg"), join("/cfg", "workbuddy-tasks", "state", "tasks-accounts.json"));
});
