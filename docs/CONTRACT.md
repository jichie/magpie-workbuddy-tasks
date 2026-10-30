# magpie-workbuddy-tasks — 内部契约（所有实现必须遵守）

把 workbuddy2api-hub 的「国内版成长/积分任务批量自动化」移植成 magpie 插件。
账号凭据**复用 magpie 已登录的 WorkBuddy 账号**（共享读 `plugin-auth.json`，必要时回写刷新结果）。

## 0. 铁律

1. **不碰对话链路**：本插件不声明 `workbuddy` / `workbuddy-ai` 这两个 provider id，不接管模型、不接管 loader/fetch。对话继续由 `@magpie-community/opencode-workbuddy-auth` 服务。
2. **凭据不外泄**：access/refresh token 永不出现在任何 HTTP 响应、页面、日志里（只显示 `uid`、昵称、掩码）。
3. **单一凭据血统**：刷新 token 后必须原子回写 `plugin-auth.json`，保证社区插件与我们用的是同一对 token，避免 refresh 轮换把对方踢下线。
4. **限速不可省**：任何两次上游调用之间最少 1.0 s；账号之间 1.5 s（手动）/ 2–5 s 抖动（排程）。这是风控红线，不并行跑成长任务。
5. **纯 ESM、零运行时依赖**：只用 Bun/Node 内置（`node:fs`、`node:crypto`、`node:http`、`zlib`）。插件宿主里没有构建步骤。
6. `index.mjs` **只导出一个函数**（magpie 会把入口文件里每个导出函数当插件跑）。辅助导出必须挂在 `export const _internal = {...}` 上。

## 1. 目录结构

```
magpie-workbuddy-tasks/
  package.json
  index.mjs              # 插件入口：provider 声明 + tool 钩子 + 守护进程生命周期
  daemon.mjs             # 常驻 Bun 进程：HTTP 看板 + /api + 排程 + 任务执行
  engine/
    fingerprint.mjs      # derive_id 等设备指纹派生
    identity.mjs         # 三套请求头构造：chat / billing / web
    upstream.mjs         # call()：信封、重试、退避、403/11140、host 回退
    store.mjs            # plugin-auth.json 读写 + 本插件状态文件
    tasks.mjs            # 成长任务：列表/接取/上报/领奖 + run_growth_tasks 流水线
    travel.mjs           # 猫猫旅行闭环 + 夜猫子任务
    runner.mjs           # 跨账号批量编排、job 状态与日志、并发闸门
    schedule.mjs         # 小时窗口排程
    constants.mjs        # TASK_SPECS / 事件池 / 上游常量（唯一事实来源）
  dashboard/             # 独立看板前端（qwenwork 负责，风格对齐 magpie）
    index.html  app.js  style.css  vendor/
  page/                  # magpie 沙箱页（入口卡：状态 + 看板地址 + 跳转）
    index.html  app.js  style.css  icon.svg
  tests/                 # bun test，fetch 全部 mock，不碰真实账号
  README.md  LICENSE  install.md
```

## 2. engine 对外 API（`daemon.mjs`、`index.mjs` 只依赖这些）

