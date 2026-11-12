# 安装与发布指南（magpie-workbuddy-tasks）

本文档只讲安装：把本插件推上 GitHub 并用 `magpie plugin add github:<owner>/<repo>` 装进 magpie；以及本地开发时的沙箱测试。功能、机制与安全细节见 [README.md](./README.md)。

## 0. 前提

- magpie 已安装并能正常启动。
- magpie 里已经登录过 **WorkBuddy（国内版）**账号（`workbuddy` 供应商，由社区插件 `@magpie-community/opencode-workbuddy-auth` 提供）。本插件共享读取那份登录信息（`plugin-auth.json`），**不需要也不接受任何密钥**。

## 1. 推到 GitHub

本仓库已经完成 `git init` 与干净的初始提交（含 `LICENSE` 与 `.gitignore`），你只需要建远端并推送：

```bash
# 1) 在 GitHub 建一个空仓库（建议同名：magpie-workbuddy-tasks），不要初始化 README
#    https://github.com/new

# 2) 推送（替换 <owner>）
cd magpie-workbuddy-tasks
git branch -M main
git remote add origin https://github.com/<owner>/magpie-workbuddy-tasks.git
git push -u origin main

# 3)（可选，推荐）打上 magpie-plugin topic，让插件出现在「插件 → 发现 → 非官方插件」
#    仓库页 → About ⚙ → Topics → 添加：magpie-plugin
```

**必须整仓提交**：magpie 按「仓库当前代码」直接加载运行，没有构建步骤——`package.json` 要在仓库根目录，加载所需的 `index.mjs`、`daemon.mjs`、`lifecycle.mjs`、`engine/`、`dashboard/`、`page/` 都要提交进仓库。本仓库没有 dist/构建产物，提交的树就是运行的东西（初始提交已满足；`.gitignore` 只排除 node_modules、状态目录与日志，不含任何运行必需文件）。

以后更新：改动推到默认分支即可。magpie 对比远端提交与本地安装的提交（每 10 分钟最多问一次 GitHub），有差异就在「插件 → 已安装」提示更新，点一下或 `magpie plugin update` 完成更新。固定到某次提交（`github:<owner>/<repo>#<sha>`）的安装不会自动更新。更新代码后需要让宿主重载一次（见下）。

## 2. 安装到 magpie

```bash
# 在跑 magpie 的机器上执行
magpie plugin add github:<owner>/<repo>
```

> **首次 add 可能提示 `the plugin's load didn't finish in 20s` —— 冷启动一次性开销，不是插件坏了。**
> magpie 的插件宿主给每个插件 **20 s** 的加载时限（宿主代码 `loadWait = 20 * 1000`），而首次加载时
> Bun 运行时要**现场从 npm 源拉取 `@opencode-ai/plugin`**（注册工具必须用它）；账户代理功能的运行时依赖由包管理器按本项目 `package.json` 安装，不需要手动复制或修改 `node_modules`。离线交付时须一并携带已安装的依赖。
> 在群晖 Docker（x86_64，magpie v0.1.1876）实测：冷缓存首次解析 **45.5 s**，热缓存 **23 ms**；
> 本插件自身的 `import index.mjs` 仅 12 ms、工厂函数仅 4 ms（守护进程已在跑的复用路径），都不是瓶颈。
> 第一次 add 超时后，Bun 的拉取仍在后台完成并写入缓存，**再 add 一次（或在插件管理里停用→启用一次）即可
> 正常加载**（5 个工具全部注册成功）。全新环境还可能先下载插件运行用的
> Bun 本体（实测一次 ~60 s，且 GitHub 下载偶发失败需重试），同样只需一次。

然后在 magpie 应用里打开「**插件管理**」，**启用**本插件（安装后若未自动启用）。启用后：

- 侧栏「插件」分组出现「**WorkBuddy 任务**」入口卡；
- **「供应商」里不会出现本插件**——本插件不声明 provider，没有「登录/添加账号」一说：任务凭据始终来自 magpie 已登录的 workbuddy 账号，本插件不收任何密钥。旧版本在供应商里的「WorkBuddy 任务」（显示「未登录」）升级后消失，这是预期行为；也不要给它曾经的占位账号发对话。

### 重载语义（重要）

- 终端里执行的 magpie 命令**每次都会重新加载插件**；
- 应用内宿主**不会热重载**：`magpie plugin update` 拉下来的新代码、或文件夹方式安装时的本地改动，都要等宿主重载才生效——用 `magpie plugin use <插件名>`（若你的版本支持），或最稳妥地在「插件管理」里把本插件**关掉再打开**。

### 验证

