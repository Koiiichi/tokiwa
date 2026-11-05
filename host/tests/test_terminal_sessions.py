"""Exercise terminal recovery against a disposable tmux server."""
from pathlib import Path
import os
import json
import base64
import pty
import select
import shutil
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]

class Server(unittest.TestCase):
    """A disposable tmux server and the helper that runs against it."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='tokiwa-test-')
        self.socket = str(Path(self.temp.name) / 'tmux.sock')
        self.tmux = shutil.which('tmux')
        self.server = subprocess.Popen([self.tmux, '-D', '-S', self.socket, '-f', '/dev/null'])
        self.env = dict(os.environ, TOKIWA_SOCKET=self.socket, TOKIWA_WORKDIR=self.temp.name,
                        TOKIWA_STATE=str(Path(self.temp.name) / 'state'))
        for _ in range(100):
            if self.tm('show-options', '-s', 'exit-empty').returncode == 0:
                return
            time.sleep(.02)
        self.fail('The test server did not start.')

    def tearDown(self):
        self.tm('kill-server')
        self.server.wait(timeout=30)
        self.temp.cleanup()

    def tm(self, *args):
        return subprocess.run([self.tmux, '-N', '-S', self.socket, *args], capture_output=True, text=True)

    def helper(self, *args):
        return subprocess.run(['bash', str(ROOT / 'terminal-session.sh'), *args], env=self.env,
                              capture_output=True, text=True, timeout=30)


class ScreenCapture(Server):
    """`capture` of a session that printed known text."""

    def session(self, name, text):
        """Start a session that shows text and stays open. Return its identity."""
        path = Path(self.temp.name) / f'{name}.txt'
        path.write_text(text, encoding='utf-8')
        marker = f'printed-{name}'
        self.tm('new-session', '-d', '-s', name, '-x', '80', '-y', '24', 'sh', '-c',
                f'cat "{path}"; echo; echo {marker}; exec sleep 300')
        for _ in range(200):
            if marker in self.tm('capture-pane', '-p', '-t', f'={name}:').stdout:
                break
            time.sleep(.02)
        else:
            self.fail('The session did not print its text.')
        rows = json.loads(self.helper('snapshot').stdout)['sessions']
        return next(r['identity'] for r in rows if r['name'] == name)

    def keys(self):
        """A one-time key pair, as the launcher makes it. Return the recipient as base64."""
        self.key = Path(self.temp.name) / 'key.pem'
        self.cert = Path(self.temp.name) / 'cert.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-keyout', str(self.key),
                        '-out', str(self.cert), '-subj', '/CN=tokiwa-capture', '-days', '1'],
                       check=True, capture_output=True)
        return base64.b64encode(self.cert.read_bytes()).decode()

    def sealed(self, name, identity, lines='200'):
        """The helper's raw stdout for a capture."""
        result = self.helper('capture', name, identity, lines, self.keys())
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def capture(self, name, identity, lines='200'):
        sealed = base64.b64decode(self.sealed(name, identity, lines))
        opened = subprocess.run(['openssl', 'smime', '-decrypt', '-binary', '-inform', 'DER', '-inkey', str(self.key),
                                 '-recip', str(self.cert)], input=sealed, capture_output=True)
        self.assertEqual(opened.returncode, 0, opened.stderr)
        return json.loads(opened.stdout)

    def test_capture_returns_the_last_clean_lines(self):
        identity = self.session('cap', 'one\n\ntwo   \n')
        row = self.capture('cap', identity, '2')
        self.assertEqual(row['text'], 'two\nprinted-cap')
        self.assertEqual(row['lines'], 2)
        self.assertEqual(row['name'], 'cap')
        self.assertEqual(row['identity'], identity)
        self.assertFalse(row['truncated'])
        self.assertFalse(row['dead'])
        self.assertEqual(row['clients'], 0)
        self.assertRegex(row['pane'], r'^%[0-9]+$')
        self.assertTrue(row['command'])
        self.assertGreater(row['sampled_at'], 0)

    def test_capture_reads_scrollback(self):
        identity = self.session('cap', ''.join(f'line-{i}\n' for i in range(300)))
        row = self.capture('cap', identity)
        lines = row['text'].split('\n')
        self.assertEqual(len(lines), 200)
        self.assertEqual(lines[-2:], ['line-299', 'printed-cap'])

    def test_capture_refuses_a_replaced_session(self):
        old = self.session('cap', 'old-secret\n')
        self.tm('kill-session', '-t', '=cap')
        self.session('cap', 'new\n')
        result = self.helper('capture', 'cap', old, '10', self.keys())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Session identity changed. Nothing was read.', result.stderr)
        self.assertEqual(result.stdout, '')

    def test_capture_of_a_missing_session_is_a_clear_error(self):
        result = self.helper('capture', 'gone', '1:$2:3', '10', self.keys())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('The selected session no longer exists.', result.stderr)
        self.assertNotIn('Traceback', result.stderr)

    def test_capture_of_a_session_that_ends_during_the_read_is_a_clear_error(self):
        identity = self.session('cap', 'x\n')
        wrapper = Path(self.temp.name) / 'bin/tmux'
        wrapper.parent.mkdir()
        wrapper.write_text(f"""#!/bin/sh
case "$*" in *pane_dead*) exit 1 ;; esac
exec {self.tmux} "$@"
""")
        wrapper.chmod(0o755)
        self.env['PATH'] = f"{wrapper.parent}:{self.env['PATH']}"
        result = self.helper('capture', 'cap', identity, '10', self.keys())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('The selected session no longer exists.', result.stderr)
        self.assertNotIn('Traceback', result.stderr)

    def test_capture_limits_lines(self):
        identity = self.session('cap', 'x\n')
        for lines in ['0', '201', 'x', '']:
            result = self.helper('capture', 'cap', identity, lines, self.keys())
            self.assertNotEqual(result.returncode, 0, lines)
            self.assertIn('from 1 to 200', result.stderr)

    def test_capture_cuts_at_a_character_boundary(self):
        identity = self.session('cap', ('é' * 79 + '\n') * 180)
        row = self.capture('cap', identity)
        self.assertTrue(row['truncated'])
        self.assertLessEqual(len(json.dumps(row['text'], ensure_ascii=False).encode()), 15000)
        self.assertTrue(row['text'].endswith('printed-cap'))
        self.assertNotIn('\ufffd', row['text'])

    def test_capture_limits_text_that_grows_when_encoded(self):
        identity = self.session('cap', ('"' * 79 + '\n') * 180)
        self.assertLess(len(self.sealed('cap', identity)), 24000)
        self.assertTrue(self.capture('cap', identity)['truncated'])

    def test_capture_output_holds_no_screen_text(self):
        identity = self.session('cap', 'secret-marker-52\\n')
        sealed = self.sealed('cap', identity)
        self.assertNotIn('secret-marker-52', sealed)
        self.assertNotIn('printed-cap', base64.b64decode(sealed).decode('latin-1'))
        self.assertIn('secret-marker-52', self.capture('cap', identity)['text'])

    def test_capture_refuses_without_a_recipient(self):
        identity = self.session('cap', 'secret-marker-52\\n')
        for args in [('10',), ('10', ''), ('10', 'not base64!')]:
            result = self.helper('capture', 'cap', identity, *args)
            self.assertNotEqual(result.returncode, 0, args)
            self.assertIn('Nothing was read.', result.stderr)
            self.assertEqual(result.stdout, '')

    def test_capture_with_a_bad_recipient_prints_no_text(self):
        identity = self.session('cap', 'secret-marker-52\\n')
        junk = base64.b64encode(b'not a certificate').decode()
        result = self.helper('capture', 'cap', identity, '10', junk)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('could not be encrypted', result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertNotIn('secret-marker-52', result.stderr)

    def test_capture_keeps_text_without_a_utf8_locale(self):
        identity = self.session('cap', 'é ok\n')
        self.env.update(LC_ALL='C', LANG='C')
        self.assertIn('é ok', self.capture('cap', identity)['text'])

    def test_capture_output_is_json_with_control_characters(self):
        identity = self.session('cap', 'a "quoted" \\ b\tc \x1b[31mred\x1b[0m\n')
        self.assertIn('"quoted"', self.capture('cap', identity)['text'])

    def test_capture_of_a_dead_pane_reports_it(self):
        self.tm('set-option', '-g', 'remain-on-exit', 'on')
        self.tm('new-session', '-d', '-s', 'cap', '-x', '80', '-y', '24', 'sh', '-c', 'echo finished')
        for _ in range(200):
            if self.tm('display-message', '-p', '-t', '=cap:', '#{pane_dead}').stdout.strip() == '1':
                break
            time.sleep(.02)
        rows = json.loads(self.helper('snapshot').stdout)['sessions']
        row = self.capture('cap', next(r['identity'] for r in rows if r['name'] == 'cap'))
        self.assertTrue(row['dead'])
        self.assertIn('finished', row['text'])


class TerminalSessions(Server):
    def test_snapshot_reports_sessions_without_creating_one(self):
        self.assertEqual(json.loads(self.helper('snapshot').stdout), {'sessions': [], 'projects': {}})
        self.assertEqual(self.helper('ensure', 'backend').returncode, 0)
        result = self.helper('snapshot')
        self.assertEqual(result.returncode, 0, result.stderr)
        row = json.loads(result.stdout)['sessions'][0]
        self.assertEqual(row['name'], 'backend')
        self.assertEqual(row['cwd'], str(Path(self.temp.name).resolve()))
        self.assertEqual(row['project'], row['cwd'])
        self.assertRegex(row['identity'], r'^[0-9]+:\$[0-9]+:[0-9]+$')

    def test_project_and_new_shell_preserve_source_directory(self):
        folder = Path(self.temp.name) / 'project with spaces'
        folder.mkdir()
        self.helper('ensure', 'agent')
        encoded = base64.b64encode(str(folder).encode()).decode()
        self.assertEqual(self.helper('project', 'agent', encoded).returncode, 0)
        self.tm('send-keys', '-t', '=agent:', "cd '" + str(folder) + "'", 'Enter')
        for _ in range(100):
            cwd = self.tm('display-message', '-p', '-t', '=agent:', '#{pane_current_path}').stdout.strip()
            if cwd == str(folder.resolve()): break
            time.sleep(.02)
        self.assertEqual(cwd, str(folder.resolve()))
        self.helper('new', 'shell', 'agent')  # Non-TTY attachment fails after creation.
        rows = json.loads(self.helper('snapshot').stdout)['sessions']
        shell = next(row for row in rows if row['name'] == 'shell')
        self.assertEqual(shell['cwd'], str(folder.resolve()))
        self.assertEqual(shell['project'], str(folder.resolve()))
        self.assertNotEqual(self.helper('project', 'agent', 'invalid!').returncode, 0)
        self.assertNotEqual(self.helper('new', 'absent-source', 'missing').returncode, 0)
        self.assertNotEqual(self.tm('has-session', '-t', '=absent-source').returncode, 0)

    def test_end_is_exact_and_rejects_replaced_session_identity(self):
        self.helper('ensure', 'target')
        self.helper('ensure', 'target-other')
        identity = next(r['identity'] for r in json.loads(self.helper('snapshot').stdout)['sessions'] if r['name']=='target')
        self.tm('kill-session', '-t', '=target')
        self.helper('ensure', 'target')
        result = self.helper('end', 'target', identity)
        self.assertNotEqual(result.returncode, 0, result)
        self.assertEqual(self.tm('has-session', '-t', '=target').returncode, 0)
        current = next(r['identity'] for r in json.loads(self.helper('snapshot').stdout)['sessions'] if r['name']=='target')
        result = self.helper('end', 'target', current)
        self.assertEqual(result.returncode, 0, result)
        self.assertNotEqual(self.tm('has-session', '-t', '=target').returncode, 0)
        self.assertEqual(self.tm('has-session', '-t', '=target-other').returncode, 0)
        self.assertNotEqual(self.helper('end','target-other', 'bad;token').returncode, 0)

    def test_recreate_after_last_shell_exits(self):
        self.assertEqual(self.helper('ensure', 'workbench').returncode, 0)
        pid = self.tm('display-message', '-p', '-t', '=workbench:', '#{pane_pid}').stdout
        self.tm('send-keys', '-t', '=workbench:', 'exit', 'Enter')
        for _ in range(100):
            if self.tm('has-session', '-t', '=workbench:').returncode:
                break
            time.sleep(.02)
        self.assertEqual(self.helper('ensure', 'workbench').returncode, 0)
        self.assertNotEqual(pid, self.tm('display-message', '-p', '-t', '=workbench:', '#{pane_pid}').stdout)

    def test_independent_sessions_and_idempotent_reconnect(self):
        for name in ['alpha', 'beta', 'alpha']:
            self.assertEqual(self.helper('ensure', name).returncode, 0)
        self.assertEqual(self.tm('list-sessions', '-F', '#{session_name}').stdout.split(), ['alpha', 'beta'])
        first = self.tm('display-message', '-p', '-t', '=alpha:', '#{pane_pid}').stdout
        self.helper('ensure', 'alpha')
        self.assertEqual(first, self.tm('display-message', '-p', '-t', '=alpha:', '#{pane_pid}').stdout)
        self.assertNotEqual(first, self.tm('display-message', '-p', '-t', '=beta:', '#{pane_pid}').stdout)

    def test_invalid_names_and_missing_attach_do_not_create_sessions(self):
        for name in ['-x', 'a;b', '../x', 'a b', 'a:b', 'x' * 49]:
            self.assertNotEqual(self.helper('ensure', name).returncode, 0)
        self.assertNotEqual(self.helper('attach', 'missing').returncode, 0)
        self.assertEqual(self.tm('list-sessions').stdout, '')

    def test_two_clients_detach_and_reconnect_without_losing_shell(self):
        self.assertEqual(self.helper('ensure', 'alpha').returncode, 0)
        shell_pid = self.tm('display-message', '-p', '-t', '=alpha:', '#{pane_pid}').stdout
        clients = []
        try:
            for _ in range(2):
                pid, fd = pty.fork()
                if pid == 0:
                    os.environ.update(self.env)
                    os.environ['TERM'] = 'xterm-256color'
                    os.execl('/bin/bash', 'bash', str(ROOT / 'terminal-session.sh'), 'attach', 'alpha')
                clients.append((pid, fd))
            for _ in range(100):
                if self.tm('list-clients', '-F', '#{client_pid}').stdout.count('\n') == 2:
                    break
                time.sleep(.02)
            self.assertEqual(self.tm('list-clients', '-F', '#{client_pid}').stdout.count('\n'), 2)
        finally:
            self.tm('detach-client', '-s', 'alpha')
            for pid, fd in clients:
                os.close(fd)
                os.waitpid(pid, 0)
        self.assertEqual(shell_pid, self.tm('display-message', '-p', '-t', '=alpha:', '#{pane_pid}').stdout)
        self.assertEqual(self.helper('ensure', 'alpha').returncode, 0)
        self.assertEqual(shell_pid, self.tm('display-message', '-p', '-t', '=alpha:', '#{pane_pid}').stdout)

    def identity(self, name):
        rows = json.loads(self.helper('snapshot').stdout)['sessions']
        return next(r['identity'] for r in rows if r['name'] == name)

    def attach_in_terminal(self, *args):
        """Run the helper attach in a PTY. Return its exit code, output and the attached sessions."""
        pid, fd = pty.fork()
        if pid == 0:
            os.environ.update(self.env)
            os.environ['TERM'] = 'xterm-256color'
            os.execl('/bin/bash', 'bash', str(ROOT / 'terminal-session.sh'), 'attach', *args)
        output, attached, code = b'', '', None
        try:
            deadline = time.time() + 5
            while time.time() < deadline:
                ready, _, _ = select.select([fd], [], [], 0.05)
                if ready:
                    try:
                        output += os.read(fd, 65536)
                    except OSError:
                        pass
                attached = attached or self.tm('list-clients', '-F', '#{client_session}').stdout.strip()
                done, status = os.waitpid(pid, os.WNOHANG)
                if done:
                    code = os.waitstatus_to_exitcode(status)
                    break
                if attached:
                    self.tm('detach-client', '-s', attached)
        finally:
            if code is None:
                if attached:
                    self.tm('detach-client', '-s', attached)
                os.kill(pid, 15)
                code = os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
            os.close(fd)
        return code, output.decode(errors='replace'), attached

    def test_attach_with_identity_attaches_the_exact_session(self):
        self.helper('ensure', 'alpha')
        self.helper('ensure', 'beta')
        code, output, attached = self.attach_in_terminal('alpha', self.identity('alpha'))
        self.assertEqual(attached, 'alpha', output)
        self.assertEqual(code, 0, output)

    def test_attach_refuses_a_replaced_session_with_the_same_name(self):
        self.helper('ensure', 'target')
        old = self.identity('target')
        self.tm('kill-session', '-t', '=target')
        self.helper('ensure', 'target')
        self.assertNotEqual(old, self.identity('target'))
        code, output, attached = self.attach_in_terminal('target', old)
        self.assertEqual(attached, '', output)
        self.assertNotEqual(code, 0, output)
        self.assertIn('Session identity changed. No session was attached.', output)

    def test_attach_refuses_when_the_name_now_names_a_different_session(self):
        # The expected session still exists under another name. Its name now belongs to a
        # new session. The helper compares the identity of the named session, so it refuses.
        self.helper('ensure', 'target')
        old = self.identity('target')
        self.tm('rename-session', '-t', '=target', 'moved')
        self.helper('ensure', 'target')
        code, output, attached = self.attach_in_terminal('target', old)
        self.assertEqual(attached, '', output)
        self.assertNotEqual(code, 0, output)
        self.assertEqual(self.tm('list-clients').stdout, '')

    def test_attach_rejects_an_empty_identity(self):
        self.helper('ensure', 'alpha')
        result = self.helper('attach', 'alpha', '')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('identity is invalid', result.stderr)

    def test_attach_rejects_an_invalid_identity_before_tmux(self):
        self.helper('ensure', 'alpha')
        for value in ['bad;token', "1:$2:3' ; kill-server '", '1:2:3']:
            result = self.helper('attach', 'alpha', value)
            self.assertNotEqual(result.returncode, 0, value)
            self.assertIn('identity is invalid', result.stderr)
        self.assertEqual(self.tm('has-session', '-t', '=alpha').returncode, 0)

    def ring(self, target):
        """Make the shell of a pane print a bell character."""
        self.tm('send-keys', '-t', target, "printf '\\a'", 'Enter')

    def bells(self):
        rows = json.loads(self.helper('snapshot').stdout)['sessions']
        return {row['name']: row['bell'] for row in rows}

    def wait_for_bell(self, name):
        for _ in range(100):
            if self.bells()[name]:
                return
            time.sleep(.05)
        self.fail(f'The snapshot did not report the bell of {name}.')

    def test_snapshot_reports_a_bell_until_a_client_attaches(self):
        self.helper('ensure', 'agent')
        self.helper('ensure', 'other')
        self.assertEqual(self.bells(), {'agent': False, 'other': False})
        # A session without a client keeps the bell of its current window.
        self.ring('=agent:')
        self.wait_for_bell('agent')
        # A snapshot read does not clear the flag.
        self.assertEqual(self.bells(), {'agent': True, 'other': False})
        code, output, attached = self.attach_in_terminal('agent', self.identity('agent'))
        self.assertEqual(attached, 'agent', output)
        # The attachment cleared the flag of the window that the client viewed.
        self.assertEqual(self.bells(), {'agent': False, 'other': False})

    def test_snapshot_keeps_a_bell_in_another_window_until_that_window_is_selected(self):
        self.helper('ensure', 'agent')
        self.tm('new-window', '-d', '-t', '=agent:', '/bin/bash', '--noprofile', '--norc')
        self.ring('=agent:1')
        self.wait_for_bell('agent')
        code, output, attached = self.attach_in_terminal('agent', self.identity('agent'))
        self.assertEqual(attached, 'agent', output)
        self.assertTrue(self.bells()['agent'])
        self.tm('select-window', '-t', '=agent:1')
        self.assertFalse(self.bells()['agent'])

    def test_missing_server_is_not_started(self):
        self.tm('kill-server')
        self.server.wait(timeout=30)
        result = self.helper('ensure', 'alpha')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unavailable', result.stderr)
        self.assertNotEqual(self.tm('show-options', '-s', 'exit-empty').returncode, 0)

if __name__ == '__main__':
    unittest.main()


class ModelHelpers:
    """Encoding and snapshot helpers for the session model tests."""

    def b64(self, value):
        return base64.b64encode((value if isinstance(value, str) else json.dumps(value)).encode()).decode()

    def rows(self):
        result = self.helper('snapshot')
        self.assertEqual(result.returncode, 0, result.stderr)
        return {row['name']: row for row in json.loads(result.stdout)['sessions']}

    def screen(self, name, text):
        for _ in range(150):
            shown = self.tm('capture-pane', '-p', '-t', '=' + name + ':').stdout
            if text in shown:
                return shown
            time.sleep(.02)
        self.fail(f'{text!r} did not appear in {name}: {shown!r}')


class SessionModel(ModelHelpers, Server):
    """Projects are name paths on sessions; a child session records its parent."""

    def test_new_shells_show_the_configured_name_in_the_prompt(self):
        self.helper('ensure', 'first')
        self.screen('first', 'tokiwa:')
        self.assertEqual(self.helper('name').stdout.strip(), 'tokiwa')
        self.assertEqual(self.helper('name', 'myname').returncode, 0)
        self.assertEqual(self.helper('name').stdout.strip(), 'myname')
        self.helper('ensure', 'second')
        self.screen('second', 'myname:')
        self.assertNotEqual(self.helper('name', 'bad name!').returncode, 0)

    def test_new_shells_open_links_through_tokiwa_open(self):
        self.helper('ensure', 'links')
        self.screen('links', 'tokiwa:')
        self.tm('send-keys', '-t', '=links:', 'echo "B=$BROWSER"', 'Enter')
        self.screen('links', 'B=/opt/agent-platform/rootless/tokiwa-open')

    def test_a_shell_from_a_session_records_its_parent(self):
        self.helper('ensure', 'agent')
        self.helper('new', 'child', 'agent')
        rows = self.rows()
        self.assertEqual(rows['child']['parent'], rows['agent']['identity'].split(':')[1])
        self.assertEqual(rows['agent']['parent'], '')

    def test_a_project_is_a_name_path_and_moves_and_nests_by_relabel(self):
        for name in ['claude-a', 'claude-b', 'codex']:
            self.helper('ensure', name)
            self.assertEqual(self.helper('project', name, self.b64('api')).returncode, 0)
        self.assertEqual(self.helper('project', 'claude-b', self.b64('inbox')).returncode, 0)
        self.assertEqual(self.rows()['claude-b']['project'], 'inbox')
        # api becomes a subproject of studio; its sessions keep their directories.
        before = self.rows()['codex']['cwd']
        result = self.helper('relabel', self.b64({'from': 'api', 'to': 'studio/api'}))
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = self.rows()
        self.assertEqual([rows[n]['project'] for n in ['claude-a', 'codex']], ['studio/api'] * 2)
        self.assertEqual(rows['claude-b']['project'], 'inbox')
        self.assertEqual(rows['codex']['cwd'], before)
        # A nested project moves with its parent.
        self.helper('relabel', self.b64({'from': 'studio', 'to': 'archive/studio'}))
        self.assertEqual(self.rows()['codex']['project'], 'archive/studio/api')
        for bad in ['a/', 'a//b', '../x', 'a/' * 7 + 'a', 'with space']:
            self.assertNotEqual(self.helper('project', 'codex', self.b64(bad)).returncode, 0, bad)

    def test_create_starts_a_session_in_an_existing_or_a_new_folder(self):
        root = Path(self.temp.name) / 'workspaces'
        root.mkdir()
        self.env['TOKIWA_WORKSPACES'] = str(root)
        existing = root / 'existing'
        existing.mkdir()
        request = {'dir': str(existing), 'project': 'api'}
        self.assertEqual(self.helper('create', 'one', self.b64(request)).returncode, 0)
        result = self.helper('create', 'two', self.b64({'folder': 'inbox', 'project': 'inbox'}))
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = self.rows()
        self.assertEqual((rows['one']['cwd'], rows['one']['project']), (str(existing.resolve()), 'api'))
        self.assertEqual((rows['two']['cwd'], rows['two']['project']), (str((root / 'inbox').resolve()), 'inbox'))
        # A folder is one name inside the workspaces folder; a directory must exist.
        for bad in [{'folder': '../escape'}, {'folder': 'a/b'}, {'dir': str(root / 'missing')}, {}]:
            self.assertNotEqual(self.helper('create', 'bad', self.b64(bad)).returncode, 0, bad)
        self.assertNotEqual(self.tm('has-session', '-t', '=bad').returncode, 0)
        self.assertNotEqual(self.helper('create', 'one', self.b64(request)).returncode, 0)


class SavedProjects(ModelHelpers, Server):
    """Projects are saved on the workstation, so a project outlives its sessions."""

    def setUp(self):
        super().setUp()
        self.state = Path(self.temp.name) / 'state'
        self.env['TOKIWA_STATE'] = str(self.state)
        self.root = Path(self.temp.name) / 'workspaces'
        self.root.mkdir()
        self.env['TOKIWA_WORKSPACES'] = str(self.root)

    def projects(self):
        result = self.helper('snapshot')
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)['projects']

    def end(self, name):
        identity = self.rows()[name]['identity']
        self.assertEqual(self.helper('end', name, identity).returncode, 0)

    def test_a_project_stays_after_its_last_session_ends_until_it_is_forgotten(self):
        self.helper('create', 'notes', self.b64({'folder': 'inbox', 'project': 'inbox'}))
        self.assertEqual(self.projects(), {'inbox': {'dir': str((self.root / 'inbox').resolve())}})
        self.assertEqual(oct(self.state.stat().st_mode & 0o777), '0o700')
        # A project with a running session cannot be forgotten.
        self.assertNotEqual(self.helper('forget-project', self.b64('inbox')).returncode, 0)
        self.end('notes')
        self.assertIn('inbox', self.projects())
        result = self.helper('forget-project', self.b64('inbox'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.projects(), {})
        # The folder stays.
        self.assertTrue((self.root / 'inbox').is_dir())

    def test_moving_a_session_or_a_project_updates_the_saved_projects(self):
        self.helper('ensure', 'agent')
        self.helper('project', 'agent', self.b64('api'))
        self.assertIn('api', self.projects())
        self.helper('create', 'sub', self.b64({'folder': 'deep', 'project': 'api/deep'}))
        self.helper('relabel', self.b64({'from': 'api', 'to': 'studio/api'}))
        saved = self.projects()
        self.assertEqual(sorted(saved), ['studio/api', 'studio/api/deep'])
        self.assertEqual(saved['studio/api/deep']['dir'], str((self.root / 'deep').resolve()))
        # An empty project can also move.
        self.end('agent')
        self.end('sub')
        self.helper('relabel', self.b64({'from': 'studio', 'to': 'archive/studio'}))
        self.assertEqual(sorted(self.projects()), ['archive/studio/api', 'archive/studio/api/deep'])
        # Forgetting a project forgets the projects inside it.
        self.helper('forget-project', self.b64('archive'))
        self.assertEqual(self.projects(), {})


class RenameSession(ModelHelpers, Server):
    """A session is renamed only when its identity still matches; its project and children stay."""

    def test_rename_keeps_identity_project_and_children(self):
        self.helper('ensure', 'agent')
        self.helper('project', 'agent', self.b64('api'))
        self.helper('new', 'child', 'agent')
        identity = self.rows()['agent']['identity']
        result = self.helper('rename', 'agent', self.b64({'to': 'claude-api', 'identity': identity}))
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = self.rows()
        self.assertNotIn('agent', rows)
        self.assertEqual(rows['claude-api']['identity'], identity)
        self.assertEqual(rows['claude-api']['project'], 'api')
        self.assertEqual(rows['child']['parent'], identity.split(':')[1])
        # A wrong identity, a taken name or an invalid name renames nothing.
        self.assertNotEqual(self.helper('rename', 'claude-api', self.b64({'to': 'x', 'identity': '1:$99:1'})).returncode, 0)
        self.assertNotEqual(self.helper('rename', 'claude-api', self.b64({'to': 'child', 'identity': identity})).returncode, 0)
        self.assertNotEqual(self.helper('rename', 'claude-api', self.b64({'to': 'bad name', 'identity': identity})).returncode, 0)
        self.assertIn('claude-api', self.rows())
