# 工作站异机备份与站外探活

本目录用于 macOS 工作站。数据库从已授权的 Hub 经 SSH 拉取到 AES-256 加密的稀疏卷，解锁口令保存在当前账户的登录钥匙串中。稀疏卷、钥匙串与工作站的 SSH 配置都不应进入 Git。Hub 后台的 `offsite` 显示的是服务器主动推送状态，工作站拉取以本机的 `last-backup.json` 为准。

将本目录下的 Python 脚本复制到 `~/Library/Application Support/Cmonitor Maintenance/`，目录权限设为 0700。在那里创建权限为 0600 的 `settings.json`，填写 `host`（已有 SSH 别名）、`ssh_config`（绝对路径）、`site`（站点的 HTTPS 地址）、`check_hub` 和 `check_agent`（与发布匹配的本机演练程序绝对路径）。使用系统 Python 3，钥匙串条目按本机用户创建。

先运行 `python3 recovery.py --init --drill`。它验证远端清单、节点数量、完整性与外键，将数据库恢复到加密卷内的独立目录，再启动回环 Hub、加载磁盘主题并接收测试 Agent 的指标。演练副本关闭通知，撤销生产会话并替换节点凭据。恢复包另存 Linux 程序、主题及 systemd 定义。跨机房正式切换时还需准备该站点的反代和 TLS 证书，并保留 HTTP 节点使用的 IP 和端口。

运行 `python3 watch.py` 检查站点，再运行 `python3 schedule.py` 注册三个用户级 launchd 作业。公网探活每两分钟运行一次，连续三次失败或恢复时投递到本机通知中心。只跟踪至少观察到一次在线的公开节点。异机备份每半小时检查服务器是否有新恢复点，保留最近十四个备份日期。每三十天重复恢复演练。工作站须登录、联网且能读取钥匙串，休眠或关机会暂停检查。若要全天候外部送达，可在后台配置团队实际使用的 Telegram 或 Webhook，随后从收件端确认。

`drill.json` 记录最近一次实际演练。系统钥匙串中的条目名称为 `Cmonitor encrypted recovery volume`。更换工作站前请按自己的密钥托管流程保存恢复口令，否则不能在新机器解开旧卷。安装环境与日志都位于上述本机目录。卸载调度只需对 `local.cmonitor.backup`、`local.cmonitor.public-watch`、`local.cmonitor.restore-check` 分别执行 `launchctl bootout gui/$(id -u)/服务名`，移除对应 LaunchAgents plist，保留加密备份和钥匙串条目。
