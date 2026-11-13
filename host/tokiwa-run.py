"""Run commands that the owner listed, as root, on the host."""

import base64
import fcntl
import grp
import json
import math
import os
import pwd
import re
import secrets
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

LIST = Path("/etc/tokiwa/commands.json")
RUNS = Path("/srv/development/cache/tokiwa-runs")
LOG = Path("/var/log/tokiwa/run.jsonl")
HOME = Path("/srv/development/private/homes/workbench")
SECRETS = HOME / ".tokiwa/secrets.env"
PRIVATE = Path("/srv/development/private")
WORKSPACES = Path("/srv/development/state/workspaces")
USER = "agent-workspace"
SAFE_PATH = "/usr/local/bin:/usr/bin:/bin"
PAGE_BYTES = 15000
MAX_RUNNING = 4
KEEP_SECONDS = 14 * 86400
WAIT_SECONDS = 8
# Well inside the 30 seconds that Run Command gives a call.
START_SECONDS = 12
SECRETS_BYTES = 1 << 20
TIMED_OUT = 124
ID_PATTERN = r"^[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$"
NAME_PATTERN = r"^[a-z][a-z0-9_-]{0,47}$"
SECRET_PATTERN = r"^[A-Z_][A-Z0-9_]{0,63}$"
# The root ExecStopPost hook starts with env -i, but the loader and the C library of
# /usr/bin/env still read the unit's environment, EnvironmentFile included. So a secret must not
# name a variable that changes how a loader, a library, an interpreter, systemd or a session
# behaves.
RESERVED_PREFIXES = (
    "LD_", "MALLOC_", "PYTHON", "SYSTEMD_", "TOKIWA_", "TMUX", "LISTEN_", "OPENSSL_"
)
RESERVED_NAMES = {
    "GCONV_PATH",
    "GLIBC_TUNABLES",
    "NLSPATH",
    "TZ",
    "TZDIR",
    "HOSTALIASES",
    "LOCPATH",
    "PATH",
    "HOME",
    "SHELL",
    "USER",
    "LOGNAME",
    "PWD",
    "BROWSER",
    "PS1",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "SERVICE_RESULT",
    "EXIT_CODE",
    "EXIT_STATUS",
    "CREDENTIALS_DIRECTORY",
    "NOTIFY_SOCKET",
}
ENTRY_KEYS = {
    "description",
    "argv",
    "args",
    "cwd",
    "home",
    "secrets",
    "timeout_seconds",
    "output_bytes",
    "writable",
}
ARG_KINDS = ("pattern", "choice", "path_below")
PLACEHOLDER = re.compile(r"\{([^{}]*)\}")
ENDS = {"success": "done", "timeout": "timed-out"}
# Only after these results is ExecMainStatus an exit status; after a signal it is the signal.
EXITED = ("success", "exit-code")
# The limits of cloud-workbench.service, for each run unit and each git unit. ProtectHome also
# hides /run/user, so a run has no Docker engine.
SANDBOX = (
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "PrivateDevices=yes",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectControlGroups=yes",
    "RestrictSUIDSGID=yes",
    "CapabilityBoundingSet=",
    "UMask=0077",
    "TasksMax=512",
    "MemoryMax=8G",
    "MemorySwapMax=0",
    "InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -/var/lib/agent-platform",
)
VIA_PATTERN = r"^(cli|mcp|app)$"
ACTOR_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$"


class Refused(Exception):
    """A call or the list failed a check, so nothing ran."""

    def __init__(self, reason):
        super().__init__(f"{reason} Nothing was run.")


def is_int(value, low, high):
    return type(value) is int and low <= value <= high


