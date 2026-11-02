# magpie-workbuddy-tasks — 内部契约（所有实现必须遵守）

把 workbuddy2api-hub 的「国内版成长/积分任务批量自动化」移植成 magpie 插件。
账号凭据**复用 magpie 已登录的 WorkBuddy 账号**（共享读 `plugin-auth.json`，必要时回写刷新结果）。

## 0. 铁律

1. **不碰对话链路**：本插件不声明 `workbuddy` / `workbuddy-ai` 这两个 provider id，不接管模型、不接管 loader/fetch。对话继续由 `@magpie-community/opencode-workbuddy-auth` 服务。
2. **凭据不外泄**：access/refresh token 永不出现在任何 HTTP 响应、页面、日志里（只显示 `uid`、昵称、掩码）。
3. **单一凭据血统**：刷新 token 后必须原子回写 `plugin-auth.json`，保证社区插件与我们用的是同一对 token，避免 refresh 轮换把对方踢下线。
4. **限速不可省**：任何两次上游调用之间最少 1.0 s；账号之间 1.5 s（手动）/ 2–5 s 抖动（排程）。这是风控红线，不并行跑成长任务。**全局节流器的唯一归属与并发策略**：daemon 进程创建唯一的 `engine/upstream.makeSpacer` 实例（gap 动态取 `settings.gapMs`），经 `engineOpts()` 与 runner ctx 注入**所有**打上游的路径——job 腿、token 临期刷新（`refreshAccount`）、快照刷新（`finalizeJob → refreshSnapshots` 与 `GET /api/state?refresh=`）、手动操作（claim/accept/checkin）；任何路径都不得新建 ctx 后绕开它直接打上游。spacer 记录「上次上游调用真正发出的时刻」，调用前先补足到 ≥gap（跨路径对齐，start-to-start 口径），并把并发入口**排队串行**（前一个调用完整结束后才放行下一个，绝不允许两个调用同时在途）。固定 sleep（腿间 gap、账号间隔、manualOp 的 1 s）保留作为节奏设计，但跨路径的正确性由 spacer 保证——各路径的等待窗重叠时后者等待，而不是贴着发。同一逻辑调用内的重试退避与主机回退同样算「两次上游调用」，间隔同样 ≥1.0 s。
5. **纯 ESM、零运行时依赖**：只用 Bun/Node 内置（`node:fs`、`node:crypto`、`node:http`、`zlib`）。插件宿主里没有构建步骤。
6. `index.mjs` **只导出一个函数**（magpie 会把入口文件里每个导出函数当插件跑）。辅助导出必须挂在 `export const _internal = {...}` 上。

## 1. 目录结构

```
magpie-workbuddy-tasks/
  package.json
  index.mjs              # 插件入口：tool 钩子 + 守护进程生命周期（不声明 provider，§5）
  daemon.mjs             # 常驻 Bun 进程：HTTP 看板 + /api + 排程 + 任务执行
  engine/
    fingerprint.mjs      # derive_id 等设备指纹派生
    identity.mjs         # 三套请求头构造：chat / billing / web
    upstream.mjs         # call()：信封、重试、退避、403/11140、host 回退
    store.mjs            # plugin-auth.json 读写 + 本插件状态文件
    tasks.mjs            # 成长任务：列表/接取/上报/领奖 + run_growth_tasks 流水线
    taskkind.mjs         # 任务 → kind 解析（P0-1）：jump_url 派生专家 id、未收录标注、
                         # canAccept/canLight/pinnedExpertId 收敛结论（唯一判断源）
    travel.mjs           # 猫猫旅行闭环 + 夜猫子任务
    daily.mjs            # 每日活跃上报（点亮成长中心连登；uid→北京日幂等）
    credits.mjs          # 积分余额 + 套餐权益包明细（只读；fetchCredits）
    runner.mjs           # 跨账号批量编排、job 状态与日志、并发闸门
    schedule.mjs         # 小时窗口排程
    constants.mjs        # TASK_SPECS / 事件池 / 上游常量（唯一事实来源）
  dashboard/             # 独立看板前端（qwenwork 负责，风格对齐 magpie）
    index.html  app.js  style.css  vendor/
  page/                  # magpie 沙箱页（入口卡：状态 + 看板地址 + 跳转）
    index.html  app.js  style.css  logo-mark.png
  tests/                 # bun test，fetch 全部 mock，不碰真实账号
  README.md  LICENSE  install.md
```

## 2. engine 对外 API（`daemon.mjs`、`index.mjs` 只依赖这些）

