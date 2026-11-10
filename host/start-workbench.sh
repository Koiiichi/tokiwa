#!/bin/bash
set -euo pipefail
socket=/run/cloud-workbench/tmux.sock
# Type=simple starts the post command before tmux finishes creating its socket.
for attempt in $(seq 1 100); do
 if /usr/bin/tmux -S "$socket" show-options -s exit-empty >/dev/null 2>&1; then
  # The server starts without a configuration file. Mouse mode passes the wheel and drags to
  # programs that report the mouse and gives other panes tmux's own scrolling. set-clipboard and
  # allow-passthrough pass a program's OSC 52 copy on to the viewer's clipboard.
  /usr/bin/tmux -S "$socket" set-option -g mouse on \; set-option -s set-clipboard on \; set-option -g allow-passthrough on
  # Programs open links through tokiwa-open, so the links open in the browser of the Mac.
  /usr/bin/tmux -S "$socket" set-environment -g BROWSER /opt/agent-platform/rootless/tokiwa-open
  # New shells show the configured name in the prompt (tokiwa unless `tokiwa name` set another).
  prompt=$(/usr/bin/tmux -S "$socket" show-options -gqv @tokiwa_name || true)
  [[ $prompt =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,23}$ ]] || prompt=tokiwa
  exec /usr/bin/tmux -S "$socket" new-session -d -s workbench -c /srv/development/state/workspaces/workbench env TOKIWA_BROWSER=/opt/agent-platform/rootless/tokiwa-open "TOKIWA_PS1=$prompt:\\W\\$ " /bin/bash --noprofile --rcfile /opt/agent-platform/rootless/tokiwa-bashrc \; set-option @tokiwa_session 1
 fi
 sleep 0.1
done
printf 'The workbench terminal did not become ready.\n' >&2
exit 1
