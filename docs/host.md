# Host

The host is the EC2 instance with Ubuntu 24.04 that keeps the sessions: one systemd service runs one tmux server in a sandbox, and a rootless Docker engine runs beside it. The host does not draw the interface, keep the order of the projects or open links; the app on the Mac does that (see [Architecture](architecture.md) and [Interface](interface.md)).

## Processes

```
┌─ EC2 host ───────────────────────────────────────────────────────────────┐
│                                                                          │
│  amazon-ssm-agent  (Run Command, interactive sessions)                   │
│    │ sudo -n runuser -u agent-workspace -- terminal-session.sh MODE      │
│    ▼                                                                     │
│  terminal-session.sh  → workbench-health.py, workbench-files.py          │
│    │ tmux -N -S /run/cloud-workbench/tmux.sock                           │
│    ▼                                                                     │
│  ╔═ cloud-workbench.service ═══════════════════════════════════════════╗ │
│  ║ User=agent-workspace  Slice=agent-sessions.slice  sandbox           ║ │
│  ║                                                                     ║ │
│  ║ tmux server  -D -S /run/cloud-workbench/tmux.sock -f /dev/null      ║ │
│  ║   │                                                                 ║ │
│  ║   ▼                                                                 ║ │
│  ║ session workbench   session NAME            session NAME   ...      ║ │
│  ║ bash                bash → claude, codex    bash → docker compose   ║ │
│  ║                                                    │                ║ │
│  ╚════════════════════════════════════════════════════│════════════════╝ │
│                       /run/cloud-workbench/docker.sock│(read-only bind)  │
│                                                       ▼                  │
│  ┌─ user@2200.service  (with --with-docker; cloud-containers) ─────────┐ │
│  │ docker.service (user unit) → rootlesskit → dockerd → containers     │ │
│  │ socket /run/user/2200/docker.sock                                   │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

The helper, [`terminal-session.sh`](../host/terminal-session.sh), runs outside the sandbox as `agent-workspace` and talks to the tmux server only through its socket. Every process of a session is a child of the tmux server, so it runs inside the sandbox of `cloud-workbench.service`. [Transport](transport.md) describes how the launcher on the Mac reaches the helper.

## The service and its sandbox

[`units/cloud-workbench.service`](../host/units/cloud-workbench.service) starts the tmux server in the foreground (`-D`) without a configuration file. Its `ExecStartPost`, [`start-workbench.sh`](../host/start-workbench.sh), waits for the socket, sets the server options and creates the first session, `workbench`, in `/srv/development/state/workspaces/workbench`.

| Setting | Value | Effect |
| --- | --- | --- |
| `User`, `Group` | `agent-workspace` (UID 2100) | The tmux server and every session run as this unprivileged user. |
| `Environment` | `HOME=/srv/development/private/homes/workbench`, `CLAUDE_CONFIG_DIR=/srv/development/private/homes/workbench/.claude`, `CODEX_HOME=/srv/development/private/homes/workbench/.codex`, `PEERMESH_HOME=/srv/development/private/peermesh`, `DOCKER_HOST=unix:///run/cloud-workbench/docker.sock`, `DISABLE_AUTOUPDATER=1`, `PATH=/usr/local/bin:/usr/bin:/bin` | The tmux server starts with this environment, and new sessions inherit it. Claude Code, Codex and PeerMesh keep their files in the private home, and `docker` reaches the rootless engine. |
| `ReadWritePaths` | `/srv/development/state/workspaces/workbench`, `/srv/development/private/homes/workbench`, `/srv/development/private/peermesh` | The only persistent paths that a session can write. |
| `ProtectSystem` | `strict` | The rest of the file system is read-only for the service. |
| `ProtectHome` | `yes` | `/home`, `/root` and `/run/user` are inaccessible. The engine socket reaches the service only through `BindReadOnlyPaths`. |
| `NoNewPrivileges` | `yes` | No process can gain privileges. `sudo` and other setuid programs do not work in a session. `CapabilityBoundingSet=` (empty) and `RestrictSUIDSGID=yes` add to this. |
| `Restart` | `no` | systemd does not start the service again after it stops. |
| `KillMode` | `control-group` | When the service stops, systemd stops every process in its cgroup, also processes that detached from their session. |

Other settings of the unit:

