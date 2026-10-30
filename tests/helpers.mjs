// tests/helpers.mjs —— 测试共用工具：假时钟 + 有状态的 WorkBuddy 假后端。
// 全程零真实网络；所有等待走假时钟（sleep 只拨表，不真等）。

export function fakeClock(startMs) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
    get time() {
      return t;
    },
  };
}

// 本地某天某时的 epoch 毫秒（与时区无关的确定性测试时间）。
export function localTime(y, monthIndex, day, hour, minute = 0) {
  return new Date(y, monthIndex, day, hour, minute, 0, 0).getTime();
}

function cloneTask(t) {
  // 内部形态：current/target 拍平（引擎看到的列表响应里它们住在 progress 里）
  return {
    task_code: t.task_code,
    title: t.title ?? t.task_code,
    description: t.description ?? "",
    jump_url: t.jump_url ?? "",
    accept_status: t.accept_status ?? t.status ?? "not_accepted",
    task_type: t.task_type ?? "single",
    reward_credit: t.reward_credit ?? 100,
    reward_energy: t.reward_energy ?? 0,
    current: t.progress?.current ?? t.current ?? 0,
    target: t.progress?.target ?? t.target ?? 1,
  };
}

// wbBackend 造一个记录全部请求的假 WorkBuddy：
// - state.tasks 是活状态：accept 会翻 accept_status，report 按 litRules 推进
//   current（到 target 且已接取则 completed），claim 在达标时翻 claimed；
// - litRules: { eventCode: taskCode | [taskCode...] }（同 eventCode 多任务时
//   依序找第一个未满的）；
// - failAcceptOnce: 第一次 accept 整批回信封错误（测二次补接）；
// - buddyDepartFails: 前 N 次 depart 回 400 "no active buddy"（测补 first_buddy
//   后重试）；
// - chatClaimAlways400: chat 域领奖永远 400（测 web 回退）；
// - restrictedUids: 这些 uid 一律 403/code 11140；
// - refreshTokens: 刷新路由按序吐 {accessToken, ...}。
export function wbBackend(opts = {}) {
  const clock = opts.clock;
  const calls = [];
  const litRules = opts.litRules ?? {};
  const state = {
    tasks: (opts.tasks ?? []).map((t) => ({ ...cloneTask(t) })),
    travel: opts.travel ? { ...opts.travel } : { state: "traveling" },
    claims: [],
    acceptCalls: 0,
    reports: [],
    bodies: [],
    failAcceptOnce: opts.failAcceptOnce ?? false,
    buddyDepartFails: opts.buddyDepartFails ?? 0,
    chatClaimAlways400: opts.chatClaimAlways400 ?? false,
    restrictedUids: new Set(opts.restrictedUids ?? []),
    refreshTokens: [...(opts.refreshTokens ?? [])],
    webClaims: 0,
  };
  const find = (code) => state.tasks.find((t) => t.task_code === code);
  const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = String(init.method || "GET").toUpperCase();
    const headers = init.headers ?? {};
    const uid = headers["X-User-Id"] ?? "";
    let body = null;
    if (typeof init.body === "string" && init.body.length) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, host: u.host, path: u.pathname, method, headers, body, at: clock.now(), uid });

    if (state.restrictedUids.has(uid)) {
      return respond(403, { code: 11140, msg: "request illegal" });
    }

    if (u.pathname.endsWith("/refresh")) {
      const tok = state.refreshTokens.shift();
      if (!tok) return respond(401, { code: 12153, msg: "refresh token failed: invalid_grant" });
      return respond(200, { code: 0, data: tok });
    }

    if (u.pathname === "/v2/activity/growth/tasks") {
      const tasks = state.tasks.map((t) => ({
        task_code: t.task_code,
        title: t.title,
        description: t.description,
        jump_url: t.jump_url,
        accept_status: t.accept_status,
        task_type: t.task_type,
        progress: { current: t.current, target: t.target },
        reward_credit: t.reward_credit,
        reward_energy: t.reward_energy,
      }));
      return respond(200, { code: 0, data: { tasks } });
    }

    if (u.pathname === "/v2/activity/growth/tasks/accept") {
      state.acceptCalls += 1;
      if (state.failAcceptOnce && state.acceptCalls === 1) {
        return respond(200, { code: 500, msg: "upstream hiccup" });
      }
      const results = (body?.task_codes ?? []).map((code) => {
        const t = find(code);
        if (!t) return { task_code: code, status: "unknown_task", message: "no such task" };
        if (t.accept_status === "not_accepted") {
          t.accept_status = "accepted";
          return { task_code: code, status: "accepted" };
        }
        return { task_code: code, status: "already_accepted" };
      });
      return respond(200, { code: 0, data: { results } });
    }

    if (u.pathname === "/v2/report") {
      state.bodies.push(body);
      for (const ev of Array.isArray(body) ? body : [body]) {
        state.reports.push(ev);
        const rule = litRules[ev.eventCode];
        const targets = Array.isArray(rule) ? rule : rule ? [rule] : [];
        for (const code of targets) {
          const t = find(code);
          if (!t || (t.current ?? 0) >= (t.target ?? 1)) continue;
          t.current = (t.current ?? 0) + 1;
          // auto 任务（first_buddy）不需要接取也能点亮完成
          if (t.current >= (t.target ?? 1) && (t.accept_status !== "not_accepted" || t.task_type === "auto")) {
            t.accept_status = "completed";
          }
          break; // 一个事件只推一个任务
        }
      }
      return respond(200, { code: 0, data: {} });
    }

    const claimMatch = /^\/activity\/growth\/tasks\/([^/]+)\/claim$/.exec(u.pathname);
    if (claimMatch) {
      const code = decodeURIComponent(claimMatch[1]);
      const onWebHost = u.host === "www.workbuddy.cn";
      if (!onWebHost && state.chatClaimAlways400) {
        return respond(400, { code: 400, msg: "task not completed" });
      }
      if (onWebHost) state.webClaims += 1;
      const t = find(code);
      if (t && (t.current ?? 0) >= (t.target ?? 1) && (t.accept_status !== "not_accepted" || t.task_type === "auto")) {
        t.accept_status = "claimed";
        state.claims.push(code);
        return respond(200, { code: 0, data: { credit: t.reward_credit ?? 0, energy: t.reward_energy ?? 0 } });
      }
      return respond(400, { code: 400, msg: "task not completed" });
    }

    if (u.pathname === "/v2/activity/growth/energy") {
      return respond(200, { code: 0, data: { balance: 42 } });
    }

    if (u.pathname === "/activity/growth/buddy/travel/status") {
      return respond(200, { code: 0, data: state.travel });
    }

    if (u.pathname === "/activity/growth/buddy/travel/config") {
      return respond(200, { code: 0, data: { locations: [{ id: 1, name: "外滩" }, { id: 2, name: "西湖" }] } });
    }

    if (u.pathname === "/activity/growth/buddy/travel/depart") {
      if (state.buddyDepartFails > 0) {
        state.buddyDepartFails -= 1;
        return respond(400, { code: 400, msg: "no active buddy" });
      }
      state.travel = { state: "traveling" };
      return respond(200, { code: 0, data: { location: { id: body?.location_id ?? 1, name: "外滩" } } });
    }

    if (u.pathname === "/activity/growth/buddy/travel/claim") {
      state.travel = { state: "idle" };
      return respond(200, { code: 0, data: { reward_credit: 20 } });
    }

    return respond(404, { code: -1, msg: "not found" });
  };

  return { fetchImpl, calls, state };
}

// 构造 Account（引擎内部形状）。
export function makeAcct(overrides = {}) {
  return {
    key: "workbuddy",
    provider: "workbuddy",
    uid: "u-12345678",
    nickname: "测试账号",
    access: "access-token-abc",
    refresh: "refresh-token-xyz",
    expires: 0,
    refreshExpiresAt: 0,
    domain: "",
    enterpriseId: "",
    tokenType: "",
    source: "oauth",
    isApiKey: false,
    tasksEnabled: true,
    ...overrides,
  };
}

// 任务种子的简写。
export function task(code, extra = {}) {
  return {
    task_code: code,
    title: extra.title ?? code,
    description: "",
    jump_url: extra.jump_url ?? "",
    accept_status: extra.status ?? "not_accepted",
    task_type: extra.task_type ?? "single",
    progress: { current: extra.current ?? 0, target: extra.target ?? 1 },
    reward_credit: extra.reward ?? 100,
    reward_energy: extra.reward_energy ?? 0,
  };
}
