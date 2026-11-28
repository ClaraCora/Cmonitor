#!/bin/sh
# Installs monitor-agent as a systemd or OpenRC service.
#   curl -fsSL https://hub.example.com/install.sh | sh -s -- --server URL --token TOKEN [options]
#   curl -fsSL https://hub.example.com/install.sh | sh -s -- --server URL --register KEY [options]
set -eu
# Do not execute programs from a caller-controlled directory as root.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# Binary and token in one directory, the same one the hub uses, giving a node a
# single path to inspect and a single path to remove.
ROOT="/opt/monitor"
BIN="$ROOT/monitor-agent"
ENV_FILE="$ROOT/agent.env"
MAINT_FILE="$ROOT/agent-maintenance.json"
REG_PENDING="$ROOT/.agent-registration.pending"
USED_REG=""
PAIRED=""
SERVER=""
TOKEN=""
REGISTER=""
INTERVAL=""
INSECURE=""
OFFLINE=""
ALLOW_DOWNGRADE=""
SKIP_UPDATER=""
UPDATER_ONLY=""
ARG_COUNT=$#

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
	--no-updater) SKIP_UPDATER=1; shift ;;
	--updater-only) UPDATER_ONLY=1; shift ;;
	--insecure) INSECURE=1; shift ;;
	*) echo "unknown option: $1" >&2; exit 2 ;;
	esac
done
[ -z "$UPDATER_ONLY" ] || [ "$ARG_COUNT" -eq 1 ] || { echo "--updater-only must be used on its own" >&2; exit 2; }
[ -z "$ALLOW_DOWNGRADE" ] || [ -n "$OFFLINE" ] || { echo "--allow-downgrade requires --offline-dir" >&2; exit 2; }

SYSTEM_UNIT=/etc/systemd/system/monitor-agent.service
OPENRC_UNIT=/etc/init.d/monitor-agent
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
if command -v systemctl >/dev/null; then
	INIT=systemd; UNIT=$SYSTEM_UNIT
elif command -v rc-update >/dev/null; then
	INIT=openrc; UNIT=$OPENRC_UNIT
else
	echo "this installer needs systemd or OpenRC" >&2; exit 1
fi
if [ ! -d "$ROOT" ]; then install -d -m 0755 "$ROOT"; fi
check_owned() {
	[ ! -L "$1" ] && perm=$(stat -c '%u:%a' "$1") || return 1
	case "$perm" in 0:*[2367]?|0:*[2367]) return 1 ;; 0:*) return 0 ;; *) return 1 ;; esac
}
for item in "$ROOT" "$BIN" "$ENV_FILE" "$UNIT" "$MAINT_FILE" "$REG_PENDING" "$ROOT/.agent-updater.lock" "$ROOT/.agent-install.recovery" "$ROOT/.agent-install.recovery.done"; do
	if [ -e "$item" ] || [ -L "$item" ]; then
		check_owned "$item" || { echo "unsafe ownership or permissions: $item" >&2; exit 1; }
	fi
done
take_lock() {
	if command -v flock >/dev/null; then flock -n 9
	elif command -v busybox >/dev/null && busybox --list | grep -qx flock; then busybox flock -n 9
	elif command -v python3 >/dev/null; then python3 -I -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)'
	else echo "install flock (util-linux), BusyBox with flock, or Python 3 from a trusted package" >&2; return 1
	fi
}
exec 9>>"$ROOT/.agent-updater.lock"
take_lock || { echo "could not acquire the Agent maintenance lock; check flock availability or retry later" >&2; exit 1; }
RECOVERY="$ROOT/.agent-install.recovery"
if [ -z "$UPDATER_ONLY" ] && { [ -e "$ROOT/.agent-updater.state" ] || [ -e "$ROOT/.agent-updater.pending" ]; }; then
	echo "an Agent rollout is awaiting completion; resolve it before manual maintenance" >&2; exit 1
