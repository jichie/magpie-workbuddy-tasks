// 回归：index.mjs 的 hereDir() 必须返回「目录」。
// 真实宿主里曾拼出 /config/.../magpie-workbuddy-tasks/daemon.mjs/daemon.mjs
// —— because hereDir() treated the ./daemon.mjs URL as a directory, so the daemon
// never spawned. Local tests missed it because they passed pluginDir explicitly.
import { strict as assert } from "node:assert";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { _internal } from "../index.mjs";

const { hereDir } = _internal;
const REAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("hereDir() 返回目录，不是 daemon.mjs 文件路径", () => {
  const dir = hereDir();
  assert.ok(dir, "hereDir 不能为空");
  assert.ok(!/\.[cm]?js$/i.test(dir), `hereDir 不该以 .js/.mjs 结尾：${dir}`);
  assert.equal(existsSync(dir), true, `目录不存在：${dir}`);
  assert.equal(statSync(dir).isDirectory(), true, `不是目录：${dir}`);
  assert.equal(resolve(dir), REAL_DIR, "hereDir 应指向插件根目录");
});

test("pluginDir 下 daemon.mjs / lifecycle.mjs 存在（ensureDaemon 的拼接前提）", () => {
  const dir = hereDir();
  for (const f of ["daemon.mjs", "lifecycle.mjs", "index.mjs", "package.json"]) {
    assert.equal(existsSync(join(dir, f)), true, `缺少 ${f}`);
  }
  // ensureDaemon 做 join(pluginDir, "daemon.mjs")：结果必须正好是根目录下的那个文件
  assert.equal(resolve(join(dir, "daemon.mjs")), resolve(REAL_DIR, "daemon.mjs"));
});
