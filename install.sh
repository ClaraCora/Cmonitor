#!/bin/sh
# Installs monitor-agent as a systemd or OpenRC service.
#   curl -fsSL https://hub.example.com/install.sh | sh -s -- --server URL --token TOKEN [options]
#   curl -fsSL https://hub.example.com/install.sh | sh -s -- --server URL --register KEY [options]
set -eu
# rc-update resides in sbin, which a root shell entered through `su` without `-`
# can lack because the caller's PATH is retained.
PATH="$PATH:/usr/sbin:/sbin"

# Binary and token in one directory, the same one the hub uses, giving a node a
# single path to inspect and a single path to remove.
ROOT="/opt/monitor"
BIN="$ROOT/monitor-agent"
ENV_FILE="$ROOT/agent.env"
SERVER=""
TOKEN=""
REGISTER=""
INTERVAL=""
INSECURE=""
OFFLINE=""
ALLOW_DOWNGRADE=""

while [ $# -gt 0 ]; do
	# A flag with no argument: under set -u, `$2` aborts with the shell's own
	# message rather than the usage below, and `shift 2` cannot proceed.
	case "$1" in
	--server | --token | --register | --interval | --offline-dir)
		[ $# -ge 2 ] || { echo "$1 needs a value" >&2; exit 2; } ;;
	esac
	case "$1" in
	--server) SERVER="$2"; shift 2 ;;
	--token) TOKEN="$2"; shift 2 ;;
	--register) REGISTER="$2"; shift 2 ;;
	--interval) INTERVAL="$2"; shift 2 ;;
	--offline-dir) OFFLINE="$2"; shift 2 ;;
	--allow-downgrade) ALLOW_DOWNGRADE=1; shift ;;
	--insecure) INSECURE=1; shift ;;
	*) echo "unknown option: $1" >&2; exit 2 ;;
	esac
done
[ -z "$ALLOW_DOWNGRADE" ] || [ -n "$OFFLINE" ] || { echo "--allow-downgrade requires --offline-dir" >&2; exit 2; }

# An offline update with no connection arguments only replaces the executable.
# In particular a hand-written HTTP/OpenRC service is kept byte for byte.
SYSTEM_UNIT=/etc/systemd/system/monitor-agent.service
OPENRC_UNIT=/etc/init.d/monitor-agent
if [ -f "$SYSTEM_UNIT" ]; then EXISTING=$SYSTEM_UNIT; else EXISTING=$OPENRC_UNIT; fi
saved_server=$(sed -n 's/^MONITOR_SERVER=//p' "$ENV_FILE" 2>/dev/null || true)
keep_unit=""
if [ -z "$SERVER$TOKEN$REGISTER$INTERVAL$INSECURE" ] && [ -f "$EXISTING" ] && [ -f "$BIN" ]; then
	keep_unit=1; SERVER=$saved_server
	TOKEN=$(sed -n 's/^MONITOR_TOKEN=//p' "$ENV_FILE")
fi
if [ "$SERVER" = "$saved_server" ] && [ -z "$INTERVAL$INSECURE" ] && [ -f "$EXISTING" ] && [ -f "$BIN" ]; then preserve_definition=1; else preserve_definition=""; fi
if [ -z "$INTERVAL" ] && [ -f "$EXISTING" ]; then
	INTERVAL=$(sed -nE 's/^(ExecStart|command_args)=.*--interval ([0-9]+).*/\2/p' "$EXISTING" | head -1)