fi
service_stop() { if [ "$INIT" = openrc ]; then rc-service monitor-agent stop 9>&-; else systemctl stop monitor-agent 9>&-; fi; }
service_start() { if [ "$INIT" = openrc ]; then rc-service monitor-agent restart 9>&-; else systemctl daemon-reload && systemctl restart monitor-agent 9>&-; fi; }
service_active() { if [ "$INIT" = openrc ]; then rc-service monitor-agent status 9>&-; else systemctl is-active --quiet monitor-agent; fi; }
restore_previous() {
	if [ -f "$UNIT" ]; then
		if service_active >/dev/null 2>&1; then service_stop || return 1; fi
		if [ ! -f "$RECOVERY/saved-unit" ]; then
			if [ "$INIT" = systemd ]; then systemctl disable monitor-agent >/dev/null || return 1
			elif [ -L /etc/runlevels/default/monitor-agent ]; then rc-update del monitor-agent default || return 1; fi
		fi
	fi
	for file in "$BIN" "$ENV_FILE" "$MAINT_FILE" "$UNIT"; do
		copy="$RECOVERY/${file##*/}"
		if [ "$file" = "$UNIT" ]; then copy="$RECOVERY/saved-unit"; fi
		if [ -f "$copy" ]; then cp -p "$copy" "$file.restore" && mv -f "$file.restore" "$file" || return 1
		else rm -f "$file" || return 1; fi
	done
	[ ! -f "$RECOVERY/was-active" ] || { service_start && service_active; } || return 1
	sync
	mv "$RECOVERY" "$RECOVERY.done" && sync && rm -rf "$RECOVERY.done"
}
# Older bundled OpenRC definitions sourced agent.env as root. Replace that
# particular source statement before issuing any rc-service command, including
# recovery. Custom args and unrelated service settings are left intact.
openrc_env_loader() {
	cat <<'LOADER'
	while IFS= read -r entry || [ -n "$entry" ]; do
		case "$entry" in
		MONITOR_HTTP_PROBE_ALLOWLIST=\"*\"|MONITOR_HTTP_PROBE_ALLOWLIST=\'*\')
		    probe_list=${entry#*=}; probe_list=${probe_list#?}
		    export MONITOR_HTTP_PROBE_ALLOWLIST="${probe_list%?}"
		    unset probe_list ;;
		MONITOR_SERVER=*|MONITOR_TOKEN=*|MONITOR_DISABLE_TERMINAL=*|MONITOR_NET_INCLUDE=*|MONITOR_NET_EXCLUDE=*|MONITOR_HTTP_PROBE_ALLOWLIST=*) export "$entry" ;;
		esac
LOADER
	printf '\t%s\n' "done < '$ENV_FILE'" 'unset entry'
}
harden_openrc() (
	[ "$INIT" = openrc ] && [ -f "$UNIT" ] || return 0
	unit_stage=$(mktemp -d "$ROOT/.openrc-migrate.XXXXXX")
	trap 'rm -rf "$unit_stage"' EXIT
	openrc_env_loader > "$unit_stage/loader"
	awk -v envfile="$ENV_FILE" -v loader="$unit_stage/loader" '
		{
			line=$0; sub(/^[[:space:]]+/, "", line); sub(/[[:space:]]+$/, "", line)
			if (line ~ /^(\.|source)[[:space:]]+/) {
				path=line; sub(/^(\.|source)[[:space:]]+/, "", path)
				if (path == envfile || path == "\"" envfile "\"" || path == sprintf("%c%s%c", 39, envfile, 39)) {
					while ((getline replacement < loader) > 0) print replacement
					close(loader); next
				}
			}
			if (line !~ /^#/ && line ~ /(^|[;&|[:space:]])(\.|source)[[:space:]]/ && (index(line, "agent.env") || index(line, "$") || index(line, "`"))) exit 3
			print
		}' "$UNIT" > "$unit_stage/safe-unit" || {
			echo "unrecognised OpenRC agent.env source; use the literal start_pre reader in OFFLINE_DEPLOY.md" >&2; exit 1
		}
	if ! cmp -s "$UNIT" "$unit_stage/safe-unit"; then
		unit_tmp=$(mktemp "$UNIT.XXXXXX")
		install -m 0755 "$unit_stage/safe-unit" "$unit_tmp" && mv -f "$unit_tmp" "$UNIT"
	fi
)
if [ -n "$UPDATER_ONLY" ] && [ -d "$RECOVERY" ]; then
	echo "finish recovering the interrupted manual Agent installation before updating its worker" >&2; exit 1
