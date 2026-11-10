#!/bin/bash
# All shells belong to the existing protected tmux server.
set -euo pipefail
socket=${TOKIWA_SOCKET:-/run/cloud-workbench/tmux.sock}
workdir=${TOKIWA_WORKDIR:-/srv/development/state/workspaces/workbench}
# A new project folder is one name inside this folder. Sessions run in a service that can write
# only inside the workbench folder (see units/cloud-workbench.service), so new folders go there.
workspaces=${TOKIWA_WORKSPACES:-$workdir}
# Saved projects, so that a project outlives its sessions: projects.json in this private folder.
state=${TOKIWA_STATE:-/srv/development/private/homes/workbench/.tokiwa}
# Programs open links through this helper, so the links open in the browser of the Mac.
browser=${TOKIWA_BROWSER:-/opt/agent-platform/rootless/tokiwa-open}
tm() { tmux -N -S "$socket" "$@"; }
fail() { printf '%s\n' "$*" >&2; exit 1; }
valid_name() { [[ $1 =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$ ]]; }
valid_prompt_name() { [[ $1 =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,23}$ ]]; }
# A secret becomes an environment variable of each new shell; the names that shells and Tokiwa use are refused.
valid_secret() {
 [[ $1 =~ ^[A-Za-z_][A-Za-z0-9_]{0,63}$ ]] || return 1
 case $1 in PATH|HOME|SHELL|USER|LOGNAME|PWD|BROWSER|PS1|TOKIWA_*|TMUX*) return 1 ;; esac
}
mode=${1:-shell}
name=${2:-}
extra=${3:-}
[[ $# -le 3 || ( $mode == capture && $# -le 5 ) ]] || fail 'Too many arguments.'
case "$mode" in
 new|attach|view|ensure|project|end|create|rename|capture) valid_name "$name" || fail 'Use a session name of 1 to 48 letters, digits, hyphens or underscores. Start with a letter or digit.' ;;
 name) [[ -z $name ]] || valid_prompt_name "$name" || fail 'Use a name of 1 to 24 letters, digits, hyphens or underscores. Start with a letter or digit.' ;;
 relabel|forget-project) [[ $name =~ ^[A-Za-z0-9+/=]+$ && ${#name} -le 2000 && -z $extra ]] || fail 'The project move is invalid.' ;;
 health|shell|sessions|status|snapshot|secrets) [[ -z $name ]] || fail 'This command does not accept a session name.' ;;
 secret|secret-remove) valid_secret "$name" || fail 'Use a secret name of letters, digits and underscores. PATH, HOME, SHELL, USER, LOGNAME, PWD, BROWSER, PS1 and names that start with TOKIWA_ or TMUX are refused.' ;;
 *) fail 'Unknown terminal command.' ;;
esac
[[ $mode == new || $mode == project || $mode == end || $mode == attach || $mode == create || $mode == rename || $mode == capture || $mode == view || -z $extra ]] || fail 'Too many arguments.'
if [[ $mode == new && -n $extra ]]; then valid_name "$extra" || fail 'The source session name is invalid.'; fi
if [[ $mode == health ]]; then
 exec python3 "$(dirname "$0")/workbench-health.py"
fi
if [[ $mode == secret || $mode == secret-remove || $mode == secrets ]]; then
 # Each line is `export NAME='value'`; tokiwa-bashrc loads the file in each new shell. A value reaches
 # this program on stdin only: an argument is visible to every user in the process list.
 read -r -d '' secrets_program <<'PY_SECRETS' || true
import os, re, shlex, sys
op, name, path = sys.argv[1:4]
line = re.compile(r'export ([A-Za-z_][A-Za-z0-9_]*)=')
try:
    with open(path, encoding='utf-8') as f:
        lines = f.read().splitlines()
except FileNotFoundError:
    lines = []
names = [m.group(1) for m in map(line.match, lines) if m]
if op == 'list':
    print(''.join(n + '\n' for n in sorted(names)), end='')
    raise SystemExit
