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
# Each tool with its command: an entry has one tool, or a list of them when one command serves several.
TOOLS = [(c, t) for c in CAPABILITIES for t in ([c['tool']] if 'tool' in c else c.get('tools', []))]


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
        examples = [(c, c['example']) for c in CAPABILITIES if 'example' in c]
        examples += [(c, t['example']) for c, t in TOOLS if 'example' in t]
        for capability, example in examples:
            with self.subTest(example=example):
                (self.home / 'calls').unlink(missing_ok=True)
                result = self.run_cli(*example)
                self.assertEqual(result.returncode, 0, result.stderr)
                if 'helper' in capability:
                    self.assertIn(f"terminal-session.sh {capability['helper']}", (self.home / 'calls').read_text())

    def test_each_tool_fills_in_to_its_example(self):
        for capability, tool in TOOLS:
            with self.subTest(tool=tool['name']):
                argv, example = tool['argv'], tool.get('example', capability.get('example'))
                if argv and argv[-1].endswith('...}'):
                    # A {name...} part matches every remaining example item, each as NAME=VALUE.
                    name, rest = argv[-1][1:-4], example[len(argv) - 1:]
                    self.assertEqual(tool['args'][name]['type'], 'pairs')
                    for item in rest:
                        self.assertRegex(item, r'^[a-z][a-z0-9_-]{0,47}=.+$')
                    argv, example = argv[:-1], example[:len(argv) - 1]
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
                    self.assertNotIn('tools', capability)
                if 'run_option' in capability:
                    self.assertEqual(capability['class'], 'control')

    def test_commands_class_is_separate_from_run(self):
        by_name = {t['name']: (c, t) for c, t in TOOLS}
        effective = {t['name']: t.get('class', c['class']) for c, t in TOOLS}
        self.assertEqual({n for n, k in effective.items() if k == 'commands'}, {'tokiwa_run'})
        self.assertNotIn('tokiwa_run', {n for n, k in effective.items() if k == 'run'})
        self.assertEqual(by_name['tokiwa_run'][0]['class'], 'commands')
        self.assertEqual(by_name['tokiwa_launch'][1].get('class', by_name['tokiwa_launch'][0]['class']), 'run')
        self.assertEqual(by_name['tokiwa_commands'][0]['class'], 'read')
        self.assertEqual(by_name['tokiwa_run_status'][0]['class'], 'read')


if __name__ == '__main__':
    unittest.main()