```js
// store.mjs
readMagpieConfigDir(env) -> string|null        // directory / $MAGPIE_CONFIG_DIR / ~/.config/magpie
loadAccounts(cfg) -> Account[]                 // 读 plugin-auth.json 的 workbuddy* 条目
saveAccountRefresh(cfg, acctKey, patch) -> void // 原子回写（tmp + rename，保留未知字段，mode 600）
acctKey = "workbuddy" | "workbuddy#xxxxxxxx"   // magpie/OpenCode 的多账号键格式

// Account（我们的内部形状，由 plugin-auth.json 映射而来）
{ key, provider /*workbuddy|workbuddy-ai*/, uid, nickname /*=accountId*/, access, refresh,
  expires /*ms*/, refreshExpiresAt /*ms*/, domain, enterpriseId, tokenType, source,
  isApiKey /*false：我们只吃 oauth 账号*/, tasksEnabled /*来自本插件 state，不是 auth 字段*/ }

// 过滤规则（对齐 hub 的 task_accounts("cn")）
eligibleAccounts(accounts, opts) -> Account[]
  // provider==='workbuddy' && !isApiKey && !enterpriseId && tasksEnabled!==false

// fingerprint.mjs
deriveId(uid, salt) -> "xxxxxxxx-xxxx-4xxx-axxx-xxxxxxxxxxxx"
  // md5(`${salt}:${uid||'anonymous'}`) 后强制 UUIDv4 版本位/变体位：h[12]='4', h[16]='a'
uuidHex() -> 32 hex

// identity.mjs —— 返回 plain object，键名大小写必须逐字一致
chatHeaders(acct, {conversationId,requestId,messageId,rootRequestId}) -> Record<string,string>
billingHeaders(acct) -> Record<string,string>     // 含 X-Machine-ID/X-Session-ID = deriveId
webHeaders(acct) -> Record<string,string>          // 领奖回退用，Origin/Referer=www.workbuddy.cn

// upstream.mjs
callJSON(acct, kind, url, init, opts) -> {ok, status, code, data, msg, raw}
  // kind: 'chat'|'billing'|'web'；统一 {code,msg,data} 信封；code===0 为成功
  // 3 次线性退避重试；403/11140 → {restricted:true}（由 runner 记冷却）
  // chat 主机失败（TLS reset）→ 回退到 https://www.workbuddy.cn，X-Domain 不变
growthBase() -> string      // 默认 https://copilot.tencent.com，可被 cfg/env 覆盖
billBase()  -> "https://www.codebuddy.cn"
webBase()   -> "https://www.workbuddy.cn"

// tasks.mjs
fetchTasks(acct) -> Task[]
  // Task 是**规范形状**（camelCase）：上游 snake_case（task_code/reward_credit/jump_url、
  // 顶层 current/target/status/name）只在这一处归一，全引擎与 daemon 只认这一种拼写，
  // 绝不做双拼写回退链。raw 为非枚举字段（不进 JSON），保留上游原始对象调试用。
  // Task = { code, title, description, jumpUrl,
  //          acceptStatus /*"not_accepted"|"accepted"|"completed"|"claimed"*/,
  //          taskType /*""|"single"|"auto"|…*/, progress:{current,target},
  //          rewardCredit, rewardEnergy, unforgeable, reason, raw?(非枚举) }
acceptTasks(acct, codes) -> {accepted[], already[], failed[]}   // 20 个一批
reportEvents(acct, events) -> boolean
claimTask(acct, code) -> {ok, credit, energy, via /*'chat'|'web'*/, reason}
buildEvent(acct, kind, idx) -> object
runGrowthTasks(acct, opts) -> GrowsResult
  // opts: {gap=1000, claim=true, log(fn), sleep(fn), signal}
  // 阶段：auto 任务先做 → 批量接取+复查+二次补接 → 逐任务点亮(轮询进度) → 领奖

// travel.mjs
runCatTravel(acct, opts) -> TravelResult
runNightTask(acct, opts) -> NightResult       // black_cat，23:00–08:00

// runner.mjs
class JobRunner {
  start(spec) -> job        // spec: {uids[], legs:['growth','travel','night'], claim, trigger:'manual'|'schedule'}
  get(id) -> Job            // Job: {id, state:'queued|running|done|error', startedAt, endedAt,
                            //       totals:{credit,energy,tasksLit,tasksClaimed}, steps:Step[], log:string[]}
  current() -> Job|null     // 同一时刻只允许 1 个 job（全局闸门）
  holds() -> [{uid, releasedAt}] // 风控冷却（403/11140）中的账号；releasedAt = 解除时刻 epoch ms
                                 //（/api/state 的 scheduler.holds 数据源，daemon 负责拼昵称）
}
```

`Step = {uid, nickname, leg, state:'pending|running|ok|skip|fail', detail, credit, energy, at}`

**时间必须可注入**：所有 sleep/now 走 `opts.sleep/opts.now`，测试里换成假时钟，保证「≥1 s 间隔」可断言、测试秒级完成。
**fetch 同样可注入**：runner/daemon 全程把 `opts.fetch` 透传给 upstream（daemon 亦接受 `startDaemon({fetch})`，并注入到快照刷新、手动领奖/接取/签到等每一路引擎调用），测试以假 fetch 替换全部上游调用，零真实网络。跨腿/跨刷新的边界由 runner 在每条腿前补一拍 `gap`（腿内由 `makeCtx.breathe` 保证），使「任意两次上游调用 ≥1 s」在整条链路上成立。

## 3. daemon HTTP API（前端唯一依赖；全部 JSON；除 `/api/hello` 外都要 key）

鉴权：`Authorization: Bearer <daemon key>` 或 `?k=<daemon key>`；key 由 `index.mjs` 生成存 `state/daemon.json`。
绑定：`127.0.0.1` 默认；`--addr 0.0.0.0` 才对外（README 强调只在局域网/VPN 用）。