fi
harden_openrc
if [ -d "$RECOVERY.done" ]; then rm -rf "$RECOVERY.done"; fi
if [ -d "$RECOVERY" ]; then
	echo "recovering interrupted Agent installation"
	restore_previous || { echo "recovery incomplete; inspect $RECOVERY" >&2; exit 1; }
fi
if [ -f "$SYSTEM_UNIT" ]; then EXISTING=$SYSTEM_UNIT; else EXISTING=$OPENRC_UNIT; fi
existing_install=""
if [ -f "$BIN" ] || [ -f "$EXISTING" ] || [ -f "$ENV_FILE" ]; then existing_install=1; fi
if [ -n "$UPDATER_ONLY" ] && { [ ! -f "$EXISTING" ] || [ ! -f "$BIN" ] || [ ! -r "$ENV_FILE" ]; }; then
	echo "--updater-only requires an installed Agent" >&2; exit 1
fi
saved_server=$(sed -n 's/^MONITOR_SERVER=//p' "$ENV_FILE" 2>/dev/null || true)
saved_token=$(sed -n 's/^MONITOR_TOKEN=//p' "$ENV_FILE" 2>/dev/null || true)
keep_unit=""
if [ -z "$SERVER$TOKEN$REGISTER$INTERVAL$INSECURE" ] && [ -f "$EXISTING" ] && [ -f "$BIN" ]; then
	keep_unit=1; SERVER=$saved_server
	TOKEN=$saved_token
fi
if [ "$SERVER" = "$saved_server" ] && [ -z "$INTERVAL$INSECURE" ] && [ -f "$EXISTING" ] && [ -f "$BIN" ]; then preserve_definition=1; else preserve_definition=""; fi
if [ -z "$INTERVAL" ] && [ -f "$EXISTING" ]; then
	INTERVAL=$(sed -nE 's/^(ExecStart|command_args)=.*--interval ([0-9]+).*/\2/p' "$EXISTING" | head -1)
fi
INTERVAL=${INTERVAL:-1}
if [ "$SERVER" = "$saved_server" ] && [ -f "$EXISTING" ] && grep -Eq '^(ExecStart|command_args)=.* --insecure([^[:alnum:]_-]|$)' "$EXISTING"; then INSECURE=1; fi
[ -n "$SERVER" ] && { [ -n "$TOKEN" ] || [ -n "$REGISTER" ]; } || {
	echo "usage: install.sh --server URL (--token TOKEN | --register KEY) [--interval SECONDS] [--insecure] [--no-updater], or install.sh --updater-only" >&2
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
# URL and identity are literal single-line values in both init systems.
case "$SERVER" in *[!a-zA-Z0-9.:/%_~\[\]-]*) echo "invalid Hub URL" >&2; exit 2 ;; esac
hostport=${SERVER#*://}; hostport=${hostport%%/*}
[ -n "$hostport" ] || { echo "Hub URL requires a host" >&2; exit 2; }
case "$SERVER" in
https://*) ;;
http://*)
	[ -n "$OFFLINE" ] || { echo "online installation requires HTTPS; use a verified offline package for HTTP reporting" >&2; exit 2; }
	case "$hostport" in localhost|localhost:*|'[::1]'|'[::1]':*|127.0.0.1|127.0.0.1:*) ;;
	*) [ -n "$INSECURE" ] || { echo "remote HTTP reporting requires --insecure" >&2; exit 2; } ;; esac
	;;
*) echo "expected an HTTP or HTTPS Hub URL" >&2; exit 2 ;;
esac
valid_credential() {
	case "$1" in ''|*[!a-zA-Z0-9._-]*) return 1 ;; esac
	[ "${#1}" -le 512 ]
}
for supplied in "$TOKEN" "$REGISTER"; do
	[ -z "$supplied" ] || valid_credential "$supplied" || { echo "invalid credential format" >&2; exit 2; }
