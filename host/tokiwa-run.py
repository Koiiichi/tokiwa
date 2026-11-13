"""Run commands that the owner listed, as root, on the host."""

import json
import re
from pathlib import Path

LIST = Path("/etc/tokiwa/commands.json")
RUNS = Path("/srv/development/cache/tokiwa-runs")
LOG = Path("/var/log/tokiwa/run.jsonl")
HOME = Path("/srv/development/private/homes/workbench")
SECRETS = HOME / ".tokiwa/secrets.env"
PAGE_BYTES = 15000
MAX_RUNNING = 4
KEEP_SECONDS = 14 * 86400
WAIT_SECONDS = 8
ID_PATTERN = r"^[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$"
NAME_PATTERN = r"^[a-z][a-z0-9_-]{0,47}$"
SECRET_PATTERN = r"^[A-Z_][A-Z0-9_]{0,63}$"
ENTRY_KEYS = {
    "description",
    "argv",
    "args",
    "cwd",
    "home",
    "secrets",
    "timeout_seconds",
    "output_bytes",
}
ARG_KINDS = ("pattern", "choice", "path_below")
PLACEHOLDER = re.compile(r"\{([^{}]*)\}")


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
    if not is_int(entry.get("timeout_seconds"), 1, 86400):
        raise ValueError("timeout_seconds is not an integer from 1 to 86400")
    if not is_int(entry.get("output_bytes"), 1, 10_000_000):
        raise ValueError("output_bytes is not an integer from 1 to 10000000")
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
    root = Path(arg["path_below"]).resolve()
    try:
        path = (root / value).resolve(strict=True)
    except (OSError, RuntimeError):
        raise Refused(f"The path of {name} does not exist.")
    if not path.is_relative_to(root):
        raise Refused(f"The path of {name} is not below its root.")
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


def fill_argv(argv, filled):
    """Put each filled value into its placeholders, keeping each value whole."""
    return [
        PLACEHOLDER.sub(lambda match: filled[match.group(1)], item) for item in argv
    ]
