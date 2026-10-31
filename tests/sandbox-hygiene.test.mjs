// tests/sandbox-hygiene.test.mjs —— 测试沙箱卫生防回归（node --test）。
//
// 历史缺陷：测试只 mkdtemp 不删除，跑一次全套 temp 里就涨一批 wb-* 沙箱
// （control.json / settings.json / daemon.json / daemon.heartbeat 状态目录，
// 曾积到 2463+ 个）。本文件把卫生线钉进 CI：
//   1. makeSandbox().cleanup() 必须把「目录」从磁盘真删掉（不只是登记簿销账）；
//   2. 模拟「用例忘了 cleanup」的泄漏：cleanupAllSandboxes()（每文件 after
//      兜底与 process.on('exit') 钩子走的同一个函数）必须能回收它；
//   3. cleanup 后原路径最多剩一个 0 字节墓碑文件（挡 daemon 迟到的
//      refreshSnapshots 落盘把已删目录原地重建；exit 时统一摘除）；
//   4. 收尾断言：本测试进程登记的沙箱集合全部已删除 —— 跑完套件后 temp 里
//      不应残留本次前缀的沙箱目录（不扫整个用户 temp：慢且会碰到别人的文件；
//      node --test 每文件独立进程，进程内登记簿即「本次创建的沙箱」全集）。
// 口径与三道卫生线见 tests/helpers.mjs 的「测试沙箱卫生」一节。

import { test, after } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupAllSandboxes, cleanupSandbox, makeSandbox, pendingSandboxes } from "./helpers.mjs"

// 断言「沙箱目录已删」：原路径要么什么都不剩，要么只剩 0 字节墓碑文件（它不是
// 目录、不含任何测试数据，进程退出时由 helpers 摘除）。
function assertDirGone(dir, what) {
  if (!existsSync(dir)) return
  const st = statSync(dir)
  assert.ok(!st.isDirectory(), `${what} 必须把目录删掉（${dir}）`)
  assert.equal(st.size, 0, `${what} 原路径只允许 0 字节墓碑文件（${dir}）`)
}

test("沙箱卫生：cleanup 真删目录、泄漏可兜底回收、exit 钩子在岗、收尾登记簿清零", () => {
  // 1. 正常路径：创建（含子目录与状态文件）→ cleanup → 目录从磁盘上没了
  const ok = makeSandbox("wb-hygiene-ok-")
  mkdirSync(join(ok.dir, "sub"), { recursive: true })
  writeFileSync(join(ok.dir, "control.json"), "{}")
  writeFileSync(join(ok.dir, "sub", "settings.json"), "{}")
  assert.equal(existsSync(join(ok.dir, "sub", "settings.json")), true, "makeSandbox 必须真的建出目录")
  ok.cleanup()
  assertDirGone(ok.dir, "cleanup()")

  // 2. 泄漏路径：创建后故意不 cleanup（模拟新增用例漏写 finally），
  //    兜底清理必须能回收 —— 这就是异常退出 / 漏删时 temp 不涨的原因
  const leaked = makeSandbox("wb-hygiene-leak-")
  writeFileSync(join(leaked.dir, "daemon.json"), "{}")
  assert.ok(pendingSandboxes().includes(leaked.dir), "泄漏的沙箱在登记簿里")
  const swept = cleanupAllSandboxes()
  assert.ok(swept >= 1, "兜底清理至少回收了泄漏的这一个")
  assertDirGone(leaked.dir, "兜底清理")
  assert.ok(!pendingSandboxes().includes(leaked.dir), "回收后从登记簿销账")

  // 3. cleanupSandbox 按路径点名清理：幂等、未知路径不抛（也不留假墓碑）
  const byName = makeSandbox("wb-hygiene-byname-")
  cleanupSandbox(byName.dir)
  assertDirGone(byName.dir, "cleanupSandbox")
  cleanupSandbox(byName.dir) // 幂等：再清一次不炸
  const absent = `${byName.dir}-absent` // 从未存在过的路径（不落在墓碑文件下面）
  cleanupSandbox(absent) // 不存在的路径不炸
  assert.equal(existsSync(absent), false, "未知路径不产生任何文件")

  // 4. 进程退出兜底在岗：makeSandbox 首次调用即注册 process.on('exit')
  assert.ok(process.listenerCount("exit") > 0, "exit 钩子必须已注册（异常退出兜底）")

  // 5. 收尾断言（CI 防回归的核心）：本进程自己创建的沙箱集合全部已删除
  assert.deepEqual(pendingSandboxes(), [], "跑完套件后登记簿必须清零 —— temp 不残留本次的沙箱")
})

// 与其他文件同款兜底：正常情况下登记簿已是空的；万一上面哪步留下未删项，
// 文件收尾统一回收（exit 钩子会在进程退出时再兜一次底并摘除墓碑）。
after(() => {
  cleanupAllSandboxes()
})