done

# Keep the interpreter used by the service identical to the one that passed
# this check (some distributions install a newer Python alongside /usr/bin/python3).
find_python() {
	for name in python3 python3.14 python3.13 python3.12 python3.11 python3.10 python3.9 python3.8; do
		interpreter=$(command -v "$name") || continue
		if "$interpreter" -I -c 'import fcntl, ssl, sys; sys.exit(sys.version_info < (3, 8))' >/dev/null 2>&1; then
			printf '%s\n' "$interpreter"
			return 0
		fi
	done
	return 1
}

install_python() {
	if command -v apt-get >/dev/null 2>&1; then
		DEBIAN_FRONTEND=noninteractive apt-get update &&
			DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3
	elif command -v apk >/dev/null 2>&1; then
		apk add --no-cache python3
	elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
		if command -v dnf >/dev/null 2>&1; then rpm_tool=dnf; else rpm_tool=yum; fi
		"$rpm_tool" -y install python3 && find_python >/dev/null && return 0
		# Enterprise Linux 8 ships an older default and packages a parallel Python.
		"$rpm_tool" -y install python3.11
	elif command -v zypper >/dev/null 2>&1; then
		zypper --non-interactive install python3 && find_python >/dev/null && return 0
		zypper --non-interactive install python311
	elif command -v pacman >/dev/null 2>&1; then
		pacman -S --needed --noconfirm python
	else
		echo "install Python 3.8 or later using the distribution package manager" >&2
		return 1
	fi
}

enable_updater() (
	case "$SERVER" in https://*) ;; *) echo "the updater requires an HTTPS Agent connection" >&2; return 1 ;; esac
	[ -z "$INSECURE" ] || { echo "the updater requires a secure Agent service" >&2; return 1; }
	case "$SERVER" in *'?'* | *'#'* | *'\'*) echo "invalid Hub URL for the updater" >&2; return 1 ;; esac
	command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required" >&2; return 1; }
	if ! python=$(find_python); then
		echo "installing Python 3.8 or later for the upgrade service"
		install_python && python=$(find_python) || { echo "no usable Python 3.8+ with SSL support" >&2; return 1; }
	fi
	stage=$(mktemp -d "$ROOT/.agent-updater-install.XXXXXX") || return 1
	trap 'rm -rf "$stage"' EXIT
	trap 'exit 1' HUP INT TERM
	url="${SERVER%/}/agent-updater.py"
	# Neither resource takes a credential or a redirect. -q ignores an inherited
	# curlrc that could otherwise relax TLS or follow another origin.
	curl -q --proto '=https' -fsSL --max-redirs 0 --max-time 60 "$url" -o "$stage/worker.py" || return 1
	expected=$(curl -q --proto '=https' -fsSL --max-redirs 0 --max-time 30 "$url/sha256") || return 1
	actual=$(sha256sum "$stage/worker.py") || return 1
	actual=${actual%% *}
	if [ "${#expected}" -ne 64 ] || [ "$actual" != "$expected" ]; then
		echo "updater SHA-256 mismatch; refusing to execute the download" >&2
		return 1
	fi
	"$python" -I "$stage/worker.py" enable || return 1
	if [ -s "$MAINT_FILE" ]; then echo "upgrade service installed with a local maintenance credential"
	else echo "upgrade service installed; pair this node from the Hub to authorize tasks"; fi
)

