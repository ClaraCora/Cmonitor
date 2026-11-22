# 从后台分批升级 Agent

在「后台 → 节点 → 升级 Agent」中，先勾选要验证的第一台，再点「全选可升级节点」或手动勾选其余节点，每批最多 100 台。首台验证通过后，其余节点同时获得领取资格，在各自下一次轮询时开始升级。点击开始后，关闭窗口不影响任务。重新打开可以看到最近一批的结果。目标版本取自当前 Hub 随包发布的 `agent.pin`。相同版本、更高版本、离线节点和 HTTP 节点均不可选。

## 首次启用

旧版 Agent 可以沿用，无需改 Token 或重装。在每台要加入的 HTTPS 节点上以 root 执行下列命令，把域名换成当前 Hub 的 HTTPS 域名。需要 Python 3.8 或以上、系统 CA 和 systemd 或 OpenRC。升级器复用 `/opt/monitor/agent.env` 中现有的 HTTPS 地址及 Token。公网反代要向 Hub 传递真实的 `Host` 和 `X-Forwarded-Proto`，包括 Agent 的 WebSocket 路径。

```sh
install -d -m 0700 /root/cmonitor-maintenance
cd /root/cmonitor-maintenance
curl --proto '=https' -fsS https://hub.example.com/agent-updater.py -o agent-updater.py && python3 -I agent-updater.py enable
```

通常约半分钟后就能勾选版本低于目标的节点。已启用的节点会定期领取任务。节点从原 Hub 下载固定版本二进制，并通过 HTTPS 从 `ClaraCora/Cagent` 官方 GitHub Release 取得独立的校验清单。节点无法访问 GitHub Release、架构不支持或校验失败时，Hub 会停止批准新的安装，并继续核实已获准安装的节点。无法使用 HTTPS 的机器继续按[离线升级说明](../OFFLINE_DEPLOY.md)维护。

## 确认与恢复

升级器在原目录保存旧文件、原子替换 Agent 并重启现有服务。服务启动失败时尝试恢复旧文件。Hub 要同时看到本机重启成功回执，以及同一节点 ID 在新连接上以目标版本提交完整指标，才将该节点记为成功。每台领取或执行超时为十分钟。若有节点失败或超时，尚未获准安装的节点会跳过，已获准的节点继续报告结果。Hub 重启会停止批次，已获准但未验证的节点标记为「结果待核实」。排除故障后，可重新勾选仍低于目标的节点。

systemd 节点用 `journalctl -u monitor-agent-updater.service` 查看升级日志。关闭本机任务领取可执行 `systemctl disable --now monitor-agent-updater.timer`。OpenRC 上运行 `rc-service monitor-agent-updater stop` 和 `rc-update del monitor-agent-updater default`。关闭领取后，原有 Agent 继续上报。
