// runner.mjs —— 跨账号批量编排：job 状态与日志、全局并发闸门、风控冷却
//（holds）、token 临期刷新 + 原子回写（CONTRACT §2 runner 部分、铁律 3/4）。
// 每个账号开跑之前先做一次「每日活跃」上报（engine/daily.mjs，点亮成长中心
// 连登；幂等键 uid→北京日，失败只记日志不阻断腿）。
//
// 同一时刻只允许 1 个 job（current() 全局闸门；第二个 start() 抛 409）。
// 账号与账号之间按 trigger 间隔（manual 1.5 s / schedule 2–5 s 抖动，见
// schedule.accountGapMs）；腿的顺序固定 growth → travel → night，spec.legs
// 是这个顺序的子集。spec.taskCodes（{uid: string[]} | null，任务级勾选）只在
// growth 腿生效。stop() 只在步骤边界生效（abort 信号在腿/账号之间检查）。

import { DEFAULT_GAP_MS, REFRESH_LEAD_MS, RESTRICTED_COOLDOWN_MS } from "./constants.mjs";
import { reportDailyActivity } from "./daily.mjs"; // 每日活跃（点亮成长中心连登，CONTRACT §7）
import { uuidHex } from "./fingerprint.mjs";
import { accountGapMs } from "./schedule.mjs";
import { eligibleAccounts } from "./store.mjs";
import { runGrowthTasks } from "./tasks.mjs";
import { runCatTravel, runNightTask } from "./travel.mjs";
import { clock, refreshAccount } from "./upstream.mjs";

const LEG_ORDER = ["growth", "travel", "night"];

// 任务级勾选（CONTRACT §2/§3）每个账号清单的上限与 daemon.startJob 同款。
const TASK_CODES_CAP = 500;

// normalizeTaskCodes(spec.taskCodes) -> {uid: string[]} | null
// 只认「uid → 非空字符串数组」的普通对象：值清洗（去重、只留非空字符串、上限
// 500）、空清单/非法值丢弃；清洗后没有任何非空清单 → null（= 全部任务）。
// daemon.startJob 已把 /api/run 的两种 body 形状（数组 / 按 uid 对象）归一成
// 这一种再传进来；这里再防御一遍，直接构造 JobRunner 的调用方（测试/嵌入）
// 传脏数据也不会把勾选语义带歪。
function normalizeTaskCodes(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const [uid, codes] of Object.entries(raw)) {
    if (!uid || !Array.isArray(codes)) continue;
    const list = [];
    for (const c of codes) {
      if (typeof c === "string" && c.trim() && !list.includes(c.trim())) list.push(c.trim());
      if (list.length >= TASK_CODES_CAP) break;
    }
    if (list.length) out[String(uid)] = list;
  }
  return Object.keys(out).length ? out : null;
}

function normalizeSpec(spec = {}) {
  const legs = (Array.isArray(spec.legs) && spec.legs.length ? spec.legs : [...LEG_ORDER])
    .filter((l) => LEG_ORDER.includes(l))
    .sort((a, b) => LEG_ORDER.indexOf(a) - LEG_ORDER.indexOf(b)); // 顺序固定 growth→travel→night
  return {
    uids: Array.isArray(spec.uids) && spec.uids.length ? [...spec.uids] : null,
    legs: legs.length ? legs : [...LEG_ORDER],
    claim: spec.claim !== false,
    trigger: spec.trigger === "schedule" ? "schedule" : "manual",
    // 任务级勾选（CONTRACT §3）：{uid: string[]} | null；growth 腿据此只处理
    // 选中任务，travel/night 腿没有任务码，不受影响。
    taskCodes: normalizeTaskCodes(spec.taskCodes),
  };
}