| Setting | Value | Effect |
| --- | --- | --- |
| `Requires`, `After` (Docker drop-in) | `user@2200.service`, `cloud-workbench-docker-wait.service` | With `--with-docker`, `cloud-workbench.service.d/docker.conf` starts the user manager of the engine first, waits until the engine's socket exists, and binds the socket read-only into the sandbox. |
| `MemoryMax`, `MemorySwapMax`, `CPUQuota`, `TasksMax` | `8G`, `0`, `300%`, `512` | Limits for all sessions together. `agent-sessions.slice` and `agent.slice` add outer limits. |
| `TemporaryFileSystem` | `/tmp` and `/var/tmp`, 256M each | Each is a private tmpfs. Its contents go when the service stops. |
| `InaccessiblePaths` | `/run/docker.sock`, `/var/run/docker.sock`, `/var/lib/agent-platform` | Sessions cannot reach a root Docker engine or host records, when the host has them. |
| `RuntimeDirectory`, `RuntimeDirectoryMode` | `cloud-workbench`, `0700` | `/run/cloud-workbench` holds the tmux socket and the engine socket. |
| `UMask` | `0077` | Files that sessions create are private to `agent-workspace` by default. |
| `PrivateDevices`, `ProtectControlGroups`, `ProtectKernelTunables`, `ProtectKernelModules` | `yes` | Sessions see no hardware devices and cannot change cgroups, kernel settings or modules. |

The default tmux option `exit-empty` stays on. When the last session ends, the tmux server exits and the service stops. With `Restart=no`, it stays stopped until an administrator starts it:

```sh
systemctl start cloud-workbench.service
```

`start-workbench.sh` then creates the `workbench` session again. The helper never starts a tmux server: it uses `tmux -N`, and it fails with `The workbench service is unavailable. No service was started. Run tokiwa status.` when the socket does not answer.

## The tmux server

| Item | Value |
| --- | --- |
| Socket | `/run/cloud-workbench/tmux.sock` |
| Configuration file | none (`-f /dev/null`) |
| Server options from `start-workbench.sh` | `mouse on`, `set-clipboard on`, `allow-passthrough on` |
| Global environment | `BROWSER=/opt/agent-platform/rootless/tokiwa-open` |
| Shell of a new session | `/bin/bash --noprofile --norc`, with `BROWSER` and `PS1=NAME:\W\$ ` |
| Prompt name | The `@tokiwa_name` server option, `tokiwa` when it is not set (`tokiwa name NAME`) |
| Session options | `@tokiwa_project` and `@tokiwa_parent` (see [Sessions and projects](sessions-and-projects.md)) |

`mouse on` passes the wheel and drags to programs that report the mouse. `set-clipboard on` and `allow-passthrough on` pass a program's OSC 52 copy, and the `tokiwa-open` request, to the client on the Mac.

## Files that the host installer installs

[The host installer](../host/install.sh) in `host` copies these files. It runs as root, so each file belongs to `root:root` unless the table names another owner.

| Source file | Installed path | Owner, mode | Purpose |
| --- | --- | --- | --- |
| `start-workbench.sh` | `/opt/agent-platform/rootless/start-workbench.sh` | 0755 | Sets the tmux options and creates the `workbench` session. |
| `terminal-session.sh` | `/opt/agent-platform/rootless/terminal-session.sh` | 0755 | The helper: lists, creates, attaches, reads, renames and ends sessions, and keeps `projects.json`. |
| `tokiwa-open` | `/opt/agent-platform/rootless/tokiwa-open` | 0755 | The `BROWSER` program. Sends a link to the Mac. |
| `dockerd-rootless.sh` | `/opt/agent-platform/rootless/dockerd-rootless.sh` | 0755 | Starts `dockerd` inside RootlessKit. |
| `workbench-health.py` | `/opt/agent-platform/rootless/workbench-health.py` | 0644 | Reads host and workbench metrics for `tokiwa health` (see [Health](health.md)). |
| `workbench-files.py` | `/opt/agent-platform/rootless/workbench-files.py` | 0644 | Reads directory listings and text previews for **Browse files**. |
| `daemon.json` | `/opt/agent-platform/rootless/daemon.json` | 0644 | The configuration of the rootless engine. |
| `rootless-metadata.nft` | `/opt/agent-platform/rootless/rootless-metadata.nft` | 0644 | Blocks the instance metadata addresses for the engine user. `/etc/nftables.conf` includes it. |
| `units/cloud-workbench.service` | `/etc/systemd/system/cloud-workbench.service` | 0644 | The service of the tmux server. |
| `units/user-2200.slice` | `/etc/systemd/system/user-2200.slice` | 0644 | Limits of the engine user: `8G` memory, `300%` CPU, 1024 tasks. |
| `units/user-slice-limits.conf` | `/etc/systemd/system/user-2200.slice.d/50-tokiwa-limits.conf` | 0644 | Sets `TasksMax=1024` for this user only. |
| `units/user-manager.conf` | `/etc/systemd/system/user@2200.service.d/cloud-containers.conf` | 0644 | Puts the user manager in `user-2200.slice`, binds it to `nftables.service` and delegates the cgroup controllers. |
| `units/cloud-workbench-docker-wait.service` | `/etc/systemd/system/cloud-workbench-docker-wait.service` | 0644 | Waits up to 60 seconds for the engine's socket. At boot the socket appears a few seconds after the user manager starts, and the bind of a missing socket stops `cloud-workbench.service` from starting. |
| `units/agent-containers.slice` | `/etc/systemd/system/agent-containers.slice` | 0644 | A slice with container limits. No unit in this repository runs in it. |
| `units/docker.service` | `/srv/development/cache/rootless-home/.config/systemd/user/docker.service` | `cloud-containers`, 0644 | The user unit of the rootless engine. A link in `default.target.wants/` starts it with the user manager. |