if op == 'remove' and name not in names:
    raise SystemExit(f'No secret named {name}.')
kept = [l for l in lines if not (m := line.match(l)) or m.group(1) != name]
if op == 'set':
    kept.append(f'export {name}={shlex.quote(sys.stdin.read())}')
os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
temp = path + '.new'
descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(descriptor, 'w', encoding='utf-8') as f:
    f.write(''.join(l + '\n' for l in kept))
os.chmod(temp, 0o600)
os.replace(temp, path)
PY_SECRETS
 secrets_file=$state/secrets.env
 case $mode in
  secret)
   [[ -t 0 ]] || fail 'Run tokiwa secret NAME in a terminal: the value is read with hidden input.'
   # Echo goes off before the prompt shows. A paste that arrives with the prompt reaches the terminal
   # before `read -s` starts, and the terminal would echo it.
   stty -echo
   trap 'stty echo' EXIT
   printf 'Value for %s (input hidden; paste it, then press Enter): ' "$name" >&2
   value=
   IFS= read -rs value || true
   printf '\n' >&2
   # The rest of a paste of several lines waits in the terminal. Read it here, so that no shell runs it.
   dropped=0
   while IFS= read -rs -t 1 _; do dropped=$((dropped + 1)); done
   [[ -n $value ]] || fail 'The value is empty. Nothing was saved.'
   printf '%s' "$value" | python3 -c "$secrets_program" set "$name" "$secrets_file" || exit 1
   unset value
   printf 'Saved %s. New shells load it; restart an agent that runs now to give it the value.\n' "$name"
   if (( dropped == 1 )); then printf '1 extra line of the paste was dropped. Only the first line was saved.\n'
   elif (( dropped > 1 )); then printf '%s extra lines of the paste were dropped. Only the first line was saved.\n' "$dropped"; fi ;;
  secret-remove)
   python3 -c "$secrets_program" remove "$name" "$secrets_file" < /dev/null || exit 1
   printf 'Removed %s. Shells that run now keep it until they restart.\n' "$name" ;;
  secrets) python3 -c "$secrets_program" list - "$secrets_file" < /dev/null ;;
 esac
 exit
