# Host

The host is the EC2 instance with Ubuntu 24.04 that keeps the sessions: one systemd service runs one tmux server in a sandbox, and a rootless Docker engine runs beside it. The host does not draw the interface, keep the order of the projects or open links; the app on the Mac does that (see [Architecture](architecture.md) and [Interface](interface.md)).

## Processes

```
┌─ EC2 host ───────────────────────────────────────────────────────────────┐
│                                                                          │
│  amazon-ssm-agent  (Run Command, interactive sessions)                   │
│    │ sudo -n runuser -u agent-workspace -- terminal-session.sh MODE      │
│    ▼                                                                     │
│  terminal-session.sh  → workbench-health.py                              │
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
| Shell of a new session | `/bin/bash --noprofile --rcfile tokiwa-bashrc`: it reads the owner's `~/.bashrc` (for example the `PATH` of the tools in `~/.local/bin`), then the [saved secrets](#secrets), then sets `BROWSER` and `PS1=NAME:\W\$ ` |
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
| `tokiwa-bashrc` | `/opt/agent-platform/rootless/tokiwa-bashrc` | 0644 | The startup file of each shell: the owner's `~/.bashrc`, then Tokiwa's prompt and `BROWSER`. |
| `tokiwa-state` | `/usr/local/bin/tokiwa-state` | 0755 | Records the state that an agent's hook reports, for the session list. See [Agent state](#agent-state). |
| `agent-hooks.py` | `/opt/agent-platform/rootless/agent-hooks.py` | 0644 | Adds Tokiwa's state hooks to the Claude Code and Codex settings of the workbench user, or removes them. |
| `tokiwa-attention` | `/usr/local/bin/tokiwa-attention` | 0755 | Marks the session that runs it as waiting for a person, so it shows `needs you` also while a client has it open, and rings the bell. An attach clears the mark; `--clear` removes it from inside. |
| `dockerd-rootless.sh` | `/opt/agent-platform/rootless/dockerd-rootless.sh` | 0755 | Starts `dockerd` inside RootlessKit. |
| `workbench-health.py` | `/opt/agent-platform/rootless/workbench-health.py` | 0644 | Reads host and workbench metrics for `tokiwa health` (see [Health](health.md)). |
| `daemon.json` | `/opt/agent-platform/rootless/daemon.json` | 0644 | The configuration of the rootless engine. |
| `needrestart.conf` | `/etc/needrestart/conf.d/tokiwa.conf` | 0644 | Stops `needrestart` restarting `cloud-workbench.service`. Ubuntu runs `needrestart` after each package change, also an automatic update, and a restart of the service ends every session. |
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
| Core | `tmux`, `python3`, `acl`, `nftables` and `openssl`; the user `agent-workspace` (UID 2100); the folders under `/srv/development`; the helpers in `/opt/agent-platform/rootless`; `agent.slice`, `agent-sessions.slice` and `cloud-workbench.service`; the `cloud_workspace` firewall table, which keeps sessions away from the instance metadata service. It enables the service and starts it when it is not running. |
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

## Secrets

`tokiwa secret NAME` saves a value, for example an API key, on the host. Each new shell then has it as the environment variable `NAME`, so an agent that starts in a new session can use it. An agent that runs now needs a restart to see it.

```sh
tokiwa secret OPENAI_API_KEY      # paste the key at the hidden prompt, then press Enter
tokiwa secrets                    # the names of the saved secrets, never the values
tokiwa secret --remove OPENAI_API_KEY
```

The prompt runs on the host, in a Session Manager session, so the value goes from your keyboard to the host through that encrypted connection. It is never stored on the Mac, and it never goes through Run Command, which keeps its parameters and output in the AWS account. The host does not print the value, so a Session Manager log of the session would not hold it either. Type the command instead of pasting it, so that the clipboard still holds the value. When a paste holds several lines, the host keeps the first line, reads the rest so that no shell runs it, and says how many lines it dropped.

The values are in `~/.tokiwa/secrets.env` of the workbench user (`/srv/development/private/homes/workbench`), mode 600, one `export NAME='value'` line each. `tokiwa-bashrc` loads the file after `~/.bashrc`, so the newest saved value wins. Every program in a session runs as that user and can read the values; that includes the agents. Names that shells and Tokiwa rely on are refused: `PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `PWD`, `BROWSER`, `PS1`, and names that start with `TOKIWA_` or `TMUX`.

