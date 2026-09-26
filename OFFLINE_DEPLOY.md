# Agent 离线安装：通过现有 HTTP IP 入口连接原探针

本文适用于：**目标机器只能访问 IP；原探针服务端已有 HTTP 的 IP＋端口入口；安装文件从其他联网电脑下载后搬入。Agent 安装后通过这个现有入口，继续向原 Hub 上报。**

节点使用原面板为它生成的 Token。主要配置是 `MONITOR_SERVER=http://IP:端口`，启动命令增加 `--insecure`。本流程只在节点安装 Agent，使用服务端已有的接入入口。

HTTP 上报中 Token 和监控数据以明文传输；当前 Cagent v1.1.3 会禁用这种远程明文连接上的 Web Terminal，CPU、内存、流量等监控上报仍可使用。

操作流程是：在联网电脑下载 Agent → 复制到目标机器 → 写入现有 HTTP IP 入口和节点 Token → 创建带 `--insecure` 的服务 → 向原面板上报。

示例按当前仓库 Hub v1.2.27 固定的 Cagent v1.1.3 编写。目标机器为 Linux，提供 systemd 和 Alpine/OpenRC 两种服务配置。命令使用 Linux Bash 语法；在 Windows 上准备下载文件时，可以使用 WSL，或通过浏览器下载同名文件。

## 1. 提前准备原地址、Token 和系统条件

### 原探针地址

下文统一使用示例入口 `http://203.0.113.10:28081`，请替换成**你已有的、指向原 Hub 的真实 HTTP IP＋端口**。`203.0.113.10` 是文档示例 IP，28081 也只是示例端口，不能原样使用。

```ini
MONITOR_SERVER=http://203.0.113.10:28081
```

明确保留 `http://` 和实际端口，不加 `/clara`、`/install.sh` 或 `/api/agent/ws`。Agent 最终会连接 `ws://203.0.113.10:28081/api/agent/ws`。若使用 IPv6 字面量，地址需加方括号，例如 `http://[2001:db8::10]:28081`，该 IPv6 同样只是示例。

### 节点 Token

安装前，在能够访问原面板的电脑上：

1. 登录原面板，在节点列表添加这台机器对应的节点。
2. 打开该节点的“安装 Agent”窗口。
3. 从生成的命令中记下 `--token` 后面的完整值；服务器地址使用你已有的 HTTP IP 入口。

例如原命令为：

```text
curl -fsSL https://status.example.net/install.sh | sh -s -- --server https://status.example.net --token abc123... --interval 1
```

上面的域名只是原面板生成的命令示例。手写配置使用你已有的 HTTP IP 入口，Token 使用该命令中的值。IP 入口必须连接到发放这个 Token 的同一个 Hub。**每台机器使用独立节点、独立 Token**；Token 必须由原面板生成，不能随意编写，也不能用批量注册密钥代替。复用已有节点时，可使用它现有的有效 Token。

### 目标机器条件

- Linux `x86_64` 或 `aarch64`，具备 systemd 或 OpenRC。
- 具备 `tar`、`sha256sum`、`install` 等基本系统工具，并可取得 root 权限。
- 安装后能访问现有 HTTP IP 入口的 TCP 端口，并且该入口支持 `/api/agent/ws` 的 WebSocket 转发。
- 无需在节点上安装 Hub、Nginx、Docker、Rust、Node.js 或数据库。

Agent 主动连接原面板，一般不需要给节点额外开放入站端口。如果安装时节点尚未联网，可以先创建服务；恢复网络后 Agent 会自动尝试连接。

## 2. 在联网电脑准备 Agent 离线包

### 2.1 选择架构

在目标机器查看：

```bash
uname -m
```

| 输出 | 使用的文件 |
| --- | --- |
| `x86_64` / `amd64` | `monitor-agent-x86_64-unknown-linux-musl` |
| `aarch64` / `arm64` | `monitor-agent-aarch64-unknown-linux-musl` |

下面一次打包两种架构，每台机器安装时再选择自己的文件。

### 2.2 下载、校验和打包

在**能够访问 GitHub 的联网电脑**执行：

