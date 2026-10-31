// tests/library-webclick.test.mjs —— 「浏览资料库」（Library_read）改走 web 点击
// 事件的回归（CONTRACT §7）。
//
// 背景：Library_read 曾在 DESKTOP_ONLY_TASKS 里被引擎永远跳过（生产两账号长期
// 「已接取 0/1」）。上游实际认的是 web 端在资料库介绍文档页的一次元素点击事件
//（web_element_click），打 **web 域** /v2/report —— reportLibraryEvent 按参考
// 实现逐字段重写。本文件钉死：
//   1. 事件字段逐个对齐（eventCode/pageURL/elementId/elementName/os/arch/
//      osVersion/userAgent/machineId/userId/userNickname），数组包一层；
//   2. 头族 = webHeaders + 三处覆盖（Referer=文档 URL、User-Agent=WEB_UA、
//      X-User-Id=空串），Authorization 原样保留；
//   3. callJSON 的 init.headers 合并语义：大小写敏感覆盖，Authorization 不可被
//      覆盖（精确大小写与换小写两种写法都剥掉）；
//   4. 流水线端到端：Library_read 0/1 → web 点击 → 进度 0→1 → 领奖成功；
//      日志写「正在点亮任务 [浏览资料库]（web 点击事件）」。
// 全程零真实网络（wbBackend 假后端）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { LIBRARY_DOC_URL, WEB_UA } from "../engine/constants.mjs";
import { deriveId } from "../engine/fingerprint.mjs";
import { callJSON } from "../engine/upstream.mjs";
import { reportLibraryEvent, runGrowthTasks } from "../engine/tasks.mjs";
import { fakeClock, localTime, makeAcct, task, wbBackend } from "./helpers.mjs";

const GAP = 1000;

const RESP = (status, body) => ({ status, text: async () => JSON.stringify(body) });

test("reportLibraryEvent：事件字段与头逐字对齐（web 域 /v2/report，数组包一层）", async () => {
  const clock = fakeClock(1_760_000_000_000);
  const backend = wbBackend({ clock, tasks: [], litRules: {} });
  const acct = makeAcct({ uid: "uid-lib", nickname: "资料库测试" });
  const ok = await reportLibraryEvent(acct, {
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  assert.equal(ok, true);

  const call = backend.calls.at(-1);
  assert.equal(call.host, "www.workbuddy.cn", "打 web 域");
  assert.equal(call.path, "/v2/report");
  assert.equal(call.method, "POST");
  assert.ok(Array.isArray(call.body), "body 是事件数组");
  assert.equal(call.body.length, 1);

  const ev = call.body[0];
  assert.equal(ev.eventCode, "web_element_click");
  assert.equal(ev.timestamp, 1_760_000_000_000, "timestamp 用注入时钟");
  assert.equal(ev.reportDelay, 0);
  assert.equal(ev.pageURL, LIBRARY_DOC_URL);
  assert.equal(ev.elementId, "library_doc_intro_click");
  assert.equal(ev.elementName, "WorkBuddy资料库介绍");
  assert.equal(ev.os, "Win32");
  assert.equal(ev.arch, "");
  assert.equal(ev.osVersion, "10.0");
  assert.equal(ev.userAgent, WEB_UA);
  assert.equal(ev.machineId, deriveId("uid-lib", "webmachine"), "machineId = deriveId(uid,'webmachine')");
  assert.equal(ev.userId, "uid-lib", "事件必带 userId（缺了服务端静默丢弃）");
  assert.equal(ev.userNickname, "资料库测试");

  // 头族：webHeaders + 三处覆盖；Authorization 保留
  const h = call.headers;
  assert.equal(h.Referer, LIBRARY_DOC_URL, "Referer 覆盖为资料库文档 URL");
  assert.equal(h["User-Agent"], WEB_UA, "User-Agent 与事件 userAgent 同值（同一次浏览器会话）");
  assert.equal(h["X-User-Id"], "", "web 端点击事件的真实形态：X-User-Id 空串");
  assert.equal(h.Authorization, "Bearer access-token-abc", "Authorization 原样保留");
  assert.equal(h["x-client-platform"], "web", "web 头族标志保留");
  assert.equal(h.Origin, "https://www.workbuddy.cn");
  assert.equal(h["X-Domain"], "https://www.workbuddy.cn");
});

test("callJSON：init.headers 大小写敏感合并；Authorization 绝不可被覆盖", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.headers);
    return RESP(200, { code: 0, data: {} });
  };
  const acct = makeAcct({ access: "access-token-abc" });
  await callJSON(acct, "web", "https://www.workbuddy.cn/x", {
    method: "POST",
    headers: {
      Referer: "https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm",
      "X-User-Id": "",
      // 凭据头攻击面：精确大小写与换小写都必须被剥掉
      Authorization: "Bearer evil-token",
      authorization: "Bearer evil-token-lower",
    },
  }, { fetch: fetchImpl });

  const h = seen[0];
  assert.equal(h.Referer, "https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm", "自定义头覆盖 base");
  assert.equal(h["X-User-Id"], "", "自定义头覆盖 base（大小写敏感）");
  assert.equal(h["x-client-platform"], "web", "base 头保留");
  assert.equal(h.Authorization, "Bearer access-token-abc", "Authorization 保留引擎的值");
  assert.equal(h.authorization, undefined, "小写 authorization 被剥掉（不会双发）");

  // 不带自定义头时行为与旧版完全一致（base 头族原样）
  await callJSON(acct, "web", "https://www.workbuddy.cn/y", {}, { fetch: fetchImpl });
  assert.equal(seen[1].Referer, "https://www.workbuddy.cn/profile/growth-center");
  assert.equal(seen[1].Authorization, "Bearer access-token-abc");
});

