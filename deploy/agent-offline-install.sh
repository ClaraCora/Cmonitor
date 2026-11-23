#!/bin/sh
# Distribute this verifier through SSH or another trusted channel BEFORE the archive.
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
fail() { echo "$*" >&2; exit 1; }
[ "$#" -ge 2 ] || fail 'usage: agent-offline-install.sh TRUSTED_SHA256 ARCHIVE_PATH_OR_URL [installer options]'
expected=$1; source=$2; shift 2
case "$expected" in *[!0-9a-f]*) fail 'expected a lowercase SHA-256 digest from a trusted source' ;; esac
[ "${#expected}" -eq 64 ] || fail 'expected a 64-character SHA-256 digest from a trusted source'
for arg do
	case "$arg" in --offline-dir|--updater-only) fail 'the verifier supplies --offline-dir' ;; esac
done
[ "$(id -u)" = 0 ] || fail 'run as root'
cache=/var/lib/cmonitor-offline
[ -d "$cache" ] || mkdir -m 0700 "$cache"
[ ! -L "$cache" ] && [ "$(stat -c '%u:%a' "$cache")" = 0:700 ] || fail 'offline cache must be a root-owned private directory'
# Lock the cache across download, verification and consumption of these exact bytes.
exec 8>>"$cache/lock"
if command -v flock >/dev/null; then flock -n 8
elif command -v busybox >/dev/null && busybox --list | grep -qx flock; then busybox flock -n 8
elif command -v python3 >/dev/null; then python3 -I -c 'import fcntl; fcntl.flock(8, fcntl.LOCK_EX | fcntl.LOCK_NB)'
else fail 'install flock (util-linux), BusyBox with flock, or Python 3 from a trusted package'
fi || fail 'another offline transfer is in progress'
archive="$cache/$expected.part"
verified() {
	[ -f "$archive" ] && value=$(sha256sum "$archive") && [ "${value%% *}" = "$expected" ]
}
download() (
	# A missing Content-Length must not let a bad HTTP mirror fill the disk.
	ulimit -f 65536
	case "$source" in
	https://*) set -- --proto '=https' --proto-redir '=https' --max-redirs 4 ;;
	http://*) set -- --proto '=http' --max-redirs 0 ;;
	esac
	curl -q -fsSL "$@" --connect-timeout 15 --max-time 300 --max-filesize 33554432 \
		--continue-at - --output "$archive" -- "$source"
)
if ! verified; then
	case "$source" in
	http://*|https://*)
		if download; then :
		else
			status=$?
			case "$status" in
			33|36|22)
				# A server without Range support or an obsolete partial file.
				[ -s "$archive" ] || exit "$status"
				rm -f "$archive"; download ;;
			*) echo 'download incomplete; run the same command to resume' >&2; exit "$status" ;;
			esac
		fi ;;
	*://*) fail 'expected http://, https://, or a local archive path' ;;
	*) [ -f "$source" ] || fail 'offline archive not found'; cat < "$source" > "$archive" ;;
	esac
	verified || { rm -f "$archive"; fail 'archive SHA-256 mismatch; nothing extracted or installed'; }
fi
stage=$(mktemp -d "$cache/unpack.XXXXXX")
trap 'rm -rf "$stage"' EXIT
trap 'exit 1' HUP INT TERM
tar -xzf "$archive" -C "$stage"
cd "$stage/cmonitor-agent-offline"
sha256sum -c sha256sums.txt
sh ./install.sh --offline-dir . "$@" 8>&-
rm -f "$archive"
