import { test } from "node:test";
import assert from "node:assert/strict";

import {
  billingHeaders,
  chatHeaders,
  domainOf,
  refreshHeaders,
  uuid7Hex,
  webHeaders,
} from "../engine/identity.mjs";
import { deriveId } from "../engine/fingerprint.mjs";
import { makeAcct } from "./helpers.mjs";

test("chatHeaders：键名大小写逐字一致（桌面端 CN 头族）", () => {
  const h = chatHeaders(makeAcct());
  for (const key of [
    "Content-Type", "Accept", "X-Requested-With", "Origin", "Referer",
    "X-CodeBuddy-Request", "Accept-Language",
    "X-Agent-Intent", "X-Agent-Purpose", "X-Agent-Type",
    "X-IDE-Name", "X-IDE-Type", "X-IDE-Version",
    "X-Private-Data", "X-Product", "X-Domain", "User-Agent",
    "X-User-Id", "Authorization",
    "X-Conversation-ID", "X-Conversation-Request-ID", "X-Root-Request-ID",
    "X-Conversation-Message-ID", "X-Request-ID",
    "X-Trace-ID", "traceparent", "b3", "X-B3-TraceId", "X-B3-SpanId", "X-B3-Sampled",
  ]) {
    assert.ok(Object.hasOwn(h, key), `缺少头 ${key}`);
  }
  // 不该出现的（官方对话请求不带 machine/session）
  assert.ok(!Object.hasOwn(h, "X-Machine-ID"));
  assert.ok(!Object.hasOwn(h, "X-Session-ID"));
  assert.ok(!Object.hasOwn(h, "X-API-Key"));
});

test("chatHeaders：取值与 hub 桌面 CN 分支一致", () => {
  const acct = makeAcct({ access: "tok123", domain: "my.domain.example" });
  const h = chatHeaders(acct);
  assert.equal(h["X-IDE-Version"], "5.8.3");
  assert.equal(h["User-Agent"], "WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0");
  assert.equal(h["X-Agent-Intent"], "craft");
  assert.equal(h["X-Agent-Purpose"], "conversation");
  assert.equal(h["X-Agent-Type"], "main");
  assert.equal(h["X-Private-Data"], "true");
  assert.equal(h["X-Product"], "SaaS");
  assert.equal(h["X-Domain"], "my.domain.example"); // 账号 domain 优先
  assert.equal(h["Authorization"], "Bearer tok123");
  assert.equal(h["X-User-Id"], acct.uid);
  assert.equal(h["Origin"], "https://www.codebuddy.cn");
  assert.equal(h["Referer"], "https://www.codebuddy.cn/");
  assert.equal(h["Accept-Language"], "zh-CN");
  assert.equal(h["X-B3-Sampled"], "1");
  // 桌面端：X-Conversation-Request-ID 与 X-Root-Request-ID 同值
  assert.equal(h["X-Conversation-Request-ID"], h["X-Root-Request-ID"]);
  assert.equal(h["X-Request-ID"], h["X-Conversation-Message-ID"]);
  // 会话 id 带连字符、请求 id 是 32hex
  assert.match(h["X-Conversation-ID"], /^[0-9a-f-]{36}$/);
  assert.match(h["X-Request-ID"], /^[0-9a-f]{32}$/);
});

test("chatHeaders：ids 可注入（桌面端 id 关系：requestId→会话请求 id，messageId→消息+请求 id）", () => {
  const h = chatHeaders(makeAcct(), {
    conversationId: "conv-1",
    requestId: "req-1",
    messageId: "msg-1",
    rootRequestId: "root-1",
  });
  assert.equal(h["X-Conversation-ID"], "conv-1");
  // Python 桌面分支：X-Conversation-Request-ID 是这一轮的请求 id
  assert.equal(h["X-Conversation-Request-ID"], "req-1");
  // X-Root-Request-ID 与 X-Conversation-Request-ID 同值（root 可显式覆盖）
  assert.equal(h["X-Root-Request-ID"], "root-1");
  // X-Request-ID = X-Conversation-Message-ID（同一条消息 id）
  assert.equal(h["X-Conversation-Message-ID"], "msg-1");
  assert.equal(h["X-Request-ID"], "msg-1");
  // 只给 requestId 时：root 跟随，消息 id 现生成
  const h2 = chatHeaders(makeAcct(), { requestId: "req-2" });
  assert.equal(h2["X-Conversation-Request-ID"], "req-2");
  assert.equal(h2["X-Root-Request-ID"], "req-2");
  assert.match(h2["X-Request-ID"], /^[0-9a-f]{32}$/);
  assert.equal(h2["X-Request-ID"], h2["X-Conversation-Message-ID"]);
});