```
GET  /api/hello                 -> {name, version, ready}
GET  /api/state                 -> {accounts:[{uid,nickname,masked,domain,expiresInMs,expiresInDays,tasksEnabled,eligible,
                                             snapshot:{tasks:[{code,title,acceptStatus,progress:{current,target},
                                             rewardCredit,rewardEnergy,jumpUrl,taskType}],energy,streak,days,updatedISO}}],
                                    scheduler:{enabled,nextRuns[[leg,hour]],lastCycle,
                                               holds:[{uid,nickname,releasedAt}]},
                                    job:Job|null, stats:{creditsToday,energyToday,runs},
                                    settings:{claim,legs,gapMs,hours:{...},host:{chat,bill,web}}}
                                    // snapshot.tasks 的字段名 = §2 的规范 Task（daemon 只做投影，不猜第二种拼写）；
                                    // acceptStatus 是上游字符串状态（"not_accepted"|"accepted"|"completed"|"claimed"）
                                    // scheduler.holds = 真正的风控冷却名单（403/11140），不是「没进 job 的账号」；
                                    // releasedAt 为 ISO 8601 字符串（epoch ms 由 runner.holds() 给出，这里转 ISO）
                                    // tasksEnabled 为生效值：accounts.json 显式条目 > engine/store 的
                                    // tasks-accounts.json > 缺省 true
                                    // expiresInMs = token 原始剩余毫秒（exp - now，可为负 = 已过期）；
                                    // expiresInDays = ceil 口径的天数（Math.max(0,…)），token 还剩
                                    // 2 小时时会显示 1 —— 区分「不足一天」必须用 expiresInMs。
                                    // 两者在 expires 未知（=0）时均为 null。
POST /api/run                   body {uids?:string[], legs?:string[], claim?:bool} -> {job:Job} | 409 {error:"busy"}
POST /api/stop                  -> {job:Job}                                  // 取消当前 job
POST /api/task/claim            body {uid, code} -> {ok, credit, energy, reason}
POST /api/task/accept           body {uid, codes[]} -> AcceptResult
POST /api/checkin               body {uids?:string[]} -> CheckinResult[]     // 仅手动，社区插件负责自动签到
POST /api/settings              body 部分 settings -> 新的 settings（写 state/settings.json）
POST /api/accounts              -> 重新读 plugin-auth.json -> {count, eligible, added[], removed[]}
                                    // count = workbuddy* 全部条目（含 API key，不参与任务）；
                                    // eligible = 可参与任务的 OAuth 账号数（engine.store.eligibleAccounts 口径）
POST /api/account/toggle        body {uid, tasksEnabled:bool} -> account 行（同 /api/state 的 accounts[] 元素）
                                    // 「参与任务」开关（hub 的 task_active）：写 state/accounts.json 并回读；
                                    // 400 缺 uid / tasksEnabled 非布尔，404 账号不存在；
                                    // 不挡运行中的 job（runner 启动时已定名单，只影响下一轮筛选）
GET  /api/jobs/:id              -> Job
GET  /api/history?limit=200     -> 每次尝试一行（对齐 hub 的 /activity/history）
GET  /api/events                -> SSE：{kind:'job'|'step'|'log'|'scheduler', ...}
其余 GET /                      -> dashboard/index.html（静态，同源，无构建）
```

SSE 事件是看板实时进度的唯一来源；断线时看板回退到 `GET /api/state` 轮询 3 s。

## 4. 生命周期（「跟随 magpie」+「插件管理里启停生效」）

- `index.mjs` 被宿主加载时（= 插件已启用且 magpie 用到了它）：
  1. 读 `state/control.json` 的 `desired`（`'on'|'off'`）；
  2. `desired!=='off'` → `ensureDaemon()`：探测端口健康 → 不健康才 spawn `Bun.spawn([bunPath,'daemon.mjs'], {detach:true, stdio:'ignore'})`，env 传 `WB_CONFIG_DIR`、`WB_DAEMON_KEY`、`WB_DAEMON_PORT`；
  3. 注册 `process.on('exit'|'SIGINT'|'SIGTERM')` → 若我们是 owner 则 `POST /api/shutdown` 通知 daemon 退出。
- `daemon.mjs` 自持生命周期，不依赖宿主存活假设：
  1. 每 10 s 读 magpie `plugins.json`：本插件条目 `off:true` → 优雅退出；
  2. 每 15 s TCP 探测 magpie（`MAGPIE_ADDR`/`127.0.0.1:3425`，失败再试 3430）：连续 4 次失败（magpie 停了）→ 退出；
  3. 每 5 s 刷新 `state/daemon.heartbeat`（mtime）+ 写 `state/daemon.json`（pid/port/key/version）；
  4. 收到 `/api/shutdown` 或 `control.json.desired==='off'` → 停排程、停 job、退出。
- 看板的「停止/启动」按钮 = 写 `control.json` + 让 daemon 自杀/由下次宿主加载或 CLI 拉起。
- `control.json` 是唯一意图来源；崩溃重启后按它决定要不要跑，避免僵尸守护进程。

## 5. provider 声明（只为让 magpie 有理由加载我们）

