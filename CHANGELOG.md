# 更新日志

## 0.3.1 — 2026-11-06

### 新增

- **`Buddy_App` 自动化**：5 条 `buddyapp_*` 桌面事件 + 桌面指纹一次上报，实测任务进度 0→1 并领奖 +100。`Buddy_App` 已移出 `DESKTOP_ONLY_TASKS`。
- **小程序任务进入快照/看板**：`Sequential_Tasks_1–6` + `school_season` 会合并进 `/api/state` 的任务快照（同一 code 以 web 清单为准），因此可以在看板里看到、勾选、单账号接取/领奖。
- **小程序单账号操作分流**：`POST /api/task/accept` / `POST /api/task/claim` 对 MP code 自动改用小程序头族（`X-Client-Platform: miniprogram` / `mp-weixin`）。
- 看板任务行对小程序任务显示「小程序」徽章。

### 修复

- 小程序任务接取失败时记录上游原因（例如 `task locked until 2026-11-07`），不再静默 +0。
- 没有新的点亮/领取时，结尾改为「本轮结束：没有新的收益」，不再误报「全部完成」。
- 已领奖的小程序任务会记录「已领奖，跳过」。

### 测试

- 343 个测试全绿，零真实网络。

## 0.3.0 — 2026-11-06

### 新增

- **Buddy 盲盒独立腿**（`buddy`）：批量条可勾选、排程可配北京时间窗口；默认不排程，开盒会消耗成长能量；不领取积分、不计入收益结算。
- **微信小程序链式任务执行**：`Sequential_Tasks_1–6` + `school_season`，使用小程序头族与 `WorkBuddy_MP` 事件指纹，接取/点亮/领奖一次完成；支持 `codes` 勾选。
- **RichMeow 桌面 6 连**：`agent_task_created → chat_message_send → chat_request_send → chat_message_response → chat_request_response → agent_task_completed`，一次上报点亮。
- **playbook 双事件**：`playbook_cta_click` + `playbook_prompt_send`。
- 新增 `workstation_expert`（工作台搭建师）与 `Sequential_Tasks_7`（PC 灵感功能）规格。

### 修复

- 排程、夜猫子窗口、历史触发方式统一北京时间口径（容器 UTC 下不再把北京 09:00 误跑成夜猫子）。
- 排程历史正确记录「排程 / 手动」触发方式。

## 0.2.0 — 2026-11-01

### 新增

- **积分余额与套餐明细**：看板「积分」列、明细弹窗（剩余/已消耗/总额度/最近将过期、套餐包筛选/搜索/排序），10 分钟缓存，只读查询。
- **每日活跃连登**：每个账号每个北京日一条事件，成功才落账（`state/daily-activity.json`），失败不阻断任务。
- **任务级勾选**：按账号勾选任务，批量操作只做选中的；`codes` 同时支持 API 与工具。
- `Library_read` 改为 web 点击事件点亮。

### 界面

- 中文字体栈改为 PingFang / 微软雅黑 / Noto Sans SC，修复 Windows 下回退到日文字体/宋体的问题。
- 看板进度条使用 SVG + `crispEdges`，高 DPI 下两条进度条等粗。

## 0.1.0 — 2026-10-31

### 首个版本

- 复用 magpie 已登录的 WorkBuddy 国内版账号，提供成长任务批量流水线（接取 → 点亮 → 领奖）、猫猫旅行、夜猫子。
- 本地看板、SSE 实时进度、北京时间小时排程（默认停用）、5 个 MCP 工具。
- hub 兼容的账号 JSON 导入/导出、纯国内版过滤、免密钥局域网 API、全局 1s 上游节流。