export class JobRunner {
  // opts: {accounts?, loadAccounts?, saveRefresh?, fetch?, now?, sleep?, rand?,
  //        gap?, base?, bases?, env?, spacer?, dailySentMap?, onDailySent?}
  constructor(opts = {}) {
    this.opts = opts;
    this.jobs = new Map();
    this._currentId = null;
    this._ctrls = new Map();
    this._holds = new Map(); // uid -> 解除时刻 ms
    this._seq = 0;
    // 每日活跃的幂等账本（uid -> 北京日键）：daemon 从 state/daily-activity.json
    // 读入同一份对象并经 onDailySent 原子写回；未注入时用实例内存账本（同一
    // runner 的多个 job 之间仍然幂等），跨进程重启的幂等由 daemon 负责。
    this.dailySentMap =
      opts.dailySentMap && typeof opts.dailySentMap === "object" && !Array.isArray(opts.dailySentMap)
        ? opts.dailySentMap
        : {};
  }

  _now() {
    return (this.opts.now ?? clock.now)();
  }

  _sleep(ms) {
    return (this.opts.sleep ?? clock.sleep)(ms);
  }

  get(id) {
    return this.jobs.get(id) ?? null;
  }

  // 同一时刻只允许 1 个 job。
  current() {
    if (!this._currentId) return null;
    const job = this.jobs.get(this._currentId);
    if (!job || job.state === "done" || job.state === "error") return null;
    return job;
  }

  // 当前处于风控冷却（403/11140）的账号列表（/api/state 的 scheduler.holds 数据源）。
  // 返回 [{uid, releasedAt}]：releasedAt 是解除时刻的 epoch 毫秒（注入时钟口径），
  // daemon 负责拼上昵称并转成 ISO 串给看板展示「解除时间」。
  holds() {
    const now = this._now();
    const out = [];
    for (const [uid, until] of this._holds) if (until > now) out.push({ uid, releasedAt: until });
    return out;
  }

  hold(uid, ms = RESTRICTED_COOLDOWN_MS) {
    const until = this._now() + ms;
    const prev = this._holds.get(uid) ?? 0;
    if (until > prev) this._holds.set(uid, until); // 第一次命中才起算，不往后推
  }

  // start(spec) -> job；已在跑时抛 {status:409}。
  start(spec = {}) {
    if (this.current()) {
      throw Object.assign(new Error("another job is already running"), { status: 409, code: "busy" });
    }
    const norm = normalizeSpec(spec);
    const job = {
      id: `job-${++this._seq}-${uuidHex().slice(0, 8)}`,
      state: "queued",
      startedAt: this._now(),
      endedAt: 0,
      totals: { credit: 0, energy: 0, tasksLit: 0, tasksClaimed: 0 },
      steps: [],
      log: [],
      spec: norm,
      // 顶层 trigger = 归一后的 spec.trigger（"schedule" | "manual"）：/api/jobs、
      // 看板 job 卡不必钻 spec 就能读；daemon 历史的口径仍是 job.spec.trigger
      //（这里只是同一份值的顶层冗余，两处永远一致）。
      trigger: norm.trigger,
      stopped: false,
      error: null,
    };
    this.jobs.set(job.id, job);
    this._currentId = job.id;
    const ctrl = new AbortController();
    this._ctrls.set(job.id, ctrl);
    job.signal = ctrl.signal;
    job._done = this._run(job, ctrl)
      .catch((err) => {
        job.error = String(err?.message || err);
        job.state = "error";
        job.endedAt = this._now();
      })
      .finally(() => {
        if (this._currentId === job.id) this._currentId = null;
        this._ctrls.delete(job.id);
      });
    return job;
  }

  // stop(id?) —— 取消当前（或指定）job；在步骤边界生效。
  stop(id = null) {
    const job = id ? this.jobs.get(id) ?? null : this.current();
    if (!job) return null;
    job.stopped = true;
    this._ctrls.get(job.id)?.abort();
    return job;
  }

  // wait(id) —— 等 job 收尾（测试与 workbuddy_tasks_wait 工具用）。
  async wait(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    await job._done;
    return job;
  }

  async _resolveAccounts(job) {
    let base = this.opts.accounts ?? null;
    if (!base && typeof this.opts.loadAccounts === "function") {
      base = await this.opts.loadAccounts();
    }
    const eligible = eligibleAccounts(base ?? []);
    if (job.spec.uids) {
      const want = new Set(job.spec.uids);
      return eligible.filter((a) => want.has(a.uid) || want.has(a.key));
    }
    return eligible;
  }