```bash
set -euo pipefail

mkdir -p cmonitor-agent-offline
cd cmonitor-agent-offline

AGENT_TAG=v1.1.3

for ARCH in x86_64 aarch64; do
    curl -fL --retry 3 \
        "https://github.com/ClaraCora/Cagent/releases/download/${AGENT_TAG}/monitor-agent-${ARCH}-unknown-linux-musl" \
        -o "monitor-agent-${ARCH}-unknown-linux-musl"
done

# 摘要来自本仓库 Hub v1.2.27 的 agent.pin，对应 Cagent v1.1.3。
cat > sha256sums.txt <<'EOF'
1879b3cd7da55d32a41cfa751c5112345d0647ef28e310d4e4746b9bc719f423  monitor-agent-x86_64-unknown-linux-musl
9f37a0e9e7597d87b404613629389b25ccd6bb6b9e9ad60fa03f2893eda2526e  monitor-agent-aarch64-unknown-linux-musl
EOF

sha256sum -c sha256sums.txt
printf 'Agent=%s\n' "$AGENT_TAG" > versions.txt

cd ..
tar -czf cmonitor-agent-offline.tar.gz cmonitor-agent-offline
sha256sum cmonitor-agent-offline.tar.gz > cmonitor-agent-offline.tar.gz.sha256
```

两个文件应均显示 `OK`。如果原面板运行的是其他版本，先核对对应 Hub 发布版本的 `agent.pin`，采用它固定的 Agent 版本和摘要；改版本时不能继续沿用这里的旧摘要。