test("chatHeaders：domain 兜底 copilot.tencent.com；企业号带 X-Enterprise-Id/X-Tenant-Id", () => {
  assert.equal(chatHeaders(makeAcct({ domain: "" }))["X-Domain"], "copilot.tencent.com");
  const h = chatHeaders(makeAcct({ enterpriseId: "ent-1" }));
  assert.equal(h["X-Enterprise-Id"], "ent-1");
  assert.equal(h["X-Tenant-Id"], "ent-1");
});

test("billingHeaders：X-Machine-ID/X-Session-ID 按账号派生且互不相同", () => {
  const acct = makeAcct();
  const h = billingHeaders(acct);
  assert.equal(h["X-Machine-ID"], deriveId(acct.uid, "machine"));
  assert.equal(h["X-Session-ID"], deriveId(acct.uid, "session"));
  assert.notEqual(h["X-Machine-ID"], h["X-Session-ID"]);
  assert.equal(h["User-Agent"], "WorkBuddy/5.8.3");
  assert.equal(h["X-Product"], "SaaS");
  assert.equal(h["X-No-Enterprise-Id"], "1");
  assert.equal(h["X-Domain"], "copilot.tencent.com");
  assert.match(h["X-Request-ID"], /^[0-9a-f]{32}$/);
  // 企业号换 X-Enterprise-Id/X-Tenant-Id，不再发 X-No-Enterprise-Id
  const he = billingHeaders(makeAcct({ enterpriseId: "ent-9" }));
  assert.equal(he["X-Enterprise-Id"], "ent-9");
  assert.equal(he["X-Tenant-Id"], "ent-9");
  assert.ok(!Object.hasOwn(he, "X-No-Enterprise-Id"));
});

test("webHeaders：领奖回退的浏览器形态（x-client-platform 小写、X-Domain 带 scheme）", () => {
  const acct = makeAcct({ access: "webtok" });
  const h = webHeaders(acct);
  for (const key of [
    "Authorization", "Accept", "Content-Type", "Origin", "Referer",
    "x-client-platform", "User-Agent", "X-User-Id", "X-Domain",
  ]) {
    assert.ok(Object.hasOwn(h, key), `缺少头 ${key}`);
  }
  assert.equal(h["Authorization"], "Bearer webtok");
  assert.equal(h["Origin"], "https://www.workbuddy.cn");
  assert.equal(h["Referer"], "https://www.workbuddy.cn/profile/growth-center");
  assert.equal(h["x-client-platform"], "web"); // 与 Python 完全一致的小写头名
  assert.equal(h["X-Domain"], "https://www.workbuddy.cn"); // Python: "X-Domain": WEB_BASE
  assert.match(h["User-Agent"], /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\)/);
});

test("refreshHeaders：X-Refresh-Token / X-Auth-Refresh-Source: workbuddy / X-Domain", () => {
  const h = refreshHeaders(makeAcct({ refresh: "rt-1", domain: "copilot.tencent.com" }));
  assert.equal(h["X-Refresh-Token"], "rt-1");
  assert.equal(h["X-Auth-Refresh-Source"], "workbuddy"); // cn 分支
  assert.equal(h["X-Domain"], "copilot.tencent.com");
  assert.equal(h["X-User-Id"], "u-12345678");
});

test("domainOf：空 domain 回落 copilot.tencent.com", () => {
  assert.equal(domainOf({ domain: "" }), "copilot.tencent.com");
  assert.equal(domainOf({ domain: "custom.example" }), "custom.example");
  assert.equal(domainOf(undefined), "copilot.tencent.com");
});

test("uuid7Hex：32 hex、版本位 7、变体位 2（RFC 9562）", () => {
  const h = uuid7Hex(1750000000000);
  assert.match(h, /^[0-9a-f]{32}$/);
  assert.equal(h[12], "7");
  assert.ok(["8", "9", "a", "b"].includes(h[16]));
});
