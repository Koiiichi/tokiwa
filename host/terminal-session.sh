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
valid_actor() { [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$ ]]; }
valid_prompt_name() { [[ $1 =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,23}$ ]]; }
# A secret becomes an environment variable of each new shell; the names that shells and Tokiwa use are refused.
valid_secret() {
 [[ $1 =~ ^[A-Za-z_][A-Za-z0-9_]{0,63}$ ]] || return 1
 case $1 in PATH|HOME|SHELL|USER|LOGNAME|PWD|BROWSER|PS1|TOKIWA_*|TMUX*) return 1 ;; esac
}
# Record a control action after it succeeded, in a private log, with the interface that asked for
# it. A failed write warns and does not undo the action.
audit() {
 local via=${TOKIWA_VIA:-cli} actor=${TOKIWA_ACTOR:-}
 [[ $via =~ ^(cli|mcp|app)$ ]] || via=unknown
 # The caller names itself, for example an orchestrator's session; a malformed name is left out.
 valid_actor "$actor" || actor=
 # $4 is the earlier driver that a claim replaced, and $5 the id of the pending item that an answer named.
 python3 - "$state/audit.log" "$1" "$name" "${2:-}" "$via" "${3:-}" "$actor" "${4:-}" "${5:-}" <<'PY_AUDIT' || printf 'The action was not logged.\n' >&2
import json, os, sys, time
path, action, name, identity, via, run, actor, replaced, pending = sys.argv[1:10]
os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
entry = {'at': int(time.time()), 'action': action, 'name': name, 'identity': identity, 'via': via}
if run:
    entry['run'] = run == '1'
if actor:
    entry['actor'] = actor
if replaced:
    entry['replaced'] = replaced
if pending:
    entry['pending'] = pending
with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), 'a') as f:
    f.write(json.dumps(entry) + '\n')
PY_AUDIT
}
mode=${1:-shell}
name=${2:-}
extra=${3:-}
[[ $# -le 3 || ( ( $mode == capture || $mode == agent-read ) && $# -le 6 ) || ( ( $mode == agent-wait || $mode == end || $mode == claim ) && $# -le 4 ) || ( ( $mode == agent-answer || $mode == agent-relaunch ) && $# -le 5 ) ]] || fail 'Too many arguments.'
case "$mode" in
 new|attach|view|ensure|project|end|create|rename|capture|interrupt|freeze|resume|state|claim|release|agent-state|agent-wait|agent-send|agent-read|agent-answer|agent-relaunch) valid_name "$name" || fail 'Use a session name of 1 to 48 letters, digits, hyphens or underscores. Start with a letter or digit.' ;;
 name) [[ -z $name ]] || valid_prompt_name "$name" || fail 'Use a name of 1 to 24 letters, digits, hyphens or underscores. Start with a letter or digit.' ;;
 relabel|forget-project) [[ $name =~ ^[A-Za-z0-9+/=]+$ && ${#name} -le 2000 && -z $extra ]] || fail 'The project move is invalid.' ;;
 health|shell|sessions|status|snapshot|secrets|audit|digest) [[ -z $name ]] || fail 'This command does not accept a session name.' ;;
 secret|secret-remove) valid_secret "$name" || fail 'Use a secret name of letters, digits and underscores. PATH, HOME, SHELL, USER, LOGNAME, PWD, BROWSER, PS1 and names that start with TOKIWA_ or TMUX are refused.' ;;
 *) fail 'Unknown terminal command.' ;;
esac
[[ $mode == new || $mode == project || $mode == end || $mode == attach || $mode == create || $mode == rename || $mode == capture || $mode == view || $mode == interrupt || $mode == freeze || $mode == resume || $mode == state || $mode == claim || $mode == release || $mode == agent-state || $mode == agent-wait || $mode == agent-send || $mode == agent-read || $mode == agent-answer || $mode == agent-relaunch || -z $extra ]] || fail 'Too many arguments.'
if [[ $mode == new && -n $extra ]]; then valid_name "$extra" || fail 'The source session name is invalid.'; fi
if [[ $mode == health ]]; then
 exec python3 "$(dirname "$0")/workbench-health.py"
