# magpie-workbuddy-tasks

把 workbuddy2api-hub 的「国内版成长/积分任务批量自动化」移植成的 magpie 插件：复用你在 magpie 里**已经登录**的 WorkBuddy（国内版，copilot.tencent.com）账号，不填任何密钥，提供本地看板、每日小时窗口排程，以及给任意智能体用的任务工具。

## 它做什么

一轮批量 job（同一时刻只允许一个，第二个请求得 409 `busy`）按账号依次执行，可自由组合三条「腿」：

| 能力 | 对应入口 | 实际行为 |
| --- | --- | --- |
| **批量接任务** | 看板「立即运行」/ `POST /api/run` / 工具 `workbuddy_tasks_run` | 流水线第一步：把所有未接取的可自动化任务批量接取（上游 20 个一批），复查后仍有未接的自动补接一次 |
| **批量做任务（接取→点亮→领奖）** | 同上，默认腿 `growth` | 逐任务上报事件点亮、轮询进度（上报后等 1.5s、最多 6 次，在涨再等 2.5s），进度到位才领奖；没到位就把领奖顺延下一轮，绝不硬闯 |
| **只领奖** | 看板单账号「领取」/ `POST /api/task/claim` / 工具 `workbuddy_tasks_claim`；或关掉设置的「自动领奖」（`claim:false`） | 单任务领取；批量运行时也只点亮不领奖 |
| **猫猫旅行** | 腿 `travel` | 闭环：`arrived` 领奖 → `idle` 取目的地派出（没有 Buddy 就先完成并领取 `first_buddy` 再派）→ `traveling` 如实报告 |
| **夜猫子** | 腿 `night` | `black_cat` 任务只在本地 23:00–08:00 上报（白天诚实跳过），每天计 1 次、累计 3 天后领奖 |
| **小时排程** | 看板设置 / `POST /api/settings` | **默认停用**——装好插件不会自动往你的账号上打上游请求，必须在看板里点一次「启用小时窗口排程」才生效。启用后按本地 09:00 与 21:00 跑「成长+旅行」、01:00 跑「夜猫子」（窗口可改）；守护进程每 30s 检查窗口，同一天同一窗口只触发一次 |

安全默认：首次安装后 `settings.json` 不存在或损坏时，一律回落到「排程停用 + 窗口保留」，只读的账号列表不会打上游；只有你手动点「批量做任务」/启用排程，才会产生写操作。

防风控红线（不可配置、不可绕过）：任何两次上游调用之间至少 1s；账号之间手动 1.5s / 排程 2–5s 抖动；绝不并行跑成长任务。

## 它刻意不做什么

- **自动签到**：官方 `@magpie-community/opencode-workbuddy-auth` 插件已经拥有 `auth.checkin`（每个北京日一次）。本插件的 `auth.checkin` 故意不实现，只在看板留了一个走计费接口的「每日签到」按钮（`POST /api/checkin`）供偶尔手动补用。
- **连登管家 / 补签卡 / 抽奖 / 礼包兑换**：用户决策排除在范围外。引擎只会**读**补签卡余额、抽奖次数等做展示（`fetchGrowthSummary`），绝不花它们——代码里没有任何 makeup-card/lottery-draw/redeem/claim-gift 的调用。
- **国际版**：`workbuddy-ai` 没有成长任务体系（上游就没有），流水线遇到国际版账号直接返回「国际版不适用」。
- **不服务对话模型、不接管 `workbuddy` provider id**：本插件声明的是独立的 `workbuddy-tasks` provider（见下文），`models:{}`，对话链路原封不动地留给社区插件。

## 账号复用与 token 回写（关键机制）