  // 铁律 3：access 临期就刷新，并原子回写 plugin-auth.json，保证社区插件与
  // 我们用的是同一对 token（refresh 轮换不互踢）。
  async _maybeRefresh(acct, job, logFn) {
    if (!acct.refresh || !acct.expires) return;
    if (acct.expires - this._now() > REFRESH_LEAD_MS) return;
    const res = await refreshAccount(acct, {
      fetch: this.opts.fetch,
      now: this.opts.now,
      sleep: this.opts.sleep,
      env: this.opts.env,
      base: this.opts.base,
      bases: this.opts.bases,
      // 铁律 4：刷新请求也是上游调用 —— 带上全局节流器（daemon 注入的唯一
      // 实例），与快照刷新/手动操作/job 腿共用同一份「上次放行时刻」。
      ...(this.opts.spacer ? { spacer: this.opts.spacer } : {}),
      log: logFn,
      leg: "refresh",
    });
    if (res.ok) {
      Object.assign(acct, res.patch);
      if (typeof this.opts.saveRefresh === "function") {
        try {
          await this.opts.saveRefresh(acct.key, res.patch);
          job.log.push(`· [${acct.uid}] access token 临期，已刷新并回写 plugin-auth.json`);
        } catch (err) {
          job.log.push(`! [${acct.uid}] 刷新成功但回写失败: ${String(err?.message || err)}`);
        }
      } else {
        job.log.push(`· [${acct.uid}] access token 临期，已刷新（未配置回写）`);
      }
    } else {
      job.log.push(`! [${acct.uid}] 刷新失败: ${res.reason}（继续用现有 token）`);
    }
  }

  _step(job, acct, leg, state, detail = "") {
    const step = {
      uid: acct.uid,
      nickname: acct.nickname,
      leg,
      state,
      detail,
      credit: 0,
      energy: 0,
      at: this._now(),
    };
    job.steps.push(step);
    return step;
  }

  _finishStep(job, step, state, detail, credit = 0, energy = 0) {
    step.state = state;
    step.detail = detail;
    step.credit = credit;
    step.energy = energy;
    step.at = this._now();
  }