def check_arg(name, arg):
    if not isinstance(arg, dict):
        raise ValueError(f"argument {name} is not an object")
    kinds = [kind for kind in ARG_KINDS if kind in arg]
    if len(kinds) != 1 or set(arg) - {kinds[0], "as"}:
        raise ValueError(f"argument {name} needs exactly one kind and an optional as")
    kind = kinds[0]
    if kind == "pattern":
        pattern = arg["pattern"]
        if not isinstance(pattern, str) or not (
            pattern.startswith("^") and pattern.endswith("$")
        ):
            raise ValueError(f"the pattern of {name} is not anchored")
        try:
            re.compile(pattern)
        except re.error:
            raise ValueError(f"the pattern of {name} does not compile")
    elif kind == "choice":
        choice = arg["choice"]
        if not choice or not isinstance(choice, dict):
            raise ValueError(f"the choice of {name} is empty")
        if not all(isinstance(value, str) for value in choice.values()):
            raise ValueError(f"a choice value of {name} is not a string")
    elif not isinstance(arg["path_below"], str) or not Path(arg["path_below"]).is_absolute():
        raise ValueError(f"the root of {name} is not an absolute path")
    if "as" in arg and not (
        isinstance(arg["as"], str) and re.fullmatch(NAME_PATTERN, arg["as"])
    ):
        raise ValueError(f"the as of {name} is not a valid name")


def filled_name(name, arg):
    return arg.get("as", name)


def check_writable_path(path):
    """Refuse a path that systemd could read wrongly or that is not inside WORKSPACES."""
    if not (isinstance(path, str) and path.startswith("/") and path == os.path.normpath(path)):
        raise ValueError(f"writable path {path!r} is not an absolute normal path")
    if re.search(r"[\s$%]", path):
        raise ValueError(f"writable path {path} holds a space, a $ or a %")
    if not Path(path).is_relative_to(WORKSPACES) or Path(path) == WORKSPACES:
        raise ValueError(f"writable path {path} is not below the workspace folder")


def check_writable(writable, args):
    """Check the writable list of an entry: fixed paths and placeholders of choice arguments."""
    if not isinstance(writable, list):
        raise ValueError("writable is not a list")
    choices = {
        filled_name(name, arg): arg["choice"] for name, arg in args.items() if "choice" in arg
    }
    for item in writable:
        placeholder = PLACEHOLDER.fullmatch(item) if isinstance(item, str) else None
        if placeholder is None:
            if isinstance(item, str) and ("{" in item or "}" in item):
                raise ValueError(f"writable item {item} is not a whole placeholder")
            check_writable_path(item)
        elif placeholder.group(1) not in choices:
            raise ValueError(f"writable placeholder {item} is not a choice argument")
        else:
            for value in choices[placeholder.group(1)].values():
                check_writable_path(value)


def check_entry(entry):
    unknown = set(entry) - ENTRY_KEYS
    if unknown:
        raise ValueError(f"unknown key {sorted(unknown)[0]}")
    if not isinstance(entry.get("description"), str):
        raise ValueError("description is not a string")
    argv = entry.get("argv")
    if not (
        isinstance(argv, list) and argv and all(isinstance(item, str) for item in argv)
    ):
        raise ValueError("argv is not a non-empty list of strings")
    args = entry.get("args")
    if not isinstance(args, dict):
        raise ValueError("args is not an object")
    for name, arg in args.items():
        if not re.fullmatch(NAME_PATTERN, name):
            raise ValueError(f"argument name {name} is not valid")
        check_arg(name, arg)
    names = [filled_name(name, arg) for name, arg in args.items()]
    if len(set(names)) != len(names):
        raise ValueError("two arguments fill the same name")
    for item in argv:
        for placeholder in PLACEHOLDER.findall(item):
            if placeholder not in names:
                raise ValueError(f"placeholder {{{placeholder}}} has no argument")
    if entry.get("cwd") not in ("fresh", "worktree"):
        raise ValueError("cwd is not fresh or worktree")
    if entry.get("home", "none") not in ("none", "workbench"):
        raise ValueError("home is not none or workbench")
    secrets = entry.get("secrets", [])
    if not (
        isinstance(secrets, list)
        and all(isinstance(s, str) and re.fullmatch(SECRET_PATTERN, s) for s in secrets)
    ):
        raise ValueError("secrets holds an invalid name")
    for name in secrets:
        if name.startswith(RESERVED_PREFIXES) or name in RESERVED_NAMES:
            raise ValueError(f"secret name {name} is reserved")
    if not is_int(entry.get("timeout_seconds"), 1, 86400):
        raise ValueError("timeout_seconds is not an integer from 1 to 86400")
    if not is_int(entry.get("output_bytes"), 1, 10_000_000):
        raise ValueError("output_bytes is not an integer from 1 to 10000000")
    check_writable(entry.get("writable", []), args)
    if entry["cwd"] == "worktree":
        clone = [
            arg for name, arg in args.items() if filled_name(name, arg) == "clone"
        ]
        if not (clone and "choice" in clone[0] and "commit" in args):
            raise ValueError("cwd worktree needs a choice filled as clone and a commit")


