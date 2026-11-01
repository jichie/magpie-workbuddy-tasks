// schedule-utc-child.mjs —— 由 schedule-utc-container.test.mjs 以 TZ=UTC 拉起的子进程。
// 完整模拟生产 magpie 容器（时区 UTC、TZ 为空），回归生产 bug：旧实现用
// new Date(nowMs).getHours() 把北京 09:00（UTC 01:00）读成 1 点，误触夜猫子窗口。
// 断言失败 → 非零退出；全部通过 → 打印 __UTC_CONTAINER_OK__。

import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { startDaemon } from "../daemon.mjs"
import { inNightWindow, windowsAt } from "../engine/schedule.mjs"
import { makeSandbox } from "../tests/helpers.mjs"

// 引擎层（TZ=UTC 下旧 getHours/toDateString 实现会在这里现形）：
// UTC 01:00 = 北京 09:00 —— 绝不能判成夜间，窗口必须是 travel
assert.equal(inNightWindow(Date.UTC(2026, 8, 15, 1, 0)), false, "UTC 01:00 = 北京 09:00，不在夜猫窗口")
assert.deepEqual(windowsAt(Date.UTC(2026, 8, 15, 1, 0)).map((w) => w.legs), [["travel"]], "UTC 01:00 = 北京 09:00 → travel")
assert.deepEqual(windowsAt(Date.UTC(2026, 8, 14, 17, 0)).map((w) => w.legs), [["night"]], "UTC 17:00 = 北京次日 01:00 → night")

// daemon 层：假引擎 + 用户真实 hours（travel:[9,21]、night:[1]），假时钟 = 显式 UTC 毫秒
const stateDir = makeSandbox("wb-sched-utc-").dir
writeFileSync(
  join(stateDir, "settings.json"),
  JSON.stringify({ scheduler: true, hours: { travel: [9, 21], night: [1] } }),
  "utf8",
)
const eng = {
  store: {
    loadAccounts: () => [
      { key: "workbuddy", provider: "workbuddy", uid: "u1", nickname: "阿猫", access: "a", refresh: "r", expires: Date.now() + 86400000, domain: "", isApiKey: false, enterpriseId: "" },
    ],
    eligibleAccounts: (accounts) =>
      accounts.filter((a) => a.provider === "workbuddy" && !a.isApiKey && !a.enterpriseId && a.tasksEnabled !== false),
  },
  runner: {
    JobRunner: class JobRunner {
      start(spec) {
        return {
          id: "job-1",
          state: "running",
          trigger: spec.trigger ?? "manual",
          legs: spec.legs ?? [],
          spec,
          totals: { credit: 0, energy: 0, tasksLit: 0, tasksClaimed: 0 },
          steps: [],
          log: [],
        }
      }
      get() {
        return null
      }
      current() {
        return null
      }
    },
  },
  tasks: null,
  upstream: null,
  errors: [],
  ok: true,
}

const h = await startDaemon({
  key: "utc-container-key-0123456789abcdef",
  port: 0,
  stateDir,
  engine: eng,
  noTimers: true,
  skipExistingCheck: true,
  log: () => {},
})
try {
  const job = h.ticks.checkScheduler(Date.UTC(2026, 8, 15, 1, 0))
  assert.ok(job, "北京 09:00（UTC 01:00）必须触发窗口")
  assert.deepEqual(job.legs, ["travel"], `UTC 容器里北京 09:00 必须跑 travel，实际 ${JSON.stringify(job?.legs)}`)
  assert.ok(!JSON.stringify(job.legs).includes("night"), "绝不能跑 night")

  const job2 = h.ticks.checkScheduler(Date.UTC(2026, 8, 14, 17, 0))
  assert.ok(job2, "北京 01:00（UTC 17:00）必须触发窗口")
  assert.deepEqual(job2.legs, ["night"], `UTC 17:00 = 北京次日 01:00，必须跑 night，实际 ${JSON.stringify(job2?.legs)}`)
} finally {
  await h.stop()
}

console.log("__UTC_CONTAINER_OK__")
