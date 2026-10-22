# Cmonitor

部署时无法访问 GitHub、运行时仅允许 IP 接入，可按 [Agent 离线安装与手写配置指南](OFFLINE_DEPLOY.md) 配置现有 HTTP IP 入口，启动后继续向原探针上报。

## 特性

- 实时监控：秒级实时数据展示
- 轻量高效：Rust 语言构建，低资源占用，极简高效
- 自托管：完全掌控数据隐私，部署简单
- 通知：节点掉线、流量、到期与登录，推送到 Telegram 或自定义 Webhook
- Web Terminal：通过在线节点上的 Cagent 以 root 打开本地 PTY，浏览器无需 SSH 密码或密钥

## 组成

| 仓库 | 说明 |
|---|---|
| [Cmonitor](https://github.com/ClaraCora/Cmonitor) | hub：后台、API、公开页宿主 |
| [Cagent](https://github.com/ClaraCora/Cagent) | Linux agent |
| [Cmonitor-theme-default](https://github.com/ClaraCora/Cmonitor-theme-default) | 内置默认主题 |

```
Cagent (Linux)  ──WebSocket / JSON-RPC 2.0──▶  Cmonitor hub  ──▶  后台 + 状态页
浏览器 Web Terminal  ──WebSocket──▶  Cmonitor hub  ──▶  Cagent 本地 PTY
```

Cagent 服务以 `root` 运行，Web Terminal 拥有与 root SSH 相同的系统权限。请严格保护后台登录凭证。

## 登录与版本

Hub `v1.2.6` 起，后台顶部显示运行中的 Hub 版本。「安全」页可关闭应急密码，但必须先保存完整的
GitHub OAuth 配置和用户白名单，再成功登录验证。关闭后仅允许 GitHub 登录，旧密码登录会话会被撤销。
修改 GitHub 配置前先开启应急密码；修改后需要重新验证。重启和升级保持开关状态。

GitHub 不可用时，在 Hub 服务器本地恢复（自定义安装请替换路径）：

```bash
sudo /opt/monitor/monitor-hub --db /opt/monitor/data/monitor.db --reset-password
```

该命令开启应急密码，撤销所有旧登录，并仅在当前终端显示一次新密码。

## 通信与安装安全

- 浏览器 WebSocket 和后台修改请求校验来源；反向代理须保留 Host，并正确设置 Hub 的 `--site`。
- Agent 默认使用 WSS 和证书校验。Cagent `v1.1.3` 包含 TLS 握手漏洞 RUSTSEC-2026-0285 的修复。
- 重置节点 Token、删除节点、替换 Agent 连接或撤销登录会话，会断开对应终端并清理交互 shell。
- 每个节点最多 4 个终端，Hub 最多 32 个；连接建立与数据发送都有超时限制。
- `agent.pin` 固定 Agent 发布版本及 SHA-256。Hub 校验下载内容后才转发，安装脚本再次校验后才安装。
  第三方 GitHub 下载代理不能提供自己的可信摘要。升级固定 Agent 版本需要更新该文件并发布 Hub。
- 构建、测试、依赖漏洞扫描和发布通过 GitHub Actions 的 Linux 环境执行。
- 前端开发与构建使用根目录 `.node-version` 指定的 Node 版本；在 `web-admin/` 执行 npm 命令。项目会拒绝低于安全基线的 Node 环境。

## 服务器与 GitHub 构建

- 正式服务器运行 Rust Hub 和内嵌静态前端；发布容器基于 `scratch`，不需要安装 PHP、Node 或 npm。
- GitHub 的 CI、发布和依赖扫描统一使用 `.node-version` 中的 Node 安全版本。安装前端依赖前，CI 和发布流程会检查实际 Node 版本及 DNS/TLS 修复行为，并执行依赖审计；发布流程还会审计 Rust 依赖，任一步失败会阻止后续构建或发布。相关依赖变更的 PR 也会触发安全扫描。
- 将修复提交到 GitHub 后，可在 Actions 的 `ci` 工作流手动运行完整检查。`release` 的手动运行只构建二进制产物；创建 `v*` 标签才会发布二进制和容器。
- 现有服务器应通过原有安装脚本的升级入口或更新已发布容器进行升级。同机其他 PHP/Node 服务需要分别升级其实际运行时，Hub 的更新不会替它们修复漏洞。