def load_list(path=LIST):
    """Read the list and check every entry, or refuse the whole list."""
    try:
        entries = json.loads(Path(path).read_text())["entries"]
        if not isinstance(entries, dict):
            raise ValueError("entries is not an object")
        for name, entry in entries.items():
            if not re.fullmatch(NAME_PATTERN, name):
                raise ValueError(f"entry name {name} is not valid")
            if not isinstance(entry, dict):
                raise ValueError(f"entry {name} is not an object")
            try:
                check_entry(entry)
            except ValueError as error:
                raise ValueError(f"entry {name}: {error}")
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise Refused(f"The command list is invalid: {error}.")
    return entries


def public_view(entries):
    """Describe each entry for a caller, without the values behind a choice."""
    view = []
    for name in sorted(entries):
        args = {}
        for arg_name, arg in entries[name]["args"].items():
            if "pattern" in arg:
                args[arg_name] = {"pattern": arg["pattern"]}
            elif "choice" in arg:
                args[arg_name] = {"choice": sorted(arg["choice"])}
            else:
                args[arg_name] = {"path_below": arg["path_below"]}
        view.append(
            {"name": name, "description": entries[name]["description"], "args": args}
        )
    return view


def check_value(name, arg, value):
    if "pattern" in arg:
        if not re.fullmatch(arg["pattern"], value):
            raise Refused(f"The value of {name} does not match its pattern.")
        return value
    if "choice" in arg:
        if value not in arg["choice"]:
            raise Refused(f"The value of {name} is not one of the listed choices.")
        return arg["choice"][value]
    # A path outside the root gets one answer whether it exists or not, so that a caller cannot
    # probe the host. A value that cannot be resolved (a NUL byte, a link loop) gets it too.
    outside = Refused(f"The path of {name} is not below its root.")
    root = Path(arg["path_below"]).resolve()
    try:
        path = (root / value).resolve()
    except (OSError, RuntimeError, ValueError):
        raise outside
    if not path.is_relative_to(root):
        raise outside
    if not path.exists():
        raise Refused(f"The path of {name} does not exist.")
    return str(path)


def check_call(entry, values):
    """Check the caller's values against the entry and return the filled values."""
    args = entry["args"]
    for name in args:
        if name not in values:
            raise Refused(f"The argument {name} is missing.")
    for name in values:
        if name not in args:
            raise Refused(f"The argument {name} is not accepted.")
    filled = {}
    for name, arg in args.items():
        value = values[name]
        if not isinstance(value, str):
            raise Refused(f"The value of {name} is not a string.")
        filled[filled_name(name, arg)] = check_value(name, arg, value)
    return filled


def resolve_writable(name, entry, filled):
    """Return the real path of each writable folder of the call, or refuse the call.

    One text covers a missing path, a file and a link that leaves WORKSPACES, so that a refusal
    does not tell whether a path exists. A link can change after the list was loaded, so the
    path that the run gets is the resolved one.
    """
    outside = Refused(f"The writable folder of {name} is not below the workspace folder.")
    root = os.path.realpath(WORKSPACES)
    paths = []
    for item in entry.get("writable", []):
        placeholder = PLACEHOLDER.fullmatch(item)
        path = os.path.realpath(filled[placeholder.group(1)] if placeholder else item)
        if not (os.path.isdir(path) and Path(path).is_relative_to(root) and path != root):
            raise outside
        paths.append(path)
    return paths


def fill_argv(argv, filled):
    """Put each filled value into its placeholders, keeping each value whole."""
    return [
        PLACEHOLDER.sub(lambda match: filled[match.group(1)], item) for item in argv
    ]