- **读取**：守护进程读 magpie 配置目录下的 `plugin-auth.json`，只认 `workbuddy` / `workbuddy#xxxxxxxx` 键（magpie/OpenCode 多账号键格式）的条目；API key 条目、企业/团队账号（`enterpriseId`）、国际版一律不参与任务。**从不删除这个文件**——只读它，以及下述回写。
- **回写**：批量任务启动前若 access token 距到期不足 5 分钟，引擎先刷新，然后**原子回写** `plugin-auth.json`（tmp + rename，POSIX 上 mode 600）：只覆盖 `access / refresh / expires / refreshExpiresAt / domain / tokenType` 六个与刷新结果相关的键，条目里的未知字段与所有兄弟条目（其它 provider、其它账号）原样保留；文件解析失败时拒绝回写而不是覆盖。这保证了「单一凭据血统」：社区插件与我们永远用同一对 token，refresh 轮换不会把对方踢下线——官方插件负责的对话因此不受影响。
- **坦白说：这是整个插件最脆弱的一环。** 读 `plugin-auth.json` 是 magpie 宿主环境允许的行为，但该文件的位置与格式**不是 magpie 承诺过的公开接口**。如果 magpie 改了它：
  - *换位置/换文件名* → 我们读不到账号，看板与 `/api/state` 会挂出「找不到账号/读取账号失败」的 notice，任务不跑。没有破坏性后果（没有账号就不会触发回写）。
  - *改字段格式* → 轻则账号被跳过（读不出 access/uid 的条目不参与）；重则我们的回写写不进 magpie 认的键里，退化为「各刷各的 token」——最坏情况是 refresh 轮换把社区插件挤下线，重新登录一次 WorkBuddy 即可恢复。文件解析失败时我们会拒绝写入，不会损坏 magpie 的数据。
  - **Opt-out**：在 magpie「插件管理」里停用本插件即可——守护进程 10 秒内读到 `plugins.json` 的 `off:true` 自行退出，之后不再读任何文件（本插件没有申请任何 magpie 权限，`package.json` 的 `permissions` 为空）。也可以按账号关「参与任务」开关，但那只是不拿账号跑任务，账号仍会被读取用于展示。
- 参与任务的账号范围等价于 hub 的 `task_accounts("cn")`：国内版个人 OAuth 且本插件没关掉任务。看板里可按账号停用/启用（写 `state/accounts.json`）。

## 安装（GitHub 仓库方式）

前提：magpie 已安装；且 magpie 里已经登录过 **WorkBuddy（国内版）**账号（`workbuddy` 供应商，由社区插件 `@magpie-community/opencode-workbuddy-auth` 提供）。本插件不需要、也不接受任何密钥。

本仓库已完成 `git init` 和干净的初始提交。发布步骤：

```bash
# 1) 在 GitHub 建一个空仓库（建议同名 magpie-workbuddy-tasks，不要初始化 README）
#    https://github.com/new

# 2) 推送（替换 <owner>）
cd magpie-workbuddy-tasks
git branch -M main
git remote add origin https://github.com/<owner>/magpie-workbuddy-tasks.git
git push -u origin main

# 3) 在跑 magpie 的机器上安装
magpie plugin add github:<owner>/magpie-workbuddy-tasks
```

然后在 magpie 的「插件管理」里**启用**本插件（安装后若未自动启用）。启用后：

- 侧栏「插件」分组会出现「**WorkBuddy 任务**」入口卡（magpie 沙箱页，显示守护进程状态与看板地址）；
- 「供应商」里多出一个 `WorkBuddy 任务`（`workbuddy-tasks`）——它 **0 个模型是正常的**，也不要给它发对话；若 magpie 要求为它「登录/添加账号」，**直接留空确认**即可（provider 的授权方法明确不收密钥）；
- 它的账号卡会显示用量：「N 个账号参与任务 · 今日积分/能量」（守护进程拉起并扫完账号后才有数）。

**可发现性**：给 GitHub 仓库打上 `magpie-plugin` topic（仓库页 → About ⚙ → Topics），插件就会出现在 magpie 的「插件 → 发现 → 非官方插件」列表里。

**更新**：改动推到默认分支即可。magpie 会对比远端提交与本地安装的提交（每 10 分钟最多问一次 GitHub），有差异就在「插件 → 已安装」提示更新，点一下或 `magpie plugin update` 完成更新。固定到某次提交（`github:<owner>/<repo>#<sha>`）的安装不会自动更新。

