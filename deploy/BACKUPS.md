# 定时备份与恢复验证

后台仍支持手动导出。部署级备份使用 `scripts/backup.py`，通过 SQLite 一致性备份接口读取在线数据库；完整性、外键及关键表检查通过后才保留文件。启用 `--hub` 还会在临时副本上验证当前 Hub 能打开、迁移和读取节点。验证失败或异机复制失败时不会清理旧副本。

在服务器安装（按实际部署路径调整）：

```sh
install -m 700 scripts/backup.py /opt/monitor/backup.py
install -m 644 deploy/monitor-backup.service deploy/monitor-backup.timer deploy/monitor-backup-status.service deploy/monitor-backup-status.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now monitor-backup.timer
systemctl enable --now monitor-backup-status.timer
systemctl start monitor-backup.service
systemctl start monitor-backup-status.service
journalctl -u monitor-backup.service --since today
```

默认每天服务器本地时间 03:20 备份，最多随机延后 10 分钟，保留七代。后台“数据与备份”页顶部展示自动备份状态、计划、保留份数、当前本机副本数、最近成功和下次执行时间。独立状态任务每分钟读取 `monitor-backup.timer` 和本机备份目录，只把结果写入数据库；不会创建备份。Hub 只读这份状态，因此无需放宽现有服务隔离或备份目录权限。上报超过三分钟未更新时明确提示状态过期，不会因为过去成功过就显示已启用。保留策略与目录由脚本在每次运行时上报；升级脚本后需执行一次备份才会显示。异机复制只报告是否配置，不暴露目标地址。数据库、副本和校验清单仅供运行用户读写。

异机副本通过服务覆盖配置增加 `--offsite backup@host:/srv/monitor/`，预先配置专用 SSH 密钥、主机指纹与远端目录；脚本不会自行建立信任或开放权限。异机复制使用 rsync 参数调用，不解释 shell 文本。远端保留策略由备份主机管理。备份含凭证，建议备份介质加密，并限制恢复权限。

每月用一份异机副本在隔离目录运行 `monitor-hub --db /isolated/monitor.db --check-db`，再按需要使用隔离实例和测试 Agent 检查历史与通知。`--check-db` 不启动监听、不发送通知；它会迁移指定文件，因此必须对副本操作。不要把生产数据库交给旧版本。

恢复入口先上传、再独立提交；提交后根据操作 ID 查询校验、应用和完成状态。应用前保存 `monitor.db.before-restore-<操作ID>.db`。这些安全副本不会自动删除，请在确认恢复正确并已有异机副本后按运维策略清理。网络中断或服务重启时，页面会提示结果待确认，不会声称已回滚。
