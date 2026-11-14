# 复用 Magpie 账户代理

Tasks 从 Magpie 配置目录的 `providers.json` 读取
`providers[].accountProxies[accountId]`。`accountId` 是 `plugin-auth.json`
中条目的原始字段，不是 `uid`、昵称兜底值或 `workbuddy#...` 凭据键。
只读这份映射，不另存代理配置，不修改 Auth 插件。

- 支持 `http://`、`https://`、`socks5://` 和 `socks5h://`。
- `socks5h` 在代理端解析目标域名；`socks5` 按协议在本地解析。
- 每次请求读取当前配置，下一次请求即跟随账户代理修改。
- 任务腿、每日活跃、Token 刷新、手动签到/接取/领奖、积分和快照走同一账户传输。
- 显式代理不受 `NO_PROXY` 绕过；代理错误不自动直连，错误日志不含代理地址密码。
- 未绑定账户代理时保留原 `fetch` 默认行为（包括运行时原有环境代理规则）。
- 独立安装且从未存在 `providers.json` 时兼容旧行为；已观察到的文件消失、
  损坏、映射格式错误或无法准确匹配账户时阻止请求，不猜测代理或降级直连。

## 接口和升级兼容

不改现有 HTTP 路由、插件入口、认证文件格式、调度/限流与冻结行为。
`JobRunner` 新增可选 `fetchForAccount(account)`，未提供时仍使用原 `opts.fetch`；
`startDaemon({fetch})` 的测试/嵌入注入优先级不变。账户增加原始 `accountId` 字段；
`GET /api/state` 仅增加不含秘密的 `accountProxyMode` 能力标志。

传输位于发布清单已经包含的 `engine/` 内，依赖由标准 `package.json` 和
`package-lock.json` 声明，不带用户配置，不使用硬编码路径或安装后源码替换。
Magpie 的原 GitHub/npm 插件安装、更新方式保持不变，无额外补丁步骤。
只有当此功能被上游合并并发布后，官方更新才会正式包含它；未合并时不能承诺
现有官方版本升级后保留任何本地修改。

## 验证

```sh
npm ci --ignore-scripts
bun test --timeout 30000 ./tests ./tests-shell ./tests-e2e
node --test tests/account-proxy.test.mjs tests/account-proxy-daemon.test.mjs tests/account-socks.test.mjs
npm pack --ignore-scripts
```

代理测试仅使用临时配置、虚构凭据和回环服务器，不访问真实账号或公网目标。
测试覆盖跨账户隔离、配置变更、SOCKS 用户密码/远端 DNS/重定向、HTTP CONNECT、
环境代理绕过防护、故障不直连及既有 `fetch` 注入兼容性。