```js
// store.mjs
readMagpieConfigDir(env) -> string|null        // directory / $MAGPIE_CONFIG_DIR / ~/.config/magpie
loadAccounts(cfg) -> Account[]                 // 读 plugin-auth.json 的 workbuddy* 条目
                                               // **层级边界（纯国内版口径）**：这里原样返回全部
                                               // workbuddy* 条目（含国际版 workbuddy-ai）——accountio
                                               // 导入合并与导出 realm=intl 逃生口要全量数据；
                                               // daemon 在使用侧统一经自己的 loadAccountsCn()
                                               // （只留 provider==="workbuddy"）做列表/统计/排程/
                                               // 运行取数，别把「只出国内版」的过滤下沉到本层
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
  // 重试/回退也是「两次上游调用」：任意相邻两次 HTTP 尝试间隔 ≥ gap（铁律 4）
makeSpacer({now, sleep, gap}) -> {run(fn), peekLast()}
  // 跨路径全局节流器（铁律 4 的归属）：记录「上次调用放行时刻」，调用先补足
  // ≥gap 并排队串行（前一个完整结束才放行下一个，绝不在途并行）。归属与注入
  // 点见 §0.4 —— engine 不建进程级单例（各测试假时钟互不污染），不带 spacer
  // 的调用行为与旧版完全一致
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
reportLibraryEvent(acct) -> boolean
  // 「浏览资料库」（Library_read，kind:"library"）的点亮事件：web_element_click
  // 打 **web 域** /v2/report（webHeaders + 覆盖 Referer=资料库文档 URL、
  // User-Agent=WEB_UA、X-User-Id=空串；Authorization 保留）。字段与头逐字见
  // engine/tasks.mjs；callJSON 的 init.headers 支持**大小写敏感**合并自定义头，
  // 唯 Authorization 不可被覆盖（凭据头，无论大小写怎么写都保留引擎的值）。
claimTask(acct, code) -> {ok, credit, energy, via /*'chat'|'web'*/, reason}
buildEvent(acct, kind, idx) -> object
runGrowthTasks(acct, opts) -> GrowsResult
  // opts.codes?: string[] —— 任务级勾选（§3/§6/§7）：非空数组 = 只对选中任务
  // 接取/点亮/领奖；每次 fetchTasks 后都按选中集合过滤；缺失 code 警告跳过；
  // 未传/空数组 = 全部任务（旧行为）

// daily.mjs
beijingDayKey(nowMs) -> "YYYY-MM-DD"      // 北京日键（UTC+8；UTC 16:00 翻日）
reportDailyActivity(acct, opts) -> {sent:true,key} | {sent:false,skipped:true,key}
                                         // | {sent:false,error}   // 不抛
  // 每个账号每个**北京日**一条 chat 事件（buildEvent "chat"），打**计费域**
  // billBase()/v2/report（不是 chat 域！）—— 点亮成长中心连登。
  // opts.sentMap: {uid:"YYYY-MM-DD"} 幂等账本（命中今天 → {sent:false,skipped:true}，
  // 零上游调用）；成功才写 sentMap[uid]=key 并回调 opts.onSent?.(uid,key)；
  // 失败/异常返回 {sent:false,error} 不抛（调用方记日志继续）。经 reportEvents
  // → ctx.breathe/spacer，铁律 4 照常生效，绝不绕开。

// credits.mjs —— 国内版「积分余额 + 套餐权益包明细」（只读，绝不发布 token）
fetchCredits(acct, opts) -> {ok:true, credits} | {ok:false, error, needRelogin?}
  // 三个 billing 上游（POST，billing 头族 + X-Client-Platform: web）：
  //   {bill}/billing/meter/get-user-resource-summary        body "{}"
  //   {bill}/billing/meter/get-user-resource-free-packages  body {PackageCodes,PageNumber:1,PageSize:200,Status:[0]}
  //   {bill}/billing/meter/get-user-resource-paid-packages  body {同上, Status:[0,3], NeedRenewInfo:true}
  // PackageCodes = summary data.Packages[].PackageCode 去重；free/paid 单个失败
  // 忽略该来源（不整体失败）；summary 失败 → {ok:false,error}，401/403 或错误
  // 文本含「登录/过期/token/Authorization」→ needRelogin:true。每次调用前
  // ctx.breathe + callJSON 经全局 spacer（铁律 4），三次调用彼此 ≥1s。
  // credits 形状（camelCase，数值 round 2 位）：
  //   {remain, used, size, usedPercent/remainPercent（"x.x%"；size=0 → 0.0%/100.0%）,
  //    isPaidUser（null=summary 没答，不要瞎判免费）,
  //    tier {paid,package,packageCode,protectedPrice,trial}|null,
  //    earliestExpiring {name,packageCode,remain,cycleEndTime,daysLeft}|null
  //      （packages 里 remain>0 && !isExpired && daysLeft!=null，按 daysLeft 升序第一个）,
  //    packages[{name,packageCode,productName,subProductName,grantReason,resourceId,
  //              dealName,createTime,remain,used,size,unit,inUsage,autoRenew,
  //              cycleStartTime,cycleEndTime,expireTime,noExpiry,daysLeft,isExpired,status}],
  //    updatedAt（epoch ms）, updatedIso（北京 "YYYY-MM-DD HH:mm:ss"）}
  // 解析规则（wb_accounts._parse_package_account 口径，字段名保持上游原样）：
  //   free+paid 的 Account 按 AccountId 去重；size/remain/used 按
  //   Precise→普通四级键名取值，缺的量用另两个补（size>0 且 used<=0 →
  //   used=size-remain；size>0 且 remain<=0 → remain=size-used，下限 0）；
  //   grantReason 取 AccountAttributes 里 Key==="grantReason" 的 Value；
  //   包明细为空且 summary.Packages 有值时用 CycleTotal/Remain/UsedCapacity 汇总。
  // 时区红线（与 daily.beijingDayKey 同源）：容器时区可能是 UTC —— naive 字符串
  // 时间（CycleEndTime/ExpiredTime 一族）一律按北京时间（+08:00）解析成 epoch ms
  // 再算 daysLeft（1 位小数；diff<0 → isExpired）；到期优先认 DeductionEndTime
  //（epoch ms → 北京文本，免费包/体验版的 CycleEndTime 只是月度计费边界，能差
  //  8 年）；diff > 730 天 → noExpiry=true（不参与倒计时）。epoch → 文本同样固定
  // 北京时区，绝不用宿主本地时区。
epochToBeijingText(ms) -> "YYYY-MM-DD HH:mm:ss"  // 北京时区文本
beijingTextToMs(text) -> ms|null                 // naive 字符串按 +08:00 解析；解不出 null
tierFromSummary(data) -> {paid,package,packageCode,protectedPrice,trial}|null
                                                 // 无 IsPaidUser 字段 → null（「没答上来」绝不记成「免费」）

// taskkind.mjs —— 任务 → kind 解析（fetchTasks 的 unforgeable/reason、流水线的
// 接取/点亮决策、daemon.snapTask 的 6 个下发字段，全部出自这里的唯一判断源）
resolveTaskKind(t) -> { source: "spec"|"jump_url"|"none", kind, spec,
                        desktopOnly, desktopReason, unforgeable, reason,
                        acceptible, lightable /*kind 级（不含状态）*/,
                        canAccept, canLight /*收敛结论（含状态）*/,
                        pinnedExpertId, expertName }
  // 输入是规范 Task（容忍 raw 拼写）；只读 code/jumpUrl/acceptStatus/taskType/title
  // 优先级：① TASK_SPECS 命中（钉死 id 不被 jump_url 覆盖）
  //        ② 未命中但 jump_url 能解出 expertId=ex_… → expert 类可点亮，
  //          事件 id 钉在解析出的 id 上（expertType=agent，沿用 expert_actual_use）
  //        ③ 未命中且派生不出 → unforgeable:true + reason:"未收录任务"，
  //          绝不进接取批次（防「接了一大堆却一项不亮、领奖报 task not completed」）
deriveExpertIdFromJumpUrl(jumpUrl) -> string  // URL 解码后取 expertId=ex_…；解不出 ""
expertNameFromTitle(title) -> string           // 任务标题「」内的专家名（事件展示字段）
  // opts: {gap=1000, claim=true, log(fn), sleep(fn), signal}
  // 阶段：auto 任务先做 → 批量接取+复查+二次补接 → 逐任务点亮(轮询进度) → 领奖

// travel.mjs
runCatTravel(acct, opts) -> TravelResult
runNightTask(acct, opts) -> NightResult       // black_cat，23:00–08:00（北京时间）
                                              // 01:00 清单暂缺 black_cat 时按 5/15/30s
                                              // 重试（共 4 次、约 50s）；仍没有 → ok:true +
                                              // 日志「未下发，跳过」，不记失败、不领奖

// runner.mjs
class JobRunner {
  start(spec) -> job        // spec: {uids[], legs:['growth','travel','night'], claim,
                            //       trigger:'manual'|'schedule',
                            //       taskCodes:{uid:string[]}|null}  // 任务级勾选（§3）：
                            //       growth 腿把 taskCodes[uid] 作为 opts.codes 传给
                            //       runGrowthTasks；null/缺 uid/空清单 = 全部任务。
                            //       归一化在两处设防：daemon.startJob（API 边界，§3）
                            //       与 runner.normalizeSpec（直接构造 runner 的调用方）
  get(id) -> Job            // Job: {id, state:'queued|running|done|error', startedAt, endedAt,
                            //       trigger:'manual'|'schedule',   // = spec.trigger 的顶层冗余
                            //       （start() 归一后写两处，永远一致；消费方直接读顶层即可）
                            //       totals:{credit,energy,tasksLit,tasksClaimed}, steps:Step[], log:string[]}
  current() -> Job|null     // 同一时刻只允许 1 个 job（全局闸门）
  holds() -> [{uid, releasedAt}] // 风控冷却（403/11140）中的账号；releasedAt = 解除时刻 epoch ms
                                 //（/api/state 的 scheduler.holds 数据源，daemon 负责拼昵称）
  // 构造 opts 另认：dailySentMap（uid→北京日键的幂等账本，daemon 从
  // state/daily-activity.json 读入同一份对象）与 onDailySent(uid,key)（成功落盘
  // 回调）。每个账号开跑（任何腿）之前 runner 固定调一次 engine/daily.
  // reportDailyActivity：跳过/失败只写一行 job.log（「每日活跃：已上报 /
  // 今日已报过 / 上报失败：…」），绝不阻断腿、绝不 fail job。
}
```