fi
INTERVAL=${INTERVAL:-1}
if [ "$SERVER" = "$saved_server" ] && [ -f "$EXISTING" ] && grep -Eq '^(ExecStart|command_args)=.* --insecure([^[:alnum:]_-]|$)' "$EXISTING"; then INSECURE=1; fi
[ -n "$SERVER" ] && { [ -n "$TOKEN" ] || [ -n "$REGISTER" ]; } || {
	echo "usage: install.sh --server URL (--token TOKEN | --register KEY) [--interval SECONDS] [--insecure]" >&2
	exit 2
}
case "$INTERVAL" in "" | *[!0-9]*) echo "interval must be an integer from 1 to 3600" >&2; exit 2 ;; esac
[ "$INTERVAL" -ge 1 ] && [ "$INTERVAL" -le 3600 ] || { echo "interval must be from 1 to 3600" >&2; exit 2; }
# A bare host implies TLS, matching the upgrade the agent's ws_url() performs,
# and the same reversal under --insecure where the hub has no TLS to upgrade to.
# Without this the two diverge: the agent would dial wss:// while curl below
# defaults a scheme-less URL to http://, fetching over plaintext the binary about
# to run as root.
if [ -n "$INSECURE" ]; then SCHEME=http; else SCHEME=https; fi
case "$SERVER" in *://*) ;; *) SERVER="$SCHEME://$SERVER" ;; esac
# The agent already refuses plaintext ws:// to a remote hub, since the token
# would travel in the clear. The same address fetches the binary about to run as
# root here, so the same rule applies: over plain HTTP anyone on the path can
# substitute a binary of their own.
#
# --insecure overrides both halves for a hub reached at ip:port with no TLS in
# front, and says so explicitly: this is the one step of the install that cannot
# be corrected afterwards, because a substituted binary is already running as
# root by then.
#
# The test applies to the host alone, with scheme, port and path removed, and
# matches an address rather than a prefix: `127.evil.com` is a registered name
# resolving wherever its owner points it, and reading it as loopback would hand
# this plaintext channel to that owner.
HOST="${SERVER#*://}"
HOST="${HOST%%/*}"
# RFC 3986 places userinfo before the host, so `127.0.0.1:28080@evil.example.com`
# leaves a loopback address where the test below looks while curl, which parses
# the URL correctly, fetches from the owner of that name -- over plain HTTP, with
# the bytes installed 0755 and started as root a few lines below. A hub address
# never requires userinfo; the agent's own ws_url rejects it as well.
case "$HOST" in
*@*) echo "server URL must not contain '@': the host is whatever follows it" >&2; exit 2 ;;
esac
case "$HOST" in
"["*) HOST="${HOST#\[}"; HOST="${HOST%%]*}" ;;
*) HOST="${HOST%%:*}" ;;
esac
# A full dotted quad in 127/8 and nothing shorter, matching what the agent's
# is_loopback() accepts, since Rust's IpAddr parser accepts nothing shorter
# either -- `127.1` is a name to it, not an address. The two must agree, or this
# installs over plaintext against a hub the agent then refuses to dial: the unit
# is written, the service started, and it crash-loops on RestartSec while this
# script has reported success.
#
# The first arm excludes anything containing a letter, which is a registered name
# however it begins, and anything with more than four components, which is not an
# address.
case "$HOST" in
localhost | ::1) LOCAL=1 ;;
*[!0-9.]* | *.*.*.*.*) LOCAL="" ;;
127.[0-9]*.[0-9]*.[0-9]*) LOCAL=1 ;;
*) LOCAL="" ;;
esac
case "$SERVER" in
http://*)
	if [ -z "$LOCAL" ]; then
		[ -n "$INSECURE" ] || {
			echo "refusing plaintext http:// to a remote hub; use https://, or --insecure if it has no TLS" >&2
			exit 2
		}
		echo "warning: --insecure over plain HTTP to $SERVER" >&2
		echo "         the token and every report travel in the clear, and the binary" >&2
		[ -n "$OFFLINE" ] || echo "         the download also uses HTTP" >&2
	fi
	;;
esac
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
if command -v systemctl >/dev/null; then
	INIT=systemd
elif command -v rc-update >/dev/null; then
	INIT=openrc
else
	echo "this installer needs systemd or OpenRC" >&2
	exit 1
fi

case "$(uname -m)" in
x86_64 | amd64) ARCH=x86_64 ;;
aarch64 | arm64) ARCH=aarch64 ;;
*) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

# The hub relays the binary, so a node need only reach the hub it already talks
# to: an IPv6-only or blocked machine cannot resolve github.com. A hub unable to
# fetch releases itself is configured with a GitHub proxy in its own settings,
# which is why none is requested here.
URL="${SERVER%/}/agent/$ARCH"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

echo "preparing monitor-agent ($ARCH)"
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required (install coreutils)" >&2; exit 1; }
if [ -n "$OFFLINE" ]; then
	name="monitor-agent-$ARCH-unknown-linux-musl"
	WANT=$(awk -v name="$name" '$2 == name {print $1}' "$OFFLINE/sha256sums.txt")
	[ -n "$WANT" ] || { echo "offline checksum missing" >&2; exit 1; }
	cp "$OFFLINE/$name" "$TMP"
else
	curl -fsSL --max-time 180 "$URL" -o "$TMP"
	WANT=$(curl -fsSL --max-time 30 "$URL/sha256")
fi
GOT=$(sha256sum "$TMP" | cut -d ' ' -f1)
[ "$GOT" = "$WANT" ] || { echo "Agent SHA-256 mismatch; installation refused" >&2; exit 1; }

