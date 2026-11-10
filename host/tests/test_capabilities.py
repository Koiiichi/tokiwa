"""Check that app/capabilities.json and the launcher describe the same commands.

The MCP server builds its tools from the table, so a command that the table and the launcher
describe differently would fail only when an agent calls it.
"""
import json
import unittest
from pathlib import Path

import test_terminal_cli as cli

TABLE = json.loads((Path(__file__).resolve().parents[2] / 'app/capabilities.json').read_text())
CAPABILITIES = TABLE['capabilities']


class Capabilities(unittest.TestCase):
    setUp = cli.TerminalCLI.setUp
    tearDown = cli.TerminalCLI.tearDown
    run_cli = cli.TerminalCLI.run_cli

    def test_the_table_and_the_help_list_the_same_commands(self):
        # A command line of the help is indented two spaces; a wrapped line is indented further.
        listed = {line.split()[0] for line in self.run_cli('--help').stdout.splitlines()
                  if line.startswith('  ') and not line.startswith('   ')}
        described = {c['command'] for c in CAPABILITIES if not c.get('hidden')}
        described |= {alias for c in CAPABILITIES for alias in c.get('aliases', [])}
        self.assertEqual(listed, described)

    def test_each_example_reaches_its_helper_mode(self):
        for capability in CAPABILITIES:
            if 'example' not in capability:
                continue
            with self.subTest(command=capability['command']):
                (self.home / 'calls').unlink(missing_ok=True)
                result = self.run_cli(*capability['example'])
                self.assertEqual(result.returncode, 0, result.stderr)
                if 'helper' in capability:
                    self.assertIn(f"terminal-session.sh {capability['helper']}", (self.home / 'calls').read_text())

    def test_each_tool_fills_in_to_its_example(self):
        for capability in CAPABILITIES:
            tool = capability.get('tool')
            if not tool:
                continue
            with self.subTest(tool=tool['name']):
                argv, example = tool['argv'], capability['example']
                self.assertEqual(len(argv), len(example))
                for part, value in zip(argv, example):
                    if part.startswith('{'):
                        self.assertIn(part[1:-1], tool['args'])
                    else:
                        self.assertEqual(part, value)
                for spec in tool['args'].values():
                    if 'pattern' in spec:
                        self.assertIn(spec['pattern'], TABLE['patterns'])

    def test_classes_are_known_and_human_commands_have_no_tool(self):
        for capability in CAPABILITIES:
            with self.subTest(command=capability['command']):
                self.assertIn(capability['class'], TABLE['classes'])
                if capability['class'] == 'human':
                    self.assertNotIn('tool', capability)
                if 'run_option' in capability:
                    self.assertEqual(capability['class'], 'control')


if __name__ == '__main__':
    unittest.main()