`Step = {uid, nickname, leg, state:'pending|running|ok|skip|fail', detail, credit, energy, at}`

**时间必须可注入**：所有 sleep/now 走 `opts.sleep/opts.now`，测试里换成假时钟，保证「≥1 s 间隔」可断言、测试秒级完成。
**fetch 同样可注入**：runner/daemon 全程把 `opts.fetch` 透传给 upstream（daemon 亦接受 `startDaemon({fetch})`，并注入到快照刷新、手动领奖/接取/签到等每一路引擎调用），测试以假 fetch 替换全部上游调用，零真实网络。「任意两次上游调用 ≥1 s」在整条链路上成立由两道机制共同保证：腿内由 `makeCtx.breathe`、跨腿由 runner 每腿前补一拍 `gap`；跨路径（job 腿 × 快照刷新 × 手动操作 × token 刷新）由 §0.4 的全局节流器 `makeSpacer` 排队对齐——e2e 曾抓到后者缺失时 0ms 间隔的偶发失败，回归钉死在 `tests/upstream-spacer.test.mjs` 与 `tests-e2e/boundary-throttle.test.mjs`。

## 3. daemon HTTP API（前端唯一依赖；全部 JSON；**免密钥**）

鉴权（**用户明确要求「全部改成免密钥」**，局域网自建工具口径）：**所有路由一律不需要密钥**——包括
`POST /api/run`、`/api/stop`、`/api/task/claim`、`/api/task/accept`、`/api/checkin`、`/api/settings`、
`/api/account/toggle`、`/api/shutdown`、导入确认写盘（`confirm:true`）、含 token 的导出（`secrets=1`）、
SSE 与静态资源。鉴权由**网络边界**负责：默认只绑 `127.0.0.1`；绑定 `0.0.0.0`/`::` 即暴露到容器网桥/
局域网——同一局域网内任何主机都能触发批量任务、写入 `plugin-auth.json`（导入确认）、下载含
accessToken/refreshToken 的导出并关停守护进程（README 安全段如实写明，不粉饰）。

- **单一真相**在 `daemon.mjs` 的 `routeNeedsKey()`（导出供测试）：**恒返回 `false`**，函数注释写明
  「用户明确要求免密钥、局域网自建工具、鉴权由网络边界负责」。若将来要重新引入鉴权，只改这一处。
- `API_ROUTE_AUTH` 保留为**路由登记表**（每条 `{method, re, path, note}`）：任何新路由都必须登记进表；
  「全路由免密钥清单测试」（tests-shell/account-routes.test.mjs）遍历全表证明不存在需要密钥的路径。
- **向后兼容**：旧调用带 `Authorization: Bearer <…>` 或 `?k=<…>` 照常接受（不做任何校验、不报
  400/401），升级期平滑过渡；新集成不需要带。
- `state/daemon.json` 仍写 `key` 字段（0600；`index.mjs`/`lifecycle.mjs` 的探测逻辑与老看板依赖该
  字段存在），**但不再作为访问凭据，任何接口都不校验它**；`KEY_REQUIRED_MSG` 与一切「需要密钥」
  文案已删除，日志与静态兜底页如实描述「无鉴权，靠网络边界（默认只绑 127.0.0.1）」。

**纯国内版口径（用户明确要求「国际版账号彻底不出现」）**：daemon 的**列表/统计/快照/排程/运行/
单账号操作**统一经 daemon 侧唯一的取数过滤 `loadAccountsCn()`（只留 `provider === "workbuddy"`）；
`workbuddy-ai`（国际版）不进 `/api/state` 的 `accounts[]`、不进快照/汇总/统计、不进任何 job。
**过滤只发生在 daemon 使用侧**——`engine/store.loadAccounts` 行为不变（仍返回全部 workbuddy\*
条目：accountio 的导入合并与导出 `realm=intl` 逃生口要全量数据），**别把「只出国内版」的过滤
下沉进 store 层**。诊断计数：`/api/state` 顶层 `intlSkipped:{count,note}` 只给数量与说明，
绝不列出国际版账号内容（uid/昵称/域名都不给）。

绑定：`127.0.0.1` 默认；链路 `options.listenAddress → WB_DAEMON_ADDR → --addr`，设 `0.0.0.0`/`::` 才对外
（**免密钥口径下这就是唯一的安全边界**：对外绑定 = 同一局域网内任何主机都能执行上文全部路由，
包括写入凭据与下载 token；README 安全段如实写明风险与建议；真实绑定 host 由 daemon 心跳写进
`daemon.json` 的 `host`，三处日志/提示同口径）。

