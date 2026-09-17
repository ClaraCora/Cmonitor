# Cmonitor

## 特性

- 实时监控：秒级实时数据展示
- 轻量高效：Rust 语言构建，低资源占用，极简高效
- 自托管：完全掌控数据隐私，部署简单
- 通知：节点掉线、流量、到期与登录，推送到 Telegram 或自定义 Webhook
- Web Terminal：通过在线节点上的 Cagent 打开本地 PTY，浏览器无需 SSH 密码或密钥

## 组成

| 仓库 | 说明 |
|---|---|
| [Cmonitor](https://github.com/ClaraCora/Cmonitor) | hub：后台、API、公开页宿主 |
| [Cagent](https://github.com/ClaraCora/Cagent) | Linux agent |
| [monitor-theme-default](https://github.com/monitor-probe/monitor-theme-default) | 内置默认主题 |

```
Cagent (Linux)  ──WebSocket / JSON-RPC 2.0──▶  Cmonitor hub  ──▶  后台 + 状态页
浏览器 Web Terminal  ──WebSocket──▶  Cmonitor hub  ──▶  Cagent 本地 PTY
```