**重要——magpie 按「仓库当前代码」直接加载运行**（没有构建步骤：仓库根就是插件根，`package.json` 在根目录，magpie 加载 `index.mjs` 及其引用的 `daemon.mjs`、`lifecycle.mjs`、`engine/`、`dashboard/`、`page/`）。所以这些文件**必须全部提交进仓库**；本仓库没有 dist/构建产物，提交的树就是运行的东西，天然满足。

**重载语义**：通过终端执行的 magpie 命令每次都会重新加载插件；但应用内宿主不会热重载——文件夹方式安装时的本地改动、或 GitHub 方式 `magpie plugin update` 之后的代码，需要让宿主重载一次才生效：用 `magpie plugin use <插件名>`（若你的 magpie 版本提供），或最稳妥地在「插件管理」里把本插件**关掉再打开**。

## 看板、密钥与局域网安全

- 看板默认 `http://127.0.0.1:4390/`。端口被占用时自动顺延（最多 +9，再不行用随机端口），**实际端口写在 `state/daemon.json` 的 `port` 里**。
- 除 `GET /api/hello` 外所有 API 都要密钥：`Authorization: Bearer <key>` 或 `?k=<key>`。密钥由插件生成，存在 `<magpie 配置目录>/workbuddy-tasks/state/daemon.json`（POSIX 上权限 600）。
- 看板页面把密钥存在浏览器 **sessionStorage**（只发往本机守护进程；关掉标签页即失效，主题偏好才用 localStorage）。
- 守护进程**默认只绑定 127.0.0.1**。想用手机在沙发上看板，才需要显式开放：

  ```bash
  # 手动拉起并对局域网开放（--addr 支持 host:port / host / :port；--port 单独给端口）
  node daemon.mjs --addr 0.0.0.0:4390 --cfg <magpie 配置目录> --state <state 目录>
  ```

  `--addr 0.0.0.0` 意味着**同一局域网里的任何人**拿到 key（或你分享过的带 `?k=` 的链接）都能用你已登录的 WorkBuddy 账号跑任务、领奖励、开关账号——等于把 magpie 的这部分控制权交出去。API 密钥只防偷瞄，不防拿到文件/链接的人。**只在可信的家庭局域网 / VPN 内这么用；永远不要把 4390（看板）或 3440 等 magpie 相关端口暴露到公网**。跨网络用 SSH 隧道或 VPN 即可，不必开放绑定。

## 生命周期（诚实的限制）

- 守护进程由插件入口（`index.mjs`）在 **magpie 的插件宿主加载本插件时**拉起（健康探测通过就复用，不健康才 spawn 一个 detached 的 `node daemon.mjs`）。
- **但宿主是懒加载的**：magpie 首次用到本插件（打开插件页/供应商页等）才加载它，且插件新增/移除/更新/开关都会重启宿主。所以**启用插件后看板不一定立刻就在**。两个兜底：
  1. 看板顶栏的「**启动命令**」按钮会显示当前配置下的完整手动启动命令；
  2. 自己跑：`node daemon.mjs --cfg <magpie 配置目录> --state <state 目录> --port 4390`（state 目录默认就是 `<magpie 配置目录>/workbuddy-tasks/state`，可省略 `--state`）。
- **守护进程自己跟随 magpie 生死**，不依赖宿主存活：
  - 每 15s TCP 探测 magpie 网关（`MAGPIE_ADDR`，否则 127.0.0.1:3425 再试 :3430）：**连续 4 次失败（magpie 停了）→ 自行退出**；
  - 每 10s 读 magpie 的 `plugins.json`：本插件条目 `off:true`（你在插件管理里关了它）→ **10 秒内优雅退出**；再打开后由下次宿主加载或手动命令拉起；
  - 每 5s 检查 `state/control.json`：`desired:"off"` → 退出（这是看板「停止」按钮与「彻底停止」的机制）；
  - 由宿主拉起（托管模式）时，`plugins.json` 里条目被移除（插件被卸载）→ 退出。