```
GET  /api/hello                 -> {name, version, ready}
GET  /api/state                 -> {serveUrl, bindHost, port, reachableHint,
                                    intlSkipped:{count,note},   // 只读诊断计数：国际版账号
                                    // 的数量与去向说明（note="本插件只服务国内版 workbuddy，
                                    // 国际版账号不列出、不参与任务、不默认导出"）；绝不列出
                                    // 国际版账号内容（uid/昵称/域名都不给）
                                    accounts:[{uid,nickname,masked,domain,expiresInMs,expiresInDays,tasksEnabled,
                                             imported,eligible,
                                             credits,   // 该账号的积分缓存（state/credits.json 投影，
                                                        // engine/credits.fetchCredits 的 credits 形状，
                                                        // §2）；没拉过/缓存损坏 → null。只读投影：
                                                        // /api/state 绝不为此打上游
                                             snapshot:{tasks:[{code,title,acceptStatus,progress:{current,target},
                                             rewardCredit,rewardEnergy,jumpUrl,taskType,
                                             desktopOnly,unforgeable,reason,canAccept,canLight,pinnedExpertId}],
                                             energy,streak,days,updatedISO}}],
                                    // accounts[] 只含 provider==="workbuddy"（国内版）条目；
                                    // 国际版 workbuddy-ai 一律不出现（见上方纯国内版口径）
                                    scheduler:{enabled,nextRuns[[leg,hour]],lastCycle,
                                               holds:[{uid,nickname,releasedAt}]},
                                    job:Job|null, stats:{creditsToday,energyToday,runs},
                                    settings:{claim,legs,gapMs,hours:{travel,night},host:{chat,bill,web}}}
                                    // hours 只有 travel|night 两个键（排程不再触发 growth，§7/§8）；
                                    // 旧 settings.json 里的 hours.growth 在读取时丢弃。legs
                                    // （手动默认腿）仍可含 growth。
                                    // bindHost/port/reachableHint：守护进程真实绑定的 host 与端口
                                    // （host 来自 daemon.json，由 daemon 心跳写入；port 为实际绑定端口，
                                    // 被占用顺延后可能与配置值不同）。bindHost 为 0.0.0.0/:: 时
                                    // reachableHint = 「仅容器网桥/局域网可达，请用 SSH 隧道或局域网地址访问，
                                    // 切勿发布到公网」（lifecycle.bindHint 的同一句口径），否则为 ""。
                                    // 两个字段保留原语义（向后兼容），但不再是前端显示地址的来源。
                                    //
                                    // serveUrl：接口保留的访问地址，形如
                                    // http://192.0.2.10:4390/。0.0.0.0/:: 是监听值不是访问值，
                                    // serveUrl 绝不返回它们。看板 UI 已整块移除地址块，
                                    // 不再展示/复制 serveUrl；字段留给宿主、CLI 与其他集成使用。
                                    // 取值链按序取第一个可用项：
                                    //   ① 当前请求的 Host 头——用户实际用来访问的地址，最准确
                                    //     （显式端口进 URL；无显式端口 = 走 80/默认映射，URL 不带端口）
                                    //   ② 环境变量 MAGPIE_PUBLIC_URL（magpie 对外共享地址，运维显式声明）
                                    //     的 hostname + 守护进程自己的端口（不用该 URL 里的端口）
                                    //   ③ bindHost（仅当是具体地址，0.0.0.0/:: 通配不用）
                                    //   ④ 兜底 http://127.0.0.1:<port>/
                                    // Host 头是外部输入，必须过白名单（daemon.sanitizeServeHost）：
                                    // 字符集只允许 字母数字 . - _ [ ] :，总长 ≤255、host ≤253，
                                    // 端口 1-65535 无前导零；host 部分必须是 IPv4 字面量 | localhost |
                                    // 单标签 LAN 主机名 | [IPv6] 字面量，带点的非 IPv4（evil.com 这类
                                    // 公网/伪域名）与含 0.0.0.0/::/* 的值一律拒绝、落到下一级。
                                    // MAGPIE_PUBLIC_URL 是配置输入，放行公网域名，但同样拒绝通配/
                                    // 监听值（IPv6 字面量经 URL 规范化必含 ::，同样拒绝落级）。
                                    // serveUrl 只含 scheme://host[:port]/——**绝不拼入 key
                                    // 或任何查询串**，也绝不返回含 0.0.0.0/::/* 的地址（daemon 的 key
                                    // 字段绝不出现在任何响应、页面或日志里，它只在 state/daemon.json，
                                    // 0600，向后兼容保留、不是访问凭据——API 全部免密钥）。
                                    // snapshot.tasks 的字段名 = §2 的规范 Task（daemon 只做投影，不猜第二种拼写）；
                                    // acceptStatus 是上游字符串状态（"not_accepted"|"accepted"|"completed"|"claimed"）
                                    // P0-2 判断字段（六个都出自 engine/taskkind.resolveTaskKind，
                                    // 与 fetchTasks 的 unforgeable/reason、流水线决策同一判断源；
                                    // 前端据此渲染，不要再用 jumpUrl 非空猜「需桌面端完成」——
                                    // 真实数据 19 项全部有非空 jumpUrl）：
                                    //   desktopOnly —— DESKTOP_ONLY_TASKS 命中
                                    //     （RichMeow_Chat/Buddy_App/Buddy_App_QQ 这类
                                    //     伪造事件不推进、领奖必 400 的；Library_read
                                    //     已改走 web 点击事件点亮，**不在**此列），
                                    //     与 jumpUrl 形状无关
                                    //   unforgeable / reason —— 已有语义沿用（spec.unforgeable；
                                    //     未收录任务也是 unforgeable:true + reason:"未收录任务"）
                                    //   canAccept —— 现在就能进「接取」= not_accepted && 非 auto
                                    //     && !unforgeable（与引擎 needsAccept 同口径；desktopOnly
                                    //     不挡接取，引擎会接但不点亮）
                                    //   canLight —— 引擎能/会用事件点亮 = kind 可自动化 && 状态可
                                    //     推进（accepted，或 auto 的 not_accepted/accepted）；
                                    //     desktopOnly / 未收录一律 false；black_cat 的 23:00–08:00
                                    //     夜间窗口是运行时判断，不含在内
                                    //   pinnedExpertId —— 非空 = 事件 id 钉死该专家（TASK_SPECS 钉死
                                    //     或 jump_url 派生）；空串 = 不钉 id（expert/team 类走池子
                                    //     轮换，其它 kind 无专家 id）
                                    // 快照缓存（state/snapshots.json）落盘「投影前」的规范 Task +
                                    // snapVersion 版本戳；/api/state 读取时一律用 snapTask 现场重投影
                                    //（读取路径是投影的唯一出口）：旧版 8 键缓存靠重算无损升级（缺的
                                    // 6 个判断字段绝不以 undefined 下发），版本不符且条目缺投影所需
                                    // 字段、无法无损重建时整份 snapshot 返回 null（前端显示「快照已
                                    // 过期，请刷新」；宁可空，不可错）。判断永远来自引擎投影，前端
                                    // 不得按 jumpUrl 形状自行猜桌面端/专家 id（真实数据 19/19 都有
                                    // 非空 jumpUrl，猜了必错）。
                                    // snapshot.energy / streak / days 的读径与 engine 同一口径
                                    // （P1 实测 2026-10-31，两真实账号验证）：energy = data.balance
                                    //（GET /v2/activity/growth/energy），streak/days = data.streak.days
                                    //（GET /activity/growth/streak）；daemon 只认这一种拼写，
                                    // 不做多拼写回退链。
                                    // scheduler.holds = 真正的风控冷却名单（403/11140），不是「没进 job 的账号」；
                                    // releasedAt 为 ISO 8601 字符串（epoch ms 由 runner.holds() 给出，这里转 ISO）
                                    // tasksEnabled 为生效值：accounts.json 显式条目 > engine/store 的
                                    // tasks-accounts.json > 缺省 true
                                    // imported = 该账号行来自 JSON 导入（§9）：importedFrom 标记 ||
                                    // 本插件导入台账 state/hub-imports.json。尽力而为的展示标记
                                    // （magpie 覆写会抹标记、删 state 会丢台账），不作判断依据
                                    // expiresInMs = token 原始剩余毫秒（exp - now，可为负 = 已过期）；
                                    // expiresInDays = ceil 口径的天数（Math.max(0,…)），token 还剩
                                    // 2 小时时会显示 1 —— 区分「不足一天」必须用 expiresInMs。
                                    // 两者在 expires 未知（=0）时均为 null。
POST /api/run                   body {uids?:string[], legs?:string[], claim?:bool,
                                      codes?: string[] | {[uid]: string[]}} -> {job:Job} | 409 {error:"busy"}
                                    // codes —— 任务级勾选（只在 growth 腿生效，CONTRACT §6/§7）：
                                    //   不传 → 全部任务（兼容现状）
                                    //   数组 → 对 job 内每个选中账号都只做这些 code
                                    //   对象 → 按 uid；未出现的 uid 或空数组 = 该账号全部任务
                                    // 归一化在 daemon.startJob 完成（runner spec.taskCodes:
                                    //   {uid:string[]}|null）：每个 uid 的清单去重、只留非空
                                    //   字符串、上限 500；空清单/非法类型一律忽略（落 null），
                                    //   绝不 500。job.spec 透出归一后的 taskCodes。
POST /api/stop                  -> {job:Job}                                  // 取消当前 job
POST /api/task/claim            body {uid, code} -> {ok, credit, energy, reason}
POST /api/task/accept           body {uid, codes[]} -> AcceptResult
POST /api/checkin               body {uids?:string[]} -> CheckinResult[]     // 仅手动，社区插件负责自动签到
POST /api/settings              body 部分 settings -> 新的 settings（写 state/settings.json）
POST /api/accounts              -> 重新读 plugin-auth.json -> {count, eligible, added[], removed[]}
                                    // 纯国内版口径：count = provider==="workbuddy" 的条目
                                    // （含 API key，不参与任务；国际版不计入、不出现）；
                                    // eligible = 可参与任务的 OAuth 账号数（engine.store.eligibleAccounts 口径）
GET  /api/accounts/export?realm=cn|intl&secrets=0|1&uid=a,b&download=1
                                    -> {format:"workbuddy-accounts",version:1,
                                        exportedAt:"YYYY-MM-DD HH:MM:SS",count,accounts:[hub 形状行]}
                                    // hub /accounts/export（wb_proxy.py:19314）移植；语义/文件名/404
                                    // 规则与脱敏行为见 §9；纯国内版口径：不带 realm 只出 cn，
                                    // 显式 realm=intl 才出国际版（逃生口，UI 不提供）；
                                    // secrets 缺省/secrets=1 含 token 真值，secrets=0 脱敏
POST /api/accounts/import       -> 预览/确认两段式（body 形状、响应形状、错误码见 §9）；
                                    // 预览与确认都不需要密钥（免密钥口径）
POST /api/account/toggle        body {uid, tasksEnabled:bool} -> account 行（同 /api/state 的 accounts[] 元素）
                                    // 「参与任务」开关（hub 的 task_active）：写 state/accounts.json 并回读；
                                    // 400 缺 uid / tasksEnabled 非布尔，404 账号不存在；
                                    // 不挡运行中的 job（runner 启动时已定名单，只影响下一轮筛选）
GET  /api/jobs/:id              -> Job
GET  /api/credits?uid=<uid>&refresh=0|1
                                    -> 200 {ok:true, uid, nickname, credits}
                                    | 200 {ok:false, uid, nickname, error, needRelogin?, credits?旧缓存}
                                    | 404 {error}   // uid 找不到 / API key / 企业号 / 已停用
                                                    //（可参与口径与 eligibleAccounts 一致）
                                    | 409 {error:"busy"}  // 要拉取时 job 在跑（或已在拉取中）
                                    | 503 {error}   // 引擎不可用
                                    // 国内版「积分余额 + 套餐权益包明细」（看板 剩余/总额 与明细
                                    // 弹窗的数据源；engine/credits.fetchCredits，§2）。只读，
                                    // 绝不发布 token。缓存：
                                    //   · state/credits.json（{uid: credits}），启动读入，损坏/
                                    //     非对象按 {}；成功拉取后原子写回（writeJson tmp+rename）；
                                    //   · 缓存 < CREDITS_TTL_MS（10 分钟）且未要求 refresh → 直接
                                    //     回缓存，一次上游都不发；
                                    //   · 需要拉取时若 runner.current() 存在（job 在跑）→ 409 busy，
                                    //     避免和 job 抢节流窗口；但「有缓存且未 refresh」时仍直接
                                    //     回缓存（哪怕已过期）——展示优先，绝不硬闯；
                                    //   · refresh=1/true/yes → 无视 TTL 强制拉取（busy 时仍 409）；
                                    //   · 上游失败 → 200 {ok:false,...,needRelogin?}，旧缓存保留
                                    //     （不清掉）并随响应一并带回（credits 字段，若有）；
                                    //   · 拉取成功后广播 SSE {kind:"credits", uid}（可选，前端不依赖）。
GET  /api/history?limit=200     -> 每次尝试一行（对齐 hub 的 /activity/history）
                                    // 行的 trigger 口径：来自 job.spec.trigger（"schedule" |
                                    // "manual"），看板「触发」列据此显示 排程/手动 —— 触发方式
                                    // 住在 spec 上（旧版误读 job 顶层 trigger，真实引擎没有该
                                    // 字段，曾把排程行全写成 manual）；兼容旧式外壳挂在 job 顶层
                                    // 的 trigger，非法值/缺失一律按 "manual"，绝不透出第三种拼写。
                                    // 已写入的旧行不迁移（无法可靠回溯）。
GET  /api/events                -> SSE：{kind:'job'|'step'|'log'|'scheduler', ...}
其余 GET /                      -> dashboard/index.html（静态，同源，无构建）
```