## Agent state

The agent in a session reports its state through its own hooks, which call `tokiwa-state STATE`. The command records the state and the time on the session, and the session list shows it as `agent` while `claude` or `codex` runs in a pane. A state that an ended agent left behind does not show.

| State | Claude Code events | Codex events |
| --- | --- | --- |
| `working` | `UserPromptSubmit`, `PostToolUse`, `ElicitationResult`, Notification `quota_auto_resume_fired` | `UserPromptSubmit`, `PostToolUse` |
| `waiting` | `PreToolUse` of `AskUserQuestion`, `Elicitation`, Notification `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog` | `PermissionRequest` |
| `idle` | `Stop`, Notification `idle_prompt` | `Stop`, `Interrupt` |
| `limited` | `StopFailure` `rate_limit`, Notification `quota_auto_resume_stale` | none: Codex has no hook for a limit |
| `error` | `StopFailure` with any other error | none |

The installer adds these hooks with `agent-hooks.py install` to `~/.claude/settings.json` and `~/.codex/hooks.json` of the workbench user. They come after the hooks that are there already, which stay as they are, and they run without holding the agent. Codex runs a new hook only after a person trusts it: start a Codex session and accept Tokiwa's hooks once. `agent-hooks.py remove` takes them out again.

What the states cannot tell:

- Claude Code reports a permission prompt about six seconds after it appears.
- Claude Code reports no event when Esc stops a turn. `tokiwa interrupt` sets `idle` itself; after an Esc that you type, the state changes at the next turn or after a minute of no input.
- Whether a usage limit of a Claude plan arrives as `rate_limit` is not documented.

## Audit log

The helper records each control action after it succeeds: `create`, `end`, `rename`, `project`, `move-project`, `forget-project`, `name`, `interrupt`, `freeze` and `resume`. Each line of `~/.tokiwa/audit.log` of the workbench user (mode 600) is one JSON object:

```json
{"at": 1794280000, "action": "freeze", "name": "review-a", "identity": "2171359:$33:1794270951", "via": "mcp"}
```

`via` is the interface that asked: `cli` for the `tokiwa` command, `mcp` for the MCP server, `app` for the interface. A `create` also has `run`, which says whether a command ran in the new session; the log never holds the command. A refused action is not logged. `tokiwa audit` prints the last 50 lines. The log is a record of what happened and when, not proof of who did it. `via` is what the caller says, so a program with a shell can name any interface, and two agents that use the same interface look the same. A program on the host that runs as the workbench user can also write to the log.

## Stuck connections

Each connection runs its command under `sudo -n runuser -u agent-workspace`, and that `sudo` ends when the connection ends. A `sudo` that outlives its connection loses its parent, and `init` (PID 1) adopts it. It does no work, but it can spin at full CPU: one used a whole core for six days. The cause is not known yet. Closing a connection in the usual ways (detach, a dropped network, a closed session) does not reproduce it.

`tokiwa health` lists each one in `host.stuck_connections` and as a `Stuck connection` row. The Health view shows it in amber with its PID, its age and its CPU share.

Before you stop one, record where it spins, so that the cause can be found. Run these in `tokiwa admin`, so that the output stays in your terminal. `-s 0` keeps `strace` from printing the data that passes through, which can be terminal text:

```sh
pid=PID
cat /proc/$pid/stack              # the kernel stack
ls -l /proc/$pid/fd               # its terminals and pipes
timeout 5 strace -c -p $pid       # system calls, counted for 5 seconds
timeout 1 strace -s 0 -p $pid 2>&1 | head -20
kill $pid; sleep 5; kill -0 $pid 2>/dev/null && kill -KILL $pid
```

Stopping it affects no session: its program has already ended. The one seen so far ignored `TERM` and stopped with `KILL`.

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
