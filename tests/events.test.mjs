import { test } from "node:test";
import assert from "node:assert/strict";

import { TASK_SPECS, EXPERT_ID_POOL, TEAM_ID_POOL } from "../engine/constants.mjs";
import { buildEvent } from "../engine/tasks.mjs";
import { fakeClock, makeAcct } from "./helpers.mjs";

const NOW = 1_760_000_000_000;
const clock = fakeClock(NOW);
const acct = makeAcct({ uid: "uid-X" });

function ev(kind, opts = {}) {
  return buildEvent(acct, kind, opts.idx ?? 0, opts.expert ?? null, { now: clock.now });
}

test("每种 kind 的 eventCode 与必填字段", () => {
  const cases = [
    ["canvas", "wbx_design_canvas_task_create", ["conversationId", "requestId", "source", "isCustomModel", "inputLength", "id", "cost", "isSuccessful"]],
    ["template", "agent_task_created_with_template", ["isCustomModel", "id", "name", "requestId", "conversationId"]],
    ["expert", "expert_actual_use", ["mode", "id", "name", "expertTitle", "type", "expertType", "source", "version", "cost", "characterCount", "conversationId", "requestId", "messageId", "requestModelId", "requestModelName"]],
    ["team", "expert_actual_use", ["expertType"]],
    ["lighthouse", "expert_actual_use", ["expertType"]],
    ["skill", "skill_info", ["skillId", "name"]],
    ["automation", "automated_task_create_suc", ["name", "type", "source", "modelId", "modelIsThinking", "schedule", "prompt"]],
    ["playbook", "playbook_prompt_send", ["id", "name", "type", "promptLength", "isOfficial", "source"]],
    ["skin", "appearance_skin_apply", ["action", "source", "id", "vipLevel", "series", "type", "name"]],
    ["chat", "chat_request_send", ["mode", "conversationId", "requestId", "inputLength", "requestModelId", "requestModelName", "isPlan", "agentName", "agentType"]],
    ["glmchat", "chat_request_send", []],
    ["cat", "chat_request_send", []],
    ["unknown-kind", "heartbeat", ["timestamp"]],
  ];
  for (const [kind, eventCode, fields] of cases) {
    const e = ev(kind);
    assert.equal(e.eventCode, eventCode, kind);
    for (const f of fields) assert.ok(Object.hasOwn(e, f), `${kind} 缺字段 ${f}`);
  }
});

test("userId 必在（缺了服务端 200 但静默丢弃）", () => {
  for (const kind of ["canvas", "template", "expert", "team", "lighthouse", "skill", "automation", "playbook", "skin", "chat", "glmchat", "cat", "whatever"]) {
    assert.equal(ev(kind).userId, "uid-X", kind);
  }
});

test("timestamp 用注入时钟；conversationId 形态 wb-task-<now>-<idx>", () => {
  const e = ev("chat", { idx: 3 });
  assert.equal(e.timestamp, NOW);
  assert.equal(e.conversationId, `wb-task-${NOW}-3`);
  assert.equal(e.requestId, `wb-task-${NOW}-3-req`);
});

test("专家/团队：默认池、钉死 id、模式与模型字段", () => {
  // 默认 expert（无池指定）
  const e = ev("expert");
  assert.equal(e.id, "ContentCreator");
  assert.equal(e.name, "内容创作专家");
  assert.equal(e.expertType, "agent");
  assert.equal(e.mode, "CLOUD");
  assert.equal(e.requestModelId, "deepseek-v4-flash");

  // team
  const t = ev("team");
  assert.equal(t.id, "CloudOpsTeam");
  assert.equal(t.expertType, "team");

  // lighthouse 钉死真实 id
  const l = ev("lighthouse");
  assert.equal(l.id, "ex_2cvvUZQhDyeJ");
  assert.equal(l.name, "腾讯轻量云专家");

  // WorkBuddy_Valorant 钉死真实 id（spec.expert 注入）
  const v = ev("expert", { expert: TASK_SPECS.WorkBuddy_Valorant.expert });
  assert.equal(v.id, "ex_xQHHD1u5Jkua");
  assert.equal(v.name, "无畏契约拼豆专家");

  // 显式 expert 注入
  const x = ev("expert", { expert: ["ex_custom", "自定义专家"] });
  assert.equal(x.id, "ex_custom");
  assert.equal(x.expertTitle, "自定义专家");
});

test("chat / glmchat / cat 的模型与模式", () => {
  assert.equal(ev("chat").requestModelId, "deepseek-v4-flash");
  assert.equal(ev("chat").requestModelName, "DeepSeek V4 Flash");
  assert.equal(ev("chat").mode, "craft");
  assert.equal(ev("glmchat").requestModelId, "glm-5.2");
  assert.equal(ev("glmchat").requestModelName, "GLM-5.2");
  assert.equal(ev("glmchat").mode, "craft");
  assert.equal(ev("cat").requestModelId, "glm-5.2");
  assert.equal(ev("cat").mode, "night");
});

test("id 池容量与首元素（去重轮换的弹药）", () => {
  assert.ok(EXPERT_ID_POOL.length >= 5);
  assert.ok(TEAM_ID_POOL.length >= 3);
  const ids = new Set(EXPERT_ID_POOL.map(([id]) => id));
  assert.equal(ids.size, EXPERT_ID_POOL.length); // 池内本身无重复
  assert.ok(ids.has("ex_2cvvUZQhDyeJ")); // 轻量云专家也在专家池里
});