SSE 事件是看板实时进度的唯一来源；断线时看板回退到 `GET /api/state` 轮询 3 s。

缓存口径：静态资源与全部 API 响应一律 `Cache-Control: no-store`（局域网自建看板迭代频繁，
「重载即最新版」是默认行为；刻意不发 `ETag`/`Last-Modified`，no-store 之下条件请求只增加新的
失效模式）——唯一例外 `GET /api/events` 保持 `Cache-Control: no-cache`（no-store 的 SSE 长连接
在部分代理下会断流）。取舍细节以 `daemon.mjs` 的 `json()`/`serveStatic` 注释为单一真相。

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

## 5. 不声明 provider（只提供页面与 MCP 工具）

**本插件不声明 provider**：`index.mjs` 的 hooks 只有 `tool`（契约 §6），没有 `auth` / `config`。
历史：早先版本声明过一个无模型 provider「workbuddy-tasks」（`models:{}`）只为给 magpie 一个
加载理由；但它让 magpie 在供应商卡里显示「未登录」+ 登录按钮——用户既不需要也无法为它登录
（任务凭据永远共享读 magpie 已登录的 workbuddy 账号），纯造成困惑，已移除（连带 `auth.usage`、
`PROVIDER_ID` 等死代码）。后果与口径：

- magpie 的「供应商」列表不再出现本插件，没有任何「登录/添加账号」入口——这是预期行为；
- 对话链路照旧全权归 `@magpie-community/opencode-workbuddy-auth`（`workbuddy` / `workbuddy-ai`
  两个 id 我们本来就不碰，铁律 §0.1；provider id 撞车才会变 `-plugin` 后缀的顾虑随之消失）；
- **加载理由**：插件仍有 `package.json` 的 `magpie.page`（入口卡），且不是「只有页面」的插件——
  `tool` 钩子在，magpie 仍会为工具启动插件宿主、调用 `index.mjs` 的入口函数，
  `ensureDaemon` 生命周期（契约 §4）因此照常运转；
- `auth.checkin` 与 `auth.usage` 随 provider 一起不存在（每日签到归社区插件；用量数字看板与
  `workbuddy_tasks_status` 工具都有）。

## 6. `tool` 钩子（MCP `/mcp/magpie/tools`，单次执行上限 55 s）