fi
if [[ $mode == end || $mode == capture || $mode == view || ( $mode == attach && $# -eq 3 ) ]]; then
 [[ $extra =~ ^[0-9]+:\$[0-9]+:[0-9]+$ ]] || fail 'The session identity is invalid. Refresh the session list.'
fi
if [[ $mode == capture ]]; then
 lines=${4:-}
 recipient=${5:-}
 [[ $lines =~ ^[0-9]{1,3}$ ]] && (( lines >= 1 && lines <= 200 )) || fail 'Use a line count from 1 to 200.'
 # Run Command keeps its output in the account, so screen text leaves this host only encrypted.
 [[ $recipient =~ ^[A-Za-z0-9+/=]+$ && ${#recipient} -le 4000 ]] || fail 'A capture needs a recipient certificate. Nothing was read.'
fi
# -N prevents a failed connection from creating an unprotected server.
tm show-options -s exit-empty >/dev/null 2>&1 || fail 'The workbench service is unavailable. No service was started. Run tokiwa status.'
# A new shell shows the configured name in its prompt, for example `tokiwa:workbench$`.
prompt_name() {
 local value
 value=$(tm show-options -gqv @tokiwa_name 2>/dev/null || true)
 valid_prompt_name "$value" && printf '%s' "$value" || printf 'tokiwa'
}
# Start session $1 in directory $2 with a plain shell.
start_shell() {
 tm new-session -d -s "$1" -c "$2" env "TOKIWA_BROWSER=$browser" "TOKIWA_PS1=$(prompt_name):\\W\\$ " /bin/bash --noprofile --rcfile "$(dirname "$0")/tokiwa-bashrc" \; set-option @tokiwa_session 1
}
# Validate a project label from base64 $1: a name path such as studio/api, or an existing absolute directory.
project_label() {
 python3 - "$1" <<'PY_LABEL'
import base64, os, re, sys
try:
    label = base64.b64decode(sys.argv[1], validate=True).decode('utf-8')
    if label.startswith('/'):
        if any(ord(c) < 32 or ord(c) == 127 for c in label):
            raise ValueError()
        label = os.path.realpath(label)
        if not os.path.isdir(label) or not os.access(label, os.R_OK | os.X_OK):
            raise ValueError()
    else:
        parts = label.split('/')
        if not 1 <= len(parts) <= 6 or not all(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,47}', p) for p in parts):
            raise ValueError()
except (ValueError, OSError, UnicodeError):
    raise SystemExit('Use a project name path such as studio/api, or an existing absolute directory.')
print(label)
PY_LABEL
}
# Change the saved projects: add LABEL DIR (keeps an existing entry), move FROM TO, forget LABEL.
# A move or a forget also applies to the projects inside LABEL. Directory labels are not saved.
registry() {
 python3 - "$state" "$@" <<'PY_REGISTRY'
import fcntl, json, os, sys
state, op, args = sys.argv[1], sys.argv[2], sys.argv[3:]
os.makedirs(state, mode=0o700, exist_ok=True)
path = os.path.join(state, 'projects.json')
with open(os.path.join(state, 'projects.lock'), 'a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        with open(path) as f:
            projects = json.load(f).get('projects', {})
    except FileNotFoundError:
        projects = {}
    inside = lambda label, root: label == root or label.startswith(root + '/')
    if op == 'add' and not args[0].startswith('/'):
        projects.setdefault(args[0], {'dir': args[1]})
    elif op == 'move':
        projects = {(args[1] + k[len(args[0]):] if inside(k, args[0]) else k): v for k, v in projects.items()}
    elif op == 'forget':
        projects = {k: v for k, v in projects.items() if not inside(k, args[0])}
    temp = path + '.tmp'
    with open(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
        json.dump({'projects': projects}, f, indent=1, sort_keys=True)
    os.replace(temp, path)
PY_REGISTRY
}
ensure() {
 if ! tm has-session -t "=$name" 2>/dev/null; then
  printf 'Creating terminal: %s\n' "$name" >&2
  if ! start_shell "$name" "$workdir"; then
   # Another client can create this exact session between the two commands.
   tm has-session -t "=$name" 2>/dev/null || fail 'The terminal could not be created.'
  fi
 fi
}
case "$mode" in
 capture)
  # Read only. The text is the last lines of the active pane, with its scrollback, without colour.
  # The output is encrypted to the one-time certificate of the caller. There is no plain output.
  python3 - "$socket" "$name" "$extra" "$lines" "$recipient" <<'PY_CAPTURE'
import base64
import binascii
import json
import subprocess
import sys
import tempfile
import time

socket, name, identity, limit, recipient = sys.argv[1:6]
# The sealed output must fit the 24,000 characters that Run Command returns: base64 adds a third.
LIMIT_BYTES = 15000

def tmux(*args):
    # -u: without it, tmux replaces non-ASCII text for a client without a UTF-8 locale.
    return subprocess.run(['tmux', '-N', '-u', '-S', socket, *args], capture_output=True,
                          encoding='utf-8', errors='replace', timeout=10)

def size(text):
    return len(json.dumps(text, ensure_ascii=False).encode())

target = '=' + name + ':'
if tmux('has-session', '-t', '=' + name).returncode:
    raise SystemExit('The selected session no longer exists.')
fields = tmux('display-message', '-p', '-t', target,
              '#{pid}:#{session_id}:#{session_created}\t#{pane_id}\t#{pane_dead}\t#{session_attached}\t#{pane_current_command}')
if fields.returncode:
    raise SystemExit('The selected session no longer exists.')
current, pane, dead, clients, command = fields.stdout.rstrip('\n').split('\t', 4)
if current != identity:
    raise SystemExit('Session identity changed. Nothing was read.')
# A pane ID is never reused on a server, so this reads the session that the check saw.
screen = tmux('capture-pane', '-p', '-J', '-S', '-200', '-t', pane)
if screen.returncode:
    raise SystemExit('The selected session no longer exists.')
rows = [row.rstrip() for row in screen.stdout.splitlines()]
rows = [row for row in rows if row][-int(limit):]
text = '\n'.join(rows)
truncated = size(text) > LIMIT_BYTES
if truncated:
    # The smallest start that fits. Text is cut between characters, never inside one.
    low, high = 0, len(text)
    while low < high:
        middle = (low + high) // 2
        if size(text[middle:]) > LIMIT_BYTES:
            low = middle + 1
        else:
            high = middle
    text = text[low:]
output = {'name': name, 'identity': identity, 'pane': pane, 'command': command[:80],
          'clients': int(clients), 'dead': dead == '1', 'sampled_at': time.time(),
          'lines': text.count('\n') + 1 if text else 0, 'truncated': truncated, 'text': text}
try:
    certificate = base64.b64decode(recipient, validate=True)
except binascii.Error:
    raise SystemExit('The capture could not be encrypted. Nothing was read.')
sealed = None
try:
    with tempfile.NamedTemporaryFile(suffix='.pem') as pem:
        pem.write(certificate)
        pem.flush()
        sealed = subprocess.run(['openssl', 'smime', '-encrypt', '-aes256', '-binary', '-outform', 'DER', pem.name],
                                input=json.dumps(output, ensure_ascii=False).encode(), capture_output=True, timeout=10)
except (OSError, subprocess.TimeoutExpired):
    pass
if sealed is None or sealed.returncode or not sealed.stdout:
    raise SystemExit('The capture could not be encrypted. Nothing was read.')
print(base64.b64encode(sealed.stdout).decode())
PY_CAPTURE
  exit ;;
 snapshot)
  python3 - "$socket" "$state" <<'PY_SNAPSHOT'
import json
import subprocess
import sys
import hashlib
import time

output = subprocess.check_output(
    ['tmux', '-N', '-S', sys.argv[1], 'list-sessions', '-F',
     '#{session_name}\t#{session_attached}\t#{session_windows}'], text=True, timeout=10)
sessions = []
for line in output.splitlines():
    name, clients, windows = line.rsplit('\t', 2)
    def read(*args):
        return subprocess.check_output(['tmux', '-N', '-S', sys.argv[1], *args], text=True, timeout=10).rstrip('\n')
    cwd = read('display-message', '-p', '-t', '=' + name + ':', '#{pane_current_path}')
    project = read('show-options', '-qv', '-t', '=' + name + ':', '@tokiwa_project') or cwd
    parent = read('show-options', '-qv', '-t', '=' + name + ':', '@tokiwa_parent')
    managed = read('show-options', '-qv', '-t', '=' + name + ':', '@tokiwa_session') == '1'
    # One line per pane of every window. The window bell flag is set when a pane of the window
    # rang the bell while no client viewed that window; viewing the window clears it.
    panes = [pane.split('\t', 3) for pane in read('list-panes', '-s', '-t', '=' + name, '-F',
             '#{pane_id}\t#{pane_dead}\t#{window_bell_flag}\t#{pane_current_command}').splitlines()]
    bell = any(flag == '1' for _, _, flag, _ in panes)
    activity = []
    for pane_id, dead, _, command in panes[:16]:
        screen = read('capture-pane', '-p', '-t', pane_id, '-S', '-20')
        activity.append({'pane':pane_id, 'dead':dead == '1', 'command':command[:80], 'screen':hashlib.sha256(screen.encode()).hexdigest()})
    sessions.append({'activity_partial':len(panes)>16, 'activity': activity, 'bell': bell, 'sampled_at':time.time(), 'name': name, 'clients': int(clients), 'windows': int(windows), 'cwd': cwd, 'project': project, 'parent': parent, 'managed': managed, 'identity': read('display-message', '-p', '-t', '=' + name + ':', '#{pid}:#{session_id}:#{session_created}')})
if len(sessions) > 100:
    raise SystemExit('The session list exceeds the dashboard limit of 100.')
# Drop optional activity before it can prevent session navigation.
while len(json.dumps({'sessions': sessions})) > 22000:
    row = next((row for row in reversed(sessions) if row['activity']), None)
    if row is None:
        raise SystemExit('The session list exceeds the response limit.')
    row['activity'] = []
    row['activity_partial'] = True
try:
    with open(sys.argv[2] + '/projects.json') as f:
        projects = json.load(f).get('projects', {})
except (FileNotFoundError, ValueError):
    projects = {}
print(json.dumps({'sessions': sessions, 'projects': projects}))
PY_SNAPSHOT
  exit ;;
 end)
  # Both the identity check and deletion run in the same tmux command queue.
  tm has-session -t "=$name" 2>/dev/null || fail 'The selected session no longer exists.'
  session_id=${extra#*:}; session_id=${session_id%%:*}
  answer=$(tm if-shell -F -t "=$name:" "#{==:#{pid}:#{session_id}:#{session_created},$extra}" \
   "kill-session -t '$session_id'" "display-message -p 'Session identity changed. Nothing was ended.'") || fail 'The session could not be ended. Refresh its state.'
  [[ -z $answer ]] || fail "$answer"
  printf 'The selected session ended. Detached background processes may remain.\n'
  exit ;;
 rename)
  # The identity check and the rename run in the same tmux command queue, as for end.
  tm has-session -t "=$name" 2>/dev/null || fail 'The selected session no longer exists.'
  request=$(python3 - "$extra" <<'PY_RENAME'
import base64, json, re, sys
try:
    want = json.loads(base64.b64decode(sys.argv[1], validate=True))
    to, identity = want['to'], want['identity']
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}', to) or not re.fullmatch(r'[0-9]+:\$[0-9]+:[0-9]+', identity):
        raise ValueError()
    print(to, identity)
except (ValueError, KeyError, TypeError, AttributeError):
    raise SystemExit('Use a new name of 1 to 48 letters, digits, hyphens or underscores, and the session identity.')
PY_RENAME
) || exit 1
  to=${request% *}; identity=${request#* }
  tm has-session -t "=$to" 2>/dev/null && fail 'A session with this name exists.'
  session_id=${identity#*:}; session_id=${session_id%%:*}
  answer=$(tm if-shell -F -t "=$name:" "#{==:#{pid}:#{session_id}:#{session_created},$identity}" \
   "rename-session -t '$session_id' '$to'" "display-message -p 'Session identity changed. Nothing was renamed.'") || fail 'The session could not be renamed. Refresh its state.'
  [[ -z $answer ]] || fail "$answer"
  printf 'Renamed %s to %s.\n' "$name" "$to"
  exit ;;
 project)
  tm has-session -t "=$name" 2>/dev/null || fail 'The selected session does not exist.'
  label=$(project_label "$extra") || exit 1
  tm set-option -t "=$name:" @tokiwa_project "$label"
  registry add "$label" "$(tm display-message -p -t "=$name:" '#{pane_current_path}')"
  printf 'Project saved.\n'
  exit ;;
 relabel)
  # Move project `from` and every project inside it to `to`. A session without its own label
  # belongs to the project of its directory. Directories and processes do not change.
  request=$(python3 - "$name" <<'PY_MOVE'
import base64, json, sys
try:
    move = json.loads(base64.b64decode(sys.argv[1], validate=True))
    print(base64.b64encode(move['from'].encode()).decode(), base64.b64encode(move['to'].encode()).decode())
except (ValueError, KeyError, TypeError, AttributeError):
    raise SystemExit('The project move is invalid.')
PY_MOVE
) || exit 1
  from=$(project_label "${request% *}") || exit 1
  to=$(project_label "${request#* }") || exit 1
  [[ $to != /* ]] || fail 'Move a project to a name path such as studio/api.'
  [[ $to != "$from" && $to != "$from"/* ]] || fail 'A project cannot move into itself.'
  moved=0
  first=''
  while IFS=$'\t' read -r session label cwd; do
   [[ -n $label ]] || label=$cwd
   if [[ $label == "$from" ]]; then target=$to
   elif [[ $label == "$from"/* ]]; then target=$to${label#"$from"}
   else continue; fi
   tm set-option -t "=$session:" @tokiwa_project "$target"
   [[ -n $first || $target != "$to" ]] || first=$cwd
   moved=$((moved + 1))
  done < <(tm list-sessions -F $'#{session_name}\t#{@tokiwa_project}\t#{pane_current_path}')
  registry move "$from" "$to"
  [[ -z $first ]] || registry add "$to" "$first"
  printf 'Moved %d sessions.\n' "$moved"
  exit ;;
 name)
  if [[ -z $name ]]; then prompt_name; printf '\n'; exit; fi
  tm set-option -g @tokiwa_name "$name"
  printf 'New shells show %s in the prompt.\n' "$name"
  exit ;;
 forget-project)
  # Forget a saved project and the projects inside it. Its folders and files stay.
  label=$(project_label "$name") || exit 1
  [[ $label != /* ]] || fail 'Only a saved project can be forgotten.'
  while IFS=$'\t' read -r session current; do
   [[ $current == "$label" || $current == "$label"/* ]] && fail "End the sessions of this project first, for example $session."
  done < <(tm list-sessions -F $'#{session_name}\t#{@tokiwa_project}')
  registry forget "$label"
  printf 'Project forgotten. Its folders stay.\n'
  exit ;;
 create)
  # A session in an existing directory, or in a new folder inside the workspaces folder.
  tm has-session -t "=$name" 2>/dev/null && fail 'This session exists. Use tokiwa attach NAME.'
  request=$(python3 - "$extra" "$workspaces" <<'PY_CREATE'
import base64, json, os, re, sys
try:
    want = json.loads(base64.b64decode(sys.argv[1], validate=True))
    if want.get('folder'):
        folder = want['folder']
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,47}', folder):
            raise ValueError()
        path = os.path.join(sys.argv[2], folder)
        os.makedirs(path, exist_ok=True)
    elif want.get('dir'):
        path = want['dir']
        if not path.startswith('/') or any(ord(c) < 32 or ord(c) == 127 for c in path):
            raise ValueError()
    else:
        raise ValueError()
    if 'subfolder' in want:
        # The session's own folder is one name, so it stays inside the folder above.
        subfolder = want['subfolder']
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,47}', subfolder) or not os.path.isdir(path):
            raise ValueError()
        path = os.path.join(path, subfolder)
        os.makedirs(path, exist_ok=True)
    path = os.path.realpath(path)
    if not os.path.isdir(path) or not os.access(path, os.R_OK | os.X_OK):
        raise ValueError()
    label = want.get('project') or ''
    print(base64.b64encode(path.encode()).decode(), base64.b64encode(label.encode()).decode() or '-')
except (ValueError, OSError, TypeError, AttributeError):
    raise SystemExit('Use an existing absolute directory, or a folder name of letters, digits, dots, hyphens or underscores.')
PY_CREATE
) || exit 1
  directory=$(printf '%s' "${request% *}" | base64 -d)
  label=''
  [[ ${request#* } == - ]] || label=$(project_label "${request#* }") || exit 1
  start_shell "$name" "$directory" || fail 'The terminal could not be created.'
  if [[ -n $label ]]; then
   tm set-option -t "=$name:" @tokiwa_project "$label"
   registry add "$label" "$directory"
  fi
  # The identity lets the app attach at once, without another read of the session list.
  identity=$(tm display-message -p -t "=$name:" '#{pid}:#{session_id}:#{session_created}') ||
   fail 'The terminal could not be created.'
  printf 'Created terminal: %s %s\n' "$name" "$identity"
  exit ;;
 status)
  printf 'Workbench server ready.\n'
  tm list-sessions -F '#{session_name} | clients=#{session_attached} | windows=#{session_windows}'
  exit ;;
 sessions)
  tm list-sessions -F '#{session_name} | clients=#{session_attached} | windows=#{session_windows}'
  exit ;;
 ensure) ensure; exit ;;
 new)
  tm has-session -t "=$name" 2>/dev/null && fail 'This session exists. Use tokiwa attach NAME.'
  project=''
  if [[ -n $extra ]]; then
   tm has-session -t "=$extra" 2>/dev/null || fail 'The source session no longer exists.'
   workdir=$(tm display-message -p -t "=$extra:" '#{pane_current_path}')
   project=$(tm show-options -qv -t "=$extra:" @tokiwa_project)
   [[ -n $project ]] || project=$workdir
   parent=$(tm display-message -p -t "=$extra:" '#{session_id}')
  fi
  [[ -d $workdir && -x $workdir ]] || fail 'The source directory is unavailable.'
  start_shell "$name" "$workdir"
  [[ -z $project ]] || tm set-option -t "=$name:" @tokiwa_project "$project"
  # The shell opened from another session lists under it as a child.
  [[ -z ${parent:-} ]] || tm set-option -t "=$name:" @tokiwa_parent "$parent" ;;

 attach)
  tm has-session -t "=$name" 2>/dev/null || fail 'This session does not exist. Use tokiwa sessions or tokiwa new NAME.'
  if [[ $# -eq 3 ]]; then
   [[ ${TOKIWA_QUIET:-0} == 1 ]] || printf 'Attaching: %s. Detach with Ctrl-B, then D. Exit ends this shell.\n' "$name" >&2
   session_id=${extra#*:}; session_id=${session_id%%:*}
   # The identity check and the attachment run in the same tmux command queue.
   # A session that replaced the expected one under the same name is never attached.
   exec tmux -N -S "$socket" if-shell -F -t "=$name:" "#{==:#{pid}:#{session_id}:#{session_created},$extra}" \
    "attach-session -t '$session_id'" \
    "display-message -p 'Session identity changed. No session was attached.' ; run-shell 'exit 1'"
  fi ;;
 view)
  # Read only: a key press never reaches the program. The identity check and the attachment run
  # in the same tmux command queue.
  tm has-session -t "=$name" 2>/dev/null || fail 'This session does not exist. Use tokiwa sessions or tokiwa new NAME.'
  session_id=${extra#*:}; session_id=${session_id%%:*}
  exec tmux -N -S "$socket" if-shell -F -t "=$name:" "#{==:#{pid}:#{session_id}:#{session_created},$extra}" \
   "attach-session -r -t '$session_id'" \
   "display-message -p 'Session identity changed. No session was attached.' ; run-shell 'exit 1'" ;;
 shell)
  names=()
  while IFS= read -r item; do [[ -z $item ]] || names+=("$item"); done < <(tm list-sessions -F '#{session_name}')
  if [[ ${#names[@]} -eq 0 ]]; then
   name=workbench; ensure
  elif [[ ${#names[@]} -eq 1 ]]; then
   name=${names[0]}
  else
   printf 'Select a terminal. Use a separate local tab for another connection.\n' >&2
   PS3='Terminal number: '
   select name in "${names[@]}"; do [[ -n $name ]] && break; done
   [[ -n $name ]] || fail 'No terminal was selected.'
  fi ;;
esac
[[ ${TOKIWA_QUIET:-0} == 1 ]] || printf 'Attaching: %s. Detach with Ctrl-B, then D. Exit ends this shell.\n' "$name" >&2
exec tmux -N -S "$socket" attach-session -t "=$name"
