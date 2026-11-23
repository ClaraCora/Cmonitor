# 从 Hub 批量升级 Agent

在「后台 → 节点 → 升级 Agent」可以一次选择最多 100 台。Hub 先升级第一台。只有维护升级器提交安装回执，且 Hub 随后在原节点 ID 的新版 HTTPS/WSS 会话上收到完整指标后，其余已选节点才会同时获得领取资格，各自在下一次轮询时开始升级。目标版本由当前 Hub 随附的 `agent.pin` 决定。

## 部署新版升级器

1. 在没有运行中批次时升级 Hub。Hub 重启或恢复数据库会停止原批次，已经获准安装但还没有验证的节点显示「结果待核实」。
2. 通过「批量添加」的管理员注册窗口新建 HTTPS 节点时，安装器为每台机器取得独立的上报和维护凭据。用既有节点的 `--token` 安装时，Agent 安装后即可上报，升级器在收到该节点的维护凭据前待命。需要手动维护的机器可在本次安装使用 `--no-updater`。
3. 新版 Hub 会清除旧版升级器的心跳并关闭旧注册窗口。已部署的 HTTPS 节点需逐台重新配对。重置上报 Token、恢复数据库或撤销授权后也需重新配对。配对前检查节点名称、ID 和管理员验证过的 SSH 主机身份。请使用 SSH、云厂商控制台等独立管理入口传送凭据。Hub 网页终端通过上报连接识别节点，不能用它分发维护凭据。

### 为已有 HTTPS 节点配对

1. 打开「节点 → 升级 Agent → 管理节点维护凭据」，选择待配对的 HTTPS 节点，点击「复制一次性配对命令」。如果后台提示登录时间过长，请重新登录。
2. 通过独立 SSH 客户端（例如 Netcatty）登录所选服务器，以 root 粘贴完整命令并执行。命令有效期为 10 分钟。为同一节点重新生成后，前一条尚未使用的命令立即失效。每台机器使用自己的命令。
3. 回到后台核对该节点显示「已配对维护凭据」，并出现本次配对之后的「升级器 v2」心跳。这时可正常加入后续的升级批次。已经达到目标版本的节点会继续上报，等下一版 Agent 发布后再升级。

节点使用本机的上报身份和一次性票据向原 HTTPS Hub 登记，在本机保存独立维护密钥。配对只安装或启用升级器，原 Agent 持续运行。若连接在配对途中断开，请在**同一台机器**重试刚才的命令。尚未兑换且已经过期的票据需从后台重新生成。HTTP 离线维护节点请使用节点列表中的「复制升级命令」。

需要传输维护文件时，仍可使用后台的下载入口或在 **Hub 主机**以 root 签发。将下例中的数据库路径、站点和节点 ID 替换为实际值。输出目录必须是 root 私有目录，目标文件必须尚不存在。再次签发会撤销这一节点的旧凭据。

```sh
install -d -m 0700 /root/cmonitor-grants
/opt/monitor/monitor-hub --db /opt/monitor/data/monitor.db --site https://hub.example.com \
  --maintenance-grant 42 --maintenance-output /root/cmonitor-grants/node-42.json
```

通过独立管理入口将文件传给对应节点。在**该节点**以 root 将它放到升级器目录，随后安装或更新升级器。域名须与该节点原有 `/opt/monitor/agent.env` 完全一致。若更新升级器失败，修复依赖或网络后可重试第二行。

```sh
install -o root -g root -m 0600 /root/node-42.json /opt/monitor/agent-maintenance.json
curl --proto '=https' -fsS https://hub.example.com/install.sh | sh -s -- --updater-only
```

节点需要系统 CA、Python 3.8 或以上，以及 systemd 或 OpenRC。安装器会尝试用包管理器补齐缺失的 Python。普通重装保留手动停用的升级器状态。反代需要传递真实的 `Host` 和 `X-Forwarded-Proto`，包括 Agent 的 WebSocket 路径。

升级器通常每 30 秒轮询一次。在后台核对「升级器 v2」和最近心跳，完成后删除传输用的临时凭据副本。管理员也可读取 `GET /api/agent-upgrades`，查看 `maintenance` 中的配对策略和 `workers` 中的协议及最近心跳。Hub 主机可用 `/opt/monitor/monitor-hub --db /opt/monitor/data/monitor.db --maintenance-revoke 42` 撤销指定节点的升级权。