```
workbuddy_tasks_status()                 -> 账号/排程/当前 job 摘要（纯文本）
workbuddy_tasks_run(uids?, legs?, claim?, codes?) -> 启动 job，立即返回 job id（不等待）
                                            // codes?: string[] —— 任务级勾选，对所有选中
                                            // 账号生效（= §3 的数组形状，daemon 归一化）
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
- **积分余额（只读，engine/credits.mjs，wb_accounts._fetch_credits_cn_detailed 口径）**：
  `POST {bill}/billing/meter/get-user-resource-summary`（body `"{}"`）、
  `POST {bill}/billing/meter/get-user-resource-free-packages`（`{PackageCodes,PageNumber:1,PageSize:200,Status:[0]}`）、
  `POST {bill}/billing/meter/get-user-resource-paid-packages`（`{同上, Status:[0,3], NeedRenewInfo:true}`）；
  头族 = billing 头 + `X-Client-Platform: web`；PackageCodes 取 summary `data.Packages[].PackageCode`
  去重，free/paid 单个失败忽略该来源。到期语义：优先认 `DeductionEndTime`（epoch ms，积分到这个点
  不能再抵扣即作废；免费包/体验版的 `CycleEndTime` 只是每月计费边界，两者能差 8 年），>730 天按
  「不过期」处理（上游拿远超真实周期的哨兵值表示永不过期）；**naive 字符串时间一律按北京时区
  (+08:00) 解析**（容器时区可能是 UTC，绝不能当本地时间）。summary 无 `IsPaidUser` 字段时 tier=null，
  绝不瞎判免费。
- 刷新：`POST {chat} + engine/constants.REFRESH_PATH`，头 `X-Refresh-Token`、`X-Auth-Refresh-Source: workbuddy`、`X-Domain`；响应 `data.accessToken`(+轮换的 `data.refreshToken`)，可能嵌套 `data.data`。
- 事件必须有 `userId`（缺了服务端 200 但静默丢弃）。
- 进度只在**已接取**任务上累计；专家/团队事件按 `(eventCode,id)` 去重 → 必须轮换 id 池；
  `WorkBuddy_Valorant` 钉死真实 id `ex_xQHHD1u5Jkua`，`Expert_lighthouse` 钉 `ex_2cvvUZQhDyeJ`。
- **未收录任务（P0-1）**：上游会返回 TASK_SPECS 之外的任务（2026-10-31 实测每账号
  19 项里有 5 项不在 specs，其中 4 个 `expert_use_*` + 若干随版本漂移的 活动 任务）。
  处理规则（engine/taskkind.resolveTaskKind，优先级从高到低）：
  1. TASK_SPECS 命中 → 沿用 spec（`Expert_lighthouse`/`WorkBuddy_Valorant` 的 jump_url
     只有 `workbuddy://expert`，不含 expertId —— 钉死常量仍是唯一来源，绝不被 jump_url 覆盖）；
  2. 未命中但 `jump_url` 解出 `expertId=ex_…`（`expert_use_*` 一族：URL 编码的 deeplink
     查询串里，如 `…launch/?deeplink=workbuddy%3A%2F%2Fexperts%3FexpertId%3Dex_GDl31WahyIH0
     &buddy_type=workbuddy`）→ 视为 expert 类可点亮任务，**事件 id 必须钉在解析出的 id 上**
     （上游按 `(eventCode,id)` 去重，池子里的通用 id 对它不推进进度 —— Valorant 同款坑），
     `expertType` 用 `agent`，事件其余字段沿用 `expert_actual_use` 形状；专家名从任务
     标题「」内提取（仅展示字段，进度只看 id）；
  3. 未命中且派生不出 → `unforgeable:true` + `reason:"未收录任务"`：不接取、不上报、
     不领奖，**绝不放进批量接取批次**（否则「接了一大堆却一项不亮、领奖报
     task not completed」）；`desktopOnly`/`canAccept`/`canLight`/`pinnedExpertId`
     随 daemon 投影下发给前端（§3）。
- **连登/能量字段口径（P1，2026-10-31 两真实账号只读实测）**：
  `GET /v2/activity/growth/energy` → `data.balance`（data 里另有 total_consumed/
  total_earned，没有 energy/value 键）；
  `GET /activity/growth/streak` → `data.streak.days`（`makeup_cards.balance`、
  `redemption_status` 同层；data 顶层没有 days/streakDays 键）。连登为 0 是真实值
  （`streak.days` 与 `month_total_days` 是两个字段，前者才是连登天数）。
  daemon 快照读同一路径，不做多拼写回退链。
- DESKTOP_ONLY 任务（`RichMeow_Chat`/`Buddy_App`/`Buddy_App_QQ`）与 `unforgeable`
  （`wb_wechat_oa_subscribe_task`/`Expert_Philanthropy`）不上报、接不上，只展示 `jump_url`。
  **`Library_read` 不在此列**（2026-11 修正）：它由 web 端的一次元素点击事件点亮 ——
  `engine/tasks.reportLibraryEvent` 向 **web 域** `webBase()/v2/report` 发一条
  `web_element_click`（数组包一层），字段逐字为：
  `{eventCode:"web_element_click", timestamp, reportDelay:0,
    pageURL:"https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm",
    elementId:"library_doc_intro_click", elementName:"WorkBuddy资料库介绍",
    os:"Win32", arch:"", osVersion:"10.0", userAgent:<WEB_UA>,
    machineId:deriveId(uid,"webmachine"), userId:uid, userNickname:<昵称>}`；
  头族用 `webHeaders(acct)` 并覆盖三处：`Referer`=该文档 URL、`User-Agent`=同一个
  WEB_UA（与事件 userAgent 同值，冒充同一次浏览器会话）、`X-User-Id`=空串（web 端
  点击事件的真实形态，身分靠 Authorization 与事件体携带）；`Authorization` 保留。
  `callJSON` 的 `init.headers` 支持自定义头**大小写敏感**合并，唯 `Authorization`
  无论大小写写法都不可被覆盖（凭据头红线）。流水线里 `kind==="library"` 走这条路
  （每次 need 循环一条，日志「正在点亮任务 [浏览资料库]（web 点击事件）」），
  进度/领奖与其它任务同一套轮询。
- **每日活跃（点亮成长中心连登，engine/daily.mjs）**：每个账号每个**北京日**一条
  `chat` 事件，打**计费域** `billBase()/v2/report`（不是 chat 域）。触发点是 runner
  的每账号开跑之前（无论 job 跑哪些腿、也无论账号处于哪个 leg）；幂等键 =
  `uid → 北京日键`（`beijingDayKey`，UTC+8，UTC 16:00 翻北京日），账本由 daemon
  持久化在 `state/daily-activity.json`（`{uid:"YYYY-MM-DD"}`，启动读入、`onSent`
  经 writeJson tmp+rename 原子写回；文件损坏/形状不对按空对象起步，不阻断启动，
  顶多重发一条——上游按北京日幂等，无害）。成功才落账 + 回调 `onSent`；失败返回
  `{sent:false,error}` 不抛，runner 记一行日志（「每日活跃：已上报 / 今日已报过 /
  上报失败：…」）继续跑腿，绝不 fail job。上游调用经 `reportEvents` → 全局节流器，
  铁律 4 照常生效。`/api/state` 不新增字段。
- **时间口径（排程/夜猫窗口，与容器时区无关）**：生产 magpie 容器时区是 **UTC**
  （`date` 显示 UTC、`TZ` 为空），`new Date().getHours()`/`toDateString()` 读的是宿主
  时区，会把北京 09:00 读成 1 点。因此**小时窗口（settings.hours）、夜猫子
  23:00–08:00 窗口、排程「同日同窗口只触发一次」的去重日界一律按北京时间
  （UTC+8）解释，与容器/宿主时区无关**——实现为 `engine/constants.beijingHour` /
  `beijingDateKey`（UTC 毫秒 +8h 后取 UTC 分量），与 `engine/daily.beijingDayKey`、
  credits 的「naive 时间按 +08:00 解析」同一口径。`settings.hours` 的数字含义不变，
  仍是北京小时；`lastFired.json` 旧键（宿主时区口径）不做迁移，键形不同互不命中，
  最坏只多触发一个窗口，绝不清空用户文件。
- `first_buddy` 是 `task_type==='auto'`：不许进接取批次，必须先点亮+领奖，否则单任务接取报 `prerequisite not met`。
- 领奖竞态：上报后等 1.5 s，轮询进度最多 6 次（在涨就再等 2.5 s），没到位就把领奖顺延到下一轮，绝不硬闯。
- **任务级勾选（`runGrowthTasks` 的 `opts.codes`，§2/§3/§6）**：非空数组 = 只对选中的任务
  接取/点亮/领奖；**每次 `fetchTasks` 之后都按选中集合过滤**（含接取后的复查重取）——未选中的
  任务不进 auto 前置、不进批量接取批次、不轮询进度、不领奖，上游状态原封不动。选中但任务表里
  不存在的 code 记**一次**警告并跳过，绝不硬闯。未传/空数组/非法类型 = 全部任务（旧行为）。
  「清单拉空」的失败判断按**过滤前**的整表算——勾选过滤后为空是正常现象（选中任务都不在表里），
  不是拉取失败；此时跳过任务阶段、照常做猫猫旅行与能量结算。

