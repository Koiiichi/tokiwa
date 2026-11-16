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
    stub_app = cli.TerminalCLI.stub_app

    def test_the_table_and_the_help_list_the_same_commands(self):
        # A command line of the help is indented two spaces; a wrapped line is indented further.
        # `agent` is a family of commands: its subcommand is part of the name, as in `agent state`.
        words = [line.split() for line in self.run_cli('--help').stdout.splitlines()
                 if line.startswith('  ') and not line.startswith('   ')]
        listed = {' '.join(w[:2]) if w[0] == 'agent' else w[0] for w in words}
        described = {c['command'] for c in CAPABILITIES if not c.get('hidden')}
        described |= {alias for c in CAPABILITIES for alias in c.get('aliases', [])}
        self.assertEqual(listed, described)

    def test_each_example_reaches_its_helper_mode(self):
        examples = [(c, c['example']) for c in CAPABILITIES if 'example' in c]
        examples += [(c, t['example']) for c, t in TOOLS if 'example' in t]
        # claim and release refuse without an actor.
        self.env['TOKIWA_ACTOR'] = 'worker-a'
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
                # An optional part `{name?--option}` is not in the example: it must name an argument.
                for part in [a for a in argv if a.startswith('{') and '?' in a]:
                    self.assertIn(part[1:part.index('?')], tool['args'])
                argv = [a for a in argv if not ('{' in a and '?' in a)]
                if len(argv) != len(tool['argv']):
                    # The example may hold the optional options: compare the fixed part.
                    example = example[:len(argv)]
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

    def test_agent_tools_follow_the_layer_split(self):
        effective = {t['name']: t.get('class', c['class']) for c, t in TOOLS}
        for name in ['tokiwa_state', 'tokiwa_agent_state', 'tokiwa_agent_wait', 'tokiwa_agent_read']:
            self.assertEqual(effective[name], 'read')
        for name in ['tokiwa_agent_send', 'tokiwa_claim', 'tokiwa_release', 'tokiwa_end']:
            self.assertEqual(effective[name], 'control')
        self.assertEqual(effective['tokiwa_agent_answer'], 'answer')
        by_name = {t['name']: t for _, t in TOOLS}
        self.assertTrue(by_name['tokiwa_agent_read'].get('untrusted_output'))
        self.assertNotIn('text', by_name['tokiwa_agent_answer']['args'])
        self.assertEqual(by_name['tokiwa_agent_wait']['args']['timeout'],
                         {'type': 'integer', 'minimum': 1, 'maximum': 300, 'default': 60})

    def test_mcp_accepts_answer_and_actor(self):
        self.stub_app()
        for args in [('--allow', 'answer'), ('--allow', 'control,answer'), ('--actor', 'worker-a'),
                     ('--allow', 'answer', '--actor', 'a.b:c_d-1'), ('--actor', 'w', '--allow', 'run,answer')]:
            result = self.run_cli('mcp', *args)
            self.assertEqual((result.returncode, result.stdout), (0, 'app mcp ' + ' '.join(args)), (args, result.stderr))

    def test_mcp_refuses_a_bad_actor(self):
        self.stub_app()
        for args in [('--actor',), ('--actor', 'bad;rm'), ('--actor', '-x'), ('--actor', 'a' * 65),
                     ('--actor', 'a', '--actor', 'b'), ('--allow', 'answer,answer'), ('--actor', 'a', 'x')]:
            self.assertNotEqual(self.run_cli('mcp', *args).returncode, 0, args)


if __name__ == '__main__':
    unittest.main()