def command(argv, timeout=20):
    """Run a program without a shell and return its result.

    A program that cannot start gives exit 127. One that outlasts timeout seconds is killed with
    its whole process group and gives exit TIMED_OUT.
    """
    # A clean environment, so that no variable of the caller reaches systemctl or systemd-run.
    try:
        process = subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={"PATH": SAFE_PATH, "LC_ALL": "C"},
            start_new_session=True,
        )
    except OSError:
        return subprocess.CompletedProcess(argv, 127, "", "")
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.communicate(timeout=1)
        except subprocess.TimeoutExpired:
            pass
        return subprocess.CompletedProcess(argv, TIMED_OUT, "", "")
    return subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)


def clock():
    return time.monotonic()


def uid_of(user):
    return pwd.getpwnam(user).pw_uid


def chown(path, user):
    """Give a path to a user and the group of the same name, without following a link."""
    os.chown(
        path, pwd.getpwnam(user).pw_uid, grp.getgrnam(user).gr_gid, follow_symlinks=False
    )


def new_id(now):
    """Make a run id from a UTC time and a random part."""
    return time.strftime("%Y%m%dT%H%M%S", time.gmtime(now)) + "-" + secrets.token_hex(2)


def literal(argv):
    # systemd expands $NAME and ${NAME} in a command line with the unit's environment, secrets
    # included, and splits a bare $NAME at spaces; $$ is a literal $.
    return [item.replace("$", "$$") for item in argv]


def git_command(clone, work, seconds, *argv):
    """Return the systemd-run call that runs one git command as agent-workspace in a sandbox.

    The clone belongs to agent-workspace, so its config and its checkout filters are code of
    that user. git gets the limits of a run, may write only the clone's .git folder and the
    run's work folder, and runs no hook and no file system monitor. The unit stops after
    seconds, also when the caller of systemd-run is killed first.
    """
    properties = [
        *SANDBOX,
        f"ReadWritePaths={clone}/.git {work}",
        f"RuntimeMaxSec={max(1, math.ceil(seconds))}",
    ]
    return [
        "systemd-run",
        "--wait",
        "--pipe",
        "--collect",
        "--quiet",
        f"--uid={USER}",
        f"--gid={USER}",
        "--slice=agent-sessions.slice",
        *(f"--property={item}" for item in properties),
        "--",
        *literal(
            ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
             "-C", clone, *argv]
        ),
    ]


def unit_command(run_id, entry, argv, workdir, env_file, writable=()):
    """Return the systemd-run call that starts one run as agent-workspace.

    writable holds the resolved folders that the entry names. Each gets a ReadWritePaths item,
    and InaccessiblePaths and file permissions still apply.
    """
    folder = RUNS / run_id
    workbench = entry.get("home", "none") == "workbench"
    # UMask also makes the output file, which systemd opens as root, mode 0600.
    properties = [
        f"RuntimeMaxSec={entry['timeout_seconds']}",
        f"StandardOutput=file:{folder}/output",
        "StandardError=inherit",
        *SANDBOX,
        "PrivateTmp=yes",
        f"ReadWritePaths={folder}/work",
    ]
    if workbench:
        properties += [
            f"ReadWritePaths={HOME}",
            f"InaccessiblePaths={HOME}/.tokiwa",
            f"InaccessiblePaths={PRIVATE}/peermesh",
        ]
    else:
        properties.append(f"InaccessiblePaths={PRIVATE}")
    properties += [f"ReadWritePaths={path}" for path in writable]
    # Secrets travel only in a root-only file: systemctl show prints Environment to every user.
    if env_file is not None:
        properties.append(f"EnvironmentFile={env_file}")
    # The hook runs as root, so it starts with an empty environment and reads the result from
    # systemd instead of from variables.
    properties.append(
        "ExecStopPost=+/usr/bin/env -i /usr/bin/python3 -I "
        f"{Path(__file__).resolve()} finish {run_id}"
    )
    environment = [f"PATH={SAFE_PATH}"]
    if workbench:
        environment += [
            f"HOME={HOME}",
            f"CLAUDE_CONFIG_DIR={HOME}/.claude",
            f"CODEX_HOME={HOME}/.codex",
        ]
    else:
        environment.append(f"HOME={folder}/work")
    return [
        "systemd-run",
        f"--unit=tokiwa-run-{run_id}",
        f"--uid={USER}",
        f"--gid={USER}",
        "--slice=agent-sessions.slice",
        f"--working-directory={workdir}",
        "--collect",
        *(f"--property={item}" for item in properties),
        *(f"--setenv={item}" for item in environment),
        "--",
        *literal(argv),
    ]