`auth.provider = "workbuddy-tasks"`；`config` 里声明该 provider，`models: {}`（不服务对话）；
`methods: [{type:'api', label:'（无需填写）复用 magpie 已登录的 WorkBuddy 账号', placeholder:'直接留空即可'}]`，
`authorize()` 返回 `{type:'success', key:'shared', metadata:{note:'凭据取自 magpie 的 workbuddy 账号'}}`。
`auth.usage` 显示「可参与任务的账号数 / 今日积分」；`auth.checkin` **不实现**（社区插件已负责每日签到，别抢）。
文档明确：provider id 撞车才会变 `-plugin`；我们用独立 id，不影响 workbuddy 本体。

## 6. `tool` 钩子（MCP `/mcp/magpie/tools`，单次执行上限 55 s）

```
workbuddy_tasks_status()                 -> 账号/排程/当前 job 摘要（纯文本）
workbuddy_tasks_run(uids?, legs?, claim?) -> 启动 job，立即返回 job id（不等待）
workbuddy_tasks_wait(jobId, maxSeconds?)  -> 轮询到完成或超时，返回进度与结算
workbuddy_tasks_list(uid?)                -> 任务表（code/标题/接取状态/进度/奖励）
workbuddy_tasks_claim(uid, code)          -> 单个领奖
```
工具只走 daemon 的 HTTP API（`http://127.0.0.1:<port>`），自己不执行长任务——55 s 装不下一轮批量。

## 7. 上游要点（引擎必须逐字遵守，细节以 `engine/constants.mjs` 落地）

- 聊天侧：`GET {chat}/v2/activity/growth/tasks`、`POST .../tasks/accept`（`{task_codes:[...]}`，20 一批）、
  `POST {chat}/activity/growth/tasks/{code}/claim`（HTTP 400「task not completed」→ 试一次 web 回退）、
  `POST {chat}/v2/report`（**body 是事件数组**）、`GET {chat}/v2/activity/growth/energy`、
  `GET {chat}/activity/growth/streak`、`GET {chat}/activity/growth/heatmap`、
  `POST {chat}/activity/growth/makeup-cards/use`、`GET .../lottery/summary`、`POST .../lottery/draw`、`POST .../redeem`、
  猫猫：`GET .../buddy/travel/status|config`、`POST .../buddy/travel/depart`（body `{location_id}`）、`POST .../buddy/travel/claim`。
- 计费侧：`POST {bill}/billing/meter/claim-gift|claim-compensation`、`POST {bill}/v2/billing/meter/daily-checkin`、
  `POST {chat}/v2/billing/meter/checkin-activity-status`。
- 刷新：`POST {chat} + engine/constants.REFRESH_PATH`，头 `X-Refresh-Token`、`X-Auth-Refresh-Source: workbuddy`、`X-Domain`；响应 `data.accessToken`(+轮换的 `data.refreshToken`)，可能嵌套 `data.data`。
- 事件必须有 `userId`（缺了服务端 200 但静默丢弃）。
- 进度只在**已接取**任务上累计；专家/团队事件按 `(eventCode,id)` 去重 → 必须轮换 id 池；
  `WorkBuddy_Valorant` 钉死真实 id `ex_xQHHD1u5Jkua`，`Expert_lighthouse` 钉 `ex_2cvvUZQhDyeJ`。
- DESKTOP_ONLY 任务（`RichMeow_Chat`/`Library_read`/`Buddy_App`/`Buddy_App_QQ`）与 `unforgeable`
  （`wb_wechat_oa_subscribe_task`/`Expert_Philanthropy`）不上报、接不上，只展示 `jump_url`。
- `first_buddy` 是 `task_type==='auto'`：不许进接取批次，必须先点亮+领奖，否则单任务接取报 `prerequisite not met`。
- 领奖竞态：上报后等 1.5 s，轮询进度最多 6 次（在涨就再等 2.5 s），没到位就把领奖顺延到下一轮，绝不硬闯。

## 8. 测试门槛（没有这些不算完成）

`bun test` 全绿，且**零真实网络**（`fetch` 注入 mock）：
- `deriveId` 对固定 uid 输出稳定、UUIDv4 形状、machine≠session；
- 信封：`code!==0` → 失败；`403/11140` → restricted；TLS reset → 走 web 回退且 `X-Domain` 不变；
- 事件：每种 kind 的 `eventCode` 与必填字段逐个断言；`userId` 必在；
- 流水线：假账号跑完整轮 → 断言「接取在未接之前」「领奖在进度到位之后」「两次上游调用间隔 ≥1000 ms」「DESKTOP_ONLY 被跳过」「auto 任务不进接取批次」；
- 去重：`expert_5` 五个事件用 5 个不同 id；
- store：回写只改 access/refresh/expires，保留未知字段，产出合法 JSON 且权限 600；
- runner：两个 `start()` → 第二个 409；`stop()` 能在步骤边界中止；
- schedule：窗口判定（09:00/21:00 成长+旅行，01:00 夜猫，夜猫只认 23:00–08:00）。