The installer also makes these paths:

| Path | Owner, mode | Contents |
| --- | --- | --- |
| `/srv/development/state/workspaces/workbench` | `agent-workspace`, 0750, ACLs for UID 2200 (`rwx`) and UID 1049575 (`r-x`) | The `workbench/` folder: project files. |
| `/srv/development/private/homes/workbench` | `agent-workspace`, 0700 | The home of the sessions, with `.claude/` and `.codex/` (0700). |
| `/srv/development/cache/rootless-home` | `cloud-containers`, 0700 | The home of the engine user. |
| `/srv/development/cache/rootless-engine.ext4` | root | A 24 GiB ext4 image. |
| `/srv/development/cache/rootless-engine` | `cloud-containers`, 0700 | The mount point of that image (`loop,nosuid,nodev,noatime`, `nofail` in `/etc/fstab`). |

The folder also holds files that the installer does not copy: `codex-workbench.toml` (a Codex permission profile `tokiwa`), `codex-sandbox.sh`, `units/agent-slice-budget.conf`, the scripts under `compose/`, and the recovery scripts.

## Install the host

[`install.sh`](../host/install.sh) installs the host side on an Ubuntu host with systemd and cgroup v2. Copy the `workstation-parity` folder to the host, then run it as root:

```sh
sudo bash install.sh --dry-run      # print each change and make none
sudo bash install.sh                # the core
sudo bash install.sh --with-docker  # the core and the rootless Docker engine
```

| Part | What it installs |
| --- | --- |
| Core | `tmux`, `python3`, `acl` and `nftables`; the user `agent-workspace` (UID 2100); the folders under `/srv/development`; the helpers in `/opt/agent-platform/rootless`; `agent.slice`, `agent-sessions.slice` and `cloud-workbench.service`; the `cloud_workspace` firewall table, which keeps sessions away from the instance metadata service. It enables the service and starts it when it is not running. |
| `--with-docker` | `docker.io`, `docker-compose-v2`, `rootlesskit`, `slirp4netns` and `uidmap`; the user `cloud-containers` (UID 2200) with the subordinate IDs 1048576–1114111; a 24 GiB ext4 image for the engine, mounted at boot; the engine's user unit, slices and drop-ins; the `rootless_workspace` firewall table; and `cloud-workbench.service.d/docker.conf`, which gives sessions the engine's socket. It needs 28 GiB free in `/srv/development/cache`. |

Each step reads the host first and changes only what is missing, so a second run changes nothing. A folder that exists keeps its owner and mode; the installer reports a difference. It stops before any change when the host is not Ubuntu, when systemd does not run, when cgroup v2 is missing, or when `agent-workspace` or `cloud-containers` exists with another UID.

The installer never restarts `cloud-workbench.service`, because a restart ends every session. When the service is running, changed units take effect at its next start, and the installer says so.