test("流水线：Library_read 接取 → web 点击点亮 → 进度 0→1 → 领奖成功", async () => {
  const clock = fakeClock(localTime(2026, 10, 31, 10, 0));
  const backend = wbBackend({
    clock,
    tasks: [task("Library_read", { title: "浏览资料库", reward: 100, jump_url: "workbuddy://library" })],
    litRules: { web_element_click: "Library_read" }, // 上游认 web 点击事件 → 推进进度
  });
  const logs = [];
  const res = await runGrowthTasks(makeAcct({ uid: "uid-lib-e2e", nickname: "浏览资料库" }), {
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
    log: (l) => typeof l === "string" && logs.push(l),
    gap: GAP,
  });

  assert.equal(res.ok, true, logs.join("\n"));
  assert.equal(res.earnedCredit, 100);
  assert.equal(res.lit, 1);
  assert.equal(res.claimed, 1);
  assert.ok(logs.join("\n").includes("正在点亮任务 [浏览资料库]（web 点击事件）"), logs.join("\n"));

  // 批次：Library_read 正常进接取批次（不再被 DESKTOP_ONLY 挡）
  const acceptBodies = backend.calls
    .filter((c) => c.path === "/v2/activity/growth/tasks/accept")
    .map((c) => c.body);
  assert.deepEqual(acceptBodies[0].task_codes, ["Library_read"]);

  // 事件与领奖顺序：先 web 点击，进度 0→1，然后领奖
  const libEv = backend.state.reports.find((e) => e.eventCode === "web_element_click");
  assert.ok(libEv, "web 点击事件已发");
  assert.equal(libEv.userId, "uid-lib-e2e");
  const t = backend.state.tasks.find((x) => x.task_code === "Library_read");
  assert.equal(t.current, 1, "进度 0→1");
  assert.deepEqual(backend.state.claims, ["Library_read"], "进度达标后领奖");

  // 红线：点亮（web 域上报）与领奖（chat 域）之间也 ≥ gap
  const reportAt = backend.calls.find((c) => c.path === "/v2/report").at;
  const claimAt = backend.calls.find((c) => c.path.endsWith("/claim")).at;
  assert.ok(claimAt - reportAt >= GAP, `领奖距上报 ${claimAt - reportAt}ms < ${GAP}ms`);
});

test("流水线：Library_read 上报失败 → 不领奖、诚实日志（不硬闯）", async () => {
  const clock = fakeClock(localTime(2026, 10, 31, 10, 0));
  const backend = wbBackend({
    clock,
    tasks: [task("Library_read", { title: "浏览资料库", reward: 100, jump_url: "workbuddy://library" })],
    litRules: {}, // 无规则 → web 点击不推进进度
  });
  const logs = [];
  const res = await runGrowthTasks(makeAcct({ uid: "uid-lib-fail" }), {
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
    log: (l) => typeof l === "string" && logs.push(l),
    gap: GAP,
  });
  assert.equal(res.ok, true);
  assert.equal(res.earnedCredit, 0);
  assert.equal(backend.state.claims.length, 0);
  assert.ok(logs.join("\n").includes("领奖顺延到下次运行"), logs.join("\n"));
});
