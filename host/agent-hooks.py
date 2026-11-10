"""Add Tokiwa's state hooks to the Claude Code and Codex settings of the workbench user, or remove them."""

import json
import os
import sys
from pathlib import Path

COMMAND = "/usr/local/bin/tokiwa-state"
# (event, matcher or None, state). Claude Code reports no event when Esc stops a turn: tokiwa interrupt
# sets idle itself, and idle_prompt covers an Esc that a person typed.
CLAUDE = [
    ("UserPromptSubmit", None, "working"),
    ("PostToolUse", None, "working"),
    ("PreToolUse", "AskUserQuestion", "waiting"),
    ("Notification", "permission_prompt|elicitation_dialog|elicitation_url_dialog", "waiting"),
    ("Notification", "idle_prompt", "idle"),
    ("Notification", "quota_auto_resume_fired", "working"),
    ("Notification", "quota_auto_resume_stale", "limited"),
    ("Elicitation", None, "waiting"),
    ("ElicitationResult", None, "working"),
    ("Stop", None, "idle"),
    ("StopFailure", "rate_limit", "limited"),
    (
        "StopFailure",
        "overloaded|authentication_failed|oauth_org_not_allowed|account_on_hold|billing_error|"
        "invalid_request|model_not_found|server_error|max_output_tokens|cloud_credential_error|unknown",
        "error",
    ),
]
# Codex has no hook for a rate limit, so a Codex agent never reports limited.
CODEX = [
    ("UserPromptSubmit", None, "working"),
    ("PostToolUse", None, "working"),
    ("PermissionRequest", None, "waiting"),
    ("Stop", None, "idle"),
    ("Interrupt", None, "idle"),
]


def ours(handler):
    return handler.get("command", "").startswith(COMMAND + " ")


def without_ours(hooks):
    kept = {}
    for event, groups in hooks.items():
        groups = [{**group, "hooks": [h for h in group.get("hooks", []) if not ours(h)]} for group in groups]
        groups = [group for group in groups if group["hooks"]]
        if groups:
            kept[event] = groups
    return kept


def merged(config, table, handler):
    """Return the config with Tokiwa's hooks after every other hook of each event.

    Codex trusts each hook by its place in the list of its event, so the other hooks keep their
    places, and with them their trust.
    """
    hooks = without_ours(config.get("hooks", {}))
    for event, matcher, state in table:
        group = {"matcher": matcher} if matcher else {}
        group["hooks"] = [{"type": "command", "command": f"{COMMAND} {state}", **handler}]
        hooks.setdefault(event, []).append(group)
    return {**config, "hooks": hooks}


def read(path):
    if not path.exists():
        return {}
    try:
        config = json.loads(path.read_text())
    except ValueError:
        config = None
    if not isinstance(config, dict):
        raise SystemExit(f"{path} is not a JSON object. Nothing was changed.")
    return config


def write(path, config):
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    temp = path.with_name(path.name + ".tokiwa-new")
    with os.fdopen(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode), "w") as f:
        f.write(json.dumps(config, indent=2) + "\n")
    os.chmod(temp, mode)
    os.replace(temp, path)


def main(argv):
    if len(argv) != 3 or argv[0] not in ("install", "remove"):
        raise SystemExit("Use agent-hooks.py install|remove CLAUDE_SETTINGS CODEX_HOOKS.")
    action, claude_path, codex_path = argv[0], Path(argv[1]), Path(argv[2])
    # Both files are read before either is written, so a file that cannot be read changes nothing.
    claude, codex = read(claude_path), read(codex_path)
    if action == "install":
        # An async hook never holds the agent; Claude Code waits for no result from it.
        claude = merged(claude, CLAUDE, {"async": True})
        codex = merged(codex, CODEX, {"timeout": 5})
    else:
        claude = {**claude, "hooks": without_ours(claude.get("hooks", {}))}
        codex = {**codex, "hooks": without_ours(codex.get("hooks", {}))}
    for path, config in [(claude_path, claude), (codex_path, codex)]:
        path.parent.mkdir(parents=True, exist_ok=True)
        write(path, config)


if __name__ == "__main__":
    main(sys.argv[1:])