### HTTP 上报节点

Hub 一旦观察到节点通过 HTTP 上报，就会将其永久标记为离线维护，禁用在线升级和网页终端。升级 Hub 时，也可以由 Hub 主机 root 预先为已知 HTTP 节点设置策略。例如，已确认上海节点 ID 为 17 时，执行 `/opt/monitor/monitor-hub --db /opt/monitor/data/monitor.db --maintenance-offline 17`。重新连回或重置上报 Token 会保留这个标记。

目标机应先通过可信管理渠道预置独立离线验证器，再运行 `sh /root/agent-offline-install.sh "$SHA256" "$PACKAGE"`。从可信渠道取得固定摘要，包可以通过 HTTP 或本地文件提供。核对原节点 ID 恢复上报并显示目标版本。[离线包获取、校验与回退](../OFFLINE_DEPLOY.md#3-已安装节点离线升级)

## 发起和核实批次

1. 打开「升级 Agent」，先勾选用于验证的节点，再点击「全选可升级节点」或手动勾选其余节点。检查底部「首台验证」显示的名称和节点数。已达到目标版本、离线、使用明文连接或尚未就绪的节点不能勾选。
2. 点击「开始升级」。关闭窗口后，Hub 仍会处理批次。若提交时连接中断，先重新读取最近批次并核对节点，避免重复提交。
3. 最近批次显示各节点的状态和原因。「已恢复上报」表示 Hub 已同时核实升级器安装回执、原节点的新会话、目标版本和完整指标。安装回执丢失时，v2 升级器会重发同一次安装的回执。
4. 有节点失败或超时时，Hub 会跳过尚未获准安装的节点，并继续核实已获准安装的节点。排除故障后，可用「选择可重试节点」选取仍然符合条件的节点发起新批次。

## 处理异常

| 最近批次的表现 | 核查和处理 |
| --- | --- |
| 下载失败或校验失败 | 节点从原 Hub 下载二进制，并从 Cagent 官方 GitHub Release 独立取得 SHA-256 清单。暂时断网、限流和部分服务器错误会退避重试。持续下载失败时检查两条 HTTPS 路径。摘要或版本不符时检查 Hub 固定版本与官方 Release，原程序仍保留。 |
| 新服务启动失败 | 升级器保存旧程序后原子替换二进制并重启原服务。本机重启或运行状态检查失败时，升级器尝试装回旧程序并重启。检查服务日志和原节点的上报情况。 |
| 等候回滚或正在恢复旧版 | v2 的观察阶段超时，且 Hub 在新版会话上持续收到不完整指标时，Hub 才会发出限时回滚许可。升级器核对本机当前程序和旧副本，收到有效许可后执行回滚。成功启动旧版后的回执可重发。 |
| 结果待核实 | 断网、Hub 重启或超时都可能使结果无法确认。升级器保存未完成的状态，通信恢复后查询或重发回执。仅凭失联不会触发回滚。核对原节点版本、指标、Agent 和升级器日志，再决定是否重试。 |

领取、下载校验、安装和观察各有 10 分钟的期限。Hub 对持续收到不完整指标的节点保留 2 分钟领取回滚的时间，获准后有 3 分钟完成并回报。节点的旧程序保存在 `/opt/monitor/.agent-updater.previous`，当前尝试的恢复记录保存在 `/opt/monitor/.agent-updater.state`。

如果配对时发现前一份凭据留下的升级记录，升级器会先向 Hub 验证新凭据，再将旧记录与现存的备份和候选文件保留到 `/opt/monitor/.agent-updater-archive-*`。查看这些文件时，应结合 Hub 原批次记录核对版本。当前运行的二进制和服务不会因归档而重启。

systemd 节点用 `journalctl -u monitor-agent-updater.service` 查看升级器日志，用 `journalctl -u monitor-agent` 查看 Agent 日志。若要停止领取任务，执行 `systemctl disable --now monitor-agent-updater.timer`。OpenRC 节点执行 `rc-service monitor-agent-updater stop` 和 `rc-update del monitor-agent-updater default`。原有 Agent 服务可继续上报。