### 7.1 hub 移植的时间单位：expiresAt = epoch 秒，magpie expires = epoch 毫秒（双向换算）

**结论**：hub 导出文档/凭据档里的 `expiresAt` 单位是 **epoch 秒**；magpie `plugin-auth.json` 里的
`expires` 单位是 **epoch 毫秒**。换算：hub→magpie `×1000`；magpie→hub `floor(÷1000)`（<1s 精度
丢弃，对过期判断无影响）。`0` 在两边都表示「未知」，绝不当作 1970。

**Python 源码证据**（本仓库 `/tmp/wbsrc/repo` 快照，逐行核对）：

| 证据 | 行号 | 内容 |
| --- | --- | --- |
| 写入处 | `wb_accounts.py:919-920` | `self.expires_at = (0 if self.is_api_key else normalize_epoch(data.get("expiresAt")) or jwt_exp(token))` —— `jwt_exp()` 返回 JWT `exp` 声明（RFC 7519 恒为秒），:514-518 |
| 归一处 | `wb_accounts.py:526-533` | `normalize_epoch()`：`if number > 1e11: number /= 1000.0` —— >1e11 一律当毫秒除成秒，内部表示是秒 |
| 比较处 1 | `wb_accounts.py:1230-1232` | `public()`：`exp = self.expires_at or jwt_exp(...)`；`now = time.time()`；`is_token_expired = … (exp and exp <= now)` —— 与 **`time.time()`（秒）** 比较 |
| 比较处 2 | `wb_accounts.py:1829-1831` | `exp - now <= 120` → 「凭证已过期」，`now` 由调用方传 `time.time()`（秒）；`ready()` 同款 `remaining = exp - time.time()`（:1817 起） |
| 反证（毫秒口径的存在） | `wb_accounts.py:5413-5414` | cockpit snake_case 行注释：**「expires_at is milliseconds, which normalize_epoch() below converts to seconds」** —— 外来毫秒值只在入口处被换算成秒，内部从不是毫秒 |
| magpie 侧 | 真实 `plugin-auth.json` | `expires` 全部为 13 位毫秒值（如 1.79e12），9 个条目无一例外 |

**为什么必须写死**：单位搞错会让导入账号「立刻已过期」（秒值当毫秒读 = 1970 年）或
「永不过期」（毫秒值当秒读 = 5 万年后），且智能合并的分支会**静默走错**（未过期判成已过期 →
把在用的新 token 换成 JSON 里的旧 token）。tests 里有专门防秒/毫秒混淆的用例
（`tests/accountio-import.test.mjs`：双向换算 + 智能合并分支在秒/毫秒两套输入下结论一致）。

## 8. 测试门槛（没有这些不算完成）

`bun test` 全绿，且**零真实网络**（`fetch` 注入 mock）：
- `deriveId` 对固定 uid 输出稳定、UUIDv4 形状、machine≠session；
- 信封：`code!==0` → 失败；`403/11140` → restricted；TLS reset → 走 web 回退且 `X-Domain` 不变；
- 事件：每种 kind 的 `eventCode` 与必填字段逐个断言；`userId` 必在；
- 流水线：假账号跑完整轮 → 断言「接取在未接之前」「领奖在进度到位之后」「两次上游调用间隔 ≥1000 ms」「DESKTOP_ONLY 被跳过」「auto 任务不进接取批次」；
- 任务级勾选（§3/§7）：`opts.codes` 非空 → 只对选中任务接取/点亮/领奖、未选中任务上游状态
  原封不动、缺失 code 警告一次；runner 把 `spec.taskCodes[uid]` 原样传到 growth 腿、travel/night
  不受影响、脏输入归一成 null；daemon 把 `/api/run` 的数组/按 uid 对象两种形状归一到
  `taskCodes`（去重/剔非字符串/上限 500/非法忽略）；
- schedule：窗口判定（09:00/21:00 猫猫旅行，01:00 夜猫，夜猫只认 23:00–08:00；
  **一律按北京时间（UTC+8）解释，与容器时区无关**——测试必须用显式 UTC 时间戳证明
  `beijingHour(Date.UTC(...,1,0))===9`、UTC 01:00 命中 travel 而绝不能是 night、
  UTC 17:00（北京次日 01:00）命中 night、`beijingDateKey` 在 UTC 16:00 翻北京日、
  `dueWindows` 跨北京日边界不重不漏；**growth 不在任何排程窗口**——排程只触发
  travel/night，growth 只能手动跑）；daemon 回归用假时钟驱动 `checkScheduler`：
  `hours={travel:[9,21],night:[1]}` 时北京 09:00（UTC 01:00）启动 `legs:["travel"]`、
  北京 01:00（UTC 17:00）启动 night、同一北京日同窗口只触发一次、跨北京日
  （UTC 16:00 边界）重新允许；daemon 读旧 settings.json 时
  丢弃 `hours.growth`、`/api/state` 的 hours/nextRuns 无 growth、tick 不触发 growth job、
  手动 `legs:["growth"]` 照常启动；
- 去重：`expert_5` 五个事件用 5 个不同 id；
- 资料库（Library_read）：reportLibraryEvent 的事件字段/头逐字断言（web 域、
  Referer/UA/X-User-Id 覆盖、Authorization 保留）；callJSON 的 init.headers 合并
  —— 大小写敏感覆盖、Authorization 不可被覆盖（精确大小写与小写两种写法都剥掉）；
  流水线 0/1 → web 点击 → 进度 0→1 → 领奖；desktopOnly 投影只剩 RichMeow/Buddy
  三条，Library_read desktopOnly=false、accepted 可点亮；
- 每日活跃：北京日键 UTC+8 翻日；同一北京日第二次不重发（skipped）、跨日（注入
  now）再发；失败不落账不回调不抛；请求打计费域 /v2/report 且事件含 userId；经
  spacer；runner 每账号开跑前一次、失败不阻断腿；daemon 持久化
  state/daily-activity.json 读写、损坏回空不阻断启动；
- kind 解析（taskkind）：jump_url 派生专家 id（编码/裸/双重编码/解不出）、TASK_SPECS
  优先（Valorant 钉死 id 不被 jump_url 覆盖）、六类任务 × 四状态 canAccept/canLight
  矩阵、真实形态 19 项投影全表 + 批量接取 codes 与 canAccept 逐项一致（未收录绝不进
  批次）、快照 energy/streak 只认 data.balance / data.streak.days（毒键不误读）；
- store：回写只改 access/refresh/expires，保留未知字段，产出合法 JSON 且权限 600；
- runner：两个 `start()` → 第二个 409；`stop()` 能在步骤边界中止；
- 沙箱卫生：测试 temp 沙箱一律走 `tests/helpers.mjs` 的 `makeSandbox()`（用完即删 + after/exit 兜底），跑完套件 temp 不残留 `wb-*` 沙箱（`tests/sandbox-hygiene.test.mjs` 钉死）。

## 9. 账号 JSON 导入 / 导出（hub 移植口径；engine/accountio.mjs）

WorkBuddy 账号在机器之间以一份自描述 JSON 迁移（hub `wb_accounts.py` 的 export/import 移植）。
**产品口径（已定，不得扩张）**：只同步国内版（`realm==="cn"` → provider `workbuddy`）；国际版
一律不导入（rejects，reason「只同步国内版 workbuddy，国际版账号不导入」）；**导入直接写 magpie 的
`plugin-auth.json`，绝不建第二份私有账号库**（同账号两条 token 血统会在 refresh 轮换时互相踢下线）。