def log(line):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    with os.fdopen(descriptor, "a") as f:
        f.write(json.dumps(line) + "\n")


def read_record(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def read_secrets_text():
    # agent-workspace owns the folder and the file, so either name can be a planted link, and
    # the file can be a FIFO that blocks a read or a device that never ends.
    home = os.open(HOME, os.O_RDONLY | os.O_DIRECTORY)
    try:
        folder = os.open(
            SECRETS.parent.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=home
        )
    finally:
        os.close(home)
    try:
        descriptor = os.open(
            SECRETS.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder
        )
    finally:
        os.close(folder)
    with os.fdopen(descriptor, "rb") as f:
        info = os.fstat(f.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != uid_of(USER):
            raise OSError("the secrets file is not a plain file of agent-workspace")
        data = f.read(SECRETS_BYTES + 1)
    if len(data) > SECRETS_BYTES:
        raise OSError("the secrets file is too large")
    return data.decode()


def read_secrets(names):
    if not names:
        return {}
    # The file is the session's `export NAME='value'` lines, and a quoted value can span lines.
    try:
        words = shlex.split(read_secrets_text(), comments=True)
    except (OSError, KeyError, ValueError):
        raise Refused("The secrets file could not be read.")
    found = {}
    for word in words:
        name, sign, value = word.partition("=")
        if sign and name in names:
            found[name] = value
    for name in names:
        if name not in found:
            raise Refused(f"The secret {name} is not in the secrets file.")
        # An EnvironmentFile line cannot hold either one as data.
        if "\n" in found[name] or "\0" in found[name]:
            raise Refused(f"The secret {name} cannot be passed.")
    return found


def environment_line(name, value):
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'{name}="{escaped}"\n'


def count_active(timeout):
    listed = command(
        [
            "systemctl",
            "list-units",
            "tokiwa-run-*",
            "--no-legend",
            "--plain",
            "--state=activating,active,deactivating",
        ],
        timeout,
    )
    if listed.returncode == TIMED_OUT:
        raise Refused("The call ran out of time.")
    if listed.returncode:
        raise Refused("The active runs could not be counted.")
    return len([line for line in listed.stdout.splitlines() if line.strip()])


def prune(now):
    for path in RUNS.iterdir():
        name = path.name.removesuffix(".env")
        if not re.fullmatch(ID_PATTERN, name):
            continue
        if now - path.lstat().st_mtime <= KEEP_SECONDS:
            continue
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)


def time_left(deadline):
    left = deadline - clock()
    if left <= 0:
        raise Refused("The call ran out of time.")
    return left


def lock_runs(deadline):
    lock = os.open(RUNS / ".lock", os.O_RDWR | os.O_CREAT, 0o600)
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return lock
        except BlockingIOError:
            if clock() >= deadline:
                os.close(lock)
                raise Refused("The command runner is busy.")
            time.sleep(0.05)


def remove_worktree(clone, work, seconds=20):
    command(
        git_command(clone, work, seconds, "worktree", "remove", "--force", str(work)), seconds
    )


def start(name, values, via, actor, now=None):
    """Check a call, start it in its own unit and return its first status.

    The whole call takes at most about START_SECONDS, and it waits up to WAIT_SECONDS of that
    for the run to end. Each call writes one log line, also a refused call. Raises Refused,
    after the log line, when a check fails or the time runs out; then no unit was started.
    """
    deadline = clock() + START_SECONDS
    now = time.time() if now is None else now
    line = {"at": int(now), "entry": name, "args": values, "via": via}
    if actor:
        line["actor"] = actor
    folder = env_file = clone = lock = None
    try:
        entries = load_list(LIST)
        if name not in entries:
            raise Refused("The entry is not in the command list.")
        entry = entries[name]
        filled = check_call(entry, values)
        writable = resolve_writable(name, entry, filled)
        RUNS.mkdir(parents=True, exist_ok=True, mode=0o755)
        # Held until systemd-run returns, so that two calls cannot both pass the count before
        # either unit is listed.
        lock = lock_runs(deadline)
        if count_active(time_left(deadline)) >= MAX_RUNNING:
            raise Refused(f"{MAX_RUNNING} runs are active, the most at one time.")
        prune(now)
        while True:
            run_id = new_id(now)
            try:
                (RUNS / run_id).mkdir()
                folder = RUNS / run_id
                break
            except FileExistsError:
                continue
        # Only work belongs to agent-workspace. Root writes the records and systemd opens the
        # output file as root, so no name beside them may be one that agent-workspace can plant.
        os.chmod(folder, 0o755)
        work = folder / "work"
        work.mkdir(mode=0o700)
        chown(work, USER)
        call = {"entry": name, "output_bytes": entry["output_bytes"], "at": now}
        if entry["cwd"] == "worktree":
            commit = filled[filled_name("commit", entry["args"]["commit"])]
            left = time_left(deadline)
            found = command(
                git_command(
                    filled["clone"], work, left, "cat-file", "-e", f"{commit}^{{commit}}"
                ),
                left,
            )
            if found.returncode == TIMED_OUT:
                raise Refused("The call ran out of time.")
            if found.returncode:
                raise Refused(f"The commit {commit} is not in the clone.")
            # Set before the add, so that a refusal also removes a worktree that is half made.
            clone = call["clone"] = filled["clone"]
            left = time_left(deadline)
            made = command(
                git_command(
                    clone, work, left, "worktree", "add", "--detach", str(work), commit
                ),
                left,
            )
            if made.returncode == TIMED_OUT:
                raise Refused("The call ran out of time.")
            if made.returncode:
                raise Refused("The worktree could not be made.")
        named = read_secrets(entry.get("secrets", []))
        if named:
            env_file = RUNS / f"{run_id}.env"
            descriptor = os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w") as f:
                f.write("".join(environment_line(k, v) for k, v in named.items()))
        (folder / "call.json").write_text(json.dumps(call))
        log({**line, "id": run_id, "state": "running"})
        argv = fill_argv(entry["argv"], filled)
        unit = unit_command(run_id, entry, argv, work, env_file, writable)
        started = command(unit, time_left(deadline))
    except (Refused, OSError, KeyError) as error:
        # KeyError: the agent-workspace user or group is missing.
        refusal = error
        if not isinstance(error, Refused):
            refusal = Refused("The run could not be prepared.")
        if clone is not None:
            remove_worktree(clone, folder / "work")
        if folder is not None:
            shutil.rmtree(folder, ignore_errors=True)
        if env_file is not None:
            env_file.unlink(missing_ok=True)
        try:
            log({**line, "refused": str(refusal)})
        except OSError:
            pass
        raise refusal from None
    finally:
        if lock is not None:
            os.close(lock)
    # A unit that started and then failed has already run its finish hook. After a timeout the
    # unit may still start, so status decides from systemd.
    if started.returncode not in (0, TIMED_OUT) and not (folder / "end.json").exists():
        finish(run_id, "start-failed", "")
    wait_until = min(deadline, clock() + WAIT_SECONDS)
    while not (folder / "end.json").exists() and clock() < wait_until:
        time.sleep(0.25)
    return status(run_id, 0, just_started=True)


def run_folder(run_id):
    # The id is checked before it becomes part of a path.
    if not (isinstance(run_id, str) and re.fullmatch(ID_PATTERN, run_id)):
        raise Refused("Use a run id from tokiwa run.")
    folder = RUNS / run_id
    call = read_record(folder / "call.json")
    if not isinstance(call, dict):
        raise Refused("Use a run id from tokiwa run.")
    return folder, call


def unit_state(run_id):
    """Return the state word of a run's unit from systemctl is-active, or None without one."""
    shown = command(["systemctl", "is-active", f"tokiwa-run-{run_id}"])
    state = shown.stdout.strip()
    # is-active exits 3 for a unit that is not active, so only a missing word is a failure.
    if shown.returncode == TIMED_OUT or not re.fullmatch(r"[a-z-]+", state):
        return None
    return state


def status(run_id, offset, just_started=False):
    """Return the state of a run and the page of its output that starts at a byte offset.

    A run with no end record whose unit is gone reports failed with exit None, and its secrets
    file is removed. Raises Refused for a value that is not the id of a run, for a negative
    offset, or when systemd gives no state for a run with no end record. Just after the start
    (just_started), such a run reports running instead, so that the caller keeps its id.
    """
    folder, call = run_folder(run_id)
    if not is_int(offset, 0, 10**12):
        raise Refused("Use an offset from an earlier result.")
    limit = call["output_bytes"]
    text, next_offset, size = page(folder / "output", offset, PAGE_BYTES, stop=limit)
    end = read_record(folder / "end.json")
    if isinstance(end, dict):
        state, code, truncated = end["state"], end["exit"], end["truncated"]
    else:
        truncated = size > limit
        active = unit_state(run_id)
        if active is None and not just_started:
            raise Refused(f"The state of run {run_id} could not be read.")
        # deactivating: the unit's process ended and its finish hook is still writing the end.
        # A just-started unit that systemd has not loaded yet reads as inactive for a moment.
        young = time.time() - call["at"] < WAIT_SECONDS + 5
        if active in (None, "active", "activating", "deactivating") or (
            active == "inactive" and young
        ):
            state, code = "running", None
        else:
            state, code = "failed", None
            # No finish hook ran, so nothing else removes the run's secrets file.
            (RUNS / f"{run_id}.env").unlink(missing_ok=True)
    return {
        "id": run_id,
        "entry": call["entry"],
        "state": state,
        "exit": code,
        "offset": offset,
        "next_offset": next_offset,
        "size": size,
        "truncated": truncated,
        "text": text,
    }


def unit_end(run_id):
    """Return the Result and the ExecMainStatus of a run's unit, or two empty strings.

    The finish hook reads them from systemd, because a variable of its environment could come
    from the unit's EnvironmentFile.
    """
    shown = command(
        [
            "systemctl", "show", "-p", "Result", "-p", "ExecMainStatus", "--value",
            f"tokiwa-run-{run_id}.service",
        ],
        5,
    )
    # --value prints the values without their names, in systemd's order; only ExecMainStatus
    # is a number.
    values = shown.stdout.split()
    numbers = [value for value in values if re.fullmatch(r"[0-9]+", value)]
    words = [value for value in values if value not in numbers]
    if shown.returncode or len(numbers) != 1 or len(words) != 1:
        return "", ""
    return words[0], numbers[0]


def finish(run_id, service_result, exit_status):
    """Record the end of a run, as its unit's ExecStopPost hook.

    service_result and exit_status are the Result and ExecMainStatus of the unit (unit_end).
    The exit is None unless the result is success or exit-code. Removes the run's secret file
    and worktree and cuts its output to the entry's output_bytes.
    """
    folder, call = run_folder(run_id)
    state = ENDS.get(service_result, "failed")
    code = None
    if service_result in EXITED and re.fullmatch(r"[0-9]+", exit_status):
        code = int(exit_status)
    output = folder / "output"
    # Recorded here, because the cut below makes the file no larger than output_bytes.
    truncated = output.exists() and output.stat().st_size > call["output_bytes"]
    try:
        (folder / "end.json").write_text(
            json.dumps({"state": state, "exit": code, "truncated": truncated})
        )
        log({"at": int(time.time()), "id": run_id, "state": state, "exit": code})
    finally:
        (RUNS / f"{run_id}.env").unlink(missing_ok=True)
        if "clone" in call:
            remove_worktree(call["clone"], folder / "work")
        if truncated:
            os.truncate(output, call["output_bytes"])


def encoded_size(text):
    return len(json.dumps(text, ensure_ascii=False).encode())


def page(path, offset, limit, stop=None):
    """Read the text of a file from a byte offset, as much as fits in limit bytes of JSON.

    The JSON form of the text, with its quotes, is at most limit bytes. stop is the byte where
    reading ends, or None for the file's end. Returns the text, the offset of the next page or
    None at the end, and the file size. The page takes as many raw bytes as fit, so it can end
    inside a multibyte character: the cut part decodes as U+FFFD, and the next page starts at
    the exact byte. A missing file reads as empty.
    """
    try:
        with open(path, "rb") as f:
            size = os.fstat(f.fileno()).st_size
            f.seek(offset)
            stop = size if stop is None else min(stop, size)
            # Each raw byte takes at least one byte of JSON, so limit bytes are enough to read.
            data = f.read(max(0, min(limit, stop - offset)))
    except OSError:
        return "", None, 0

    def fits(count):
        return encoded_size(data[:count].decode("utf-8", errors="replace")) <= limit

    low, high = 0, len(data)
    while low < high:
        middle = (low + high + 1) // 2
        if fits(middle):
            low = middle
        else:
            high = middle - 1
    # The size is not monotonic in the byte count: completing a character can shrink one
    # U+FFFD (3 bytes) to the character (2 bytes). A larger count fits at most 3 bytes later.
    for count in range(low + 1, min(low + 4, len(data) + 1)):
        if fits(count):
            low = count
    end = offset + low
    text = data[:low].decode("utf-8", errors="replace")
    return text, end if end < stop else None, size


def seal(result, certificate_b64):
    """Encrypt a result to the caller's one-time certificate, as a capture is, and return base64.

    Raises ValueError when the certificate is unusable.
    """
    try:
        certificate = base64.b64decode(certificate_b64, validate=True)
    except ValueError:
        raise ValueError("The result could not be encrypted.")
    sealed = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".pem") as pem:
            pem.write(certificate)
            pem.flush()
            sealed = subprocess.run(
                ["openssl", "smime", "-encrypt", "-aes256", "-binary", "-outform", "DER",
                 pem.name],
                input=json.dumps(result, ensure_ascii=False).encode(),
                capture_output=True,
                timeout=10,
            )
    except (OSError, subprocess.TimeoutExpired):
        pass
    if sealed is None or sealed.returncode or not sealed.stdout:
        raise ValueError("The result could not be encrypted.")
    return base64.b64encode(sealed.stdout).decode()