# Downloaded before the registration below, because that step spends a node: the
# key returns a token and the panel gains a row, while the env file recording it
# is only written once the binary is in place. A download that fails after
# registering therefore leaves an unusable node behind, and the rerun -- the
# documented way to recover -- registers a second one.
#
# --register exchanges a key for this node's own token, which is what allows one
# command to provision a batch of machines. The key is valid only within the
# window the panel opened and never becomes the credential the agent runs with.
if [ -z "$TOKEN" ]; then
	# Re-running the same command must not add a second node. This machine's
	# token is already present and outlives the window that issued it, so the env
	# file answers before the hub is consulted.
	#
	# Only for the same hub: a token issued by hub A means nothing to hub B, and
	# retaining it would leave the agent authenticating indefinitely against a
	# node that was never created, with this installer reporting success.
	CACHED=$(sed -n 's/^MONITOR_SERVER=//p' "$ENV_FILE" 2>/dev/null || true)
	if [ "${CACHED%/}" = "${SERVER%/}" ]; then
		TOKEN=$(sed -n 's/^MONITOR_TOKEN=//p' "$ENV_FILE" 2>/dev/null || true)
		if [ -n "$TOKEN" ]; then
			echo "this machine is already registered; keeping its token"
		fi
	fi
fi
if [ -z "$TOKEN" ]; then
	[ -z "$OFFLINE" ] || { echo "offline installs need an existing identity or --token" >&2; exit 2; }
	# The hub trims and bounds this as well; here it is restricted to characters
	# a hostname may contain, so nothing unexpected travels in the body.
	NAME=$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9._-' | cut -c1-64)
	echo "registering $NAME with the hub"
	TOKEN=$(curl -fsS --max-time 30 -H "Authorization: Bearer $REGISTER" \
		--data-binary "$NAME" "${SERVER%/}/api/agent/register") || {
		echo "the hub refused the registration key: the window may have closed," >&2
		echo "the key may be wrong, or it has registered enough nodes already." >&2
		echo "open a new one from the panel's node list." >&2
		exit 1
	}
fi

# Keep the complete previous installation until the new service has proved it
# starts. This includes the environment file because it carries supported local
# policy such as network include/exclude rules and terminal restrictions.
install -d -m 0755 "$ROOT"
UPGRADE_BACKUP=$(mktemp -d "$ROOT/.agent-upgrade.XXXXXX")
trap 'rm -f "$TMP"; rm -rf "$UPGRADE_BACKUP"' EXIT
install -m 0755 "$TMP" "$UPGRADE_BACKUP/new-bin"
if [ -n "$OFFLINE" ]; then
	# A genuine older release also passes its package checksum. Check the
	# executable on the destination mount before stopping a working service.
	agent_version() { "$1" --help 2>&1 | sed -nE '1s/^monitor-agent ([0-9]+\.[0-9]+\.[0-9]+)$/\1/p'; }
	candidate_version=$(agent_version "$UPGRADE_BACKUP/new-bin")
	[ -n "$candidate_version" ] || { echo "cannot identify the offline Agent version" >&2; exit 1; }
	if [ -f "$BIN" ] && [ -z "$ALLOW_DOWNGRADE" ]; then
		installed_version=$(agent_version "$BIN")
		[ -n "$installed_version" ] || { echo "cannot identify installed Agent; inspect it before using --allow-downgrade" >&2; exit 1; }
		if ! awk -v old="$installed_version" -v new="$candidate_version" 'BEGIN {
			split(old, a, "[.]"); split(new, b, "[.]");
			for (i=1; i<=3; i++) if (a[i]+0 != b[i]+0) exit (b[i]+0 < a[i]+0);
		}'; then
			echo "offline Agent $candidate_version is older than $installed_version; intentional downgrades require --allow-downgrade" >&2; exit 1
		fi
	fi
fi
if [ "$INIT" = openrc ]; then UNIT=$OPENRC_UNIT; else UNIT=$SYSTEM_UNIT; fi
for file in "$BIN" "$ENV_FILE"; do
	if [ -f "$file" ]; then cp -p "$file" "$UPGRADE_BACKUP/"; fi