fi
if [[ $mode == audit ]]; then
 [[ ! -r $state/audit.log ]] || tail -n 50 "$state/audit.log"
 exit
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
if [[ $mode == end || $mode == capture || $mode == view || $mode == interrupt || $mode == freeze || $mode == resume || $mode == state || $mode == claim || $mode == release || $mode == agent-state || $mode == agent-wait || $mode == agent-send || $mode == agent-read || $mode == agent-answer || ( $mode == attach && $# -eq 3 ) ]]; then
 [[ $extra =~ ^[0-9]+:\$[0-9]+:[0-9]+$ ]] || fail 'The session identity is invalid. Refresh the session list.'
fi
if [[ $mode == end ]]; then
 [[ $# -le 3 || $4 == check-clients ]] || fail 'The only extra argument of end is check-clients.'
fi
if [[ $mode == claim ]]; then
 [[ $# -le 3 || $4 == replace ]] || fail 'The only extra argument of claim is replace.'
fi
if [[ $mode == claim || $mode == release ]]; then
 valid_actor "${TOKIWA_ACTOR:-}" || fail "Set TOKIWA_ACTOR to the name of the caller: 1 to 64 letters, digits, dots, colons, hyphens or underscores. Nothing was changed."
fi
if [[ $mode == agent-send ]]; then
 valid_actor "${TOKIWA_ACTOR:-}" || fail "Set TOKIWA_ACTOR to the name of the caller: 1 to 64 letters, digits, dots, colons, hyphens or underscores. Nothing was sent."
fi
if [[ $mode == agent-answer ]]; then
 valid_actor "${TOKIWA_ACTOR:-}" || fail "Set TOKIWA_ACTOR to the name of the caller: 1 to 64 letters, digits, dots, colons, hyphens or underscores. Nothing was sent."
 pending_id=${4:-}
 choice=${5:-}
 [[ $pending_id =~ ^[A-Za-z0-9_.:-]{1,128}$ ]] || fail 'Use the id of the pending item. Nothing was sent.'
 [[ $choice =~ ^([1-9]|text)$ ]] || fail 'Use a choice from 1 to 9, or text. Nothing was sent.'
fi
if [[ $mode == agent-wait ]]; then
 after=${4:-}
 [[ $after =~ ^[0-9]{1,9}$ ]] || fail 'Use a turn number: the turn count that the caller last saw.'
fi
if [[ $mode == capture ]]; then
 lines=${4:-}
 recipient=${5:-}
 [[ $lines =~ ^[0-9]{1,3}$ ]] && (( lines >= 1 && lines <= 200 )) || fail 'Use a line count from 1 to 200.'
 # Run Command keeps its output in the account, so screen text leaves this host only encrypted.
 [[ $recipient =~ ^[A-Za-z0-9+/=]+$ && ${#recipient} -le 4000 ]] || fail 'A capture needs a recipient certificate. Nothing was read.'
 # A search term, base64: the capture then reads the whole scrollback for the lines that hold it.
 query=${6:-}
 [[ -z $query || ( $query =~ ^[A-Za-z0-9+/=]+$ && ${#query} -le 400 ) ]] || fail 'Use a search term of 1 to 200 printable characters.'
fi
# -N prevents a failed connection from creating an unprotected server.
tm show-options -s exit-empty >/dev/null 2>&1 || fail 'The workbench service is unavailable. No service was started. Run tokiwa status.'
# A new shell shows the configured name in its prompt, for example `tokiwa:workbench$`.
prompt_name() {
 local value
 value=$(tm show-options -gqv @tokiwa_name 2>/dev/null || true)
 valid_prompt_name "$value" && printf '%s' "$value" || printf 'tokiwa'
}
# Start session $1 in directory $2 with a plain shell. tokiwa-bashrc sets the session cache
# from TOKIWA_SESSION and TOKIWA_CACHE_ROOT.
start_shell() {
 local cache_args=("TOKIWA_SESSION=$1") cache_root=${TOKIWA_CACHE_ROOT:-} cache_file=${TOKIWA_CACHE_ROOT_FILE:-/etc/tokiwa/cache-root}
 # The root comes from the environment of the helper, else from the first line of the root file.
 [[ -n $cache_root || ! -r $cache_file ]] || IFS= read -r cache_root <"$cache_file" || [[ -n $cache_root ]] || true
 [[ -z $cache_root ]] || cache_args+=("TOKIWA_CACHE_ROOT=$cache_root")
 [[ -z ${TOKIWA_CACHE_MIN_FREE:-} ]] || cache_args+=("TOKIWA_CACHE_MIN_FREE=$TOKIWA_CACHE_MIN_FREE")
 tm new-session -d -s "$1" -c "$2" env "TOKIWA_BROWSER=$browser" "TOKIWA_PS1=$(prompt_name):\\W\\$ " "${cache_args[@]}" /bin/bash --noprofile --rcfile "$(dirname "$0")/tokiwa-bashrc" \; set-option @tokiwa_session 1
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
# Tokiwa has two layers. The core layer is sessions, their lifecycle, status and the driver. The agent
# layer is what depends on Claude Code or Codex: hooks, turns, questions and the screen check. Core
# never calls agent code. Python for each mode is one program; a program runs after the libraries
# that it needs, as `python3 -c "$session_lib"$'\n'"$program"`.

if [[ $mode == agent-read ]]; then
 cursor=${4:-} flags=${5:-} recipient=${6:-}
 [[ $cursor =~ ^(-|[0-9a-f]{12}:[0-9]{1,12})$ ]] || fail 'The cursor is invalid. Use the cursor of an earlier read, or none. Nothing was read.'
 [[ $flags =~ ^(-|(tools|pending)(,(tools|pending))?)$ ]] || fail 'The flags are invalid. Use tools, pending or both. Nothing was read.'
 # Like a capture, a read leaves the host only encrypted.
 [[ $recipient =~ ^[A-Za-z0-9+/=]+$ && ${#recipient} -le 4000 ]] || fail 'A read needs a recipient certificate. Nothing was read.'
fi
# --- Core layer ---------------------------------------------------------------------------------
# Python that every read mode shares: the tmux call, the clients of a session and its facts.
# The Python functions for later modes live here too: `client_counts` and `writable_clients`.
read -r -d '' session_lib <<'PY_SESSION_LIB' || true
import base64
import binascii
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
import unicodedata

socket = sys.argv[1]
# The longest message text, in bytes of UTF-8.
MAX_MESSAGE_BYTES = 16384
AGENTS = ('claude', 'codex')
SHELLS = ('bash', 'sh', 'zsh', 'fish')
# The sealed output must fit the 24,000 characters that Run Command returns: base64 adds a third.
LIMIT_BYTES = 15000

def tmux(*args):
    # -u: without it, tmux replaces non-ASCII text for a client without a UTF-8 locale.
    return subprocess.run(['tmux', '-N', '-u', '-S', socket, *args], capture_output=True,
                          encoding='utf-8', errors='replace', timeout=10)

def client_counts(name, identity):
    """(all clients, writable clients) of the session that `identity` names.

    A writable client has #{client_readonly} 0. The session id of each row decides which clients
    count, so a session that took over the name has none of these clients.
    """
    session_id = identity.split(':')[1]
    listed = tmux('list-clients', '-t', '=' + name, '-F', '#{session_id}\t#{client_readonly}')
    if listed.returncode:
        return 0, 0
    flags = [line.split('\t')[1] for line in listed.stdout.splitlines()
             if line.count('\t') == 1 and line.split('\t')[0] == session_id]
    return len(flags), sum(1 for flag in flags if flag == '0')

def writable_clients(name, identity):
    """The clients of the session `identity` that can type into it."""
    return client_counts(name, identity)[1]

def read_session(name, identity, extra=()):
    """Read session `name` in one tmux call, so that its fields agree.

    `extra` lists more tmux formats, for example options. Returns (facts, pane, dead, values): the
    facts of the core record, the active pane and whether it is dead, and the values of `extra`.
    The pane is None unless the session is live.
    """
    facts = {'name': name, 'identity': identity, 'session': 'gone', 'program': None, 'clients': 0,
             'writable_clients': 0, 'driver': None, 'sampled_at': int(time.time())}
    # Without this check, display-message falls back to another session when the name is missing.
    if tmux('has-session', '-t', '=' + name).returncode:
        return facts, None, None, []
    formats = ['#{pid}:#{session_id}:#{session_created}', '#{pane_id}', '#{pane_dead}', '#{session_attached}',
               '#{pane_current_command}', '#{@tokiwa_driver}', *extra]
    fields = tmux('display-message', '-p', '-t', '=' + name + ':', '\t'.join(formats))
    if fields.returncode:
        return facts, None, None, []
    current, pane, dead, clients, command, driver, *values = fields.stdout.rstrip('\n').split('\t', len(formats) - 1)
    if current != identity:
        # Another session holds the name. Nothing of it is shown.
        facts['session'] = 'replaced'
        return facts, None, None, []
    facts.update(session='live', clients=int(clients), writable_clients=writable_clients(name, identity),
                 driver=driver or None,
                 program=command if command in AGENTS else 'shell' if command in SHELLS else 'other')
    return facts, pane, dead, values

def text_refusal(text):
    """The sentence that refuses message `text`, or None. The rules of every delivery."""
    if not text.strip():
        return 'The message is empty. Nothing was sent.'
    if len(text.encode('utf-8')) > MAX_MESSAGE_BYTES:
        return f'The message is over {MAX_MESSAGE_BYTES} bytes. Nothing was sent.'
    if any(unicodedata.category(c) == 'Cc' and c not in '\n\t' for c in text):
        return 'The message has a control character. Nothing was sent.'
    return None

def read_message():
    """The message text on stdin, or the exit of the program with the sentence that refuses it."""
    data = sys.stdin.buffer.read(MAX_MESSAGE_BYTES + 1)
    if len(data) > MAX_MESSAGE_BYTES:
        sys.exit(f'The message is over {MAX_MESSAGE_BYTES} bytes. Nothing was sent.')
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        sys.exit('The message is not UTF-8 text. Nothing was sent.')

def seal(output, recipient, what):
    """`output` as JSON, encrypted to the one-time certificate in base64 `recipient`, as base64 DER.

    Run Command keeps its output in the account, so text that leaves this host leaves it only
    sealed. The program exits with a sentence that names `what` when the sealing fails.
    """
    failure = f'The {what} could not be encrypted. Nothing was read.'
    try:
        certificate = base64.b64decode(recipient, validate=True)
    except binascii.Error:
        sys.exit(failure)
    sealed = None
    try:
        with tempfile.NamedTemporaryFile(suffix='.pem') as pem:
            pem.write(certificate)
            pem.flush()
            sealed = subprocess.run(['openssl', 'smime', '-encrypt', '-aes256', '-binary', '-outform', 'DER', pem.name],
                                    input=json.dumps(output, ensure_ascii=False).encode('utf-8', 'replace'), capture_output=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        pass
    if sealed is None or sealed.returncode or not sealed.stdout:
        sys.exit(failure)
    return base64.b64encode(sealed.stdout).decode()

def stage_delivery(name, identity, payload, extra=(), check=None):
    """Check session `name` and put `payload` in a tmux buffer. Return (pane, clients, buffer, values).

    A `payload` of None loads no buffer, for a delivery of keys: `buffer` is then `-`.

    The checks here only refuse early with a clear sentence. The shell function `deliver` repeats
    each of them inside the tmux command queue that pastes, which is what makes them hold.
    `clients` is the number of clients that this call counted; the paste goes only while it is the
    number then attached. `check(facts, pane, values)` is the layer's own check: it returns a
    sentence, or None. `extra` lists the tmux formats whose values `check` and the caller read.
    The program exits with the sentence on a refusal.
    """
    # The clients are read before the session, so that a client that attaches in between is counted
    # by the tmux condition and not missed.
    total, writable = client_counts(name, identity)
    # A pane in a mode such as copy mode, or with its input off, would not take a bracketed paste.
    facts, pane, dead, values = read_session(name, identity, ('#{pane_in_mode}', '#{pane_input_off}', *extra))
    if facts['session'] == 'gone':
        sys.exit('The selected session no longer exists. Nothing was sent.')
    if facts['session'] == 'replaced':
        sys.exit('Session identity changed. Nothing was sent.')
    if dead == '1':
        sys.exit('The pane has ended. Nothing was sent.')
    in_mode, input_off, *values = values
    if in_mode != '0':
        sys.exit('The pane is in copy mode. Nothing was sent.')
    if input_off != '0':
        sys.exit('The pane does not take input. Nothing was sent.')
    if writable:
        sys.exit('A client is attached. Nothing was sent.')
    if facts['driver'] != os.environ.get('TOKIWA_ACTOR'):
        sys.exit('Only the driver can send. Claim the session first. Nothing was sent.')
    problem = check(facts, pane, values) if check else None
    if problem:
        sys.exit(problem)
    if payload is None:
        return pane, total, '-', values
    buffer = 'tokiwa-send-' + secrets.token_hex(6)
    # The text reaches tmux on stdin only. It is never an argument of a process.
    loaded = subprocess.run(['tmux', '-N', '-S', socket, 'load-buffer', '-b', buffer, '-'],
                            input=payload.encode('utf-8'), capture_output=True, timeout=10)
    if loaded.returncode:
        sys.exit('The message could not be loaded. Nothing was sent.')
    return pane, total, buffer, values
PY_SESSION_LIB
# `state`: the facts of a session, with no agent field and no screen read.
read -r -d '' state_program <<'PY_STATE' || true
print(json.dumps(read_session(sys.argv[2], sys.argv[3])[0]))
PY_STATE
# The core stage of a delivery: the text on stdin, as it is. Prints `PANE CLIENTS BUFFER`.
read -r -d '' core_stage_program <<'PY_CORE_STAGE' || true
text = read_message()
problem = text_refusal(text)
if problem:
    sys.exit(problem)
print(*stage_delivery(sys.argv[2], sys.argv[3], text)[:3])
PY_CORE_STAGE
# `end`: the clients of the session, as `ALL WRITABLE`.
read -r -d '' client_counts_program <<'PY_CLIENT_COUNTS' || true
print(*client_counts(sys.argv[2], sys.argv[3]))
PY_CLIENT_COUNTS

# `capture`: the last lines of the active pane, or the lines that hold a search term, sealed.
read -r -d '' capture_program <<'PY_CAPTURE' || true
socket, name, identity, limit, recipient, query = sys.argv[1:7]
# Lines of context on each side of a line that holds the search term.
CONTEXT = 2

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
if query:
    try:
        query = base64.b64decode(query, validate=True).decode('utf-8')
    except (binascii.Error, UnicodeDecodeError):
        query = ''
    if not 1 <= len(query) <= 200 or any(ord(c) < 32 or ord(c) == 127 for c in query):
        raise SystemExit('Use a search term of 1 to 200 printable characters.')
# A pane ID is never reused on a server, so this reads the session that the check saw.
screen = tmux('capture-pane', '-p', '-J', '-S', '-' if query else '-200', '-t', pane)
if screen.returncode:
    raise SystemExit('The selected session no longer exists.')
rows = [row.rstrip() for row in screen.stdout.splitlines()]
rows = [row for row in rows if row]
found = 0
if query:
    # The latest matches, each with its context; blocks that touch are joined.
    hits = [i for i, row in enumerate(rows) if query.lower() in row.lower()][-int(limit):]
    found = len(hits)
    blocks = []
    for i in hits:
        start, end = max(0, i - CONTEXT), min(len(rows), i + CONTEXT + 1)
        if blocks and start <= blocks[-1][1]:
            blocks[-1][1] = end
        else:
            blocks.append([start, end])
    text = '\n--\n'.join('\n'.join(rows[start:end]) for start, end in blocks)
else:
    text = '\n'.join(rows[-int(limit):])
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
if query:
    output.update(query=query, matches=found)
print(seal(output, recipient, 'capture'))
PY_CAPTURE

# --- Agent layer --------------------------------------------------------------------------------
# Python for the modes `agent-state` and `agent-wait`: the screen check and the agent fields.
read -r -d '' agent_lib <<'PY_AGENT_LIB' || true
# Regular expressions that mark a dialog on the screen, for each agent. A dialog that no hook
# reported, for example a folder trust prompt, shows only here. Task 9 checks these against live
# screens; until then they are the expected shapes, not verified ones.
DIALOG_MARKERS = {
    'claude': [r'Enter to confirm', r'Esc to cancel', r'^\s*❯\s*\d+\.\s', r'Do you want to'],
    'codex': [r'Press enter to confirm', r'^\s*›\s*\d+\.\s', r'Allow command\?'],
}
# The screen check reads this many lines from the bottom of the pane.
SCREEN_LINES = 15

def screen_dialog(pane_id, program):
    """True when the last SCREEN_LINES lines of the pane hold a dialog marker of `program`.

    A dialog that no hook reported waits for a person. The check never decides that a turn is done.
    """
    markers = DIALOG_MARKERS.get(program)
    if not markers:
        return False
    screen = tmux('capture-pane', '-p', '-J', '-t', pane_id)
    if screen.returncode:
        return False
    # The pane shows blank rows below the text; the last lines are the last rows that hold text.
    rows = [row.rstrip() for row in screen.stdout.splitlines()]
    while rows and not rows[-1]:
        rows.pop()
    return any(re.search(marker, row) for row in rows[-SCREEN_LINES:] for marker in markers)

def pending_item(value):
    """The `id`, `kind` and `at` of an @tokiwa_agent_pending value. Its text stays on the host."""
    try:
        item = json.loads(base64.b64decode(value, validate=True))
        return {key: item[key] for key in ('id', 'kind', 'at')}
    except (binascii.Error, ValueError, KeyError, TypeError):
        # An item that cannot be read still waits for a person, so it is not hidden.
        return {'id': None, 'kind': None, 'at': None}

def agent_state_record(name, identity):
    """The core facts of the session, and what its agent reports."""
    record, pane, dead, values = read_session(
        name, identity, ('#{@tokiwa_agent}', '#{@tokiwa_agent_turn}', '#{@tokiwa_agent_pending}'))
    record.update(agent='none', agent_at=None, turn=None, pending=None, dialog=False)
    if pane is None:
        return record
    agent, turn, pending = values
    state, _, at = agent.partition(':')
    # str.isdigit() alone also accepts digits such as '²', which int() refuses.
    turn_ok, at_ok = turn.isascii() and turn.isdigit(), at.isascii() and at.isdigit()
    record.update(turn=int(turn) if turn_ok else 0, pending=pending_item(pending) if pending else None)
    if record['program'] in AGENTS and dead != '1':
        # An agent that has reported nothing yet is `unknown`, which no caller treats as idle.
        record.update(agent=state if at_ok else 'unknown', agent_at=int(at) if at_ok else None,
                      dialog=screen_dialog(pane, record['program']))
    return record
PY_AGENT_LIB
read -r -d '' agent_state_program <<'PY_AGENT_STATE' || true
print(json.dumps(agent_state_record(sys.argv[2], sys.argv[3])))
PY_AGENT_STATE
# `agent-read`: the events of the transcript that the agent's hooks name, sealed to the caller.
# The transcript is a file that the agent writes, so every line is untrusted data: the read is
# bounded, a link is refused, and a line that cannot be read becomes a notice, never an error.
read -r -d '' agent_read_program <<'PY_AGENT_READ' || true
import hashlib
import stat
from datetime import datetime

name, identity, cursor, flags, recipient = sys.argv[2:7]
flags = set(flags.split(','))
# The longest line that is read as JSON, the bytes read in one call, and how far a longer line is skipped.
MAX_LINE = 1 << 20
READ_BUDGET = 4 << 20
SKIP_LIMIT = 64 << 20
# The longest text of one event, in characters.
MAX_TEXT = 2000
UNREADABLE = 'unreadable line'
CODEX_CONTEXT = ('# AGENTS.md instructions', '<environment_context>', '<user_instructions>')

def refuse(reason):
    sys.exit(f'{reason} Nothing was read.')

def clip(value, limit=MAX_TEXT):
    # JSON accepts a lone surrogate, which UTF-8 cannot hold: it becomes `?` before any size check or seal.
    value = value.encode('utf-8', 'replace').decode('utf-8')
    return value if len(value) <= limit else value[:limit - 1] + '…'

def json_size(value):
    return len(json.dumps(value, ensure_ascii=False).encode('utf-8'))

def text_of(value):
    return value if isinstance(value, str) else ''

def dict_of(value):
    return value if isinstance(value, dict) else {}

def flat(value):
    """The text of a tool result: a string, or the text blocks of a list."""
    if isinstance(value, list):
        return '\n'.join(text_of(dict_of(block).get('text')) for block in value)
    return text_of(value)

def epoch(value):
    """Seconds since the epoch of an ISO time with a zone, or None."""
    try:
        moment = datetime.fromisoformat(value[:-1] + '+00:00' if value.endswith('Z') else value)
        return int(moment.timestamp()) if moment.tzinfo else None
    except (AttributeError, ValueError, OverflowError, OSError):
        return None

def event(at, kind, text, tool=None, error=False):
    return {'at': at, 'kind': kind, 'text': clip(text), 'tool': clip(tool, 80) if tool else None, 'error': error}

def message_events(at, kind, text):
    return [event(at, kind, text)] if text.strip() else []

def claude_events(record, tools, calls):
    """The events of a Claude Code line. `calls` maps a tool call id to its tool, for the result."""
    kind, at = record.get('type'), epoch(record.get('timestamp'))
    if kind == 'system':
        return message_events(at, 'notice', text_of(record.get('content')))
    if kind not in ('user', 'assistant') or record.get('isMeta'):
        return []
    content = dict_of(record.get('message')).get('content')
    if isinstance(content, str):
        return message_events(at, kind, content)
    events = []
    for block in content if isinstance(content, list) else []:
        block = dict_of(block)
        shape = block.get('type')
        if shape == 'text':
            events += message_events(at, kind, text_of(block.get('text')))
        elif shape == 'tool_use':
            tool = text_of(block.get('name')) or None
            calls[text_of(block.get('id'))] = tool
            events.append(event(at, 'tool_call', json.dumps(block.get('input'), ensure_ascii=False) if tools else '', tool))
        elif shape == 'tool_result':
            events.append(event(at, 'tool_result', flat(block.get('content')) if tools else '',
                                calls.get(text_of(block.get('tool_use_id'))), block.get('is_error') is True))
        # Thinking and every other block stay out.
    return events

def codex_events(record, tools, calls):
    """The events of a Codex line, in the same shape as the events of a Claude Code line."""
    kind, at, payload = record.get('type'), epoch(record.get('timestamp')), dict_of(record.get('payload'))
    shape = payload.get('type')
    if kind == 'event_msg':
        return message_events(at, 'notice', text_of(payload.get('message'))) if shape == 'error' else []
    if shape == 'message' and payload.get('role') in ('user', 'assistant'):
        blocks = payload.get('content')
        texts = [text_of(dict_of(block).get('text')) for block in blocks] if isinstance(blocks, list) else []
        # Codex writes the AGENTS.md files and the environment of a session as user messages; nobody typed them.
        texts = [t for t in texts if not t.lstrip().startswith(CODEX_CONTEXT)]
        return message_events(at, payload['role'], '\n'.join(texts))
    if shape in ('function_call', 'custom_tool_call'):
        tool = text_of(payload.get('name')) or None
        calls[text_of(payload.get('call_id'))] = tool
        return [event(at, 'tool_call', text_of(payload.get('arguments') or payload.get('input')) if tools else '', tool)]
    if shape in ('function_call_output', 'custom_tool_call_output'):
        return [event(at, 'tool_result', flat(payload.get('output')) if tools else '',
                      calls.get(text_of(payload.get('call_id'))), payload.get('success') is False)]
    # Reasoning, token counts and every other record stay out.
    return []

def line_events(line, tools, calls):
    """The events of one transcript line. A line that is not a JSON object becomes a notice."""
    if not line.strip():
        return []
    try:
        record = json.loads(line.decode('utf-8', errors='replace'))
    except (ValueError, RecursionError):
        return [event(None, 'notice', UNREADABLE)]
    if not isinstance(record, dict):
        return [event(None, 'notice', UNREADABLE)]
    reader = codex_events if record.get('type') in ('response_item', 'event_msg') else claude_events
    return reader(record, tools, calls)

def skip_line(file):
    """Skip to the end of the line that is under way. Return (bytes skipped, whether the line ended)."""
    skipped = 0
    while skipped < SKIP_LIMIT:
        chunk = file.readline(65536)
        if not chunk:
            return skipped, False
        skipped += len(chunk)
        if chunk.endswith(b'\n'):
            return skipped, True
    # A line this long is cut here, so that the cursor moves on.
    return skipped, True

def pending_summary(value):
    """The item of an @tokiwa_agent_pending value, with its text."""
    try:
        item = dict_of(json.loads(base64.b64decode(value, validate=True)))
    except (binascii.Error, ValueError, RecursionError):
        item = {}
    options = item.get('options')
    summary = {'id': clip(text_of(item.get('id')), 200) or None, 'kind': clip(text_of(item.get('kind')), 80) or None,
               'summary': clip(text_of(item.get('summary'))),
               'options': [clip(text_of(o), 200) for o in options[:20]] if isinstance(options, list) else [],
               'at': item.get('at') if isinstance(item.get('at'), int) else None}
    # Fit LIMIT_BYTES: the options go from the end first, then the summary is halved.
    while json_size({'pending': summary}) > LIMIT_BYTES and summary['options']:
        summary['options'].pop()
    while json_size({'pending': summary}) > LIMIT_BYTES and summary['summary']:
        summary['summary'] = summary['summary'][:len(summary['summary']) // 2]
    return summary

def open_transcript(path):
    """Open the transcript read only. Return (file, size). Only a regular file of this user is read."""
    if not (path.startswith('/') and path.endswith('.jsonl')):
        refuse('The transcript path is not an absolute path of a .jsonl file.')
    try:
        # O_NOFOLLOW refuses a link; O_NONBLOCK keeps a pipe from holding the open.
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError:
        refuse('The transcript cannot be opened. It may be missing or a link.')
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
        os.close(descriptor)
        refuse('The transcript is not a regular file of this user.')
    return os.fdopen(descriptor, 'rb'), info.st_size

facts, pane, dead, values = read_session(name, identity, ('#{@tokiwa_agent_pending}', '#{@tokiwa_agent_transcript}'))
if facts['session'] == 'gone':
    refuse('The selected session no longer exists.')
if facts['session'] == 'replaced':
    refuse('Session identity changed.')
pending, path = values
if 'pending' in flags:
    print(seal({'pending': pending_summary(pending) if pending else None}, recipient, 'read'))
    sys.exit()
if not path:
    refuse('No transcript is known for this session yet. Use capture to read its screen.')
file, size = open_transcript(path)
digest = hashlib.sha256(path.encode()).hexdigest()[:12]
offset, changed = 0, False
if cursor != '-':
    seen, _, seen_offset = cursor.partition(':')
    # Another file, or a file that is now shorter, starts again at its first line.
    if seen == digest and int(seen_offset) <= size:
        offset = int(seen_offset)
    else:
        changed = True
tools = 'tools' in flags
# The JSON of an empty page, with the longest cursor, is the room that every page needs.
used = len(json.dumps({'events': [], 'cursor': digest + ':' + '9' * 12, 'more': False, 'transcript_changed': False}).encode())
events, calls, consumed, more = [], {}, 0, False
file.seek(offset)
while True:
    if consumed >= READ_BUDGET:
        more = True
        break
    line = file.readline(MAX_LINE + 1)
    if not line:
        break
    length = len(line)
    if line.endswith(b'\n'):
        found = line_events(line, tools, calls)
    elif length <= MAX_LINE:
        # The last line has no end yet: the agent is still writing it. It waits for the next read.
        break
    else:
        skipped, ended = skip_line(file)
        if not ended:
            break
        length += skipped
        found = [event(None, 'notice', 'line too long')]
    sizes = [json_size(e) + 2 for e in found]
    if events and used + sum(sizes) > LIMIT_BYTES:
        more = True
        break
    # The first line of a page is always consumed, so that a page makes progress: it keeps the events that fit.
    for e, room in zip(found, sizes):
        if used + room > LIMIT_BYTES:
            break
        events.append(e)
        used += room
    consumed += length
file.close()
print(seal({'events': events, 'cursor': f'{digest}:{offset + consumed}', 'more': more, 'transcript_changed': changed},
           recipient, 'read'))
PY_AGENT_READ
# Poll until the agent needs the caller: a turn ended, an item is pending, a dialog shows, or the
# agent is gone. Else return `timeout` after TOKIWA_WAIT_SECONDS (default 20); the launcher repeats.
read -r -d '' agent_wait_program <<'PY_AGENT_WAIT' || true
import os
try:
    limit = float(os.environ.get('TOKIWA_WAIT_SECONDS', '20'))
except ValueError:
    limit = 20.0
after = int(sys.argv[4])
# The agent states in which a turn is over.
DONE = ('idle', 'limited', 'error')

def reason(record):
    # `none` is also the state of a pane whose program has ended, so a dead pane is `ended` too.
    if record['session'] != 'live' or record['agent'] == 'none':
        return 'ended'
    if record['turn'] > after and record['agent'] in DONE:
        return 'turn-ended'
    if record['pending']:
        return 'pending'
    if record['dialog']:
        return 'dialog'
    return None

deadline = time.monotonic() + limit
while True:
    record = agent_state_record(sys.argv[2], sys.argv[3])
    found = reason(record)
    if found or time.monotonic() >= deadline:
        break
    time.sleep(0.5)
print(json.dumps(dict(record, reason=found or 'timeout')))
PY_AGENT_WAIT
# The agent stage of a delivery. The fixed first line tells the agent that the text is not from the
# owner. Prints `PANE CLIENTS BUFFER TURN`; TURN is `-` when the agent has reported no turn.
read -r -d '' agent_send_program <<'PY_AGENT_SEND' || true
actor = os.environ['TOKIWA_ACTOR']
LABEL = f'[Message from agent {actor} through Tokiwa. It is not from the owner and carries no owner approval.]'
text = read_message()
problem = text_refusal(text)
# After any leading white space, a / ! or # would make the agent read the line as a command, not as text.
if not problem and text.lstrip()[:1] in ('/', '!', '#'):
    problem = 'The message starts with /, ! or #. Nothing was sent.'
if problem:
    sys.exit(problem)

def check(facts, pane, values):
    """The sentence that refuses the session, or None when its agent is ready for a message."""
    agent, turn, pending = values
    if facts['program'] not in AGENTS:
        return 'The pane does not run an agent. Nothing was sent.'
    state, _, at = agent.partition(':')
    # An agent that has reported nothing yet is `unknown`: no caller treats it as idle.
    if state not in ('idle', 'limited', 'error') or not (at.isascii() and at.isdigit()):
        return 'The agent is not idle. Nothing was sent.'
    if pending:
        return 'An item waits for a person. Nothing was sent.'
    if screen_dialog(pane, facts['program']):
        return 'A dialog is on the screen. Nothing was sent.'
    return None

pane, clients, buffer, values = stage_delivery(
    sys.argv[2], sys.argv[3], LABEL + '\n' + text,
    ('#{@tokiwa_agent}', '#{@tokiwa_agent_turn}', '#{@tokiwa_agent_pending}'), check)
turn = values[1]
print(pane, clients, buffer, turn if turn.isascii() and turn.isdigit() else '-')
PY_AGENT_SEND
# The relaunch of a Claude Code session: the shared part of its two programs below. A relaunch stops the
# agent with /exit and types `claude --resume ID --settings PATH` into the shell of the same pane, so that
# the tmux session, its pane, its folder and the conversation stay. It decides nothing about the settings.
read -r -d '' relaunch_lib <<'PY_RELAUNCH_LIB' || true
import hashlib
import shlex
import stat

# A settings path is one absolute path of these characters, so that it needs no quoting in the typed line
# and reads the same in the process list.
SETTINGS_PATH = re.compile(r'/[A-Za-z0-9._/-]{1,1000}')
MAX_SETTINGS_BYTES = 1 << 20
SESSION_ID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')

def settings_digest(path):
    """(sha256, None) of the settings file at `path`, or (None, the sentence that refuses it)."""
    if not SETTINGS_PATH.fullmatch(path) or '/../' in path + '/' or '/./' in path + '/':
        return None, 'Use an absolute settings path of letters, digits, dots, hyphens, underscores and slashes.'
    try:
        # A link could change its target between this check and the start of the agent.
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode):
            return None, 'The settings path is not a regular file.'
        if info.st_size > MAX_SETTINGS_BYTES:
            return None, 'The settings file is over 1 MiB.'
        with open(path, 'rb') as f:
            data = f.read(MAX_SETTINGS_BYTES + 1)
    except OSError:
        return None, 'The settings file cannot be read.'
    try:
        # Claude Code shows a dialog for a file that is not valid JSON, and one of its choices starts the
        # agent without the file. So a file that is not a JSON object stops here.
        if not isinstance(json.loads(data), dict):
            raise ValueError
    except ValueError:
        return None, 'The settings file is not a JSON object.'
    return hashlib.sha256(data).hexdigest(), None

def descendants(root):
    """The processes below pid `root`, with the root, as {pid: ppid}."""
    listed = subprocess.run(['ps', '-A', '-o', 'pid=,ppid='], capture_output=True, text=True, timeout=10)
    children = {}
    for line in listed.stdout.splitlines():
        fields = line.split()
        if len(fields) == 2:
            children.setdefault(fields[1], []).append(fields[0])
    found, todo = [], [str(root)]
    while todo:
        pid = todo.pop()
        found.append(pid)
        todo.extend(children.get(pid, []))
    return found

def arguments(pid):
    """The argument list of process `pid`, or None. /proc keeps the boundaries of the arguments; `ps`,
    where /proc is missing, splits them at spaces."""
    try:
        with open(f'/proc/{pid}/cmdline', 'rb') as f:
            return [a.decode('utf-8', 'replace') for a in f.read().split(b'\0') if a]
    except OSError:
        pass
    listed = subprocess.run(['ps', '-ww', '-o', 'args=', '-p', str(pid)], capture_output=True, text=True, timeout=10)
    return listed.stdout.split() or None

def agent_process(pane_pid):
    """(pid, arguments) of the one process below the pane's shell whose program is claude, or None."""
    found = []
    for pid in descendants(pane_pid)[1:]:
        args = arguments(pid)
        if args and os.path.basename(args[0]) == 'claude':
            found.append((pid, args))
    return found[0] if len(found) == 1 else None
PY_RELAUNCH_LIB
# The stage of a relaunch: the checks of a delivery, the agent checks of agent send, and the checks of
# the settings file and of the command that started the agent. Puts /exit in a buffer. Prints
# `PANE CLIENTS BUFFER TURN SESSION_ID SHA256 PID COMMAND`; COMMAND is the base64 of the new command line.
read -r -d '' agent_relaunch_program <<'PY_AGENT_RELAUNCH' || true
settings, expected = sys.argv[4], sys.argv[5]
# The options of the first command that the relaunch keeps, with a value or without one. The relaunch sets
# the session and the settings itself, so it drops those options and the first prompt. Any other option
# could change what the agent may do, so it stops the relaunch.
KEEP_VALUE = ('--model', '--permission-mode', '--effort', '--agent', '--fallback-model')
KEEP_FLAG = ('--verbose',)
DROP_VALUE = ('--settings', '--session-id')
DROP_OPTIONAL = ('-r', '--resume')
DROP_FLAG = ('-c', '--continue', '--fork-session')
VALUE = re.compile(r'[A-Za-z0-9._:/@+-]{1,200}')
found = {}

def kept_options(args):
    """The options of `args` (without the program) that the new command keeps, or a refusal sentence."""
    kept, i = [], 0
    while i < len(args):
        word = args[i]
        option, has_value, value = word.partition('=') if word.startswith('--') else (word, '', '')
        i += 1
        if not word.startswith('-'):
            continue
        if option in KEEP_FLAG and not has_value:
            kept.append(option)
        elif option in KEEP_VALUE + DROP_VALUE:
            if not has_value:
                if i >= len(args):
                    return f'The option {option} of the Claude command has no value. Nothing was changed.'
                value, i = args[i], i + 1
            if option in KEEP_VALUE:
                if not VALUE.fullmatch(value):
                    return f'The value of {option} in the Claude command cannot be kept. Nothing was changed.'
                kept += [option, value]
        elif option in DROP_OPTIONAL:
            if not has_value and i < len(args) and not args[i].startswith('-'):
                i += 1
        elif option not in DROP_FLAG or has_value:
            name = option if re.fullmatch(r'-{1,2}[A-Za-z0-9-]{1,40}', option) else 'an option'
            return f'The Claude command has {name}, which a relaunch does not keep. Nothing was changed.'
    return kept

def check(facts, pane, values):
    agent, turn, pending, session, frozen, pane_pid = values
    if facts['program'] != 'claude':
        return 'The pane does not run Claude Code. Only Claude Code can be relaunched. Nothing was changed.'
    state, _, at = agent.partition(':')
    if state not in ('idle', 'limited', 'error') or not (at.isascii() and at.isdigit()):
        return 'The agent is not idle. Nothing was changed.'
    if pending:
        return 'An item waits for a person. Nothing was changed.'
    if frozen:
        return 'The session is frozen. Nothing was changed.'
    if screen_dialog(pane, 'claude'):
        return 'A dialog is on the screen. Nothing was changed.'
    if not SESSION_ID.fullmatch(session):
        return 'The agent has not reported its session id. Nothing was changed.'
    listed = tmux('list-panes', '-s', '-t', '=' + facts['name'], '-F', '#{pane_id} #{pane_current_command}')
    agents = [line.split(' ', 1)[0] for line in listed.stdout.splitlines() if line.partition(' ')[2] in AGENTS]
    if listed.returncode or agents != [pane]:
        return 'Another pane of the session runs an agent. Nothing was changed.'
    digest, problem = settings_digest(settings)
    if problem:
        return problem + ' Nothing was changed.'
    if expected != '-' and digest != expected:
        return 'The settings file does not have the expected SHA-256. Nothing was changed.'
    process = agent_process(pane_pid)
    if process is None:
        return 'The Claude process of the pane cannot be found. Nothing was changed.'
    kept = kept_options(process[1][1:])
    if isinstance(kept, str):
        return kept
    found.update(digest=digest, pid=process[0],
                 command=' '.join(['claude', *map(shlex.quote, kept), '--resume', session, '--settings', settings]))
    return None

pane, clients, buffer, values = stage_delivery(
    sys.argv[2], sys.argv[3], '/exit',
    ('#{@tokiwa_agent}', '#{@tokiwa_agent_turn}', '#{@tokiwa_agent_pending}', '#{@tokiwa_agent_session}',
     '#{@tokiwa_frozen}', '#{pane_pid}'), check)
turn = values[1]
print(pane, clients, buffer, turn if turn.isascii() and turn.isdigit() else '-', values[3], found['digest'],
      found['pid'], base64.b64encode(found['command'].encode()).decode())
PY_AGENT_RELAUNCH
# Wait until the old agent of a relaunch has exited and the pane shows its shell. Prints `exited` or
# `running`. Arguments: NAME IDENTITY PID SECONDS.
read -r -d '' relaunch_exit_program <<'PY_RELAUNCH_EXIT' || true
pid, limit = sys.argv[4], float(sys.argv[5])
deadline = time.monotonic() + limit
while True:
    facts, pane, dead, values = read_session(sys.argv[2], sys.argv[3])
    gone = subprocess.run(['ps', '-o', 'pid=', '-p', pid], capture_output=True, text=True).stdout.strip() == ''
    if facts['session'] == 'live' and facts['program'] == 'shell' and gone:
        print('exited')
        break
    if time.monotonic() >= deadline:
        print('running')
        break
    time.sleep(0.2)
PY_RELAUNCH_EXIT
# Check that the relaunched agent started with the settings file: a Claude process below the pane's shell
# has `--resume ID --settings PATH` in its arguments, the agent's hooks reported a start of the same session
# after the relaunch, no dialog is on the screen, and the file still has the SHA-256 that the stage read.
# Arguments: NAME IDENTITY SESSION_ID SETTINGS SHA256 STARTED_AT SECONDS. Prints the result as JSON, or
# exits with the sentence of a failure.
read -r -d '' relaunch_verify_program <<'PY_RELAUNCH_VERIFY' || true
session, settings, digest, started, limit = sys.argv[4], sys.argv[5], sys.argv[6], int(sys.argv[7]), float(sys.argv[8])
begun = time.monotonic()
deadline = begun + limit
# Claude Code draws in the pane and not on a second screen, so the last lines of the old agent can stay
# until the new one draws. A dialog counts only when it stays on the screen this long.
DIALOG_SECONDS = 2
dialog_since = None
problem = None
while True:
    facts, pane, dead, values = read_session(
        sys.argv[2], sys.argv[3], ('#{@tokiwa_agent}', '#{@tokiwa_agent_session}', '#{pane_pid}'))
    if facts['session'] != 'live' or dead == '1':
        sys.exit('The session ended during the relaunch.')
    agent, reported, pane_pid = values
    state, _, at = agent.partition(':')
    process = agent_process(pane_pid)
    args = process[1] if process else []
    loaded = any(args[i:i + 2] == ['--settings', settings] for i in range(len(args)))
    resumed = any(args[i:i + 2] == ['--resume', session] for i in range(len(args)))
    dialog = facts['program'] == 'claude' and screen_dialog(pane, 'claude')
    dialog_since = (dialog_since or time.monotonic()) if dialog else None
    if dialog and time.monotonic() - dialog_since >= DIALOG_SECONDS:
        problem = 'Claude Code shows a dialog after the relaunch. The settings may not be in effect. Look at the session.'
    elif not dialog and process and loaded and resumed and state == 'idle' and at.isascii() and at.isdigit() \
            and int(at) >= started and reported == session:
        if settings_digest(settings)[0] != digest:
            sys.exit('The settings file changed during the relaunch. Relaunch again to use the current file.')
        print(json.dumps({'relaunched': True, 'session_id': session, 'pid': int(process[0]),
                          'settings': settings, 'sha256': digest, 'started_at': started}))
        sys.exit(0)
    elif facts['program'] == 'shell' and time.monotonic() > begun + 2:
        problem = 'Claude Code exited after the relaunch.'
    else:
        problem = None
    if problem or time.monotonic() >= deadline:
        sys.exit(problem or 'The relaunched agent did not report its start in time. Look at the session.')
    time.sleep(0.3)
PY_RELAUNCH_VERIFY
# The answer stage of a delivery: the digit of an option for the pending question PENDING_ID. A choice
# of `text` would type free text, whose key path is unknown (docs/agents.md), so it refuses after the text
# checks. Prints `PANE CLIENTS - PENDING LAST LABEL`: PENDING and LAST are the base64 values of @tokiwa_agent_pending
# and @tokiwa_agent_last_tool that were read, and LABEL is the base64 value of @tokiwa_agent_input.
# The question must be live: the agent is `waiting`, and the last tool call that started is the question itself.
read -r -d '' agent_answer_program <<'PY_AGENT_ANSWER' || true
actor = os.environ['TOKIWA_ACTOR']
pending_id, choice = sys.argv[4], sys.argv[5]
if choice == 'text':
    text = read_message()
    problem = text_refusal(text)
    if not problem and text.lstrip()[:1] in ('/', '!', '#'):
        problem = 'The message starts with /, ! or #. Nothing was sent.'
    sys.exit(problem or 'Free-text answers are not supported for this agent. Nothing was sent.')

def check(facts, pane, values):
    """The sentence that refuses the session, or None when it holds the question `pending_id`."""
    if facts['program'] not in AGENTS:
        return 'The pane does not run an agent. Nothing was sent.'
    if not values[0]:
        return 'No item waits for an answer. Nothing was sent.'
    try:
        item = json.loads(base64.b64decode(values[0], validate=True))
        kind, found, options = item['kind'], item['id'], item.get('options')
        tool, questions, multi = item.get('tool'), item.get('questions'), item.get('multi_select')
    except (binascii.Error, ValueError, KeyError, TypeError, RecursionError):
        return 'The pending item cannot be read. Nothing was sent.'
    # A permission item, also a sign-in page, has no answer path. Its only key is interrupt (Esc).
    if kind == 'permission':
        return 'A permission item has no answer path. Use interrupt to refuse it. Nothing was sent.'
    if kind != 'question':
        return 'The pending item is not a question. Nothing was sent.'
    if found != pending_id:
        return 'The pending item is not the one named. Nothing was sent.'
    # An interrupt or the end of the question leaves another state. The queue checks the same.
    if not values[1].startswith('waiting:'):
        return 'The agent is not waiting for an answer. Nothing was sent.'
    # A tool call that started after the question means that the question is no longer on the screen.
    try:
        last_id = json.loads(base64.b64decode(values[2], validate=True)).get('id')
    except (binascii.Error, ValueError, AttributeError, RecursionError):
        last_id = None
    if not last_id or last_id != pending_id:
        return 'The question is not the last tool call of the agent. Nothing was sent.'
    # Only the question tool of Claude Code adds the input label to the context of the worker, and only its
    # numbered dialog takes a digit. A form of an MCP server, or any item without options, has neither.
    if tool != 'AskUserQuestion' or not isinstance(options, list) or not options:
        return 'The pending item has no options to choose. Nothing was sent.'
    # One digit and Enter answer one single-select question. The keys of other shapes are not checked live.
    if questions != 1 or multi is not False:
        return 'The question has more than one part or allows several choices. Nothing was sent.'
    # A digit past the last option would reach the free-text entry of the dialog, not an option.
    if int(choice) > len(options):
        return 'The choice is not one of the options. Nothing was sent.'
    # A person who pressed Esc on the question leaves no hook event: the state and the item stay for about a
    # minute, and a digit would reach the idle prompt as an unlabelled message. The question must be on the screen.
    # DIALOG_MARKERS match any dialog of the agent, and the live check confirms them (docs/agents.md).
    if not screen_dialog(pane, facts['program']):
        return 'No question is on the screen. Nothing was sent.'
    return None

pane, clients, buffer, values = stage_delivery(
    sys.argv[2], sys.argv[3], None, ('#{@tokiwa_agent_pending}', '#{@tokiwa_agent}', '#{@tokiwa_agent_last_tool}'), check)
label = json.dumps({'actor': actor, 'pending_id': pending_id, 'at': int(time.time())}, separators=(',', ':'))
print(pane, clients, buffer, values[0], values[2], base64.b64encode(label.encode()).decode())
PY_AGENT_ANSWER
ensure() {
 if ! tm has-session -t "=$name" 2>/dev/null; then
  printf 'Creating terminal: %s\n' "$name" >&2
  if ! start_shell "$name" "$workdir"; then
   # Another client can create this exact session between the two commands.
   tm has-session -t "=$name" 2>/dev/null || fail 'The terminal could not be created.'
  fi
 fi
}
# Deliver the buffer $3 into the pane $1 of the session $name (identity $extra), then press Enter.
# The checks, the paste and the Enter run in one tmux command queue, so that a failed paste never
# leaves typed text at the prompt, and a change since the checks stops the delivery.
#   $2 the number of attached clients that the caller counted
#   $4 1 to require the driver and no writable client, 0 for a session that was just made
#   $5 the flags of paste-buffer
#   $6 a tmux condition of the layer above, $7 the sentence that names its failure, and
#   $8 a tmux command that the layer above runs in the same queue after the Enter, and
#   $9 the keys of a delivery without text (a buffer of `-`): they replace the paste and the Enter.
# The sentences go through #{?...} and display-message -p '...': they must stay free of commas
# and single quotes. On a failure the buffer is deleted, and `delivery_answer` holds the sentence
# of a refusal, or nothing when tmux itself failed. The status is 0 when the text was delivered.
# The refusal text never names the pane: display-message expands % sequences of its text, so a pane id
# such as %0 cannot be compared there. A change of the pane shows as `The session changed.` send-keys gets an empty -c: without it, tmux takes the attached client of the
# session as the target client, and refuses when that client is read only.
deliver() {
 local pane=$1 total=$2 buffer=$3 guard=$4 flags=$5 layer_condition=${6:-1} layer_refusal=${7:-} layer_action=${8:-} keys=${9:-}
 local session_id=${extra#*:}
 session_id=${session_id%%:*}
 local identity_ok="#{==:#{pid}:#{session_id}:#{session_created},$extra}"
 local pane_ok="#{==:#{pane_id},$pane}"
 # A pane in copy mode or with its input off keeps a paste as raw keys, and a dead pane takes nothing.
 local ready="#{&&:#{==:#{pane_in_mode},0},#{&&:#{==:#{pane_input_off},0},#{==:#{pane_dead},0}}}"
 local condition="#{&&:$identity_ok,#{&&:$pane_ok,$ready}}"
 local refusal="#{?$identity_ok,#{?$ready,The session changed. Nothing was sent.,The pane cannot take input now. Nothing was sent.},Session identity changed. Nothing was sent.}"
 if [[ $guard == 1 ]]; then
  local clients_ok="#{==:#{session_attached},$total}"
  local driver_ok="#{==:#{@tokiwa_driver},$TOKIWA_ACTOR}"
  condition="#{&&:$condition,#{&&:$clients_ok,#{&&:$driver_ok,$layer_condition}}}"
  refusal="#{?$identity_ok,#{?$ready,#{?$clients_ok,#{?$driver_ok,${layer_refusal:-The session changed. Nothing was sent.},Only the driver can send. Claim the session first. Nothing was sent.},A client is attached. Nothing was sent.},The pane cannot take input now. Nothing was sent.},Session identity changed. Nothing was sent.}"
 fi
 local action="paste-buffer${flags:+ $flags} -d -b '$buffer' -t '$pane' ; send-keys -c '' -t '$pane' Enter"
 [[ -z $keys ]] || action="send-keys -c '' -t '$pane' $keys"
 [[ -z $layer_action ]] || action="$action ; $layer_action"
 delivery_answer=
 if ! delivery_answer=$(tm if-shell -F -t "=$name:" "$condition" "$action" "display-message -p '$refusal'"); then
  delivery_answer=
  [[ $buffer == - ]] || tm delete-buffer -b "$buffer" 2>/dev/null || true
  return 1
 fi
 [[ -z $delivery_answer ]] || { [[ $buffer == - ]] || tm delete-buffer -b "$buffer" 2>/dev/null || true; return 1; }
}
# Sets the layer's condition, refusal and action of a delivery after the agent stage ($1 is its TURN).
agent_layer() {
 local state='#{@tokiwa_agent}'
 local program="#{||:#{==:#{pane_current_command},claude},#{==:#{pane_current_command},codex}}"
 local idle="#{||:#{m:idle:*,$state},#{||:#{m:limited:*,$state},#{m:error:*,$state}}}"
 local no_item='#{==:#{@tokiwa_agent_pending},}'
 local turn=$1
 [[ $turn != - ]] || turn=
 layer_condition="#{&&:$program,#{&&:$idle,#{&&:$no_item,#{==:#{@tokiwa_agent_turn},$turn}}}}"
 layer_refusal="#{?$program,#{?$idle,#{?$no_item,The session changed. Nothing was sent.,An item waits for a person. Nothing was sent.},The agent is not idle. Nothing was sent.},The pane does not run an agent. Nothing was sent.}"
 local session_id=${extra#*:}
 session_id=${session_id%%:*}
 sent_at=$(date +%s)
 layer_action="set-option -t '$session_id' @tokiwa_agent 'working:$sent_at'"
}
# Sets the layer's condition, refusal, keys and action of an answer. $1 is `PENDING LAST LABEL`, as the answer stage prints.
# The condition holds the pending and last-tool values that the stage read, so a new item, a tool call that
# started, or a state other than `waiting` in between stops the keys.
answer_layer() {
 local pending last label
 read -r pending last label <<< "$1"
 local program="#{||:#{==:#{pane_current_command},claude},#{==:#{pane_current_command},codex}}"
 local waiting='#{m:waiting:*,#{@tokiwa_agent}}'
 local last_ok="#{==:#{@tokiwa_agent_last_tool},$last}"
 layer_condition="#{&&:$program,#{&&:$waiting,#{&&:$last_ok,#{==:#{@tokiwa_agent_pending},$pending}}}}"
 layer_refusal="#{?$program,#{?$waiting,#{?$last_ok,The session changed. Nothing was sent.,The question is not the last tool call of the agent. Nothing was sent.},The agent is not waiting for an answer. Nothing was sent.},The pane does not run an agent. Nothing was sent.}"
 local session_id=${extra#*:}
 session_id=${session_id%%:*}
 layer_keys="$choice Enter"
 layer_action="set-option -u -t '$session_id' @tokiwa_agent_pending ; set-option -t '$session_id' @tokiwa_agent_input '$label'"
 audit_action=answer audit_pending=$pending_id
}
# Send the text on stdin into session $name with identity $1. The core layer knows no agent: a
# layer above passes its own stage program (Python, text on stdin) and its function that sets
# layer_condition, layer_refusal and layer_action from the last field of the stage output.
core_deliver() {
 extra=$1
 local stage=${2:-$core_stage_program} lib=${3:-} layer=${4:-} staged pane clients buffer rest
 # stage_args holds words that the launcher and this helper checked: no space or quote.
 # shellcheck disable=SC2086
 staged=$(python3 -c "$session_lib"$'\n'"$lib"$'\n'"$stage" "$socket" "$name" "$extra" ${stage_args:-}) || return 1
 read -r pane clients buffer rest < <(printf '%s\n' "$staged")
 layer_condition= layer_refusal= layer_action= layer_keys=
 [[ -z $layer ]] || "$layer" "$rest"
 if ! deliver "$pane" "$clients" "$buffer" 1 '-p -r' "$layer_condition" "$layer_refusal" "$layer_action" "$layer_keys"; then
  fail "${delivery_answer:-The message could not be sent. Refresh the session state.}"
 fi
 audit "${audit_action:-send}" "$extra" '' '' "${audit_pending:-}"
 # The last field of the stage output, for the layer above to report.
 stage_rest=$rest
}
# A test sources this file with TOKIWA_SOURCE_ONLY=1 to call the functions above.
[[ ${TOKIWA_SOURCE_ONLY:-} != 1 ]] || return 0
case "$mode" in
 agent-answer)
  stage_args="$pending_id $choice"
  core_deliver "$extra" "$agent_answer_program" "$agent_lib" answer_layer
  printf '{"pending_id": "%s", "choice": %s}\n' "$pending_id" "$choice"
  exit ;;
 agent-relaunch)
  # Relaunch the Claude Code agent of the session with a settings file: /exit, then `claude --resume ID
  # --settings PATH` in the same shell. Each step runs only while the checks of a delivery still hold.
  [[ -n ${4:-} && ${5:-} =~ ^([0-9a-f]{64}|-)$ ]] || fail 'Use agent-relaunch NAME IDENTITY SETTINGS SHA256|-.'
  settings=$4
  staged=$(python3 -c "$session_lib"$'\n'"$agent_lib"$'\n'"$relaunch_lib"$'\n'"$agent_relaunch_program" \
   "$socket" "$name" "$extra" "$settings" "$5") || exit 1
  read -r pane clients buffer turn claude_session digest old_pid command_b64 < <(printf '%s\n' "$staged")
  [[ $turn != - ]] || turn=
  # The same conditions as a message to an idle agent, and the agent is still the one of that session.
  layer_condition="#{&&:#{==:#{pane_current_command},claude},#{&&:#{||:#{m:idle:*,#{@tokiwa_agent}},#{||:#{m:limited:*,#{@tokiwa_agent}},#{m:error:*,#{@tokiwa_agent}}}},#{&&:#{==:#{@tokiwa_agent_pending},},#{&&:#{==:#{@tokiwa_agent_turn},$turn},#{==:#{@tokiwa_agent_session},$claude_session}}}}}"
  layer_refusal='The agent changed. Nothing was changed.'
  # The same tmux queue marks the agent busy, so that a send or a second relaunch refuses while it exits.
  session_id=${extra#*:}; session_id=${session_id%%:*}
  layer_action="set-option -t '$session_id' @tokiwa_agent 'working:$(date +%s)'"
  if ! deliver "$pane" "$clients" "$buffer" 1 '-p -r' "$layer_condition" "$layer_refusal" "$layer_action"; then
   fail "${delivery_answer:-The agent could not be stopped. Nothing was changed.}"
  fi
  recover="To start it again by hand, type in the session: claude --resume $claude_session"
  exited=$(python3 -c "$session_lib"$'\n'"$relaunch_exit_program" "$socket" "$name" "$extra" "$old_pid" \
   "${TOKIWA_RELAUNCH_EXIT_SECONDS:-8}") || exited=
  [[ $exited == exited ]] || fail 'Claude Code did not exit after /exit. It may still run with its old settings. Look at the session.'
  # From here the agent has stopped. Each failure says how to start it again.
  read -r total writable < <(python3 -c "$session_lib"$'\n'"$client_counts_program" "$socket" "$name" "$extra") ||
   fail "Claude Code stopped, but the clients could not be read. $recover"
  (( writable == 0 )) || fail "Claude Code stopped, and a client attached before the new command was typed. $recover"
  buffer="tokiwa-relaunch-$$-$RANDOM"
  printf '%s' "$command_b64" | base64 -d | tm load-buffer -b "$buffer" - ||
   fail "Claude Code stopped, but the new command could not be loaded. $recover"
  started=$(date +%s)
  shell_ok="#{||:#{==:#{pane_current_command},bash},#{||:#{==:#{pane_current_command},sh},#{||:#{==:#{pane_current_command},zsh},#{==:#{pane_current_command},fish}}}}"
  if ! deliver "$pane" "$total" "$buffer" 1 '' "$shell_ok" 'The pane does not show its shell.'; then
   fail "Claude Code stopped, but the new command was not typed: ${delivery_answer:-tmux failed.} $recover"
  fi
  python3 -c "$session_lib"$'\n'"$agent_lib"$'\n'"$relaunch_lib"$'\n'"$relaunch_verify_program" "$socket" "$name" "$extra" \
   "$claude_session" "$settings" "$digest" "$started" "${TOKIWA_RELAUNCH_START_SECONDS:-15}" ||
   fail "The relaunch could not be confirmed. The new command was typed: claude --resume $claude_session --settings $settings"
  # Only a confirmed relaunch is recorded, as for every other action.
  audit relaunch "$extra"
  exit ;;
 agent-send)
  core_deliver "$extra" "$agent_send_program" "$agent_lib" agent_layer
  # The agent layer reports the turn: `-` means that the agent has reported no turn yet.
  printf '{"turn_before": %s, "sent_at": %s}\n' "$([[ $stage_rest == - ]] && echo 0 || echo "$stage_rest")" "$sent_at"
  exit ;;
 state)
  # Read only. One JSON object that holds no session text and is not sealed.
  python3 -c "$session_lib"$'\n'"$state_program" "$socket" "$name" "$extra"
  exit ;;
 agent-state)
  python3 -c "$session_lib"$'\n'"$agent_lib"$'\n'"$agent_state_program" "$socket" "$name" "$extra"
  exit ;;
 agent-wait)
  python3 -c "$session_lib"$'\n'"$agent_lib"$'\n'"$agent_wait_program" "$socket" "$name" "$extra" "$after"
  exit ;;
 agent-read)
  python3 -c "$session_lib"$'\n'"$agent_read_program" "$socket" "$name" "$extra" "$cursor" "$flags" "$recipient"
  exit ;;
 capture)
  # Read only. The text is the last lines of the active pane, with its scrollback, without colour.
  # The output is encrypted to the one-time certificate of the caller. There is no plain output.
  python3 -c "$session_lib"$'\n'"$capture_program" "$socket" "$name" "$extra" "$lines" "$recipient" "$query"
  exit ;;
 digest)
  # One line of facts for each session: the state that its agent reported, when its screen last
  # changed, and the git state of its folder. Commit messages stay out: Run Command keeps this output.
  python3 - "$socket" <<'PY_DIGEST'
import json
import os
import subprocess
import sys
import time

socket = sys.argv[1]
# A status check never takes the index lock that an agent's own git command needs.
GIT_ENV = dict(os.environ, GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0')

def tmux(*args):
    return subprocess.run(['tmux', '-N', '-S', socket, *args], capture_output=True, text=True, timeout=10).stdout.rstrip('\n')

def git(folder, *args):
    try:
        result = subprocess.run(['git', '-C', folder, *args], capture_output=True, text=True, timeout=5, env=GIT_ENV)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 else None

def repository(folder):
    if git(folder, 'rev-parse', '--is-inside-work-tree') != 'true':
        return None
    head = git(folder, 'log', '-1', '--format=%h %ct')
    commit, _, committed = (head or '').partition(' ')
    unpushed = git(folder, 'rev-list', '--count', '@{upstream}..HEAD')
    return {'branch': git(folder, 'rev-parse', '--abbrev-ref', 'HEAD'),
            'unpushed': int(unpushed) if unpushed is not None else None,
            'changed': len((git(folder, 'status', '--porcelain') or '').splitlines()),
            'commit': commit or None,
            'committed_at': int(committed) if committed.isdigit() else None}

rows = []
for line in tmux('list-sessions', '-F', '#{session_name}\t#{pid}:#{session_id}:#{session_created}\t#{session_activity}').splitlines()[:100]:
    name, identity, active = line.split('\t')
    target = '=' + name + ':'
    folder = tmux('display-message', '-p', '-t', target, '#{pane_current_path}')
    panes = [pane.split(' ', 1) for pane in tmux('list-panes', '-s', '-t', '=' + name, '-F', '#{pane_dead} #{pane_current_command}').splitlines()]
    state, _, at = tmux('show-options', '-qv', '-t', target, '@tokiwa_agent').partition(':')
    agent = None
    if at.isascii() and at.isdigit() and any(dead != '1' and command in ('claude', 'codex') for dead, command in panes):
        agent = {'state': state, 'at': int(at)}
    rows.append({'name': name, 'identity': identity, 'active_at': int(active) if active.isdigit() else None,
                 'agent': agent, 'git': repository(folder) if folder else None})
print(json.dumps({'sampled_at': int(time.time()), 'sessions': rows}))
PY_DIGEST
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
    # The time that tokiwa-attention marked the session, or 0. Unlike the bell, it survives an open client.
    attention = read('show-options', '-qv', '-t', '=' + name + ':', '@tokiwa_attention')
    frozen = read('show-options', '-qv', '-t', '=' + name + ':', '@tokiwa_frozen') != ''
    # The state that the agent's hooks last reported (tokiwa-state), shown only while an agent
    # runs, so a state that an ended agent left behind does not show.
    reported = read('show-options', '-qv', '-t', '=' + name + ':', '@tokiwa_agent')
    # One line per pane of every window. The window bell flag is set when a pane of the window
    # rang the bell while no client viewed that window; viewing the window clears it.
    panes = [pane.split('\t', 3) for pane in read('list-panes', '-s', '-t', '=' + name, '-F',
             '#{pane_id}\t#{pane_dead}\t#{window_bell_flag}\t#{pane_current_command}').splitlines()]
    bell = any(flag == '1' for _, _, flag, _ in panes)
    agent = None
    state, _, at = reported.partition(':')
    if at.isascii() and at.isdigit() and any(dead != '1' and command in ('claude', 'codex') for _, dead, _, command in panes):
        agent = {'state': state, 'at': int(at)}
    activity = []
    for pane_id, dead, _, command in panes[:16]:
        screen = read('capture-pane', '-p', '-t', pane_id, '-S', '-20')
        activity.append({'pane':pane_id, 'dead':dead == '1', 'command':command[:80], 'screen':hashlib.sha256(screen.encode()).hexdigest()})
    sessions.append({'activity_partial':len(panes)>16, 'activity': activity, 'bell': bell, 'attention': int(attention) if attention.isdigit() else 0, 'frozen': frozen, 'agent': agent, 'sampled_at':time.time(), 'name': name, 'clients': int(clients), 'windows': int(windows), 'cwd': cwd, 'project': project, 'parent': parent, 'managed': managed, 'identity': read('display-message', '-p', '-t', '=' + name + ':', '#{pid}:#{session_id}:#{session_created}')})
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
  # The identity check and the deletion run in the same tmux command queue. With check-clients, the
  # clients are read first, and the queue ends the session only while the number of attached clients
  # is still the number that was read, so that a client that attaches in between stops it. Without
  # the flag only the identity is checked, as before; a program that ends a session on purpose, for
  # example the app's end button, sends no flag.
  tm has-session -t "=$name" 2>/dev/null || fail 'The selected session no longer exists.'
  session_id=${extra#*:}; session_id=${session_id%%:*}
  identity_ok="#{==:#{pid}:#{session_id}:#{session_created},$extra}"
  condition=$identity_ok
  refusal='Session identity changed. Nothing was ended.'
  if [[ ${4:-} == check-clients ]]; then
   read -r total writable < <(python3 -c "$session_lib"$'\n'"$client_counts_program" "$socket" "$name" "$extra") ||
    fail 'The clients of the session could not be read. Nothing was changed.'
   (( writable == 0 )) || fail 'A client is attached. Nothing was changed. Use --attached-ok to end it anyway.'
   condition="#{&&:$identity_ok,#{==:#{session_attached},$total}}"
   # The answer names the cause: an identity that still matches means that a client attached.
   # The sentences go through #{?...} and display-message -p '...': they must stay free of commas
   # and single quotes.
   refusal="#{?$identity_ok,A client is attached. Nothing was changed. Use --attached-ok to end it anyway.,Session identity changed. Nothing was ended.}"
  fi
  answer=$(tm if-shell -F -t "=$name:" "$condition" \
   "kill-session -t '$session_id'" "display-message -p '$refusal'") || fail 'The session could not be ended. Refresh its state.'
  [[ -z $answer ]] || fail "$answer"
  audit end "$extra"
  printf 'The selected session ended. Detached background processes may remain.\n'
  exit ;;

 claim)
  # The driver is the one actor that may send to the session. The checks and the change run in one
  # tmux command queue, as for end: the identity matches, the number of attached clients is still
  # the number that was read (so a client that attaches in between stops the claim), and the
  # session has no driver, or the caller is the driver, or the caller asked to replace it.
  tm has-session -t "=$name" 2>/dev/null || fail 'The selected session no longer exists.'
  session_id=${extra#*:}; session_id=${session_id%%:*}
  read -r total writable < <(python3 -c "$session_lib"$'\n'"$client_counts_program" "$socket" "$name" "$extra") ||
   fail 'The clients of the session could not be read. Nothing was changed.'
  (( writable == 0 )) || fail 'A client is attached. Nothing was changed.'
  identity_ok="#{==:#{pid}:#{session_id}:#{session_created},$extra}"
  clients_ok="#{==:#{session_attached},$total}"
  driver_ok="#{||:#{==:#{@tokiwa_driver},},#{==:#{@tokiwa_driver},$TOKIWA_ACTOR}}"
  [[ ${4:-} != replace ]] || driver_ok=1
  earlier=$(tm show-options -qv -t "=$name:" @tokiwa_driver)
  # The answer names the cause. The sentences go through #{?...} and display-message -p '...': they
  # must stay free of commas and single quotes.
  refusal="#{?$identity_ok,#{?$clients_ok,Another actor is the driver. Nothing was changed. Use --replace to take it.,A client is attached. Nothing was changed.},Session identity changed. Nothing was changed.}"
  answer=$(tm if-shell -F -t "=$name:" "#{&&:$identity_ok,#{&&:$clients_ok,$driver_ok}}" \
   "set-option -t '$session_id' @tokiwa_driver '$TOKIWA_ACTOR'" "display-message -p '$refusal'") || fail 'The driver could not be set. Refresh the session state.'
  [[ -z $answer ]] || fail "$answer"
  replaced=
  [[ ${4:-} != replace || $earlier == "$TOKIWA_ACTOR" ]] || replaced=$earlier
  audit claim "$extra" '' "$replaced"
  printf 'The driver of %s is %s.\n' "$name" "$TOKIWA_ACTOR"
  exit ;;
 release)
  # Only the driver releases. The check and the change run in one tmux command queue.
  tm has-session -t "=$name" 2>/dev/null || fail 'The selected session no longer exists.'
  session_id=${extra#*:}; session_id=${session_id%%:*}
  identity_ok="#{==:#{pid}:#{session_id}:#{session_created},$extra}"
  refusal="#{?$identity_ok,Only the driver can release. Nothing was changed.,Session identity changed. Nothing was changed.}"
  answer=$(tm if-shell -F -t "=$name:" "#{&&:$identity_ok,#{==:#{@tokiwa_driver},$TOKIWA_ACTOR}}" \
   "set-option -u -t '$session_id' @tokiwa_driver" "display-message -p '$refusal'") || fail 'The driver could not be released. Refresh the session state.'
  [[ -z $answer ]] || fail "$answer"
  audit release "$extra"
  printf 'The driver of %s was released.\n' "$name"
  exit ;;
 interrupt)
  # The identity check and the key press run in the same tmux command queue, as for end. Esc stops
  # the current turn of Claude Code and Codex, and closes a question: the same queue clears the pending
  # item, so that no answer reaches the prompt after it.
  tm has-session -t "=$name" 2>/dev/null || fail 'The selected session no longer exists.'
  session_id=${extra#*:}; session_id=${session_id%%:*}
  answer=$(tm if-shell -F -t "=$name:" "#{==:#{pid}:#{session_id}:#{session_created},$extra}" \
   "send-keys -t '$session_id' Escape ; set-option -u -t '$session_id' @tokiwa_agent_pending" \
   "display-message -p 'Session identity changed. Nothing was sent.'") || fail 'The key could not be sent. Refresh the session state.'
  [[ -z $answer ]] || fail "$answer"
  # Claude Code reports no event when Esc stops a turn, so a reported agent becomes idle here.
  if [[ -n $(tm show-options -qv -t "=$name:" @tokiwa_agent) ]]; then
   tm set-option -t "=$name:" @tokiwa_agent "idle:$(date +%s)"
  fi
  audit interrupt "$extra"
  printf 'Sent Esc to %s.\n' "$name"
  exit ;;
 freeze|resume)
  tm has-session -t "=$name" 2>/dev/null || fail 'The selected session no longer exists.'
  # The identity and the pane processes come from one call, so the signal reaches the panes of the
  # session that was checked.
  panes=$(tm list-panes -s -t "=$name" -F '#{pid}:#{session_id}:#{session_created} #{pane_pid}') ||
   fail 'The session could not be read. Refresh its state.'
  done_word=frozen; [[ $mode == freeze ]] || done_word=resumed
  roots=()
  while read -r found pane; do
   [[ $found == "$extra" ]] || fail "Session identity changed. Nothing was $done_word."
   roots+=("$pane")
  done <<< "$panes"
  # Each pane process and every process below it, from the process table. A process that left the
  # tree, for example a daemon, is not reached.
  targets=$(ps -A -o pid=,ppid= | python3 -c '
import sys
roots = set(sys.argv[1:])
children = {}
for line in sys.stdin:
    pid, ppid = line.split()
    children.setdefault(ppid, []).append(pid)
seen, todo = [], list(roots)
while todo:
    pid = todo.pop()
    seen.append(pid)
    todo.extend(children.get(pid, []))
print(" ".join(seen))
' "${roots[@]}")
  if [[ $mode == freeze ]]; then
   tm set-option -t "=$name:" @tokiwa_frozen "$(date +%s)"
   # shellcheck disable=SC2086
   kill -STOP $targets 2>/dev/null || true
   printf 'Froze %s: its processes wait until tokiwa resume.\n' "$name"
  else
   # shellcheck disable=SC2086
   kill -CONT $targets 2>/dev/null || true
   tm set-option -u -t "=$name:" @tokiwa_frozen
   printf 'Resumed %s.\n' "$name"
  fi
  audit "$mode" "$extra"
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
  audit rename "$identity"
  printf 'Renamed %s to %s.\n' "$name" "$to"
  exit ;;
 project)
  tm has-session -t "=$name" 2>/dev/null || fail 'The selected session does not exist.'
  label=$(project_label "$extra") || exit 1
  tm set-option -t "=$name:" @tokiwa_project "$label"
  registry add "$label" "$(tm display-message -p -t "=$name:" '#{pane_current_path}')"
  audit project
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
  name=$from audit move-project
  printf 'Moved %d sessions.\n' "$moved"
  exit ;;
 name)
  if [[ -z $name ]]; then prompt_name; printf '\n'; exit; fi
  tm set-option -g @tokiwa_name "$name"
  audit name
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
  name=$label audit forget-project
  printf 'Project forgotten. Its folders stay.\n'
  exit ;;
 create)
  # A session in an existing directory, or in a new folder inside the workspaces folder.
  tm has-session -t "=$name" 2>/dev/null && fail 'This session exists. Use tokiwa attach NAME.'
  # With run_stdin in the request, the command line arrives on stdin and not in the request: the
  # launcher sends it encrypted, and root decrypts it into this pipe (docs/host.md, "Encrypted input").
  # The program below reads the pipe from descriptor 3, because its own stdin holds its source.
  exec 3<&0
  request=$(python3 - "$extra" "$workspaces" <<'PY_CREATE'
import base64, json, os, re, sys
try:
    want = json.loads(base64.b64decode(sys.argv[1], validate=True))
    run = want.get('run')
    if want.get('run_stdin') is True:
        if run is not None:
            raise SystemExit('Use a command of one line, at most 2000 printable characters.')
        # One more character than the limit shows that a line is too long. The final newline ends the line.
        try:
            run = os.fdopen(3, encoding='utf-8', errors='strict').read(2002)
        except UnicodeDecodeError:
            raise SystemExit('Use a command of one line, at most 2000 printable characters, as UTF-8 text.')
        run = run[:-1] if run.endswith('\n') else run
    # The command is typed into the shell, so one line of printable text: no extra line runs.
    if run is not None and (not isinstance(run, str) or not run or len(run) > 2000
                            or any(ord(c) < 32 or ord(c) == 127 for c in run)):
        raise SystemExit('Use a command of one line, at most 2000 printable characters.')
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
    print(base64.b64encode(path.encode()).decode(), base64.b64encode(label.encode()).decode() or '-',
          base64.b64encode(run.encode()).decode() if run else '-')
except (ValueError, OSError, TypeError, AttributeError):
    raise SystemExit('Use an existing absolute directory, or a folder name of letters, digits, dots, hyphens or underscores.')
PY_CREATE
) || exit 1
  # A here-string would put the request, which can hold the command, in a temporary file on some systems.
  read -r directory_b64 label_b64 run_b64 < <(printf '%s\n' "$request")
  directory=$(printf '%s' "$directory_b64" | base64 -d)
  label=''
  [[ $label_b64 == - ]] || label=$(project_label "$label_b64") || exit 1
  start_shell "$name" "$directory" || fail 'The terminal could not be created.'
  # The actor that creates a session is its driver; a call with no valid actor leaves it with none.
  # The change is conditional on an empty driver, in the same tmux command, so that a claim made
  # since the session was created is never overwritten. Its status is checked.
  if valid_actor "${TOKIWA_ACTOR:-}"; then
   tm if-shell -F -t "=$name:" '#{==:#{@tokiwa_driver},}' "set-option -t '=$name:' @tokiwa_driver '$TOKIWA_ACTOR'" ||
    fail 'The terminal was created, but its driver could not be set. Nothing was typed into it. Refresh the session state.'
  fi
  if [[ -n $label ]]; then
   tm set-option -t "=$name:" @tokiwa_project "$label"
   registry add "$label" "$directory"
  fi
  # The identity lets the app attach at once, without another read of the session list.
  read -r pane identity < <(tm display-message -p -t "=$name:" '#{pane_id} #{pid}:#{session_id}:#{session_created}') ||
   fail 'The terminal could not be created.'
  # The shell reads the typed line after its startup file, so the command has the PATH and the
  # secrets of a new shell, and the shell stays when the command ends. The line reaches tmux on stdin
  # (load-buffer) and is pasted from a buffer that tmux deletes: it is never an argument of a process.
  # printf is a shell builtin, so the line is not an argument of base64 either. The paste and the
  # Enter are one core delivery, as for a message to an agent.
  if [[ $run_b64 != - ]]; then
   buffer="tokiwa-create-$$-$RANDOM"
   printf '%s' "$run_b64" | base64 -d | tm load-buffer -b "$buffer" - || fail 'The command could not be typed into the new terminal. Refresh the session state.'
   extra=$identity
   deliver "$pane" 0 "$buffer" 0 '' || fail "${delivery_answer:-The command could not be typed into the new terminal. Refresh the session state.}"
  fi
  audit create "$identity" "$([[ $run_b64 == - ]] && echo 0 || echo 1)"
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
    "set-option -u -t '$session_id' @tokiwa_attention ; attach-session -t '$session_id'" \
    "display-message -p 'Session identity changed. No session was attached.' ; run-shell 'exit 1'"
  fi ;;
 view)
  # Read only: a key press never reaches the program. The identity check and the attachment run
  # in the same tmux command queue.
  tm has-session -t "=$name" 2>/dev/null || fail 'This session does not exist. Use tokiwa sessions or tokiwa new NAME.'
  session_id=${extra#*:}; session_id=${session_id%%:*}
  exec tmux -N -S "$socket" if-shell -F -t "=$name:" "#{==:#{pid}:#{session_id}:#{session_created},$extra}" \
   "set-option -u -t '$session_id' @tokiwa_attention ; attach-session -r -t '$session_id'" \
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
