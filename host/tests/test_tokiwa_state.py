"""Check that tokiwa-state records agent hook events as options of a tmux session."""

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "tokiwa-state"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "hooks"


def fixture(name):
    return (FIXTURES / f"{name}.json").read_text()


class TokiwaState(unittest.TestCase):
    """A disposable tmux server with one session, and tokiwa-state run in its pane."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tokiwa-test-")
        self.socket = str(Path(self.temp.name) / "tmux.sock")
        self.tmux = shutil.which("tmux")
        self.server = subprocess.Popen([self.tmux, "-D", "-S", self.socket, "-f", "/dev/null"])
        for _ in range(100):
            if self.tm("show-options", "-s", "exit-empty").returncode == 0:
                break
            time.sleep(0.02)
        else:
            self.fail("The test server did not start.")
        self.tm("new-session", "-d", "-s", "worker-a", "sleep 600")
        self.pane = self.tm("list-panes", "-t", "=worker-a:", "-F", "#{pane_id}").stdout.strip()

    def tearDown(self):
        self.tm("kill-server")
        self.server.wait(timeout=30)
        self.temp.cleanup()

    def tm(self, *args):
        return subprocess.run([self.tmux, "-N", "-S", self.socket, *args], capture_output=True, text=True)

    def option(self, name):
        return self.tm("show-options", "-qv", "-t", "=worker-a:", name).stdout.strip()

    def decoded(self, name):
        return json.loads(base64.b64decode(self.option(name)))

    def record(self, *args, stdin="", env=None, timeout=30):
        env = env if env is not None else dict(os.environ, TMUX=f"{self.socket},1,0", TMUX_PANE=self.pane)
        result = subprocess.run([sys.executable, str(SCRIPT), *args], input=stdin, env=env,
                                capture_output=True, text=True, timeout=timeout)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def test_turn_increments_on_turn_start(self):
        self.record("working", "--turn", stdin=fixture("claude-user-prompt-submit"))
        self.record("working", "--turn", stdin=fixture("claude-user-prompt-submit"))
        self.assertEqual(self.option("@tokiwa_agent_turn"), "2")

    def test_working_without_turn_keeps_the_turn(self):
        self.record("working", "--turn", stdin=fixture("claude-user-prompt-submit"))
        self.record("working", stdin=fixture("claude-pre-tool-use-bash"))
        self.assertEqual(self.option("@tokiwa_agent_turn"), "1")

    def test_transcript_and_session_id_are_recorded(self):
        for name, session in [("claude-user-prompt-submit", "claude-session-a"),
                              ("codex-user-prompt-submit", "codex-thread-a")]:
            data = json.loads(fixture(name))
            self.record("working", "--turn", stdin=fixture(name))
            self.assertEqual(self.option("@tokiwa_agent_transcript"), data["transcript_path"])
            self.assertEqual(self.option("@tokiwa_agent_session"), session)

    def test_question_tool_records_a_question(self):
        self.record("waiting", "--kind", "question", stdin=fixture("claude-pre-tool-use-ask-user-question"))
        pending = self.decoded("@tokiwa_agent_pending")
        self.assertEqual(pending["kind"], "question")
        self.assertEqual(pending["id"], "toolu_question_a")
        self.assertEqual(pending["options"], ["Text parser", "Binary parser"])
        self.assertEqual(pending["summary"], "Which parser should the test cover?")
        self.assertIsInstance(pending["at"], int)

    def test_question_tool_records_its_source_and_shape(self):
        self.record("waiting", "--kind", "question", stdin=fixture("claude-pre-tool-use-ask-user-question"))
        pending = self.decoded("@tokiwa_agent_pending")
        self.assertEqual((pending["tool"], pending["questions"], pending["multi_select"]), ("AskUserQuestion", 1, False))

    def test_question_tool_records_several_questions_and_multi_select(self):
        data = json.loads(fixture("claude-pre-tool-use-ask-user-question"))
        first = data["tool_input"]["questions"][0]
        data["tool_input"]["questions"] = [dict(first, multiSelect=True), dict(first)]
        self.record("waiting", "--kind", "question", stdin=json.dumps(data))
        pending = self.decoded("@tokiwa_agent_pending")
        self.assertEqual((pending["questions"], pending["multi_select"]), (2, True))

    def test_an_elicitation_form_records_its_event_as_the_source(self):
        self.record("waiting", "--kind", "question", stdin=fixture("claude-elicitation-form"))
        pending = self.decoded("@tokiwa_agent_pending")
        self.assertEqual((pending["tool"], pending["options"], pending["questions"]), ("Elicitation", [], 0))

    def test_long_question_is_cut_to_500_characters(self):
        data = json.loads(fixture("claude-pre-tool-use-ask-user-question"))
        data["tool_input"]["questions"][0]["question"] = "q" * 900
        self.record("waiting", "--kind", "question", stdin=json.dumps(data))
        self.assertEqual(len(self.decoded("@tokiwa_agent_pending")["summary"]), 500)

    def test_permission_notification_uses_the_last_tool(self):
        self.record("note", stdin=fixture("claude-pre-tool-use-bash"))
        self.record("waiting", "--kind", "permission", stdin=fixture("claude-notification-permission"))
        pending = self.decoded("@tokiwa_agent_pending")
        self.assertEqual(pending["kind"], "permission")
        self.assertIn("Bash", pending["summary"])
        self.assertIn("make check", pending["summary"])
        self.assertEqual(self.decoded("@tokiwa_agent_last_tool")["tool"], "Bash")

    def test_codex_permission_request_names_the_tool(self):
        self.record("waiting", "--kind", "permission", stdin=fixture("codex-permission-request"))
        pending = self.decoded("@tokiwa_agent_pending")
        self.assertIn("rm -rf build/", pending["summary"])
        self.assertEqual(len(pending["id"]), 16)

    def test_url_elicitation_is_a_permission(self):
        self.record("waiting", "--kind", "question", stdin=fixture("claude-elicitation-url"))
        pending = self.decoded("@tokiwa_agent_pending")
        self.assertEqual(pending["kind"], "permission")
        self.assertIn("https://auth.example.com/login", pending["summary"])

    def test_form_elicitation_stays_a_question(self):
        self.record("waiting", "--kind", "question", stdin=fixture("claude-elicitation-form"))
        pending = self.decoded("@tokiwa_agent_pending")
        self.assertEqual(pending["kind"], "question")
        self.assertEqual(pending["summary"], "Please provide a name")

    def test_working_and_idle_clear_the_pending_item(self):
        for state in ["working", "idle"]:
            self.record("waiting", "--kind", "question", stdin=fixture("claude-elicitation-form"))
            self.assertTrue(self.option("@tokiwa_agent_pending"))
            self.record(state, stdin=fixture("claude-pre-tool-use-bash"))
            self.assertEqual(self.option("@tokiwa_agent_pending"), "")

    def agent_input(self, pending_id="toolu_question_a", actor="orchestrator-a"):
        item = {"actor": actor, "pending_id": pending_id, "at": 5}
        self.tm("set-option", "-t", "=worker-a:", "@tokiwa_agent_input",
                base64.b64encode(json.dumps(item).encode()).decode())

    def test_answered_hook_adds_the_label_for_the_matching_question(self):
        self.agent_input()
        result = self.record("answered", stdin=fixture("claude-post-tool-use-ask-user-question"))
        output = json.loads(result.stdout)["hookSpecificOutput"]
        self.assertEqual(output["hookEventName"], "PostToolUse")
        self.assertEqual(output["additionalContext"],
                         "The answer to this question was chosen by agent orchestrator-a through Tokiwa, "
                         "not by the owner. It carries no owner approval.")
        # The label is used once.
        self.assertEqual(self.option("@tokiwa_agent_input"), "")

    def test_answered_hook_is_silent_for_another_question(self):
        self.agent_input(pending_id="toolu_other")
        result = self.record("answered", stdin=fixture("claude-post-tool-use-ask-user-question"))
        self.assertEqual(result.stdout, "")

    def test_answered_hook_is_silent_without_an_agent_answer(self):
        self.assertEqual(self.record("answered", stdin=fixture("claude-post-tool-use-ask-user-question")).stdout, "")
        # A value that is not an input record, and bad JSON, are silent too and exit 0.
        self.tm("set-option", "-t", "=worker-a:", "@tokiwa_agent_input", "not-base64!")
        self.assertEqual(self.record("answered", stdin=fixture("claude-post-tool-use-ask-user-question")).stdout, "")
        self.assertEqual(self.record("answered", stdin="{not json").stdout, "")

    def test_answered_hook_does_not_change_the_state(self):
        self.record("waiting", "--kind", "question", stdin=fixture("claude-pre-tool-use-ask-user-question"))
        before = self.option("@tokiwa_agent")
        self.agent_input()
        self.record("answered", stdin=fixture("claude-post-tool-use-ask-user-question"))
        self.assertEqual(self.option("@tokiwa_agent"), before)

    def test_session_start_records_idle(self):
        self.record("idle", stdin=fixture("claude-session-start"))
        self.assertTrue(self.option("@tokiwa_agent").startswith("idle:"))

    def test_ended_clears_agent_and_pending(self):
        self.record("waiting", "--kind", "question", stdin=fixture("claude-elicitation-form"))
        self.record("ended", stdin=fixture("claude-session-end"))
        self.assertEqual(self.option("@tokiwa_agent"), "")
        self.assertEqual(self.option("@tokiwa_agent_pending"), "")

    def test_note_changes_no_state(self):
        self.record("working", stdin=fixture("claude-pre-tool-use-bash"))
        before = self.option("@tokiwa_agent")
        self.record("note", stdin=fixture("codex-pre-tool-use"))
        self.assertEqual(self.option("@tokiwa_agent"), before)

    def test_a_repeated_state_keeps_its_first_time(self):
        self.record("working", stdin=fixture("claude-pre-tool-use-bash"))
        self.tm("set-option", "-t", "=worker-a:", "@tokiwa_agent", "working:100")
        self.record("working", stdin=fixture("claude-pre-tool-use-bash"))
        self.assertEqual(self.option("@tokiwa_agent"), "working:100")

    def test_bad_json_records_the_state_and_exits_0(self):
        self.record("waiting", "--kind", "question", stdin="{not json")
        self.assertTrue(self.option("@tokiwa_agent").startswith("waiting:"))
        self.assertEqual(self.decoded("@tokiwa_agent_pending")["kind"], "question")

    def test_unknown_state_exits_0_and_changes_nothing(self):
        self.record("bogus", stdin=fixture("claude-pre-tool-use-bash"))
        self.assertEqual(self.option("@tokiwa_agent"), "")
        self.assertEqual(self.option("@tokiwa_agent_transcript"), "")

    def test_outside_tmux_exits_0(self):
        env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
        self.record("working", stdin=fixture("claude-pre-tool-use-bash"), env=env)
        self.assertEqual(self.option("@tokiwa_agent"), "")

    def test_more_than_64_kib_of_input_is_read_and_ignored(self):
        data = json.loads(fixture("claude-pre-tool-use-bash"))
        data["padding"] = "x" * 200_000
        self.record("working", stdin=json.dumps(data), timeout=10)
        # The input is cut at 64 KiB, so it does not parse and nothing of it is recorded.
        self.assertTrue(self.option("@tokiwa_agent").startswith("working:"))
        self.assertEqual(self.option("@tokiwa_agent_transcript"), "")


if __name__ == "__main__":
    unittest.main()