def read_payload(text):
    try:
        payload = json.loads(base64.b64decode(text, validate=True))
    except ValueError:
        payload = None
    if not (
        isinstance(payload, dict)
        and set(payload) == {"entry", "args"}
        and isinstance(payload["entry"], str)
        and isinstance(payload["args"], dict)
        and all(isinstance(v, str) for v in payload["args"].values())
    ):
        raise Refused("The call is not base64 JSON with entry and args.")
    return payload


def main(argv):
    if os.geteuid() != 0:
        raise Refused("The command runner needs root.")
    match argv:
        case ["commands"]:
            print(json.dumps(public_view(load_list(LIST))))
        case ["start", payload, certificate]:
            call = read_payload(payload)
            # A certificate that fails here would leave a started run with no id for the caller.
            try:
                seal({}, certificate)
            except ValueError as error:
                raise Refused(str(error))
            via = os.environ.get("TOKIWA_VIA", "cli")
            actor = os.environ.get("TOKIWA_ACTOR", "")
            print(
                seal(
                    start(
                        call["entry"],
                        call["args"],
                        via if re.fullmatch(VIA_PATTERN, via) else "cli",
                        actor if re.fullmatch(ACTOR_PATTERN, actor) else "",
                    ),
                    certificate,
                )
            )
        case ["status", run_id, offset, certificate]:
            if not re.fullmatch(r"[0-9]{1,12}", offset):
                raise Refused("Use an offset from an earlier result.")
            print(seal(status(run_id, int(offset)), certificate))
        case ["finish", run_id]:
            # The id is checked before it names a unit.
            run_folder(run_id)
            finish(run_id, *unit_end(run_id))
        case _:
            raise Refused("Use commands, start, status or finish.")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (Refused, ValueError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
