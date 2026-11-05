#!/bin/bash
# Install the host side of Tokiwa on an Ubuntu host with systemd and cgroup v2.
#
#   sudo bash install.sh [--with-docker] [--dry-run]
#
# The core: tmux, the agent-workspace user (UID 2100), the session folders, the helpers in
# /opt/agent-platform/rootless, cloud-workbench.service and its slices, and a firewall rule that
# keeps sessions away from the instance metadata service. --with-docker adds a rootless Docker
# engine as cloud-containers (UID 2200) and gives sessions its socket.
#
# Each step checks the host first and changes only what is missing, so a second run changes
# nothing. --dry-run prints each change instead of making it. The installer never restarts
# cloud-workbench.service: a restart ends every session.
set -euo pipefail
umask 022
cd "$(dirname "$0")"

docker=0 dry=0
for arg in "$@"; do
 case $arg in
  --with-docker) docker=1 ;;
  --dry-run) dry=1 ;;
  *) printf 'Usage: install.sh [--with-docker] [--dry-run]\n' >&2; exit 2 ;;
 esac
done

fail() { printf 'install: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
# Run one change, or print it with --dry-run.
run() { if (( dry )); then printf 'would run: %s\n' "$*"; else "$@"; fi; }
# Append a line to a file unless the file already holds it.
append() {
 grep -qxF -- "$2" "$1" 2>/dev/null && return 0
 if (( dry )); then printf 'would append to %s: %s\n' "$1" "$2"; else printf '%s\n' "$2" >> "$1"; fi
}
# Install a file only when its content differs.
place() {
 local mode=$1 source=$2 target=$3
 if [[ -f $target ]] && cmp -s "$source" "$target"; then return 0; fi
 run install -D -m "$mode" "$source" "$target"
}

rootless=/opt/agent-platform/rootless
units=/etc/systemd/system
workspaces=/srv/development/state/workspaces
home=/srv/development/private/homes/workbench

# Preflight: read only. The tests point the two system paths at a stand-in folder.
check=${TOKIWA_INSTALL_CHECK_ROOT:-}
(( dry )) || [[ $(id -u) == 0 ]] || fail 'Run as root, for example with sudo, or add --dry-run.'
[[ -r $check/etc/os-release ]] && . "$check/etc/os-release"
[[ ${ID:-} == ubuntu ]] || fail 'This installer supports Ubuntu.'
[[ -d $check/run/systemd/system ]] || fail 'systemd is not running.'
[[ $(stat -fc %T /sys/fs/cgroup) == cgroup2fs ]] || fail 'The host does not use cgroup v2.'
say "Tokiwa host install on ${PRETTY_NAME:-Ubuntu}$( (( docker )) && printf ' with rootless Docker')$( (( dry )) && printf ' (dry run)')."

# Packages.
packages=(tmux python3 acl nftables)
(( docker )) && packages+=(docker.io docker-compose-v2 rootlesskit slirp4netns uidmap)
missing=()
for package in "${packages[@]}"; do
 dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'ok installed' || missing+=("$package")
done
if (( ${#missing[@]} )); then
 run apt-get update -qq
 run apt-get install -y -qq --no-install-recommends "${missing[@]}"
fi

# The session user. The units and the firewall rule name UID 2100.
if id agent-workspace >/dev/null 2>&1; then
 [[ $(id -u agent-workspace) == 2100 ]] || fail 'The user agent-workspace exists with a UID other than 2100.'
else
 ! getent passwd 2100 >/dev/null || fail 'UID 2100 belongs to another user.'
 run useradd --uid 2100 --user-group --no-create-home --shell /bin/bash agent-workspace
fi

# The session folders.
# Make a missing folder. An existing folder keeps its owner and mode; a difference is reported.
dir() {
 if [[ ! -d $4 ]]; then run install -d -o "$1" -g "$2" -m "$3" "$4"
 elif [[ $(stat -c '%U:%G %a' "$4") != "$1:$2 $3" ]]; then
  say "note: $4 is $(stat -c '%U:%G %a' "$4"), not $1:$2 $3; it was left as it is."
 fi
}
dir root root 755 /srv/development
dir root root 755 /srv/development/state
dir agent-workspace agent-workspace 750 "$workspaces"
dir agent-workspace agent-workspace 750 "$workspaces/workbench"
dir root agent-workspace 750 /srv/development/private
dir root agent-workspace 750 /srv/development/private/homes
dir agent-workspace agent-workspace 700 "$home"
dir agent-workspace agent-workspace 700 "$home/.claude"
dir agent-workspace agent-workspace 700 "$home/.codex"
dir agent-workspace agent-workspace 700 /srv/development/private/peermesh

# The helpers and the units.
for file in start-workbench.sh terminal-session.sh tokiwa-open; do place 0755 "$file" "$rootless/$file"; done
for file in workbench-files.py workbench-health.py workspace-metadata.nft; do place 0644 "$file" "$rootless/$file"; done
for unit in agent.slice agent-sessions.slice cloud-workbench.service; do place 0644 "units/$unit" "$units/$unit"; done

# Sessions never reach the instance metadata service.
# Load only this table now (/etc/nftables.conf starts with flush ruleset); the include loads it at boot.
if ! nft list table inet cloud_workspace >/dev/null 2>&1; then
 run nft -f "$rootless/workspace-metadata.nft"
 append /etc/nftables.conf "include \"$rootless/workspace-metadata.nft\""
fi
run systemctl enable --quiet nftables.service

if (( docker )); then
 # The engine user and its subordinate IDs.
 if id cloud-containers >/dev/null 2>&1; then
  [[ $(id -u cloud-containers) == 2200 ]] || fail 'The user cloud-containers exists with a UID other than 2200.'
 else
  ! getent passwd 2200 >/dev/null && ! getent group 2200 >/dev/null || fail 'UID or GID 2200 is taken.'
  python3 - <<'PY' || fail 'The subordinate ID range 1048576-1114111 is taken.'
from pathlib import Path
for file in ('/etc/subuid', '/etc/subgid'):
    path = Path(file)
    for line in (path.read_text().splitlines() if path.exists() else []):
        _, start, count = line.split(':')
        if int(start) < 1114112 and int(start) + int(count) > 1048576:
            raise SystemExit(1)
PY
  run groupadd --gid 2200 cloud-containers
  run useradd --uid 2200 --gid 2200 --no-create-home --home-dir /srv/development/cache/rootless-home --shell /usr/sbin/nologin cloud-containers
  run usermod --add-subuids 1048576-1114111 --add-subgids 1048576-1114111 cloud-containers
 fi
 dir root root 755 /srv/development/cache
 dir cloud-containers cloud-containers 700 /srv/development/cache/rootless-home
 # The engine's storage: a 24 GiB ext4 image, mounted at boot.
 image=/srv/development/cache/rootless-engine.ext4 mount=/srv/development/cache/rootless-engine
 if [[ ! -e $image ]]; then
  (( $(df --output=avail -B1 /srv/development/cache | tail -1) > 30064771072 )) || fail 'The engine image needs 28 GiB free in /srv/development/cache.'
  run truncate -s 24G "$image"
  run mkfs.ext4 -q -F "$image"
 fi
 dir root root 755 "$mount"
 append /etc/fstab "$image $mount ext4 loop,nosuid,nodev,noatime,nofail 0 0"
 mountpoint -q "$mount" || run mount "$mount"
 run chown cloud-containers:cloud-containers "$mount"
 run chmod 0700 "$mount"
 place 0755 dockerd-rootless.sh "$rootless/dockerd-rootless.sh"
 place 0644 daemon.json "$rootless/daemon.json"
 place 0644 rootless-metadata.nft "$rootless/rootless-metadata.nft"
 for unit in user-2200.slice agent-containers.slice; do place 0644 "units/$unit" "$units/$unit"; done
 place 0644 units/user-slice-limits.conf "$units/user-2200.slice.d/50-tokiwa-limits.conf"
 place 0644 units/user-manager.conf "$units/user@2200.service.d/cloud-containers.conf"
 place 0644 units/cloud-workbench-docker.conf "$units/cloud-workbench.service.d/docker.conf"
 # The engine's user unit. Each folder of its path belongs to cloud-containers.
 user=/srv/development/cache/rootless-home/.config/systemd/user
 for folder in "${user%/systemd/user}" "${user%/user}" "$user" "$user/default.target.wants"; do
  dir cloud-containers cloud-containers 700 "$folder"
 done
 if [[ ! -f $user/docker.service ]] || ! cmp -s units/docker.service "$user/docker.service"; then
  run install -o cloud-containers -g cloud-containers -m 0644 units/docker.service "$user/docker.service"
 fi
 [[ -L $user/default.target.wants/docker.service ]] || run ln -s ../docker.service "$user/default.target.wants/docker.service"
 # The engine reaches the workbench folder; its container root (1049575) reads it.
 run setfacl -m u:2200:--x "$workspaces"
 run setfacl -m u:2200:rwx,u:1049575:r-x,d:u:2200:rwx,d:u:1049575:r-x "$workspaces/workbench"
 # Containers never reach the instance metadata service either.
 if ! nft list table inet rootless_workspace >/dev/null 2>&1; then
  run nft -f "$rootless/rootless-metadata.nft"
  append /etc/nftables.conf "include \"$rootless/rootless-metadata.nft\""
 fi
 run loginctl enable-linger cloud-containers
fi

run systemctl daemon-reload
if (( docker )); then
 systemctl is-active --quiet user@2200.service || run systemctl start user@2200.service
fi
run systemctl enable --quiet cloud-workbench.service
if systemctl is-active --quiet cloud-workbench.service; then
 say 'cloud-workbench.service is running and was not restarted. Changed units take effect at its next start, which ends every session.'
else
 run systemctl start cloud-workbench.service
fi
say "Done$( (( dry )) && printf ' (dry run: nothing changed)'). On the Mac, set the instance in ~/.config/tokiwa/host.env and run tokiwa."