  async _run(job, ctrl) {
    job.state = "running";
    const accounts = await this._resolveAccounts(job);
    if (!accounts.length) job.log.push("没有可参与任务的账号（workbuddy 个人 OAuth 且未关闭 tasks）");

    for (let ai = 0; ai < accounts.length; ai++) {
      if (ctrl.signal.aborted) break;
      const acct = accounts[ai];

      const holdUntil = this._holds.get(acct.uid) ?? 0;
      if (holdUntil > this._now()) {
        this._step(job, acct, job.spec.legs[0], "skip", `账号风控冷却中（403/11140，至 ${new Date(holdUntil).toISOString()}），本轮跳过`);
        continue;
      }

      const logFn = (line) => {
        if (typeof line === "string") {
          job.log.push(line);
          return;
        }
        // 上游结构化步进：{uid, leg, state, detail}（token 一律不进日志）
        const { uid, leg, state, detail } = line;
        if (state === "restricted") {
          this.hold(uid || acct.uid);
          job.log.push(`! [${uid || acct.uid}/${leg}] 触发风控限制 (403/11140)，冷却 ${Math.round(RESTRICTED_COOLDOWN_MS / 60000)} 分钟`);
        } else if (state === "fail" || state === "retry") {
          job.log.push(`· [${uid || acct.uid}/${leg}] ${state}: ${detail}`);
        }
      };

      await this._maybeRefresh(acct, job, logFn);

      // 每日活跃（CONTRACT §7）：每个账号每个北京日一条 chat 事件（计费域），
      // 点亮成长中心连登。无论本 job 跑哪些腿都先打这一条；跳过/失败只记日志，
      // 绝不阻断后面的腿，更不让 job 失败。上游调用经 reportEvents → 全局节流器
      //（spacer 注入见下），与腿内调用同一条红线。
      {
        const daily = await reportDailyActivity(acct, {
          now: this.opts.now,
          sleep: this.opts.sleep,
          fetch: this.opts.fetch,
          env: this.opts.env,
          base: this.opts.base,
          bases: this.opts.bases,
          gap: this.opts.gap,
          signal: ctrl.signal,
          log: logFn,
          leg: "daily",
          // 铁律 4：每日活跃也是上游调用 —— 带上全局节流器（daemon 注入的
          // 唯一实例），与 job 腿/刷新/快照/手动操作共用「上次放行时刻」。
          ...(this.opts.spacer ? { spacer: this.opts.spacer } : {}),
          // 幂等账本与落盘回调（daemon 注入；未注入时用实例内存账本）
          sentMap: this.dailySentMap,
          ...(typeof this.opts.onDailySent === "function" ? { onSent: this.opts.onDailySent } : {}),
        });
        if (daily.sent) {
          job.log.push(`· [${acct.uid}] 每日活跃：已上报（${daily.key}）`);
        } else if (daily.skipped) {
          job.log.push(`· [${acct.uid}] 每日活跃：今日已报过（${daily.key}），跳过`);
        } else {
          job.log.push(`! [${acct.uid}] 每日活跃：上报失败：${daily.error || "未知原因"}（继续跑腿）`);
        }
      }

      for (const leg of job.spec.legs) {
        if (ctrl.signal.aborted) break;
        // 铁律 4：腿内节奏由 upstream.makeCtx 的 breathe 保证，但「上一条腿 /
        // 刷新调用」与这一条腿分属两个节奏器（legOpts 每腿新建）—— 这里补一拍
        // gap，保证跨边界的两次上游调用也 ≥1s（宁可多等，绝不硬闯）。
        await this._sleep(Math.max(0, Number(this.opts.gap ?? DEFAULT_GAP_MS)));
        const step = this._step(job, acct, leg, "running");
        let res = null;
        try {
          const legOpts = {
            ...this.opts,
            log: logFn,
            claim: job.spec.claim,
            signal: ctrl.signal,
            // 任务级勾选（CONTRACT §3）：growth 腿把该账号的选中清单作为
            // opts.codes 传给 runGrowthTasks；未勾选（taskCodes=null）、该账号
            // 不在映射里或清单为空 → undefined = 全部任务（旧行为）。travel/
            // night 腿没有任务码，不传。
            ...(leg === "growth" && job.spec.taskCodes ? { codes: job.spec.taskCodes[acct.uid] } : {}),
          };
          if (leg === "growth") res = await runGrowthTasks(acct, legOpts);
          else if (leg === "travel") res = await runCatTravel(acct, legOpts);
          else res = await runNightTask(acct, legOpts);
        } catch (err) {
          this._finishStep(job, step, "fail", String(err?.message || err));
          continue;
        }

        if (res?.restricted) {
          this.hold(acct.uid);
          this._finishStep(job, step, "fail", `触发风控限制 (403/11140): ${res.msg || ""}`);
          continue;
        }
        const credit = Number(res?.credit ?? res?.earnedCredit ?? 0) || 0;
        const energy = Number(res?.energy ?? 0) || 0;
        const ok = res?.ok !== false;
        let detail = "";
        if (leg === "growth") {
          detail = `${ok ? "完成" : "失败"}；+${credit} 积分, 点亮 ${res?.lit ?? 0}, 领取 ${res?.claimed ?? 0}`;
        } else if (leg === "travel") {
          detail = res?.msg || (ok ? "完成" : "失败");
        } else {
          detail = (res?.logs ?? []).slice(-1)[0] || (ok ? "完成" : "失败");
        }
        this._finishStep(job, step, ok ? "ok" : "fail", detail, credit, energy);
        if (ok) {
          job.totals.credit += credit;
          job.totals.energy += energy;
          job.totals.tasksLit += Number(res?.lit ?? 0) || 0;
          job.totals.tasksClaimed += Number(res?.claimed ?? 0) || 0;
        }
      }

      // 账号间隔：manual 1.5 s / schedule 2–5 s 抖动（铁律 4）。最后一个账号
      // 之后不再空等。
      if (ai < accounts.length - 1 && !ctrl.signal.aborted) {
        await this._sleep(accountGapMs(job.spec.trigger, this._now(), this.opts.rand));
      }
    }

    if (ctrl.signal.aborted) job.log.push("已按要求取消（步骤边界生效）");
    if (job.state !== "error") {
      job.state = "done";
      job.endedAt = this._now();
    }
  }
}
