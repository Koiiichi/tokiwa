# host

The host side of Tokiwa: the systemd units, the scripts that start the tmux server and serve the app's requests, the rootless Docker engine setup, and the host installer.

| File | Contents |
| --- | --- |
| `units/` | `cloud-workbench.service`, its slices, and the units and drop-ins of the rootless engine. |
| `start-workbench.sh` | Sets the tmux options and starts the first session after the server starts. |
| `terminal-session.sh` | The helper that the launcher runs: snapshot, create, attach, rename, end, projects. |
| `workbench-health.py`, `workbench-files.py` | Health readings and Browse files. |
| `tokiwa-open` | Sends a link from a program on the host to the Mac's browser. |
| `install.sh` | The host installer: the core, and rootless Docker with `--with-docker`. |
| `compose/` | Checks and export and restore scripts for Docker Compose projects. |
| `tests/` | The offline tests of these files. |

[Host](../docs/host.md) describes what runs on the host and how to install it.
