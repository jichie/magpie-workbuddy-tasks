// schedule-utc-container.test.mjs —— UTC 容器仿真回归（生产 bug 的确定性复现）。
//
// 生产 magpie 容器时区是 UTC：旧实现 checkScheduler 的 new Date(nowMs).getHours()
// 把北京 09:00（UTC 01:00）读成 1 点，命中 night 而不是 travel。在 UTC+8 的开发机上
// 新旧实现数值恰好一致，同进程测试分不出好坏 —— 所以这里以 TZ=UTC 拉起
// schedule-utc-child.mjs 子进程（= 生产容器的时区环境），在**真实 UTC 时区**下
// 驱动 engine/daemon 的排程路径，新旧实现只有一个能通过。

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

test("TZ=UTC 容器仿真：北京 09:00（UTC 01:00）跑 travel 绝非 night；北京 01:00（UTC 17:00）跑 night", () => {
  const r = spawnSync(process.execPath, [join(here, "schedule-utc-child.mjs")], {
    env: { ...process.env, TZ: "UTC" },
    encoding: "utf8",
    timeout: 30000,
  })
  const out = String(r.stdout ?? "")
  if (r.status !== 0 || !out.includes("__UTC_CONTAINER_OK__")) {
    assert.fail(
      `UTC 容器仿真未通过（status=${r.status}，信号 ${r.signal ?? "无"}）\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
    )
  }
})