下载页面：[Cagent v1.1.3 Release](https://github.com/ClaraCora/Cagent/releases/tag/v1.1.3)。用浏览器准备时，下载上述二进制文件，按本节内容创建校验文件并校验；不要下载 `Source code` 源码包来代替可执行文件。

## 3. 把文件复制到目标机器

通过 U 盘、SFTP、SCP 或内网文件服务器，把以下文件放到目标机器 `/tmp/`：

```text
cmonitor-agent-offline.tar.gz
cmonitor-agent-offline.tar.gz.sha256
```

以下步骤均在**被监控的目标机器**上以 root 执行，可先运行 `sudo -i`。

```bash
cd /tmp
sha256sum -c cmonitor-agent-offline.tar.gz.sha256

# 仅在上一条校验显示 OK 后继续。
tar -xzf cmonitor-agent-offline.tar.gz -C /opt
cd /opt/cmonitor-agent-offline
sha256sum -c sha256sums.txt
```

全部校验通过后继续。后面的安装步骤只读取本地文件，不会访问 GitHub。

## 4. 手动安装二进制并写配置

### 4.1 安装二进制

以下按首次安装编写。如果机器已有 Agent，先按第 7 节停止并备份原服务、二进制和配置，再替换。

```bash
case "$(uname -m)" in
    x86_64|amd64) ARCH=x86_64 ;;
    aarch64|arm64) ARCH=aarch64 ;;
    *) echo "不支持的架构"; exit 1 ;;
esac

install -d -m 0755 /opt/monitor
install -m 0755 -o root -g root \
    "/opt/cmonitor-agent-offline/monitor-agent-${ARCH}-unknown-linux-musl" \
    /opt/monitor/monitor-agent
```

最终运行的文件为 `/opt/monitor/monitor-agent`。发布文件是静态链接二进制，无需在目标机器编译。

### 4.2 手写 `/opt/monitor/agent.env`

创建配置文件，**把下面的 IP、端口替换成现有 HTTP 入口，Token 替换成第 1 节取得的节点 Token**：

```bash
install -m 0600 -o root -g root /dev/null /opt/monitor/agent.env
cat > /opt/monitor/agent.env <<'EOF'
MONITOR_SERVER=http://203.0.113.10:28081
MONITOR_TOKEN=REPLACE_WITH_THIS_NODE_TOKEN
EOF
```

配置要求：

- `MONITOR_SERVER` 填现有 HTTP IP 入口，形如 `http://IP:端口`；运行时不需要解析原面板域名。
- `MONITOR_TOKEN` 是这个节点的完整 Token。
- 每行一个 `KEY=value`，不要写 `export`，等号两边不要留空格。
- 文件权限为 `0600`，只允许 root 读取和修改。

例如最终文件可以是：

```ini
MONITOR_SERVER=http://203.0.113.10:28081
MONITOR_TOKEN=这里替换成原面板生成的完整Token
```

`agent.env` 由下文的服务配置加载；Agent 不会仅因这个文件存在就自动读取它。上报间隔写在服务启动参数中。

## 5. systemd：手写服务并启动

适用于 Debian、Ubuntu、Rocky Linux 等使用 systemd 的机器。Alpine/OpenRC 使用第 6 节，两种方式选一种。

### 5.1 创建 `/etc/systemd/system/monitor-agent.service`

```bash
cat > /etc/systemd/system/monitor-agent.service <<'EOF'
[Unit]
Description=Cmonitor Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
EnvironmentFile=/opt/monitor/agent.env
ExecStart=/opt/monitor/monitor-agent --interval 1 --insecure
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

`--interval 1` 表示每秒上报，可改成 1–3600 的整数，例如 `--interval 5`。`--insecure` 用于允许连接远程 HTTP IP 入口，不能遗漏。使用 root 与项目官方安装方式一致；在本方案的远程明文连接上，Agent 不开放 Web Terminal。

### 5.2 启用和检查

```bash
systemctl daemon-reload
systemctl enable --now monitor-agent
systemctl status monitor-agent --no-pager
journalctl -u monitor-agent -n 50 --no-pager
```

安装时仍无网络，日志会显示连接失败并重试；网络恢复后，Agent 会自动连接 `MONITOR_SERVER` 中配置的原探针地址。也可以在联网后主动执行：

```bash
systemctl restart monitor-agent
```

需要实时查看日志时执行 `journalctl -u monitor-agent -f`，按 `Ctrl+C` 返回。

## 6. Alpine / OpenRC：手写服务并启动

先完成第 3、4 节的二进制和 `agent.env` 配置，再创建 `/etc/init.d/monitor-agent`：

```bash
cat > /etc/init.d/monitor-agent <<'EOF'
#!/sbin/openrc-run
description="Cmonitor Agent"
command="/opt/monitor/monitor-agent"
command_args="--interval 1 --insecure"
command_user="root:root"
supervisor="supervise-daemon"
respawn_delay=5
output_log="/var/log/monitor-agent.log"
error_log="/var/log/monitor-agent.log"

depend() {
    need net
}

start_pre() {
    set -a
    . /opt/monitor/agent.env
    set +a
}
EOF

chmod 0755 /etc/init.d/monitor-agent
rc-update add monitor-agent default
rc-service monitor-agent start
rc-service monitor-agent status
tail -n 50 /var/log/monitor-agent.log
```

网络恢复后 Agent 会自动重连；手动重启使用 `rc-service monitor-agent restart`。

## 7. 后续修改、重装和升级

如果这台机器已经按此前的 HTTPS 域名方案安装，只需把 `agent.env` 中的 `MONITOR_SERVER` 改为现有 `http://IP:端口`，保留 Token，再将服务启动参数按第 5.1 或第 6 节补上 `--insecure`。systemd 执行 `daemon-reload` 后重启；OpenRC 直接重启。无需重新下载二进制或重复创建节点。

### 修改原地址或 Token

编辑 `/opt/monitor/agent.env` 后重启服务即可：

```bash
# systemd
systemctl restart monitor-agent
```

OpenRC 使用 `rc-service monitor-agent restart`。如果后台“换发凭证”，旧 Token 会立即失效，要把新值写回这个文件。

只改 `agent.env` 不需要 `daemon-reload`；修改了 systemd 服务文件或上报间隔时，执行：

```bash
systemctl daemon-reload
systemctl restart monitor-agent
```

### 重新安装或升级已存在的 Agent

先按第 2、3 节准备并校验新二进制。systemd 机器停止服务并备份：

```bash
BACKUP_DIR="/opt/monitor-agent-backups/$(date +%Y%m%d-%H%M%S)"
install -d -m 0700 "$BACKUP_DIR"
systemctl stop monitor-agent
cp -a /opt/monitor/monitor-agent "$BACKUP_DIR/monitor-agent"
cp -a /opt/monitor/agent.env "$BACKUP_DIR/agent.env"
cp -a /etc/systemd/system/monitor-agent.service "$BACKUP_DIR/monitor-agent.service"
printf '备份位置：%s\n' "$BACKUP_DIR"
```

确认备份成功后，只执行第 4.1 节的二进制安装命令，**保留原 `agent.env` 中的地址和 Token**，再执行 `systemctl start monitor-agent`。无需在面板重复创建节点。

OpenRC 使用 `rc-service monitor-agent stop/start`，并将服务脚本 `/etc/init.d/monitor-agent` 一起备份。若新版本运行异常，停止服务、装回备份的旧二进制，再启动。

## 8. 安装后确认仍然接入原探针

联网后检查三件事：

1. `agent.env` 中的 `MONITOR_SERVER` 是已有的 HTTP IP＋端口入口，服务启动参数包含 `--insecure`。
2. Agent 日志出现 `connected`，没有持续的鉴权或证书错误。
3. 打开原面板，对应节点显示在线，CPU、内存等数据持续更新。

仅看到服务 `active` 不能证明已连接，因为 Agent 可能正在重试。

### 检查现有 IP 入口

在受限节点执行下面的请求，替换成真实 IP 和端口。它不传 Token，只检查是否能到达 Hub 的 Agent 接口：

```bash
curl --noproxy '*' --http1.1 -i --max-time 10 \
    -H 'Connection: Upgrade' \
    -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    http://203.0.113.10:28081/api/agent/ws
```

`--noproxy '*'` 让这次 curl 直接访问 IP，避免被环境中的代理设置转走。收到 `401 Unauthorized` 且响应包含 `missing token`，是这次无 Token 检查的预期结果，表示请求已到达 Hub。实际接入是否成功，仍以 Agent 日志的 `connected` 和原面板数据更新为准。

如果 IP 入口只开放 Agent 路径，访问 `/`、`/clara`、`/api/me` 返回 404 是正常的，不要用能否打开后台页面来判断这个入口是否可用。

### 常见问题

| 问题 | 检查方法 |
| --- | --- |
| `Exec format error` | 二进制架构是否与目标机器匹配，是否误下载了源码或错误页面 |
| 找不到环境文件或无法读取 | 路径是否为 `/opt/monitor/agent.env`；文件归 root、权限 0600；服务中是否有 EnvironmentFile |
| `refusing plaintext ws://` | 运行中的启动命令缺少 `--insecure`；修改服务文件、重新加载并重启 |
| 超时或拒绝连接 | 真实 IP、实际端口、节点出站策略、服务端防火墙/安全组/来源 IP 白名单是否正确 |
| IP 请求返回 301/302，跳转到域名 | 当前入口进行了域名跳转，需要原服务端让 `/api/agent/ws` 在该 IP 入口直接转发，不要跟随域名跳转 |
| 403 | 检查服务端来源 IP 白名单，尤其是节点经过 NAT 后的实际出口 IP |
| 404 | 检查 IP、端口和 `/api/agent/ws` 路径，确认这个 HTTP 入口确实转发到原 Hub |
| 502 | 服务端反代无法访问 Hub，上游地址、端口或服务状态有问题 |
| Agent 日志报 401 / Unauthorized | Token 是否完整、是否属于这个 Hub 的这个节点、是否已经换发或删除；与上述无 Token 检查返回 401 不同 |
| 节点反复上下线 | 是否有另一台机器或旧 Agent 进程使用同一个 Token |
| 可以上报但 Web Terminal 不可用 | 本方案为远程明文 WebSocket，Cagent v1.1.3 会禁用终端，这是预期限制 |
| 文件改好仍没生效 | 修改 env 后重启；修改 systemd unit 后先 daemon-reload 再重启；检查是否有旧服务覆盖文件 |

查看 systemd 实际加载的服务文件和覆盖文件：

```bash
systemctl cat monitor-agent
```

如果存在额外的 `monitor-agent.service.d/*.conf` 覆盖启动命令，需要同步确保最终命令包含 `--insecure`。Token 应只保存在 `agent.env` 中，不要写进可公开读取的服务文件。

## 9. 本方案的地址与功能边界

- 只把节点的上报地址配置成原 Hub 的现有 HTTP IP 入口。原 Hub 的 `--site` 继续使用其管理后台原地址，不需要改成 IP；后台添加节点等操作仍在能够访问原后台的电脑上完成。
- `--insecure` 允许远程 HTTP/WS，不是跳过 HTTPS/WSS 的证书校验。不要把只有域名证书的原站点直接改写成 `https://IP`。
- HTTP 入口必须支持 WebSocket 的 `Upgrade`/`Connection` 头，并将 `/api/agent/ws` 转发到发放 Token 的原 Hub。普通网页能通过 IP 打开，不等于 Agent 接口已配置正确。
- 如以后要使用 Web Terminal 或加密上报，可以采用证书包含该 IP 且受 Agent 信任的 HTTPS IP 入口，或通过可达 IP 建立 SSH/VPN 加密通道。Cagent v1.1.3 使用内置 WebPKI 根证书，没有自定义 CA 文件参数。
- 不需要为本方案修改 hosts。hosts 只改变解析，不能保证解决域名/SNI 受限的问题。

本流程中 GitHub 只用于联网电脑准备安装文件；目标机器运行时通过配置的 IP 和端口连接原 Hub。

配置依据：本仓库 `install.sh`、`agent.pin`、`src/agent_ws.rs`，以及对应 Cagent v1.1.3 的参数、环境变量和连接实现。示例尚未在你的目标机器上执行，实际连接按第 8 节验收。

## 10. 宝塔 Nginx：IP 入口只允许 Agent 连接

适用于已在宝塔把 Hub 的本机地址反代为 HTTP IP 入口，并希望这个入口只接收 Agent 连接、不能打开探针页面的情况。下文使用文档示例 IP `203.0.113.10`，部署时替换为实际 IP。

### 10.1 修改哪个站点

1. 在宝塔进入“网站 → 对应的 IP 站点 → 设置 → 配置文件”，先备份原配置。
2. 确认这是 IP 专用的 `server { ... }`。如果原域名和 IP 共用同一个站点，先将 IP 入口拆成独立站点；下面规则会屏蔽该站点内除 Agent 路径外的所有访问。
3. 保留当前正确的 `listen` 端口和 IP 站点设置。下面只调整访问路径，不改变现有对外端口。
4. 在这个 `server` 内、其他 `rewrite` 或代理配置 `include` 之前，加入下面的白名单规则及精确代理。

### 10.2 放入 `server { ... }` 内的配置

下例使用 Hub 的默认本机地址 **`127.0.0.1:28080`**，部署时应换成原配置中的实际上游地址。将该 IP 站点中从 `#PROXY-START/` 到 `#PROXY-END/` 的整段原配置替换为下面内容，移除原来的全站代理和静态资源缓存规则。原来的 `location ^~ /` 全站代理会把整个探针站点代理出来。

```nginx
#PROXY-START/

# 本片段位于 IP 专用站点的 server { ... } 内。
# 所有其他路径直接返回 404。
if ($uri != /api/agent/ws) {
    return 404;
}

location = /api/agent/ws {
    proxy_pass http://127.0.0.1:28080;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    proxy_buffering off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
}

#PROXY-END/
```

配置说明：

- `if` 里只执行 `return`，用于在这个站点级别拒绝非白名单路径；不要把它塞进已有的 `location /` 内。
- `location =` 是精确匹配，只代理 `/api/agent/ws`，不放行整个 `/api/`。节点状态查询等其他接口不会通过 IP 暴露。
- 白名单会让这个站点的 `/`、`/clara`、`/api/nodes`、`/install.sh`、Agent 下载和注册路径全部返回 404。这与你已取得 Token、手动离线安装的方式相符。
- Agent 的 Token 仍由 Hub 验证，不能为了连通而删除 Token。代理明确保留 `Authorization` 头和 WebSocket 升级头。
- `Connection "upgrade"` 在这个专用 WebSocket 路径中直接使用，不依赖其他位置是否定义了 `$connection_upgrade`。此连接不需要原片段中的 `expires`、静态文件判断和缓存响应头。

宝塔可能把反向代理写在独立文件，再通过类似 `include /www/server/panel/vhost/nginx/proxy/站点名/*.conf;` 的配置加载。只处理这个 IP 站点里旧的全站代理规则，避免重复定义相同 `location`。**不要删除整个站点的全部 include，更不要同时改原域名站点。** 如果已经存在 `location = /api/agent/ws`，直接编辑该块，不要重复添加。

同时确认 IP 站点没有把所有请求重定向到域名或 HTTPS 的规则，也不要把 404 错误页设置为跳转到探针域名。这里需要直接返回 404，并让 Agent 路径直接进入 Hub。保存后在宝塔检测 Nginx 配置，成功后重载；若通过宝塔“反向代理”界面重新编辑，需再检查自定义规则是否被覆盖。

### 10.3 Agent 地址与验证

Agent 继续使用目前能连通的 HTTP IP 地址和实际端口、原 Token，以及 `--insecure`。例如入口为标准 HTTP 80 端口时：

```ini
MONITOR_SERVER=http://203.0.113.10
MONITOR_TOKEN=REPLACE_WITH_THIS_NODE_TOKEN
```

若入口为其他端口，则使用 `http://203.0.113.10:实际端口`。不要在 `MONITOR_SERVER` 中附加 `/api/agent/ws`，Agent 会自动补全。

保存并重载后检查：

| 请求或现象 | 预期结果 |
| --- | --- |
| 浏览器打开 `http://203.0.113.10:端口/` | 404 |
| 打开同一入口的 `/clara`、`/api/nodes` | 404 |
| 使用第 8 节带 WebSocket 头的请求检查该 IP 的 `/api/agent/ws`，不传 Token | 401，响应包含 `missing token` |
| 正常启动 Agent，使用有效 Token | 日志出现 `connected`，原面板继续显示节点在线、数据更新 |
| 通过原域名访问后台 | 正常访问，由原来的域名站点处理 |

直接在浏览器打开 `/api/agent/ws` 没有 WebSocket 握手头，可能返回 400，这不代表反向代理失效。最终以上报是否持续为准。

这份路径限制控制的是 IP 站点暴露哪些接口，不会把 HTTP 变成加密传输；本方案仍适用第 9 节的明文传输与终端限制。