After the install, set the instance in `~/.config/tokiwa/host.env` on the Mac; see [Configuration](configuration.md#host-settings). The host needs the AWS Systems Manager agent and an instance role that allows Session Manager; the installer does not set them up.

## The rootless Docker engine

The engine runs as `cloud-containers` (UID and GID 2200), with the subordinate IDs 1048576–1114111, under its own user manager `user@2200.service`. Lingering keeps the user manager running without a login.

| Item | Value |
| --- | --- |
| User unit | `docker.service`: `dockerd-rootless.sh --config-file=/opt/agent-platform/rootless/daemon.json` |
| Network | `slirp4netns`, with host loopback disabled |
| Socket | `/run/user/2200/docker.sock`. `ExecStartPost` gives UID 2100 access with ACLs. |
| Socket in a session | `/run/cloud-workbench/docker.sock` (`DOCKER_HOST`) |
| Data root | `/srv/development/cache/rootless-engine/data`, on the 24 GiB image |
| Storage driver, cgroup driver | `overlay2`, `systemd` |
| Logs | `local` driver, 10 MB per file, 3 files |
| Published ports | Bound to `127.0.0.1` unless the port names another address |
| Restart | `Restart=no`, `StartLimitBurst=1` |
| Firewall | `rootless-metadata.nft` rejects traffic from UID 2200 and its subordinate IDs to `169.254.0.0/16` and `fd00:ec2::254` |

The engine cannot read the private homes, and it has no access to the root engine socket. All sessions share this one engine and the `workbench/` folder. A process that runs as root in a container runs as UID 2200 on the host, so it can write a folder of `workbench/` that the container mounts.

### Use Docker and Compose from a session

Compose is the `docker compose` plugin. Run it in a project folder in `workbench/`:

```sh
mkdir -p /srv/development/state/workspaces/workbench/projects/example
cd /srv/development/state/workspaces/workbench/projects/example
docker build -t my-app .
docker compose up -d
docker compose logs -f
docker compose exec app sh
docker compose down
```

A published port binds to `127.0.0.1` on the host. The host needs no inbound port; reach the port from the Mac with Session Manager port forwarding:

```sh
aws ssm start-session --profile PROFILE --region REGION \
  --target INSTANCE_ID \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["18080"],"localPortNumber":["18080"]}'
```

Named volumes live in the engine data root on the cache volume. The hourly backup does not include them. An application with data to keep needs its own export and restore; [`compose/export.sh`](../host/compose/export.sh) and [`compose/restore.sh`](../host/compose/restore.sh) do this for the three-service fixture in [`compose/compose.json`](../host/compose/compose.json). The scripts in `compose/` are checks of the engine. They are not a Docker API or a list of allowed commands.

The Docker documentation describes the rootless mode: [rootless tips](https://docs.docker.com/engine/security/rootless/tips/) and [rootless troubleshooting](https://docs.docker.com/engine/security/rootless/troubleshoot/).

## BROWSER and tokiwa-open

Programs in a session open a link through `$BROWSER`, which is `/opt/agent-platform/rootless/tokiwa-open`.

```
program in a session
  │ $BROWSER URL
  ▼
tokiwa-open → ESC ] 7717 ; open ; BASE64 BEL → TTY of the pane
  │
  ▼
tmux server (allow-passthrough on) → tmux client → Session Manager
  │
  ▼
app on the Mac → input in that view in the last 5 seconds?
  │ yes                                  no → footer offers open and copy
  ▼
/usr/bin/open URL → default browser
```

| Step | Behaviour |
| --- | --- |
| Check | Only `http://` and `https://` links. Any other link exits with status 2. |
| Request | `ESC ] 7717 ; open ; BASE64 BEL`. Inside tmux, the request goes in a DCS passthrough (`ESC P tmux;` … `ESC \`). |
| Output | `/dev/tty`. When that fails, the pane TTY from `tmux display-message`. With no terminal, exit status 1. |
| On the Mac | The app opens the link when the user typed or clicked in that view in the last 5 seconds and the link has at most 4096 characters. Otherwise the footer names the link and offers open and copy. |

## What a session can write

| Path | Access from a session |
| --- | --- |
| `/srv/development/state/workspaces/workbench` (`workbench/`) | Read and write. Project folders go here. |
| `/srv/development/private/homes/workbench` (`$HOME`) | Read and write: `.claude/`, `.codex/`, `.gitconfig`, `.tokiwa/projects.json` |
| `/srv/development/private/peermesh` | Read and write |
| `/tmp`, `/var/tmp` | Read and write, a private 256M tmpfs each, emptied when the service stops |
| `/run/cloud-workbench` | The tmux socket and the engine socket |
| `/home`, `/root`, `/run/user` | No access |
| `/run/docker.sock`, `/var/run/docker.sock`, `/var/lib/agent-platform` | No access |
| Every other path | Read only |

The state volume holds `workbench/`. The private volume holds the home, with the logins of Claude Code and Codex; the backup leaves it out. Sign in from a session with `claude auth login` or `codex login`.

## The admin route

`tokiwa admin` opens an interactive Session Manager session that runs `sudo -n /bin/bash -l`: a root login shell on the host, outside the service sandbox. It uses the same AWS profile as the other launcher commands, and the launcher adds no other authentication. Use it to start the service after it stopped, read the units, or run the installer again:

```sh
systemctl start cloud-workbench.service
```

## Related

- [Architecture](architecture.md)
- [Transport](transport.md)
- [Sessions and projects](sessions-and-projects.md)
- [Health](health.md)
- [Configuration](configuration.md)
- [Development](development.md)
