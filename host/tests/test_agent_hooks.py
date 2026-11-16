"""Check that agent-hooks.py adds Tokiwa's state hooks beside other hooks and leaves them unchanged."""

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "agent-hooks.py"
spec = importlib.util.spec_from_file_location("agent_hooks", SCRIPT)
hooks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hooks)

STATE = "/usr/local/bin/tokiwa-state"
OTHER_CLAUDE = {
    "model": "opus",
    "hooks": {
        "Stop": [{"hooks": [{"type": "command", "command": "peers hook stop"}]}],
        "PostToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "python3 other.py"}]}],
    },
}
OTHER_CODEX = {
    "hooks": {
        "Stop": [{"hooks": [{"type": "command", "command": "peers hook stop"}]}],
        "SessionStart": [{"hooks": [{"type": "command", "command": "peers hook start"}]}],
    }
}


def states(config, event):
    """The (matcher, arguments) pairs of Tokiwa's hooks for one event."""
    found = []
    for group in config["hooks"].get(event, []):
        for handler in group["hooks"]:
            if handler["command"].startswith(STATE + " "):
                found.append((group.get("matcher"), handler["command"][len(STATE) + 1:]))
    return found


class AgentHooks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.claude, self.codex = root / "claude/settings.json", root / "codex/hooks.json"
        self.claude.parent.mkdir()
        self.codex.parent.mkdir()
        self.claude.write_text(json.dumps(OTHER_CLAUDE, indent=2))
        self.codex.write_text(json.dumps(OTHER_CODEX, indent=2))

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, action):
        return subprocess.run([sys.executable, str(SCRIPT), action, str(self.claude), str(self.codex)],
                              capture_output=True, text=True, timeout=30)

    def read(self, path):
        return json.loads(path.read_text())

    def test_install_appends_after_the_other_hooks_and_keeps_them(self):
        self.assertEqual(self.run_script("install").returncode, 0)
        claude, codex = self.read(self.claude), self.read(self.codex)
        self.assertEqual(claude["model"], "opus")
        # Codex trusts each hook by its place in the list, so the other hooks keep theirs.
        for config, other in [(claude, OTHER_CLAUDE), (codex, OTHER_CODEX)]:
            for event, groups in other["hooks"].items():
                self.assertEqual(config["hooks"][event][: len(groups)], groups)
        self.assertEqual(states(claude, "Stop"), [(None, "idle")])
        self.assertEqual(states(claude, "PreToolUse"), [(None, "note"), ("AskUserQuestion", "waiting --kind question")])
        self.assertEqual(states(claude, "UserPromptSubmit"), [(None, "working --turn")])
        # Compaction also starts a session, often mid-turn: it must not mark the agent idle.
        self.assertEqual(states(claude, "SessionStart"), [("startup|resume|clear|fork", "idle")])
        self.assertEqual(states(claude, "SessionEnd"), [(None, "ended")])
        self.assertEqual(states(claude, "Elicitation"), [(None, "waiting --kind question")])
        self.assertIn(("rate_limit", "limited"), states(claude, "StopFailure"))
        self.assertIn(("permission_prompt|elicitation_url_dialog", "waiting --kind permission"),
                      states(claude, "Notification"))
        self.assertIn(("elicitation_dialog", "waiting --kind question"), states(claude, "Notification"))
        self.assertEqual(states(codex, "PermissionRequest"), [(None, "waiting --kind permission")])
        self.assertEqual(states(codex, "UserPromptSubmit"), [(None, "working --turn")])
        self.assertEqual(states(codex, "PreToolUse"), [(None, "note")])
        self.assertEqual(states(codex, "SessionStart"), [("startup|resume|clear|fork", "idle")])
        self.assertEqual(states(codex, "SessionEnd"), [(None, "ended")])
        self.assertEqual(states(codex, "Interrupt"), [(None, "idle")])
        claude_handler = claude["hooks"]["Stop"][-1]["hooks"][0]
        self.assertTrue(claude_handler["async"])
        # The answered hook adds context to the agent, so it is synchronous and has a timeout.
        self.assertIn(("AskUserQuestion", "answered"), states(claude, "PostToolUse"))
        answered = [h for g in claude["hooks"]["PostToolUse"] if g.get("matcher") == "AskUserQuestion" for h in g["hooks"]
                    if h["command"].endswith(" answered")][0]
        self.assertNotIn("async", answered)
        self.assertEqual(answered["timeout"], 5)
        self.assertEqual(codex["hooks"]["Stop"][-1]["hooks"][0]["timeout"], 5)
        # Codex clamps the timeout of these two events to 3 seconds and warns at each start about a longer one.
        for event in ("SessionEnd", "Interrupt"):
            self.assertEqual(codex["hooks"][event][-1]["hooks"][0]["timeout"], 3)

    def test_install_replaces_an_earlier_hook_that_has_no_arguments_after_the_state(self):
        self.claude.write_text(json.dumps({"hooks": {"Stop": [
            {"hooks": [{"type": "command", "command": STATE + " working"}]}]}}))
        self.run_script("install")
        self.assertEqual(states(self.read(self.claude), "Stop"), [(None, "idle")])

    def test_a_second_install_changes_nothing(self):
        self.run_script("install")
        first = (self.claude.read_text(), self.codex.read_text())
        self.assertEqual(self.run_script("install").returncode, 0)
        self.assertEqual((self.claude.read_text(), self.codex.read_text()), first)

    def test_remove_leaves_only_the_other_hooks(self):
        self.run_script("install")
        self.assertEqual(self.run_script("remove").returncode, 0)
        self.assertEqual(self.read(self.claude), OTHER_CLAUDE)
        self.assertEqual(self.read(self.codex), OTHER_CODEX)

    def test_missing_files_are_created_private(self):
        self.claude.unlink()
        self.codex.unlink()
        self.assertEqual(self.run_script("install").returncode, 0)
        for path in [self.claude, self.codex]:
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertTrue(states(self.read(path), "Stop"))

    def test_a_file_that_is_not_a_json_object_is_refused_unchanged(self):
        self.claude.write_text("not json")
        result = self.run_script("install")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("settings.json", result.stderr)
        self.assertEqual(self.claude.read_text(), "not json")
        self.assertEqual(self.read(self.codex), OTHER_CODEX)


if __name__ == "__main__":
    unittest.main()