- 这就是「**跟随 magpie 启停 + 插件管理里启用/停用即时生效**」的完整闭环：magpie 开它才在，magpie 关它就退，插件管理里的开关两个方向都会生效（关：10 秒内退；开：下次宿主加载时拉起，或用上面的手动命令立刻拉起）。
- 崩溃重启无僵尸：意图唯一来源是 `control.json`，重复启动会被 `daemon.json` 里的存活 pid + `/api/hello` 健康探测挡下（拒绝双开）。

## 状态都在哪

全部状态都在 `<magpie 配置目录>/workbuddy-tasks/state/`（Docker 里通常是容器内 `/config/magpie/workbuddy-tasks/state/`）：

| 文件 | 内容 |
| --- | --- |
| `control.json` | 唯一意图来源：`{"desired":"on"/"off"}`（看板停止/启动按钮写这里） |
| `settings.json` | 排程开关、窗口小时、默认腿、领奖开关、账号间隔、上游 host 覆盖 |
| `snapshots.json` | 每账号任务快照（任务表/能量/连署，job 结束或 `?refresh=1` 时刷新） |
| `history.json` | 每次尝试一行（上限 2000 行） |
| `accounts.json` | 按账号的「参与任务」开关覆盖（看板 toggle 写入） |
| `daemon.json` | 守护进程 `pid / port / key / version / startedAt`（0600，密钥在这里） |
| `daemon.heartbeat` | 心跳时间戳 |
| `lastFired.json` | 排程「同一天同窗口只触发一次」的去重记录 |
| `tasks-accounts.json` | 引擎层按账号键的参与开关映射（与 `accounts.json` 口径一致） |

登录凭据 `plugin-auth.json` 在 magpie 配置目录**根部**，由 magpie/社区插件拥有：我们只读它 + 上述原子回写，**从不删除它**。想彻底清掉本插件的痕迹，删 `<magpie 配置目录>/workbuddy-tasks/` 整个目录即可（里面没有登录凭据）。

## provider「workbuddy-tasks」是什么

一个**故意存在的、无模型的独立 provider**。magpie 只会加载「用得上」的插件——声明这个 provider（`models:{}`）加上用量钩子，就是给 magpie 一个加载本插件的理由。它：

- 不服务任何对话（空模型表；`loader` 返回空 baseURL/key 兜底）；
- 不占用 `workbuddy` / `workbuddy-ai` 这两个 id（那是社区插件的；provider id 撞车才会被改成 `-plugin` 后缀，我们用独立 id 避开）；
- **不需要也不应该登录**：任务完全靠共享读取 `workbuddy` 账号的凭据。若 magpie 要求为它添加账号，留空确认即可——产生的只是一个无密钥占位条目，有没有它任务都能跑。

## 智能体工具（MCP）

本插件向 magpie 的 MCP 工具服务注册五个工具，任何接了 `http://127.0.0.1:3425/mcp/magpie/tools` 的智能体（Claude Code、Codex 等）都能用：

| 工具 | 作用 |
| --- | --- |
| `workbuddy_tasks_status` | 账号、排程窗口、当前 job、今日收益一览 |
| `workbuddy_tasks_run` | 启动一轮批量任务（可指定 uids / legs / claim），**立即返回 job id，不等待** |
| `workbuddy_tasks_wait` | 轮询某个 job 直到完成或超时（默认 45s、上限 50s），返回进度与结算 |
| `workbuddy_tasks_list` | 某个账号的任务表（code / 标题 / 接取状态 / 进度 / 奖励） |
| `workbuddy_tasks_claim` | 单个任务领奖 |

每个工具的单次执行上限是 55 秒，装不下一轮跨账号批量，所以它们**只负责启动或轮询**：真正的执行在守护进程里，工具只调守护进程的 HTTP API（先 `run` 拿 job id，再 `wait` 到完成）。批量任务运行中，单账号操作（claim/accept/checkin）会得到 409 `busy`，避免和批量抢限速窗口。