if [ -n "$UPDATER_ONLY" ]; then
	enable_updater
	exit $?
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
	curl -q --proto '=https' --proto-redir '=https' -fsSL --max-redirs 0 --max-time 180 "$URL" -o "$TMP"
	WANT=$(curl -q --proto '=https' --proto-redir '=https' -fsSL --max-redirs 0 --max-time 30 "$URL/sha256")
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
registration_status() {
	valid_credential "$1" || { echo "invalid saved reporting credential" >&2; return 1; }
	status=$(printf 'Authorization: Bearer %s\n' "$1" |
		curl -q --proto '=https' -fsS --connect-timeout 10 --max-time 30 --max-filesize 64 \
			-H @- "${SERVER%/}/api/agent/register") || return 1
	case "$status" in registered|unregistered) printf '%s\n' "$status" ;; *) return 1 ;; esac
}
if [ -z "$TOKEN" ] && [ "${saved_server%/}" = "${SERVER%/}" ] && [ -n "$saved_token" ]; then
	if [ -n "$OFFLINE" ]; then
		TOKEN=$saved_token
	else
		status=$(registration_status "$saved_token") || {
			echo "could not verify the saved reporting token with the Hub; retry the same command" >&2; exit 1
		}
		case "$status" in
		registered) TOKEN=$saved_token; echo "Hub confirmed the existing registration" ;;
		unregistered) echo "Hub no longer recognises this node; registering again" ;;
		esac
	fi
fi
if [ -z "$TOKEN" ]; then
	[ -z "$OFFLINE" ] || { echo "offline installs need an existing identity or --token" >&2; exit 2; }
	accept='text/plain'
	if [ -z "$SKIP_UPDATER$INSECURE" ]; then accept='application/vnd.cmonitor.agent-registration+text'; fi
	# A failed install may outlive its registration window. Never send a
	# pending token to another origin, even when the next command has a new key.
	binding=$(printf '%s\n' "${SERVER%/}" "$REGISTER" "$accept" | sha256sum | cut -d ' ' -f 1)
	if [ -d "$REG_PENDING" ]; then
		if [ "$(cat "$REG_PENDING/binding")" != "$binding" ] &&
			[ "$(cat "$REG_PENDING/server" 2>/dev/null || true)" != "${SERVER%/}" ]; then
			echo "cannot verify the origin of the pending registration; retry its original command" >&2; exit 1
		fi
		pending_status=$(registration_status "$(sed -n '1p' "$REG_PENDING/response")") || {
			echo "could not verify the pending registration with the Hub; retry the same command" >&2; exit 1
		}
		if [ "$pending_status" = unregistered ]; then
			rm -rf "$REG_PENDING"
		elif [ -f "$REG_PENDING/accept" ] && [ "$(cat "$REG_PENDING/accept")" != "$accept" ]; then
			echo "retry with the updater option from the pending registration" >&2; exit 1
		fi
	fi
	if [ ! -d "$REG_PENDING" ]; then
		reg_stage=$(mktemp -d "$ROOT/.agent-register.XXXXXX")
		trap 'rm -f "$TMP"; rm -rf "$reg_stage"' EXIT
		NAME=$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9._-' | cut -c1-64)
		printf '%s\n' "$binding" > "$reg_stage/binding"
		printf '%s\n' "${SERVER%/}" > "$reg_stage/server"
		printf '%s\n' "$accept" > "$reg_stage/accept"
		(umask 077; printf 'Authorization: Bearer %s\n' "$REGISTER" > "$reg_stage/header")
		echo "registering $NAME with the hub"
		(umask 077; curl -q --proto '=https' -fsSL --max-redirs 0 --max-time 30 --max-filesize 8192 \
			-H "@$reg_stage/header" -H "Accept: $accept" --data-binary "$NAME" "${SERVER%/}/api/agent/register" >"$reg_stage/response") || {
			echo "registration failed; check the Hub and its registration window" >&2; exit 1
		}
		rm -f "$reg_stage/header"
		# Validate framing. The worker validates the JSON fields and identity before
		# use. A legacy TLS Hub returns just the report token.
		LC_ALL=C awk -v accept="$accept" '
			NR == 1 {if (length != 64 || /[^a-f0-9]/) exit 1; next}
			NR == 2 && accept != "text/plain" && length <= 4096 && /^\{[^[:cntrl:]]*\}$/ {next}
			{exit 1} END {if (!NR) exit 1}' "$reg_stage/response" || { echo "invalid registration response" >&2; exit 1; }
		sync; mv "$reg_stage" "$REG_PENDING"; sync
		trap 'rm -f "$TMP"' EXIT
	fi
	TOKEN=$(sed -n '1p' "$REG_PENDING/response")
	PAIRED=$(sed -n '2p' "$REG_PENDING/response")
	USED_REG=1