done
if [ -f "$UNIT" ]; then cp -p "$UNIT" "$UPGRADE_BACKUP/saved-unit"; fi
service_stop() { if [ "$INIT" = openrc ]; then rc-service monitor-agent stop; else systemctl stop monitor-agent; fi; }
service_start() { if [ "$INIT" = openrc ]; then rc-service monitor-agent restart; else systemctl daemon-reload && systemctl restart monitor-agent; fi; }
service_active() { if [ "$INIT" = openrc ]; then rc-service monitor-agent status; else systemctl is-active --quiet monitor-agent; fi; }
restore_previous() {
	if [ -f "$UNIT" ]; then service_stop >/dev/null 2>&1 || return 1; fi
	for file in "$BIN" "$ENV_FILE" "$UNIT"; do
		copy="$UPGRADE_BACKUP/${file##*/}"
		# OpenRC's service and the executable have identical basenames; the
		# service copy is stored under its own name below.
		if [ "$file" = "$UNIT" ]; then copy="$UPGRADE_BACKUP/saved-unit"; fi
		if [ -f "$copy" ]; then cp -p "$copy" "$file.restore" && mv -f "$file.restore" "$file" || return 1
		else rm -f "$file" || return 1; fi
	done
	[ ! -f "$UNIT" ] || { service_start && service_active; }
}
finish_agent() {
	code=$?; trap - EXIT HUP INT TERM; set +e; rm -f "$TMP"
	if [ "$code" -ne 0 ]; then
		if restore_previous; then echo "installation failed; previous files restored" >&2
		else echo "recovery incomplete; inspect $UPGRADE_BACKUP" >&2; fi
	else rm -rf "$UPGRADE_BACKUP"; fi
	exit "$code"
}
trap finish_agent EXIT; trap 'exit 1' HUP INT TERM
if [ -f "$UNIT" ] && service_active >/dev/null 2>&1; then service_stop; fi
mv -f "$UPGRADE_BACKUP/new-bin" "$BIN"
save_offline_previous() {
	# Keep only the last different executable. A same-version rerun with the
	# identical image must not overwrite the previous rollback point.
	if [ -n "$OFFLINE" ] && [ -f "$UPGRADE_BACKUP/monitor-agent" ] && ! cmp -s "$UPGRADE_BACKUP/monitor-agent" "$BIN"; then
		cp -p "$UPGRADE_BACKUP/monitor-agent" "$UPGRADE_BACKUP/keep-previous" &&
			mv -f "$UPGRADE_BACKUP/keep-previous" "$ROOT/.agent-offline.previous"
	fi
}
if [ -n "$keep_unit" ]; then
	service_start && sleep 2 && service_active || exit 1
	save_offline_previous
	echo "updated binary; kept the existing service, credentials and reporting settings"; exit 0
fi

# Preserve every existing setting while replacing only the connection values.
# Write beside the final file, set its mode before publication, then atomically
# replace it so a service never observes a partial environment file.
ENV_TMP="$UPGRADE_BACKUP/new-env"
(umask 077; : > "$ENV_TMP")
if [ -f "$ENV_FILE" ]; then
	sed '/^MONITOR_SERVER=/d; /^MONITOR_TOKEN=/d' "$ENV_FILE" >"$ENV_TMP"
fi
{
	printf 'MONITOR_SERVER=%s\n' "$SERVER"
	printf 'MONITOR_TOKEN=%s\n' "$TOKEN"
} >>"$ENV_TMP"
chmod 0600 "$ENV_TMP"
mv -f "$ENV_TMP" "$ENV_FILE"

if [ -n "$preserve_definition" ]; then
	service_start && sleep 2 && service_active || exit 1
	save_offline_previous
	echo "updated agent and connection settings; existing service options retained"; exit 0
fi

if [ "$INIT" = openrc ]; then
	cat >/etc/init.d/monitor-agent <<RC
#!/sbin/openrc-run
description="monitor agent"
command="$BIN"
command_args="--interval $INTERVAL${INSECURE:+ --insecure}"
command_user="root:root"
supervisor="supervise-daemon"
respawn_delay=5
output_log="/var/log/monitor-agent.log"
error_log="/var/log/monitor-agent.log"

depend() {
	need net
}

# The token stays in the root-only env file rather than the service script.
start_pre() {
	set -a
	. $ENV_FILE
	set +a
}
RC
	chmod 0755 /etc/init.d/monitor-agent
	rc-update add monitor-agent default >/dev/null
	if ! rc-service monitor-agent restart || ! rc-service monitor-agent status >/dev/null 2>&1; then
		echo "agent upgrade failed; starting recovery" >&2
		exit 1
	fi
	save_offline_previous
	echo "monitor-agent installed; follow it with: tail -f /var/log/monitor-agent.log"
	exit 0
fi

cat >/etc/systemd/system/monitor-agent.service <<UNIT
[Unit]
Description=monitor agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
ExecStart=$BIN --interval $INTERVAL${INSECURE:+ --insecure}
Restart=always
RestartSec=5
# Web Terminal is the node's remote administration channel. Running the agent
# as root gives that terminal the same access as a root SSH login.
User=root

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable monitor-agent >/dev/null
# restart rather than `enable --now`: --now leaves an already-running service
# untouched, so reinstalling over a live agent would keep the old binary
# running.
if ! systemctl restart monitor-agent; then
	echo "agent upgrade failed; starting recovery" >&2
	exit 1
fi
sleep 2
if ! systemctl is-active --quiet monitor-agent; then
	echo "agent did not remain active; starting recovery" >&2
	exit 1
fi
save_offline_previous
echo "monitor-agent installed; follow it with: journalctl -u monitor-agent -f"