## 故障排查

| 症状 | 原因与处理 |
| --- | --- |
| 「没有可参与任务的账号」 | 需要 magpie 里已登录国内版 `workbuddy` 的 **OAuth** 账号：API key 账号、企业/团队账号、国际版 `workbuddy-ai` 一律不参与；也可能被看板「参与任务」开关停用了。Docker/自定义安装时多半是守护进程找错了配置目录——给它设 `MAGPIE_CONFIG_DIR` 指向 magpie 配置目录（容器里通常是 `/config/magpie`）后重启。看板「重新扫描账号」或 `POST /api/accounts` 可立即重扫。 |
| 「任务引擎不可用」（`/api/hello` 的 `ready:false`，`/api/run` 503） | `engine/*.mjs` 缺失或加载失败——GitHub 安装没提交全 `engine/`、或文件损坏。补齐提交后在插件管理里关/开一次重载。 |
| 步骤失败：「触发风控限制 (403/11140)」 | 上游账号级风控（HTTP 403 或信封 code 11140）。引擎立即停手不重试，把该账号放进 **120 分钟冷却**（`scheduler.holds` 可看解除时间）；冷却中的账号整轮跳过。引擎**绝不**因为风控轮换/替换账号硬闯——等冷却自然解除，或明天再跑。 |
| 「快照缺任务码」/任务表为空 | 快照只在 job 结束后或 `?refresh=1` 时刷新，刚装好插件时是空的，跑一轮或点「立即运行」后就有。另外：桌面端专属（`DESKTOP_ONLY`）与 `unforgeable` 任务上游只认真实客户端行为，我们只展示它的 `jumpUrl` 深链，不会给它伪造进度——这些任务永远停在「未完成」属正常。 |
| magpie 跑在 Docker 里 | 配置目录在容器内通常是 `/config/magpie`。给守护进程设 `MAGPIE_CONFIG_DIR=/config/magpie`（`WB_CONFIG_DIR` 亦可）。宿主拉起的守护进程会继承宿主环境变量；手动拉起时记得在容器内/挂载相同路径。 |
| Windows 注意事项 | 默认配置目录遵循 XDG 约定：`%USERPROFILE%\.config\magpie`（**不是** AppData）。手动启动时给含空格/反斜杠的路径加引号：`node daemon.mjs --cfg "C:\Users\me\.config\magpie"`。chmod 600 在 Windows 上近似空操作（密钥文件不设权限位）。 |
| 看板连不上（守护进程没起） | 宿主懒加载 + 插件开关会重启宿主，看板不一定立刻就绪。用看板顶栏「启动命令」显示的命令手动拉起，或自己跑 `node daemon.mjs --cfg <magpie 配置目录> --port 4390`。 |
| 如何彻底停止/启动 | 停：插件管理里关掉（10 秒内退），或写 `state/control.json` 为 `{"desired":"off"}`（看板也有按钮）。启：插件管理里打开（下次宿主加载时拉起），或手动命令立刻拉起。 |

## 目录速览

```
index.mjs      插件入口（provider 声明、usage、五个工具、守护进程生命周期）
lifecycle.mjs  守护进程 spawn / 健康探测 / control.json / daemon.json 读写
daemon.mjs     常驻进程：HTTP 看板 + /api + SSE + 小时排程 + 任务调度
engine/        任务引擎（store 凭据读写 / upstream 信封与重试 / tasks 流水线 /
               travel 旅行+夜猫 / runner 跨账号编排 / schedule 窗口 / constants 常量）
dashboard/     本地看板前端（纯静态，无构建；密钥 sessionStorage）
page/          magpie 窗口里的入口卡（沙箱页）
tests/         引擎单元测试（node --test，fetch 全 mock，零真实网络）
tests-shell/   守护进程外壳测试；tests-e2e/ 全链路集成测试（假上游 + 假时钟）
docs/CONTRACT.md  内部契约（实现必须遵守的接口与红线）
```

## 许可

MIT，见 [LICENSE](./LICENSE)。