fi
# Ordinary reinstalls preserve the local worker policy. A newly registered
# node follows the enrollment options of the current batch command.
if [ -n "$existing_install" ] && [ -z "$USED_REG" ]; then SKIP_UPDATER=1; fi

valid_credential "$TOKEN" || { echo "invalid node token" >&2; exit 2; }

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
for file in "$BIN" "$ENV_FILE" "$MAINT_FILE"; do
	if [ -f "$file" ]; then cp -p "$file" "$UPGRADE_BACKUP/"; fi
done
if [ -f "$UNIT" ]; then
	cp -p "$UNIT" "$UPGRADE_BACKUP/saved-unit"
	if service_active >/dev/null 2>&1; then touch "$UPGRADE_BACKUP/was-active"; fi
fi
# The durable journal starts only after all recovery files are on disk.
sync
trap 'rm -f "$TMP"' EXIT
mv "$UPGRADE_BACKUP" "$RECOVERY"
UPGRADE_BACKUP=$RECOVERY
sync
finish_agent() {
	code=$?; trap - EXIT HUP INT TERM; set +e; rm -f "$TMP"
	if [ "$code" -ne 0 ] && [ -d "$RECOVERY" ]; then
		if restore_previous; then echo "installation failed; previous files restored" >&2
		else echo "recovery incomplete; inspect $UPGRADE_BACKUP" >&2; fi
	fi
	exit "$code"
}
finish_install() {
	save_offline_previous
	echo "$1"
	# The agent and its identity are now healthy. A maintenance dependency
	# failure must leave them available for a standalone --updater-only retry.
	sync
	mv "$RECOVERY" "$RECOVERY.done"
	trap - EXIT HUP INT TERM
	sync; rm -f "$TMP"; rm -rf "$RECOVERY.done"
	if [ -n "$USED_REG" ]; then rm -rf "$REG_PENDING"; fi
	exec 9>&-
	if [ -z "$SKIP_UPDATER$OFFLINE$INSECURE" ]; then
		case "$SERVER" in
		https://*) enable_updater || { echo "Agent already installed; retry install.sh --updater-only after correcting the error" >&2; exit 1; } ;;
		esac
	fi
	exit 0
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
	finish_install "updated binary; kept the existing service, credentials and reporting settings"
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
if [ -n "$PAIRED" ]; then
	(umask 077; printf '%s\n' "$PAIRED" > "$UPGRADE_BACKUP/new-maintenance")
	mv -f "$UPGRADE_BACKUP/new-maintenance" "$MAINT_FILE"
elif [ "$TOKEN" != "$saved_token" ] || [ "${SERVER%/}" != "${saved_server%/}" ]; then
	# The recovery journal restores the old grant if the service fails to start.
	rm -f "$MAINT_FILE"
fi

if [ -n "$preserve_definition" ]; then
	service_start && sleep 2 && service_active || exit 1
	finish_install "updated agent and connection settings; existing service options retained"
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
$(openrc_env_loader)
}
RC
	chmod 0755 /etc/init.d/monitor-agent
	rc-update add monitor-agent default >/dev/null
	if ! rc-service monitor-agent restart 9>&- || ! rc-service monitor-agent status >/dev/null 2>&1; then
		echo "agent upgrade failed; starting recovery" >&2
		exit 1
	fi
	finish_install "monitor-agent installed; follow it with: tail -f /var/log/monitor-agent.log"
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
if ! systemctl restart monitor-agent 9>&-; then
	echo "agent upgrade failed; starting recovery" >&2
	exit 1
fi
sleep 2
if ! systemctl is-active --quiet monitor-agent; then
	echo "agent did not remain active; starting recovery" >&2
	exit 1
fi
finish_install "monitor-agent installed; follow it with: journalctl -u monitor-agent -f"