### 9.1 导出（`GET /api/accounts/export`）

```
GET /api/accounts/export?realm=cn|intl&secrets=0|1&uid=a,b&download=1
  -> {format:"workbuddy-accounts", version:1, exportedAt:"YYYY-MM-DD HH:MM:SS",
      count:N, accounts:[hub 形状行]}
```

- 语义照 hub `_get_accounts_export`（wb_proxy.py:19314），但 **realm 默认值按纯国内版口径收窄**：
  不带 `realm`（或任何非 `intl` 值）**只导出国内版**；显式 `realm=intl` 才导出国际版——这是给 hub
  备份场景留的**逃生口**（UI 不提供此入口，只存在于 API 层，导出的文档可再回灌本插件的导入）。
  `uid` 逗号分隔可重复（不在所选 realm 范围内的 uid → `404 {error:"no such account: …"}`，默认
  范围里的国际版 uid 同样 404）、`download=1` 走 `Content-Disposition: attachment`（文件名规则同 hub，
  见下）、`secrets=0|false|no` 按 hub 行为**删除 accessToken/refreshToken 两键**（其余字段保留）。
- **secrets 缺省 = 1（含 token）**；`secrets=0` 脱敏。免密钥口径下两种取值都不需要密钥（§3）。
- 文件名（hub :19347-19353 + `_download` :18706 净化）：单 uid →
  `workbuddy-accounts-<uid 前 8 位><YYYYMMDD-HHMMSS>.json`；多 uid/无 uid →
  `workbuddy-accounts-[<realm>-]<YYYYMMDD-HHMMSS>.json`；`[^A-Za-z0-9._-]`→`_`，截 120。
- `exportedAt` 为本地时间 `YYYY-MM-DD HH:MM:SS`（hub `time.strftime` 口径）。
- **导出行是 hub 字段名**（`Account.to_dict()`，wb_accounts.py:1136，为准的字段表）：

| hub 行字段 | 类型 | 来源（magpie 官方条目/我们的 Account） |
| --- | --- | --- |
| `uid` | string | entry.uid（缺则由 JWT sub 派生，store 载入时已定） |
| `nickname` | string | entry.accountId（magpie 的显示名） |
| `domain` | string | entry.domain |
| `realm` | "cn"\|"intl" | provider：workbuddy→cn、workbuddy-ai→intl |
| `platform` | string | 常量 "CLI"（hub 缺省） |
| `product` | string | 常量 "workbuddy"（hub `normalize_product` 缺省） |
| `enterpriseId` | string | entry.enterpriseId |
| `accessToken` | string | entry.access（**secrets=0 时删除**） |
| `refreshToken` | string | entry.refresh（**secrets=0 时删除**） |
| `expiresAt` | number | **epoch 秒** = floor(entry.expires/1000)（§7.1） |
| `source` | string | 常量 "magpie" |
| `apiKey` | bool | 是否 API Key 条目（此类条目整行不导出——没有 OAuth 凭据可导） |
| `enabled` | bool | 恒 true |
| `tasksEnabled` | bool | 本插件 state 的生效值 |

  `to_dict()` 的其余字段（addedAt/proxySlot/proxy/weight/note/disabledModels/lastError/
  cooldownUntil/restrictedUntil/credits/tier/lastCheckin/lastDailyChat/lastActivityReport/
  modelCaps）是 hub 本地运行时状态或 magpie 侧不存在的信息，**不携带**；导入侧本就按
  `VOLATILE_FIELDS`（wb_accounts.py:5317）丢弃，回灌无损。
- **导出文件本身必须真值**（含昵称与 token，不打码）——否则回灌无效；打码只属于界面展示层。
- 导入侧绝不信任行上的易失字段（cooldownUntil/lastError 等），与 hub 同款。

### 9.2 导入（`POST /api/accounts/import`，两段式）

body = 账号数据本体（**四种形态**，hub `_coerce_account_rows` wb_accounts.py:5366 逐字移植：
导出信封 `{format,accounts}`、裸数组、单账号对象、桌面端凭据 `{"auth":{…},"account":{…}}`；
cockpit snake_case 行 `access_token/expires_at(毫秒)` 也认）或 `{"blob":<同上>,"confirm":bool}`。

- **预览（默认，绝不写盘）**：
  `{wrote:false, note:"预览未写入任何文件", preview:{adds:[{uid,nickname,key}],
  updates:[{uid,nickname,key,fromExpires,toExpires,reason}], skips:[{uid,nickname,reason}],
  rejects:[{index,reason,inputHint}], totals:{adds,updates,skips,rejects}}}`
  （index 从 1 起，hub 口径；`inputHint` 只含身份字段/字段名清单，**绝不含 token**）
- **确认（`confirm:true`，免密钥口径下无需任何密钥）**：
  `{wrote:true, added:[…], updated:[…], skipped:[…], backedUpTo:"plugin-auth.json.bak-hubimport-<stamp>",
  needReload:true, reloadHint:"在 magpie「插件管理」里把 WorkBuddy 关掉再打开，新账号才会被 magpie 认到"}`
- **错误**：文档读不出可导入账号 → `400`；`plugin-auth.json` 解析失败 → `409` 拒写（连预览也拒：
  智能合并没有可靠的「现有」可用）；**预览后文件已变（竞态）→ `409 {needRepreview:true}`**；
  落盘本身失败 → `500`。确认时若本进程里没有预览缓存，按当前文件现场计划后直接执行
  （纯函数同规则 ⇒ 同输入同结论；竞态守卫针对「预览过但文件已变」）。

**智能合并**（uid 已存在时，provider `workbuddy` 条目；顺序即优先级）：
1. 导入项无 `refresh` 而现有有 → `skip`（「写进去会削弱续期能力」）；
2. 现有 `expires > now`（未过期）→ `skip`（「绝不把在用的新 token 换成 JSON 里的旧 token」）；
3. 现有已过期且 `导入.expires > 现有.expires` → `update`（覆盖 access/refresh/expires）；
4. 其余 → `skip`（「导入的 token 并不比现有的新」）。
每个分支都给人话 reason。**更新只动 token 三件套**（access/refresh/expires）+ 补 `importedFrom`
标记：domain/tokenType/accountId 是 magpie 官方登录流程写下的现场信息，JSON 不比它权威；
未知字段靠条目展开原样保留。

**写入纪律**（`applyImport` 才写；`planImport(rows, existingAuth, {now})` 是纯函数，预览与确认
共用——同输入必同结论）：写前自动备份（逐字节 copy）；tmp+rename 原子落盘、mode 0600
（复用 `engine/store.mjs` 的原语，不另起一套）；解析失败拒写；其它 provider 与未知字段逐值
原样保留（测试用含 9 条目的 fixture 逐条比对）；key 分配沿用官方规则——**首个裸 id
`workbuddy`，其余 `#`+6 位小写数字字母，不得与文件里任何已有 key 撞**。

**写进 `plugin-auth.json` 的行用官方字段名**（非 hub 名）：
`{type:"oauth", access, refresh, expires(毫秒), refreshExpiresAt?, domain, tokenType, uid,
enterpriseId?, accountId(=可读昵称，magpie 用它显示账号名), importedFrom:"hub-json"}`。
`importedFrom` 是**易失标记**：magpie 下次整体覆写可能抹掉——因此 `/api/state` 的
`imported` 布尔 = `importedFrom==="hub-json"` || 本插件台账 `state/hub-imports.json` 有该 key，
两者都只是**尽力而为的展示标记，不作为任何逻辑判断依据**。
