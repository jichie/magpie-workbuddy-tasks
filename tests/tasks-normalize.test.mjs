// tests/tasks-normalize.test.mjs —— 缺陷 1 回归（node --test）。
//
// 上游（wbBackend 照抄真实响应形状）返回的是 snake_case：task_code / reward_credit /
// reward_energy / jump_url / accept_status / task_type + 顶层 progress。fetchTasks
// 必须在引擎边界一次性归一成规范 camelCase Task（CONTRACT §2）——此前 daemon 的
// snapTask 按规范拼写取不到值，/api/state 里 code/rewardCredit/jumpUrl 永远是空串/0，
// 看板的「批量接任务」「领奖」只能发空 code。这里逐字段钉死规范拼写。

import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchTasks } from "../engine/tasks.mjs";
import { fakeClock, localTime, makeAcct, task, wbBackend } from "./helpers.mjs";

const STATUS_WORDS = ["not_accepted", "accepted", "completed", "claimed"];

test("fetchTasks：snake_case 上游 → 规范 camelCase Task（raw 非枚举保留原文）", async () => {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const backend = wbBackend({
    clock,
    tasks: [
      task("create_canvas", { title: "创建设计任务", reward: 300, reward_energy: 5 }),
      task("Library_read", { title: "浏览资料库", reward: 100, jump_url: "workbuddy://library" }),
    ],
    litRules: {},
  });
  const tasks = await fetchTasks(makeAcct(), {
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });

  assert.equal(tasks.length, 2);
  for (const t of tasks) {
    // 规范拼写的键集合逐字钉死（多一个上游拼写、少一个规范拼写都算回归）
    assert.deepEqual(
      Object.keys(t).sort(),
      [
        "acceptStatus",
        "code",
        "description",
        "jumpUrl",
        "progress",
        "reason",
        "rewardCredit",
        "rewardEnergy",
        "taskType",
        "title",
        "unforgeable",
      ],
    );
    assert.ok(typeof t.code === "string" && t.code.length > 0, "code 必须非空（缺陷 1 的直接病灶）");
    assert.ok(t.title.length > 0, "title 必须非空");
    assert.ok(STATUS_WORDS.includes(t.acceptStatus), `acceptStatus 应为上游字符串状态，得到 ${t.acceptStatus}`);
    assert.equal(t.task_code, undefined, "不许再带上游拼写 task_code");
    assert.equal(t.reward_credit, undefined, "不许再带上游拼写 reward_credit");
    assert.ok(!Object.keys(t).includes("raw"), "raw 是非枚举字段，不进 Object.keys");
    assert.equal(t.raw.task_code, t.code, "raw 保留上游原始对象（调试用）");
    assert.ok(typeof t.rewardCredit === "number" && t.rewardCredit > 0);
    assert.deepEqual(t.progress, { current: 0, target: 1 });
  }

  const canvas = tasks.find((t) => t.code === "create_canvas");
  assert.equal(canvas.title, "创建设计任务");
  assert.equal(canvas.rewardCredit, 300);
  assert.equal(canvas.rewardEnergy, 5);
  assert.equal(canvas.acceptStatus, "not_accepted");
  assert.equal(canvas.taskType, "single");
  assert.equal(canvas.jumpUrl, "");

  const lib = tasks.find((t) => t.code === "Library_read");
  assert.equal(lib.jumpUrl, "workbuddy://library", "深链必须透出（看板展示用）");
  assert.equal(lib.unforgeable, false);
});

test("fetchTasks：JSON 序列化后没有任何 snake_case 键（daemon 投影只认规范拼写）", async () => {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const backend = wbBackend({
    clock,
    tasks: [
      task("first_buddy", { task_type: "auto", reward: 300 }),
      task("chat_5", { reward: 100, status: "accepted", current: 3, target: 5 }),
    ],
    litRules: {},
  });
  const tasks = await fetchTasks(makeAcct(), {
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const text = JSON.stringify(tasks); // raw 非枚举：不会出现在序列化结果里
  for (const bad of ["task_code", "reward_credit", "reward_energy", "jump_url", "accept_status", "task_type"]) {
    assert.ok(!text.includes(`"${bad}"`), `序列化结果不该出现上游拼写 ${bad}`);
  }
  const auto = tasks.find((t) => t.code === "first_buddy");
  assert.equal(auto.taskType, "auto");
  assert.equal(auto.progress.current, 0);
  const chat = tasks.find((t) => t.code === "chat_5");
  assert.equal(chat.acceptStatus, "accepted");
  assert.deepEqual(chat.progress, { current: 3, target: 5 });
});