1. 看板守护进程由插件宿主懒加载拉起，**不一定立刻就绪**（详见 README「生命周期」）。等宿主加载过本插件后，检查 `<magpie 配置目录>/workbuddy-tasks/state/daemon.json` 是否出现（内含 `pid / port / key / version / startedAt`；`key` 仅为向后兼容保留的字段，不是访问凭据）。
2. `curl http://127.0.0.1:<port>/api/hello` 返回 `{"name":"workbuddy-tasks",...}`；`ready:true` 表示引擎文件齐全。
3. `curl http://127.0.0.1:<port>/api/state`（**无需任何密钥**，全部 API 免密钥）：`accounts` 非空且只含国内版 workbuddy 账号（国际版不出现，顶层 `intlSkipped.count` 是它的只读计数）；若 `notice` 提示找不到配置目录，给守护进程设 `MAGPIE_CONFIG_DIR`（Docker 里通常是 `/config/magpie`）后重启 magpie。
4. 守护进程就绪后打开看板 `http://127.0.0.1:<port>/`（无需登录/解锁，看板与 API 均无鉴权——安全靠网络边界，默认只绑 127.0.0.1）。批量按钮共四个：「批量接任务」（只接取，不点亮）、「批量做任务」（完整流水线：接取 → 点亮 → 领奖）、「只领奖」（补领停在「待领奖」的任务）、「每日签到」（手动补签；自动签到仍归官方插件）。也可用工具 `workbuddy_tasks_run` 启动一轮、`workbuddy_tasks_wait` 看逐步进度。

## 2b. Docker 里跑 magpie（实测环境：ghcr.io/yetone/magpie，配置卷 /config）

文件夹插件必须存在于**容器可见的目录**里。数据卷在宿主机是 `<卷>/config`，容器内是 `/config`：

```bash
# 从宿主机把插件目录放进配置卷（用 docker exec 以 uid 65532 写入，避免权限问题）
tar cf - magpie-workbuddy-tasks | docker exec -i magpie sh -c \
  'mkdir -p /config/magpie/plugins-local && tar xf - -C /config/magpie/plugins-local'
docker exec magpie magpie plugin add /config/magpie/plugins-local/magpie-workbuddy-tasks
```

看板默认只听 `127.0.0.1`——那是**容器自己的**回环，宿主机和其他机器都进不去。两种办法：

- 在「插件 → 已安装 → 选项」里把 `listenAddress` 设为 `"0.0.0.0"`：守护进程会绑定容器内**所有接口**（`0.0.0.0`），宿主机只能经**容器网桥 IP** 访问（用 `docker inspect magpie` 查容器 IP，如 `172.17.x.x` / `172.31.x.x`）——**没有** `-p` 发布就不出宿主机。改完后 `GET /api/state` 会带 `bindHost:"0.0.0.0"` 与 `reachableHint`（提示只到容器网桥、走 SSH 隧道）。再从你自己的电脑打一条隧道看网页：
  `ssh -L 4390:<容器IP>:4390 <nas-user>@<nas-host>` → 浏览器开 `http://127.0.0.1:4390/`。
- 或者重建容器加 `-p 127.0.0.1:4390:4390`（把容器 4390 映射到宿主机回环），同样只走 SSH 隧道访问。

`MAGPIE_CONFIG_DIR` 在容器里通常是 `/config/magpie`；插件的 `input.directory` 会直接给出该路径，一般不用设。

**免密钥要特别当心边界**：看板与全部 API 无任何鉴权（用户明确要求的口径）——能连上端口的人都能用你已登录的 WorkBuddy 账号跑任务、写入 `plugin-auth.json`、下载含 token 的导出并关停守护进程。默认只绑容器内回环是安全的；一旦绑 `0.0.0.0` 或用 `-p` 把端口发布出去，同一局域网内的任何主机都拥有上述全部能力。因此：**不要**把 4390 发布到公网或开放 LAN（`-p 0.0.0.0:4390:4390` 这类映射等于把控制权交给全网）；不用时在插件管理里停用（守护进程 10 秒内退出）；跨机器访问一律走 SSH 隧道——隧道本身就是鉴权。

## 3. 本地沙箱测试（不碰你真实的 magpie）

给 magpie 一个独立的 HOME，像官方文档那样：

```bash
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@" ; }

m plugin add ./magpie-workbuddy-tasks
m plugin --json                     # 方式、工具、加载错误（本插件不声明 provider：无账号、无模型）
```

跑测试套件（不需要 magpie，零真实网络——fetch 与时钟全部注入）：

```bash
node --test "tests/**/*.test.mjs" "tests-shell/*.test.mjs" "tests-e2e/*.test.mjs"
# 或只跑守护进程外壳：
node --test tests-shell/daemon.test.mjs
```

手动调试守护进程：

```bash
node daemon.mjs --state ./tmp/state --cfg ./tmp/cfg --port 4390
# Windows 下路径含空格要加引号；实际端口写在 ./tmp/state/daemon.json（0600；其 key 字段为向后兼容保留，非访问凭据）
```

## 4. 停用与卸载

- 临时停用：magpie 插件管理里关掉本插件 → 守护进程 10 秒内读到 `plugins.json` 的 `off:true` 会优雅退出；再打开即恢复（下次宿主加载时拉起，或用 README 里的手动命令立刻拉起）。
- 彻底移除：`magpie plugin remove <名字>`；托管模式下守护进程发现条目消失即自杀。想连状态一起清掉，删除 `<magpie 配置目录>/workbuddy-tasks/` 即可——里面只有排程设置、历史与快照，**没有登录凭据**；`plugin-auth.json` 由 magpie/社区插件拥有，本插件从不删除它。
