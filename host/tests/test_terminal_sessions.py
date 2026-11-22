"""Exercise terminal recovery against a disposable tmux server."""
from pathlib import Path
import os
import json
import base64
import hashlib
import pty
import re
import select
import shutil
import subprocess
import sys
import tempfile
import termios
import threading
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
                              stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)


class SessionKinds(Server):
    """A session that Tokiwa made carries a mark. A session that a program made has none."""

    def test_view_attaches_read_only_and_checks_the_identity(self):
        self.helper('ensure', 'job')
        identity = self.row('job')['identity']
        pid, fd = pty.fork()
        if pid == 0:
            os.environ.update(self.env, TERM='xterm-256color')
            os.execl('/bin/bash', 'bash', str(ROOT / 'terminal-session.sh'), 'view', 'job', identity)
        try:
            flag = ''
            for _ in range(200):
                if select.select([fd], [], [], 0.02)[0]:
                    os.read(fd, 65536)
                flag = self.tm('list-clients', '-F', '#{client_readonly}').stdout.strip()
                if flag:
                    break
            self.assertEqual(flag, '1')
            os.write(fd, b'typed-through\r')
            time.sleep(0.2)
            self.assertNotIn('typed-through', self.tm('capture-pane', '-p', '-t', '=job:').stdout)
        finally:
            # Close the terminal first: on macOS a process that writes to it cannot finish exiting.
            os.close(fd)
            os.kill(pid, 9)
            os.waitpid(pid, 0)

    def row(self, name):
        rows = json.loads(self.helper('snapshot').stdout)['sessions']
        return next(r for r in rows if r['name'] == name)

    def test_a_tokiwa_session_is_managed(self):
        self.assertEqual(self.helper('ensure', 'mine').returncode, 0)
        self.assertTrue(self.row('mine')['managed'])

    def test_a_session_that_a_program_made_is_not_managed(self):
        self.tm('new-session', '-d', '-s', 'job', 'sleep 300')
        self.assertFalse(self.row('job')['managed'])


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

    def search(self, name, identity, query, limit='50'):
        encoded = base64.b64encode(query.encode()).decode()
        result = self.helper('capture', name, identity, limit, self.keys(), encoded)
        self.assertEqual(result.returncode, 0, result.stderr)
        opened = subprocess.run(['openssl', 'smime', '-decrypt', '-binary', '-inform', 'DER', '-inkey', str(self.key),
                                 '-recip', str(self.cert)], input=base64.b64decode(result.stdout), capture_output=True)
        self.assertEqual(opened.returncode, 0, opened.stderr)
        return json.loads(opened.stdout)

    def test_search_finds_a_line_beyond_the_last_200_with_its_context(self):
        text = ''.join(f'line-{i}\n' for i in range(1500)).replace('line-50\n', 'Needle here\n')
        identity = self.session('cap', text)
        row = self.search('cap', identity, 'needle')
        self.assertEqual((row['query'], row['matches']), ('needle', 1))
        self.assertEqual(row['text'], 'line-48\nline-49\nNeedle here\nline-51\nline-52')

    def test_search_keeps_the_latest_matches_and_parts_them(self):
        text = ''.join(f'hit-{i}\nfill-{i}\nfill-{i}\nfill-{i}\nfill-{i}\nfill-{i}\n' for i in range(10))
        identity = self.session('cap', text)
        row = self.search('cap', identity, 'HIT-', limit='2')
        self.assertEqual(row['matches'], 2)
        blocks = row['text'].split('\n--\n')
        self.assertEqual([b.split('\n')[2] for b in blocks], ['hit-8', 'hit-9'])

    def test_search_without_a_match_and_a_bad_query(self):
        identity = self.session('cap', 'one\ntwo\n')
        row = self.search('cap', identity, 'absent')
        self.assertEqual((row['matches'], row['text']), (0, ''))
        for bad in ['not base64!', base64.b64encode(b'line\nbreak').decode(), base64.b64encode(b'x' * 201).decode()]:
            self.assertNotEqual(self.helper('capture', 'cap', identity, '50', self.keys(), bad).returncode, 0, bad)

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
        identity = self.session('cap', 'secret-marker-52\n')
        sealed = self.sealed('cap', identity)
        self.assertNotIn('secret-marker-52', sealed)
        self.assertNotIn('printed-cap', base64.b64decode(sealed).decode('latin-1'))
        self.assertIn('secret-marker-52', self.capture('cap', identity)['text'])

    def test_capture_refuses_without_a_recipient(self):
        identity = self.session('cap', 'secret-marker-52\n')
        for args in [('10',), ('10', ''), ('10', 'not base64!')]:
            result = self.helper('capture', 'cap', identity, *args)
            self.assertNotEqual(result.returncode, 0, args)
            self.assertIn('Nothing was read.', result.stderr)
            self.assertEqual(result.stdout, '')

    def test_capture_with_a_bad_recipient_prints_no_text(self):
        identity = self.session('cap', 'secret-marker-52\n')
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

    def test_capture_without_openssl_is_a_clear_error(self):
        identity = self.session('cap', 'secret-marker-52\n')
        tools = Path(self.temp.name) / 'tools'
        tools.mkdir()
        for name, program in {'bash': shutil.which('bash'), 'tmux': self.tmux, 'dirname': shutil.which('dirname'),
                              'python3': sys.executable}.items():
            (tools / name).symlink_to(program)
        self.env['PATH'] = str(tools)
        result = self.helper('capture', 'cap', identity, '10', self.keys())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('could not be encrypted', result.stderr)
        self.assertNotIn('Traceback', result.stderr)
        self.assertEqual(result.stdout, '')

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

    def attach_in_terminal(self, *args, mode='attach'):
        """Run the helper attach in a PTY. Return its exit code, output and the attached sessions."""
        pid, fd = pty.fork()
        if pid == 0:
            os.environ.update(self.env)
            os.environ['TERM'] = 'xterm-256color'
            os.execl('/bin/bash', 'bash', str(ROOT / 'terminal-session.sh'), mode, *args)
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

    def test_view_refuses_a_replaced_session(self):
        self.helper('ensure', 'target')
        code, output, attached = self.attach_in_terminal('target', '1:$999:1', mode='view')
        self.assertEqual(attached, '')
        self.assertIn('Session identity changed. No session was attached.', output)

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

    def test_create_prints_the_identity_of_the_new_session(self):
        root = Path(self.temp.name) / 'workspaces'
        root.mkdir()
        self.env['TOKIWA_WORKSPACES'] = str(root)
        result = self.helper('create', 'fresh', self.b64({'folder': 'inbox', 'project': 'inbox'}))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, f"Created terminal: fresh {self.rows()['fresh']['identity']}\n")

    def test_create_makes_an_own_folder_inside_the_project(self):
        root = Path(self.temp.name) / 'workspaces'
        project = root / 'proj'
        project.mkdir(parents=True)
        self.env['TOKIWA_WORKSPACES'] = str(root)
        result = self.helper('create', 'lead', self.b64({'dir': str(project), 'subfolder': 'lead', 'project': 'proj'}))
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.helper('create', 'fresh', self.b64({'folder': 'inbox', 'subfolder': 'fresh', 'project': 'inbox'}))
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = self.rows()
        self.assertEqual(rows['lead']['cwd'], str((project / 'lead').resolve()))
        self.assertEqual(rows['fresh']['cwd'], str((root / 'inbox' / 'fresh').resolve()))
        # The own folder is one name, so it stays inside the project folder.
        for bad in ['../x', 'a/b', '', '.hidden']:
            request = {'dir': str(project), 'subfolder': bad, 'project': 'proj'}
            self.assertNotEqual(self.helper('create', 'bad', self.b64(request)).returncode, 0, bad)
        self.assertNotEqual(self.tm('has-session', '-t', '=bad').returncode, 0)
        self.assertFalse((root / 'x').exists())

    def test_create_runs_a_command_in_the_new_shell_and_keeps_the_shell(self):
        root = Path(self.temp.name) / 'workspaces'
        project = root / 'proj'
        project.mkdir(parents=True)
        self.env['TOKIWA_WORKSPACES'] = str(root)
        request = {'dir': str(project), 'subfolder': 'lead', 'project': 'proj', 'run': 'echo started-$((40 + 2))'}
        result = self.helper('create', 'lead', self.b64(request))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.screen('lead', 'started-42')
        # The command ran in the session's shell, so the shell is still there after it ends.
        command = self.tm('display-message', '-p', '-t', '=lead:', '#{pane_current_command}').stdout.strip()
        self.assertEqual(command, 'bash')
        # One line of printable text only: a command never types extra lines into the shell.
        for bad in ['two\nlines', 'bell\a', '', 'x' * 2001, 7]:
            request = {'dir': str(project), 'subfolder': 'bad', 'project': 'proj', 'run': bad}
            self.assertNotEqual(self.helper('create', 'bad', self.b64(request)).returncode, 0, repr(bad))
        self.assertNotEqual(self.tm('has-session', '-t', '=bad').returncode, 0)
        self.assertFalse((project / 'bad').exists())

    def helper_with_stdin(self, text, *args):
        return subprocess.run(['bash', str(ROOT / 'terminal-session.sh'), *args], env=self.env, input=text,
                              capture_output=True, text=True, timeout=30)

    def test_create_reads_the_run_line_from_stdin(self):
        root = Path(self.temp.name) / 'workspaces'
        project = root / 'proj'
        project.mkdir(parents=True)
        self.env['TOKIWA_WORKSPACES'] = str(root)
        request = self.b64({'dir': str(project), 'project': 'proj', 'run_stdin': True})
        result = self.helper_with_stdin('echo from-stdin-$((40 + 2))\n', 'create', 'lead', request)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.screen('lead', 'from-stdin-42')
        # The line is not in the audit log. (The next test records every tmux argument.)
        self.assertNotIn('from-stdin', json.dumps(self.audit_entries()))
        # The same checks as for a line in the request: one line of at most 2000 printable characters.
        for bad in ['two\nlines\n', 'bell\a\n', '', '\n', 'x' * 2001]:
            result = self.helper_with_stdin(bad, 'create', 'bad', request)
            self.assertNotEqual(result.returncode, 0, repr(bad))
            self.assertIn('one line', result.stderr)
        self.assertNotEqual(self.tm('has-session', '-t', '=bad').returncode, 0)
        # A request cannot carry the line and ask for stdin too.
        both = self.b64({'dir': str(project), 'run': 'echo a', 'run_stdin': True})
        self.assertNotEqual(self.helper_with_stdin('echo b\n', 'create', 'bad', both).returncode, 0)
        self.assertNotEqual(self.tm('has-session', '-t', '=bad').returncode, 0)

    def recording_tmux(self, fail_on=None):
        """Put a tmux in front of the real one that records every argv, one line per call.

        `fail_on` names a tmux command that the wrapper refuses, to test the clean-up.
        """
        folder = Path(self.temp.name) / 'record-bin'
        folder.mkdir(exist_ok=True)
        self.argv_log = Path(self.temp.name) / 'tmux-argv.log'
        wrapper = folder / 'tmux'
        wrapper.write_text(f'''#!/bin/bash
printf '%s\\n' "$*" >> "{self.argv_log}"
if [[ -n "{fail_on or ''}" && " $* " == *" {fail_on or 'none'} "* ]]; then echo 'tmux failed' >&2; exit 1; fi
exec {self.tmux} "$@"
''')
        wrapper.chmod(0o755)
        self.env['PATH'] = f"{folder}:{self.env['PATH']}"

    def test_create_never_gives_the_run_line_to_a_process_as_an_argument(self):
        root = Path(self.temp.name) / 'workspaces'
        root.mkdir()
        self.env['TOKIWA_WORKSPACES'] = str(root)
        self.recording_tmux()
        line = 'echo marker-line-$((6 * 7))'
        request = self.b64({'folder': 'inbox', 'run_stdin': True})
        result = self.helper_with_stdin(line + '\n', 'create', 'lead', request)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.screen('lead', 'marker-line-42')
        calls = self.argv_log.read_text()
        self.assertIn('load-buffer', calls)
        self.assertIn('paste-buffer -d -b', calls)
        for text in [line, 'marker-line', base64.b64encode(line.encode()).decode(), base64.b64encode(line.encode()).decode().rstrip('=')]:
            self.assertNotIn(text, calls)
        # The buffer is gone after the paste.
        self.assertEqual(self.tm('list-buffers').stdout, '')

    def test_create_deletes_the_buffer_when_the_paste_fails(self):
        root = Path(self.temp.name) / 'workspaces'
        root.mkdir()
        self.env['TOKIWA_WORKSPACES'] = str(root)
        self.recording_tmux(fail_on='paste-buffer')
        request = self.b64({'folder': 'inbox', 'run_stdin': True})
        result = self.helper_with_stdin('echo hi\n', 'create', 'lead', request)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('could not be typed', result.stderr)
        self.assertEqual(self.tm('list-buffers').stdout, '')
        self.assertIn('delete-buffer', self.argv_log.read_text())

    def test_create_refuses_a_run_line_that_is_not_utf8(self):
        request = self.b64({'folder': 'inbox', 'run_stdin': True})
        result = subprocess.run(['bash', str(ROOT / 'terminal-session.sh'), 'create', 'bad', request], env=dict(
            self.env, TOKIWA_WORKSPACES=str(Path(self.temp.name) / 'workspaces')), input=b'echo \xff\xfe\n',
            capture_output=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'one line', result.stderr)
        self.assertNotEqual(self.tm('has-session', '-t', '=bad').returncode, 0)

    def test_create_fails_when_the_driver_command_fails_in_real_tmux(self):
        # No fake tmux. A second session keeps the server alive, so that the failure is not "no server
        # running". A hook ends `lead` as soon as its first option is set, so the driver step finds no
        # session and tmux gives the failing status. tmux resolves the target of `if-shell` before the
        # inner command runs, so this shows the driver step failing, and the next test shows that
        # `if-shell -F` passes on the failure of its inner command.
        self.assertEqual(self.tm('new-session', '-d', '-s', 'holder').returncode, 0)
        self.tm('set-hook', '-g', 'after-set-option', 'kill-session -t =lead')
        result = self.create_as('orchestrator-a')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('driver could not be set', result.stderr)
        self.assertNotIn('no server running', result.stderr)
        # The server is still there and `lead` is gone: the failing step was the driver command.
        self.assertEqual(self.tm('has-session', '-t', '=holder').returncode, 0)
        self.assertNotEqual(self.tm('has-session', '-t', '=lead').returncode, 0)

    def test_if_shell_f_passes_on_the_failure_of_its_inner_command(self):
        # The form that `create` uses for the driver: a condition on the empty driver, then set-option.
        self.assertEqual(self.helper('ensure', 'lead').returncode, 0)
        condition = '#{==:#{@tokiwa_driver},}'
        failing = self.tm('if-shell', '-F', '-t', '=lead:', condition, "set-option -t '=missing:' @tokiwa_driver 'worker-a'")
        self.assertNotEqual(failing.returncode, 0)
        self.assertIn('no such session', failing.stderr)
        working = self.tm('if-shell', '-F', '-t', '=lead:', condition, "set-option -t '=lead:' @tokiwa_driver 'worker-a'")
        self.assertEqual(working.returncode, 0, working.stderr)
        self.assertEqual(self.tm('show-options', '-qv', '-t', '=lead:', '@tokiwa_driver').stdout.strip(), 'worker-a')

    def audit_entries(self):
        file = Path(self.env['TOKIWA_STATE']) / 'audit.log'
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

    def fake_tmux(self, mode):
        """Put a tmux in front of the real one. It acts at the driver `if-shell` of `create`.

        `claimed` makes another actor the driver just before the command runs, as a claim between
        the creation of the session and that command would. `broken` fails the command.
        """
        folder = Path(self.temp.name) / 'fake-bin'
        folder.mkdir(exist_ok=True)
        wrapper = folder / 'tmux'
        wrapper.write_text(f'''#!/bin/bash
if [[ " $* " == *" if-shell "* && "$*" == *@tokiwa_driver* ]]; then
 case {mode} in
  claimed) {self.tmux} -N -S "{self.socket}" set-option -t "=lead:" @tokiwa_driver worker-b ;;
  broken) echo 'tmux failed' >&2; exit 1 ;;
 esac
fi
exec {self.tmux} "$@"
''')
        wrapper.chmod(0o755)
        self.env['PATH'] = f"{folder}:{self.env['PATH']}"

    def create_as(self, actor):
        root = Path(self.temp.name) / 'workspaces'
        root.mkdir(exist_ok=True)
        self.env.update(TOKIWA_WORKSPACES=str(root), TOKIWA_ACTOR=actor)
        return self.helper('create', 'lead', self.b64({'folder': 'inbox'}))

    def test_create_never_overwrites_a_driver_claimed_in_between(self):
        self.fake_tmux('claimed')
        result = self.create_as('orchestrator-a')
        self.assertEqual(result.returncode, 0, result.stderr)
        row = self.rows()['lead']
        state = json.loads(self.helper('state', 'lead', row['identity']).stdout)
        self.assertEqual(state['driver'], 'worker-b')

    def test_create_reports_a_driver_that_could_not_be_set(self):
        self.fake_tmux('broken')
        result = self.create_as('orchestrator-a')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('driver could not be set', result.stderr)


class SecretStore(Server):
    """A secret is read with hidden input on the host, saved private, and never printed."""

    def secret(self, name, typed):
        """Run `secret NAME` in a terminal, type `typed` at its prompt, and return the code and output."""
        pid, fd = pty.fork()
        if pid == 0:
            os.environ.update(self.env)
            os.execl('/bin/bash', 'bash', str(ROOT / 'terminal-session.sh'), 'secret', name)
        output = b''
        try:
            sent = False
            for _ in range(400):
                if not select.select([fd], [], [], 0.05)[0]:
                    if sent and output.endswith(b'\n') and b'Saved' in output:
                        break
                    continue
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output += chunk
                if not sent and b'hidden' in output:
                    # The terminal settings at the moment the prompt shows, before anything is typed.
                    self.echo_at_prompt = bool(termios.tcgetattr(fd)[3] & termios.ECHO)
                    os.write(fd, typed)
                    sent = True
        finally:
            os.close(fd)
        _, status = os.waitpid(pid, 0)
        return os.waitstatus_to_exitcode(status), output.decode(errors='replace')

    def test_echo_is_off_before_the_prompt_shows(self):
        # A paste that arrives with the prompt must not show: echo goes off first, then the prompt.
        # A slow `read` widens the gap between the prompt and the read, as a slow host does.
        slow = Path(self.temp.name) / 'slow-read.sh'
        slow.write_text('read() { sleep 0.5; builtin read "$@"; }\n')
        self.env['BASH_ENV'] = str(slow)
        code, output = self.secret('API_KEY', b'pasted-value\n')
        self.assertEqual(code, 0, output)
        self.assertFalse(self.echo_at_prompt)
        self.assertNotIn('pasted-value', output)

    def stored(self, name):
        file = Path(self.env['TOKIWA_STATE']) / 'secrets.env'
        script = f'. {file}; printf %s "${name}"'
        return subprocess.run(['bash', '-c', script], capture_output=True, text=True).stdout

    def test_a_secret_is_saved_private_and_never_printed(self):
        code, output = self.secret('API_KEY', b"s3cr'et value\n")
        self.assertEqual(code, 0, output)
        self.assertNotIn('s3cr', output)
        self.assertIn('Saved API_KEY', output)
        file = Path(self.env['TOKIWA_STATE']) / 'secrets.env'
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(file.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.stored('API_KEY'), "s3cr'et value")

    def test_a_paste_of_several_lines_keeps_the_first_and_drops_the_rest(self):
        code, output = self.secret('API_KEY', b'first\nsecond\nthird\n')
        self.assertEqual(code, 0, output)
        self.assertEqual(self.stored('API_KEY'), 'first')
        self.assertIn('2 extra lines', output)
        self.assertNotIn('second', output)

    def test_a_secret_is_replaced_listed_by_name_and_removed(self):
        for name, value in [('A_KEY', b'one\n'), ('B_KEY', b'two\n'), ('A_KEY', b'three\n')]:
            self.assertEqual(self.secret(name, value)[0], 0)
        self.assertEqual(self.stored('A_KEY'), 'three')
        listed = self.helper('secrets')
        self.assertEqual(listed.stdout, 'A_KEY\nB_KEY\n')
        self.assertEqual(self.helper('secret-remove', 'B_KEY').returncode, 0)
        self.assertEqual(self.helper('secrets').stdout, 'A_KEY\n')
        missing = self.helper('secret-remove', 'B_KEY')
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn('No secret named B_KEY', missing.stderr)

    def test_bad_names_empty_values_and_no_terminal_save_nothing(self):
        for name in ['PATH', 'HOME', 'PS1', 'TOKIWA_X', 'TMUX_PANE', 'bad-name', '9KEY']:
            self.assertNotEqual(self.helper('secret', name).returncode, 0, name)
        self.assertNotEqual(self.secret('API_KEY', b'\n')[0], 0)
        result = self.helper('secret', 'API_KEY')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('terminal', result.stderr)
        self.assertFalse((Path(self.env['TOKIWA_STATE']) / 'secrets.env').exists())


class ShellSettings(Server):
    """A new shell reads the owner's .bashrc, and Tokiwa's prompt and browser still apply."""

    def test_a_new_shell_reads_the_bashrc_and_keeps_the_tokiwa_prompt(self):
        home = Path(self.temp.name) / 'home'
        home.mkdir()
        (home / '.bashrc').write_text('export PATH="$HOME/tools:$PATH"\nPS1="mine> "\nexport BROWSER=other\n'
                                      'export API_KEY=old\n')
        # A saved secret comes after .bashrc, so the newest saved value wins.
        (home / '.tokiwa').mkdir()
        (home / '.tokiwa/secrets.env').write_text("export API_KEY='new'\n")
        self.tm('set-environment', '-g', 'HOME', str(home))
        self.assertEqual(self.helper('ensure', 'plain').returncode, 0)
        out = Path(self.temp.name) / 'settings'
        self.tm('send-keys', '-t', '=plain:', f'echo "$PATH|$PS1|$BROWSER|$API_KEY" > {out}', 'Enter')
        for _ in range(100):
            if out.exists() and out.read_text().endswith('\n'):
                break
            time.sleep(.05)
        path, prompt, browser, key = out.read_text().strip().split('|')
        self.assertEqual(key, 'new')
        self.assertTrue(path.startswith(f'{home}/tools:'), path)
        self.assertEqual(prompt, 'tokiwa:\\W\\$ ')
        self.assertEqual(browser, '/opt/agent-platform/rootless/tokiwa-open')

    def setUp(self):
        super().setUp()
        # A host with no cache root keeps the defaults, whatever the machine of the test has.
        self.env.pop('TOKIWA_CACHE_ROOT', None)
        self.env['TOKIWA_CACHE_ROOT_FILE'] = str(Path(self.temp.name) / 'no-such-root-file')

    def type_into(self, name, line):
        self.tm('send-keys', '-t', f'={name}:', line, 'Enter')

    def shell_env(self, name):
        """The environment of the shell of session NAME, as a dict, once the shell has started."""
        out = Path(self.temp.name) / f'env-{name}'
        self.type_into(name, f'env > {out}.part && mv {out}.part {out}')
        for _ in range(200):
            if out.exists():
                break
            time.sleep(.05)
        self.assertTrue(out.exists(), self.screen_text(name))
        return dict(line.split('=', 1) for line in out.read_text().splitlines() if '=' in line)

    def screen_text(self, name):
        return self.tm('capture-pane', '-p', '-J', '-t', f'={name}:').stdout

    def assertNoCacheVariables(self, env):
        """The shell has none of the cache variables, and keeps the values that it inherited."""
        for name in ('TOKIWA_CACHE', 'TOKIWA_CACHE_ROOT', 'TOKIWA_CACHE_ROOT_FILE', 'TOKIWA_CACHE_MIN_FREE',
                     'TOKIWA_SESSION', 'XDG_CACHE_HOME', 'UV_CACHE_DIR', 'PIP_CACHE_DIR', 'npm_config_cache',
                     'TMPDIR', 'UV_LINK_MODE'):
            self.assertEqual(env.get(name), os.environ.get(name) if name[:6] != 'TOKIWA' else None, name)

    def use_root(self, **extra):
        root = Path(self.temp.name) / 'cache-root'
        root.mkdir()
        self.env['TOKIWA_CACHE_ROOT'] = str(root)
        self.env.update(extra)
        return root

    def test_a_new_session_gets_its_cache_variables(self):
        root = self.use_root()
        self.assertEqual(self.helper('ensure', 'worker-a').returncode, 0)
        env = self.shell_env('worker-a')
        cache = root / 'worker-a'
        self.assertEqual(env['TOKIWA_CACHE'], str(cache))
        self.assertEqual(env['XDG_CACHE_HOME'], str(cache / 'cache'))
        self.assertEqual(env['UV_CACHE_DIR'], str(cache / 'cache/uv'))
        self.assertEqual(env['PIP_CACHE_DIR'], str(cache / 'cache/pip'))
        self.assertEqual(env['npm_config_cache'], str(cache / 'cache/npm'))
        self.assertEqual(env['TMPDIR'], str(cache / 'tmp'))
        self.assertEqual(env['UV_LINK_MODE'], 'copy')
        for folder in ('cache', 'tmp', 'work'):
            self.assertEqual((cache / folder).stat().st_mode & 0o777, 0o700)
        tag = (cache / 'cache/CACHEDIR.TAG').read_text()
        self.assertTrue(tag.startswith('Signature: 8a477f597d28d172789f06886806bc55\n'))
        self.assertFalse((cache / 'tmp/CACHEDIR.TAG').exists())
        self.assertFalse((cache / 'work/CACHEDIR.TAG').exists())
        for name in ('TOKIWA_CACHE_ROOT', 'TOKIWA_CACHE_ROOT_FILE', 'TOKIWA_CACHE_MIN_FREE', 'TOKIWA_SESSION'):
            self.assertNotIn(name, env)
        self.assertNotIn('not available', self.screen_text('worker-a'))

    def test_the_root_file_gives_the_root_and_the_variable_wins(self):
        root = self.use_root()
        other = Path(self.temp.name) / 'other-root'
        other.mkdir()
        Path(self.env['TOKIWA_CACHE_ROOT_FILE']).write_text(f'{other}\nsecond line\n')
        del self.env['TOKIWA_CACHE_ROOT']
        self.assertEqual(self.helper('ensure', 'worker-a').returncode, 0)
        self.assertEqual(self.shell_env('worker-a')['TOKIWA_CACHE'], str(other / 'worker-a'))
        self.env['TOKIWA_CACHE_ROOT'] = str(root)
        self.assertEqual(self.helper('ensure', 'worker-b').returncode, 0)
        self.assertEqual(self.shell_env('worker-b')['TOKIWA_CACHE'], str(root / 'worker-b'))

    def test_an_existing_cache_tag_is_kept(self):
        root = self.use_root()
        (root / 'worker-a/cache').mkdir(parents=True)
        (root / 'worker-a/cache/CACHEDIR.TAG').write_text('Signature: 8a477f597d28d172789f06886806bc55\nkept\n')
        self.assertEqual(self.helper('ensure', 'worker-a').returncode, 0)
        self.shell_env('worker-a')
        self.assertIn('kept', (root / 'worker-a/cache/CACHEDIR.TAG').read_text())

    def test_an_unusable_root_keeps_the_defaults_with_one_notice(self):
        self.env['TOKIWA_CACHE_ROOT'] = '/nonexistent/x'
        self.assertEqual(self.helper('ensure', 'worker-a').returncode, 0)
        env = self.shell_env('worker-a')
        screen = self.screen_text('worker-a')
        self.assertNoCacheVariables(env)
        notice = ('Tokiwa: the session cache is not available (no such folder). '
                  'Temporary files and caches use the default places.')
        self.assertEqual(screen.count('Tokiwa: the session cache is not available'), 1)
        self.assertIn(notice, screen)

    def test_a_root_with_odd_characters_is_refused(self):
        self.env['TOKIWA_CACHE_ROOT'] = '/tmp/a b'
        self.assertEqual(self.helper('ensure', 'worker-a').returncode, 0)
        self.assertNoCacheVariables(self.shell_env('worker-a'))
        self.assertEqual(self.screen_text('worker-a').count('Tokiwa: the session cache is not available'), 1)

    def test_a_root_that_is_not_writable_is_refused(self):
        root = self.use_root()
        root.chmod(0o500)
        try:
            if os.access(root, os.W_OK):
                self.skipTest('this user can write to every folder')
            self.assertEqual(self.helper('ensure', 'worker-a').returncode, 0)
            self.assertNoCacheVariables(self.shell_env('worker-a'))
            self.assertIn('(not writable)', self.screen_text('worker-a'))
        finally:
            root.chmod(0o700)

    def test_a_cache_or_tmp_folder_that_is_a_link_is_refused(self):
        for folder in ('cache', 'tmp'):
            with self.subTest(folder=folder):
                root = Path(self.temp.name) / f'cache-root-{folder}'
                target = Path(self.temp.name) / f'elsewhere-{folder}'
                target.mkdir()
                self.env['TOKIWA_CACHE_ROOT'] = str(root)
                name = f'worker-{folder}'
                (root / name).mkdir(parents=True)
                (root / name / folder).symlink_to(target)
                self.assertEqual(self.helper('ensure', name).returncode, 0)
                self.assertNoCacheVariables(self.shell_env(name))
                self.assertIn('(not writable)', self.screen_text(name))
                self.assertEqual(list(target.iterdir()), [])

    def test_a_tmp_folder_that_this_user_cannot_write_is_refused(self):
        root = self.use_root()
        (root / 'worker-a/tmp').mkdir(parents=True)
        (root / 'worker-a/tmp').chmod(0o500)
        try:
            if os.access(root / 'worker-a/tmp', os.W_OK):
                self.skipTest('this user can write to every folder')
            self.assertEqual(self.helper('ensure', 'worker-a').returncode, 0)
            self.assertNoCacheVariables(self.shell_env('worker-a'))
            self.assertIn('(not writable)', self.screen_text('worker-a'))
        finally:
            (root / 'worker-a/tmp').chmod(0o700)

    def test_a_nearly_full_disk_keeps_the_defaults(self):
        self.use_root(TOKIWA_CACHE_MIN_FREE='1.0')
        self.assertEqual(self.helper('ensure', 'worker-a').returncode, 0)
        self.assertNoCacheVariables(self.shell_env('worker-a'))
        self.assertIn('(disk nearly full)', self.screen_text('worker-a'))

    def test_no_root_set_changes_nothing(self):
        self.assertEqual(self.helper('ensure', 'worker-a').returncode, 0)
        env = self.shell_env('worker-a')
        self.assertNoCacheVariables(env)
        self.assertNotIn('not available', self.screen_text('worker-a'))

    def test_a_renamed_session_keeps_its_folder(self):
        root = self.use_root()
        self.assertEqual(self.helper('ensure', 'worker-a').returncode, 0)
        identity = self.helper('snapshot').stdout
        identity = next(r for r in json.loads(identity)['sessions'] if r['name'] == 'worker-a')['identity']
        request = base64.b64encode(json.dumps({'to': 'worker-b', 'identity': identity}).encode()).decode()
        self.assertEqual(self.helper('rename', 'worker-a', request).returncode, 0)
        self.assertEqual(self.shell_env('worker-b')['TOKIWA_CACHE'], str(root / 'worker-a'))
        self.assertEqual(self.helper('ensure', 'worker-a').returncode, 0)
        self.assertEqual(self.shell_env('worker-a')['TOKIWA_CACHE'], str(root / 'worker-a'))

    def test_tokiwa_attention_rings_the_bell_of_its_own_pane(self):
        self.assertEqual(self.helper('ensure', 'lead').returncode, 0)
        pane = self.tm('display-message', '-p', '-t', '=lead:', '#{pane_id}').stdout.strip()
        command = ['bash', str(ROOT / 'tokiwa-attention')]
        inside = dict(os.environ, TMUX=f'{self.socket},0,0', TMUX_PANE=pane)
        result = subprocess.run(command, env=inside, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        flag = ''
        for _ in range(100):
            flag = self.tm('display-message', '-p', '-t', '=lead:', '#{window_bell_flag}').stdout.strip()
            if flag == '1':
                break
            time.sleep(.02)
        self.assertEqual(flag, '1')
        outside = {k: v for k, v in os.environ.items() if k not in ('TMUX', 'TMUX_PANE')}
        result = subprocess.run(command, env=outside, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('inside a Tokiwa session', result.stderr)


class Attention(ModelHelpers, Server):
    """tokiwa-attention marks its session also while a client has it open, until someone attaches."""

    def attention(self, name, *args):
        pane = self.tm('display-message', '-p', '-t', f'={name}:', '#{pane_id}').stdout.strip()
        inside = dict(os.environ, TMUX=f'{self.socket},0,0', TMUX_PANE=pane)
        result = subprocess.run(['bash', str(ROOT / 'tokiwa-attention'), *args], env=inside,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def open_client(self, *command):
        """Attach a client in a terminal; return its PID and terminal, once the server lists it."""
        pid, fd = pty.fork()
        if pid == 0:
            os.environ.update(self.env, TERM='xterm-256color')
            os.execv(command[0], list(command))
        for _ in range(200):
            if select.select([fd], [], [], 0.02)[0]:
                os.read(fd, 65536)
            if self.tm('list-clients', '-F', '#{client_name}').stdout.strip():
                break
        return pid, fd

    def close_client(self, pid, fd):
        # Close the terminal first: on macOS a process that writes to it cannot finish exiting.
        os.close(fd)
        os.kill(pid, 9)
        os.waitpid(pid, 0)

    def test_a_session_with_a_client_attached_is_marked_and_clear_unmarks_it(self):
        self.assertEqual(self.helper('ensure', 'lead').returncode, 0)
        pid, fd = self.open_client(self.tmux, '-N', '-S', self.socket, 'attach-session', '-t', '=lead')
        try:
            self.assertEqual(self.rows()['lead']['clients'], 1)
            self.attention('lead')
            self.assertGreater(self.rows()['lead']['attention'], 0)
            self.attention('lead', '--clear')
            self.assertEqual(self.rows()['lead']['attention'], 0)
        finally:
            self.close_client(pid, fd)

    def test_an_attach_through_the_helper_clears_the_mark(self):
        self.assertEqual(self.helper('ensure', 'lead').returncode, 0)
        self.attention('lead')
        identity = self.rows()['lead']['identity']
        self.assertGreater(self.rows()['lead']['attention'], 0)
        pid, fd = self.open_client('/bin/bash', str(ROOT / 'terminal-session.sh'), 'view', 'lead', identity)
        try:
            self.assertEqual(self.rows()['lead']['attention'], 0)
        finally:
            self.close_client(pid, fd)

    def test_other_arguments_are_refused(self):
        self.assertEqual(self.helper('ensure', 'lead').returncode, 0)
        pane = self.tm('display-message', '-p', '-t', '=lead:', '#{pane_id}').stdout.strip()
        inside = dict(os.environ, TMUX=f'{self.socket},0,0', TMUX_PANE=pane)
        result = subprocess.run(['bash', str(ROOT / 'tokiwa-attention'), '--other'], env=inside,
                                capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--clear', result.stderr)


class Control(ModelHelpers, Server):
    """interrupt, freeze and resume act only on the session with the given identity."""

    def started(self, name, command):
        """A Tokiwa session whose shell runs `command`; return its identity and the PID of the command."""
        self.assertEqual(self.helper('ensure', name).returncode, 0)
        self.tm('send-keys', '-t', f'={name}:', command, 'Enter')
        shell = self.tm('display-message', '-p', '-t', f'={name}:', '#{pane_pid}').stdout.strip()
        child = ''
        for _ in range(100):
            child = subprocess.run(['pgrep', '-P', shell], capture_output=True, text=True).stdout.split()
            if child:
                break
            time.sleep(.05)
        self.assertTrue(child, 'the command did not start')
        return self.rows()[name]['identity'], child[0]

    def state(self, pid):
        return subprocess.run(['ps', '-o', 'stat=', '-p', pid], capture_output=True, text=True).stdout.strip()

    def test_interrupt_sends_esc_to_the_session(self):
        identity, _ = self.started('lead', 'cat -v')
        result = self.helper('interrupt', 'lead', identity)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.tm('send-keys', '-t', '=lead:', 'x', 'Enter')
        self.screen('lead', '^[x')

    def test_freeze_stops_the_processes_and_resume_continues_them(self):
        identity, pid = self.started('lead', 'sleep 300')
        result = self.helper('freeze', 'lead', identity)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.state(pid).startswith('T'), self.state(pid))
        self.assertTrue(self.rows()['lead']['frozen'])
        result = self.helper('resume', 'lead', identity)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.state(pid).startswith('T'), self.state(pid))
        self.assertFalse(self.rows()['lead']['frozen'])

    def test_a_changed_identity_is_refused_and_nothing_happens(self):
        identity, pid = self.started('lead', 'sleep 300')
        stale = identity.rsplit(':', 1)[0] + ':1'
        for mode in ['interrupt', 'freeze', 'resume']:
            result = self.helper(mode, 'lead', stale)
            self.assertNotEqual(result.returncode, 0, mode)
            self.assertIn('identity changed', result.stderr)
            self.assertNotIn('freezed', result.stderr)
        self.assertFalse(self.state(pid).startswith('T'))
        self.assertFalse(self.rows()['lead']['frozen'])
        for mode in ['interrupt', 'freeze', 'resume']:
            self.assertNotEqual(self.helper(mode, 'lead').returncode, 0, mode)

    def audit(self):
        file = Path(self.env['TOKIWA_STATE']) / 'audit.log'
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

    def test_each_control_action_is_logged_with_its_interface(self):
        identity, _ = self.started('lead', 'sleep 300')
        self.env['TOKIWA_VIA'] = 'mcp'
        for mode in ['freeze', 'resume', 'interrupt']:
            self.assertEqual(self.helper(mode, 'lead', identity).returncode, 0, mode)
        self.env['TOKIWA_VIA'] = 'cli'
        self.assertEqual(self.helper('end', 'lead', identity).returncode, 0)
        entries = self.audit()
        self.assertEqual([(e['action'], e['name'], e['identity'], e['via']) for e in entries], [
            ('freeze', 'lead', identity, 'mcp'), ('resume', 'lead', identity, 'mcp'),
            ('interrupt', 'lead', identity, 'mcp'), ('end', 'lead', identity, 'cli')])
        self.assertTrue(all(isinstance(e['at'], int) for e in entries))
        file = Path(self.env['TOKIWA_STATE']) / 'audit.log'
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        shown = self.helper('audit')
        self.assertEqual(shown.returncode, 0, shown.stderr)
        self.assertEqual(len(shown.stdout.splitlines()), 4)

    def test_a_refused_action_and_a_read_are_not_logged(self):
        identity, _ = self.started('lead', 'sleep 300')
        stale = identity.rsplit(':', 1)[0] + ':1'
        self.helper('freeze', 'lead', stale)
        self.helper('snapshot')
        self.assertEqual(self.audit(), [])

    def test_create_logs_that_a_command_ran_but_not_the_command(self):
        root = Path(self.temp.name) / 'workspaces'
        (root / 'proj').mkdir(parents=True)
        self.env['TOKIWA_WORKSPACES'] = str(root)
        request = {'dir': str(root / 'proj'), 'project': 'proj', 'run': 'echo secret-looking-text'}
        self.assertEqual(self.helper('create', 'made', self.b64(request)).returncode, 0)
        entry = self.audit()[-1]
        self.assertEqual((entry['action'], entry['name'], entry['run']), ('create', 'made', True))
        self.assertNotIn('secret-looking-text', json.dumps(self.audit()))


class AgentPanes(ModelHelpers):
    """Stand-in agents: a pane that runs a program named `claude` or `codex`, and the hook reports."""

    def agent(self, name, program, text=''):
        """A Tokiwa session whose pane runs a program named `program`, as an agent would.

        The program prints `text`, then waits. Ctrl-C ends it, which leaves the shell as the pane command.
        """
        tools = Path(self.temp.name) / 'tools'
        tools.mkdir(exist_ok=True)
        # tmux names a pane by its program. A small compiled program, because macOS stops a copied
        # system binary and a script shows the name of its interpreter.
        if not shutil.which('cc'):
            self.skipTest('the stand-in agent needs a C compiler')
        (tools / 'agent.c').write_text('#include <stdio.h>\n#include <unistd.h>\n'
                                       'int main(int argc,char**argv){if(argc>1)puts(argv[1]);fflush(stdout);sleep(300);return 0;}\n')
        subprocess.run(['cc', '-o', str(tools / program), str(tools / 'agent.c')], check=True)
        self.assertEqual(self.helper('ensure', name).returncode, 0)
        self.tm('send-keys', '-t', f'={name}:', f"{tools / program} '{text}'", 'Enter')
        for _ in range(100):
            if self.tm('display-message', '-p', '-t', f'={name}:', '#{pane_current_command}').stdout.strip() == program:
                return
            time.sleep(.05)
        self.fail(f'{program} did not start')

    def report(self, name, state, inside=True):
        pane = self.tm('display-message', '-p', '-t', f'={name}:', '#{pane_id}').stdout.strip()
        env = {k: v for k, v in os.environ.items() if k not in ('TMUX', 'TMUX_PANE')}
        if inside:
            env.update(TMUX=f'{self.socket},0,0', TMUX_PANE=pane)
        # A hook sends its event as JSON on stdin; tokiwa-state reads and ignores it.
        return subprocess.run([sys.executable, str(ROOT / 'tokiwa-state'), state], env=env, input='{"hook_event_name": "Stop"}',
                              capture_output=True, text=True, timeout=10)


class AgentState(AgentPanes, Server):
    """tokiwa-state records the state that an agent's hook reports, and the snapshot shows it."""

    def test_a_reported_state_shows_while_the_agent_runs(self):
        self.agent('lead', 'claude')
        for state in ['working', 'waiting', 'idle', 'limited', 'error']:
            self.assertEqual(self.report('lead', state).returncode, 0)
            agent = self.rows()['lead']['agent']
            self.assertEqual(agent['state'], state)
            self.assertIsInstance(agent['at'], int)

    def test_codex_counts_as_an_agent_and_a_plain_shell_does_not(self):
        self.agent('coder', 'codex')
        self.report('coder', 'working')
        self.assertEqual(self.rows()['coder']['agent']['state'], 'working')
        self.assertEqual(self.helper('ensure', 'plain').returncode, 0)
        self.report('plain', 'working')
        # A state outlives the agent that reported it; without a running agent it is not shown.
        self.assertIsNone(self.rows()['plain']['agent'])

    def test_a_bad_state_or_no_session_changes_nothing_and_never_fails_the_hook(self):
        self.agent('lead', 'claude')
        self.report('lead', 'idle')
        for state in ['busy', '', 'idle;rm']:
            self.assertEqual(self.report('lead', state).returncode, 0, state)
        self.assertEqual(self.report('lead', 'working', inside=False).returncode, 0)
        self.assertEqual(self.rows()['lead']['agent']['state'], 'idle')

    def test_the_time_is_when_the_state_began_not_its_latest_report(self):
        self.agent('lead', 'claude')
        self.report('lead', 'idle')
        began = self.rows()['lead']['agent']['at']
        time.sleep(1.2)
        self.report('lead', 'idle')
        self.assertEqual(self.rows()['lead']['agent']['at'], began)
        self.report('lead', 'working')
        self.assertGreater(self.rows()['lead']['agent']['at'], began)

    def test_interrupt_sets_a_reported_agent_to_idle(self):
        self.agent('lead', 'claude')
        self.report('lead', 'working')
        identity = self.rows()['lead']['identity']
        self.assertEqual(self.helper('interrupt', 'lead', identity).returncode, 0)
        self.assertEqual(self.rows()['lead']['agent']['state'], 'idle')


class Digest(ModelHelpers, Server):
    """digest gives one line of facts for each session: its agent, its activity and its folder's git state."""

    def git(self, folder, *args):
        subprocess.run(['git', '-C', str(folder), *args], check=True, capture_output=True,
                       env=dict(os.environ, GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@example.com',
                                GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@example.com'))

    def created(self, name, folder):
        request = {'dir': str(folder), 'project': 'proj'}
        self.assertEqual(self.helper('create', name, self.b64(request)).returncode, 0)

    def digest(self):
        result = self.helper('digest')
        self.assertEqual(result.returncode, 0, result.stderr)
        return {row['name']: row for row in json.loads(result.stdout)['sessions']}

    def test_digest_reports_the_git_state_of_each_session_folder(self):
        root = Path(self.temp.name)
        remote, repo, plain = root / 'remote.git', root / 'repo', root / 'plain'
        subprocess.run(['git', 'init', '-q', '--bare', '-b', 'main', str(remote)], check=True)
        subprocess.run(['git', 'clone', '-q', str(remote), str(repo)], check=True, capture_output=True)
        self.git(repo, 'commit', '-q', '--allow-empty', '-m', 'first')
        self.git(repo, 'push', '-q', '-u', 'origin', 'HEAD:main')
        self.git(repo, 'commit', '-q', '--allow-empty', '-m', 'secret plan in a message')
        (repo / 'notes.txt').write_text('changed\n')
        plain.mkdir()
        self.created('lead', repo)
        self.created('other', plain)
        rows = self.digest()
        git = rows['lead']['git']
        self.assertEqual((git['branch'], git['unpushed'], git['changed']), ('main', 1, 1))
        self.assertRegex(git['commit'], r'^[0-9a-f]{7,}$')
        self.assertIsInstance(git['committed_at'], int)
        # A commit message can hold more than a name, and the digest is not encrypted.
        self.assertNotIn('secret plan', json.dumps(rows))
        self.assertIsNone(rows['other']['git'])
        for row in rows.values():
            self.assertIsInstance(row['active_at'], int)
            self.assertIn('agent', row)
            self.assertIn('identity', row)

    def test_a_branch_without_upstream_has_no_unpushed_count(self):
        repo = Path(self.temp.name) / 'solo'
        repo.mkdir()
        subprocess.run(['git', 'init', '-q', '-b', 'work', str(repo)], check=True)
        self.git(repo, 'commit', '-q', '--allow-empty', '-m', 'first')
        self.created('lead', repo)
        git = self.digest()['lead']['git']
        self.assertEqual((git['branch'], git['unpushed'], git['changed']), ('work', None, 0))

    def test_the_actor_of_an_action_is_logged_when_given(self):
        self.created('lead', Path(self.temp.name))
        identity = self.rows()['lead']['identity']
        self.env['TOKIWA_ACTOR'] = 'orchestrator-a'
        self.assertEqual(self.helper('interrupt', 'lead', identity).returncode, 0)
        self.env['TOKIWA_ACTOR'] = 'bad actor;rm'
        self.assertEqual(self.helper('interrupt', 'lead', identity).returncode, 0)
        lines = (Path(self.env['TOKIWA_STATE']) / 'audit.log').read_text().splitlines()
        entries = [json.loads(line) for line in lines if '"interrupt"' in line]
        self.assertEqual(entries[0]['actor'], 'orchestrator-a')
        self.assertNotIn('actor', entries[1])


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


class Pty:
    """Clients that attach through the helper in a pseudo-terminal, ended at the end of the test."""

    def attach_client(self, name, identity, mode):
        """Attach with helper mode `attach` or `view`. Return when tmux lists the new client."""
        before = len(self.tm('list-clients', '-t', '=' + name).stdout.splitlines())
        pid, fd = pty.fork()
        if pid == 0:
            os.environ.update(self.env, TERM='xterm-256color')
            os.execl('/bin/bash', 'bash', str(ROOT / 'terminal-session.sh'), mode, name, identity)
        self.addCleanup(self.end_client, name, pid, fd)
        for _ in range(200):
            if select.select([fd], [], [], 0.02)[0]:
                os.read(fd, 65536)
            if len(self.tm('list-clients', '-t', '=' + name).stdout.splitlines()) > before:
                return
        self.fail('The client did not attach.')

    def end_client(self, name, pid, fd):
        # Detach first, so that no client is left to write to a terminal that is closed.
        self.tm('detach-client', '-s', '=' + name)
        os.close(fd)
        os.kill(pid, 9)
        os.waitpid(pid, 0)


class CoreState(Pty, ModelHelpers, Server):
    """`state` reports facts of a session, with no agent field and no screen read."""

    KEYS = ['name', 'identity', 'session', 'program', 'clients', 'writable_clients', 'driver', 'sampled_at']

    def identity(self, name):
        return self.rows()[name]['identity']

    def state(self, name, identity=None):
        result = self.helper('state', name, identity or self.identity(name))
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_core_state_has_no_agent_fields(self):
        self.assertEqual(self.helper('ensure', 'plain').returncode, 0)
        record = self.state('plain')
        self.assertEqual(sorted(record), sorted(self.KEYS))
        self.assertEqual((record['session'], record['program'], record['driver']), ('live', 'shell', None))
        self.assertEqual((record['clients'], record['writable_clients']), (0, 0))

    def test_core_state_of_a_missing_or_replaced_session(self):
        record = self.state('nothing', '1:$2:3')
        self.assertEqual((sorted(record), record['session'], record['program']), (sorted(self.KEYS), 'gone', None))
        self.assertEqual(self.helper('ensure', 'plain').returncode, 0)
        self.assertEqual(self.state('plain', '1:$99:1')['session'], 'replaced')

    def test_core_state_shows_the_driver_and_other_programs(self):
        self.tm('new-session', '-d', '-s', 'job', 'sleep 300')
        self.tm('set-option', '-t', '=job:', '@tokiwa_driver', 'orchestrator-a')
        record = self.state('job')
        self.assertEqual((record['program'], record['driver']), ('other', 'orchestrator-a'))

    def test_core_state_reads_no_screen(self):
        # A wrapper that records each tmux call shows that `state` never captures a pane.
        tools = Path(self.temp.name) / 'wrap'
        tools.mkdir()
        log = Path(self.temp.name) / 'calls.log'
        (tools / 'tmux').write_text(f'#!/bin/bash\necho "$*" >> {log}\nexec {self.tmux} "$@"\n')
        (tools / 'tmux').chmod(0o755)
        self.assertEqual(self.helper('ensure', 'plain').returncode, 0)
        identity = self.identity('plain')
        self.env['PATH'] = f"{tools}:{os.environ['PATH']}"
        self.assertEqual(self.helper('state', 'plain', identity).returncode, 0)
        self.assertNotIn('capture-pane', log.read_text())

    def test_writable_and_read_only_clients_are_counted_by_session(self):
        self.assertEqual(self.helper('ensure', 'lead').returncode, 0)
        self.assertEqual(self.helper('ensure', 'other').returncode, 0)
        identity = self.identity('lead')
        self.attach_client('lead', identity, 'view')
        self.attach_client('lead', identity, 'attach')
        self.attach_client('other', self.identity('other'), 'attach')
        record = self.state('lead')
        self.assertEqual((record['clients'], record['writable_clients']), (2, 1))
        self.assertEqual(self.state('other')['writable_clients'], 1)
        # The identity decides, not the name: another identity under the name counts nothing.
        self.assertEqual(self.state('lead', '1:$99:1')['writable_clients'], 0)


class EndGuard(Pty, ModelHelpers, Server):
    """`end` refuses a session that a person can type into, on the host and in one tmux queue."""

    SENTENCE = 'A client is attached. Nothing was changed. Use --attached-ok to end it anyway.'

    def setUp(self):
        super().setUp()
        self.assertEqual(self.helper('ensure', 'lead').returncode, 0)
        self.identity = self.rows()['lead']['identity']

    def alive(self):
        return self.tm('has-session', '-t', '=lead').returncode == 0

    def test_end_refuses_a_writable_client_on_the_host(self):
        self.attach_client('lead', self.identity, 'attach')
        result = self.helper('end', 'lead', self.identity, 'check-clients')
        self.assertEqual(result.returncode, 1)
        self.assertIn(self.SENTENCE, result.stderr)
        self.assertTrue(self.alive())

    def test_end_with_a_read_only_viewer_succeeds(self):
        self.attach_client('lead', self.identity, 'view')
        result = self.helper('end', 'lead', self.identity, 'check-clients')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.alive())

    def test_helper_end_without_a_flag_ends_an_attached_session(self):
        # The behaviour of the base version: the identity is the only check.
        self.attach_client('lead', self.identity, 'attach')
        result = self.helper('end', 'lead', self.identity)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.alive())

    def test_end_takes_no_other_fourth_argument(self):
        for flag in ['force', 'attached-ok', '']:
            self.assertNotEqual(self.helper('end', 'lead', self.identity, flag).returncode, 0, flag)
        self.assertTrue(self.alive())

    def test_end_of_a_replaced_session_still_refuses_by_identity(self):
        for flag in [(), ('check-clients',)]:
            result = self.helper('end', 'lead', '1:$99:1', *flag)
            self.assertEqual(result.returncode, 1)
            self.assertIn('identity changed', result.stderr)
            self.assertTrue(self.alive())

    def test_end_refuses_a_client_that_attaches_between_count_and_end(self):
        # A wrapper around tmux that, right after the client list, attaches a control client
        # that can write. The count that the helper read is then one too low.
        tools = Path(self.temp.name) / 'wrap'
        tools.mkdir()
        flag = Path(self.temp.name) / 'attached'
        (tools / 'tmux').write_text(f"""#!/bin/bash
{self.tmux} "$@"; code=$?
if [[ " $* " == *' list-clients '* && ! -e {flag} ]]; then
 touch {flag}
 ( sleep 30 | {self.tmux} -N -S {self.socket} -C attach-session -t =lead ) </dev/null >/dev/null 2>&1 &
 for _ in $(seq 100); do
  [[ $({self.tmux} -N -S {self.socket} list-clients -t =lead | wc -l) -gt 0 ]] && break
  sleep 0.05
 done
fi
exit $code
""")
        (tools / 'tmux').chmod(0o755)
        self.env['PATH'] = f"{tools}:{os.environ['PATH']}"
        result = self.helper('end', 'lead', self.identity, 'check-clients')
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(self.SENTENCE, result.stderr)
        self.assertTrue(self.alive())


class AgentStateRecord(Pty, AgentPanes, Server):
    """`agent-state` reports the agent of one session as JSON; `agent-wait` returns when the agent needs a caller."""

    def identity(self, name):
        return self.rows()[name]['identity']

    def state(self, name, identity=None):
        result = self.helper('agent-state', name, identity or self.identity(name))
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def option(self, name, key, value):
        self.assertEqual(self.tm('set-option', '-t', f'={name}:', key, value).returncode, 0)

    def wait(self, name, after, identity=None, seconds='20'):
        self.env['TOKIWA_WAIT_SECONDS'] = seconds
        result = self.helper('agent-wait', name, identity or self.identity(name), str(after))
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def later(self, delay, action):
        """Run action from a thread after delay seconds. Return the thread."""
        thread = threading.Timer(delay, action)
        thread.start()
        self.addCleanup(thread.join)
        return thread

    def test_state_of_an_idle_agent(self):
        self.agent('lead', 'claude')
        self.option('lead', '@tokiwa_agent', 'idle:100')
        self.option('lead', '@tokiwa_agent_turn', '3')
        identity = self.identity('lead')
        record = self.state('lead')
        self.assertEqual(record['name'], 'lead')
        self.assertEqual(record['identity'], identity)
        self.assertEqual((record['session'], record['program'], record['agent'], record['agent_at']),
                         ('live', 'claude', 'idle', 100))
        self.assertEqual((record['turn'], record['pending'], record['dialog']), (3, None, False))
        self.assertEqual((record['clients'], record['writable_clients'], record['driver']), (0, 0, None))
        self.assertIsInstance(record['sampled_at'], int)

    def test_state_with_a_non_ascii_digit_is_unknown(self):
        # '²' is a digit to str.isdigit(), but int() refuses it.
        self.agent('lead', 'claude')
        self.option('lead', '@tokiwa_agent', 'idle:²')
        self.option('lead', '@tokiwa_agent_turn', '²')
        record = self.state('lead')
        self.assertEqual((record['agent'], record['agent_at'], record['turn']), ('unknown', None, 0))

    def test_state_of_an_agent_that_has_reported_nothing(self):
        self.agent('lead', 'codex')
        record = self.state('lead')
        self.assertEqual((record['program'], record['agent'], record['agent_at'], record['turn']), ('codex', 'unknown', None, 0))

    def test_state_of_a_shell(self):
        self.assertEqual(self.helper('ensure', 'plain').returncode, 0)
        # A state that an ended agent left behind does not show.
        self.option('plain', '@tokiwa_agent', 'idle:100')
        record = self.state('plain')
        self.assertEqual((record['session'], record['program'], record['agent'], record['agent_at']), ('live', 'shell', 'none', None))

    def test_state_of_another_program(self):
        self.tm('new-session', '-d', '-s', 'job', 'sleep 300')
        record = self.state('job', self.identity('job'))
        self.assertEqual((record['program'], record['agent']), ('other', 'none'))

    def test_state_of_a_missing_session_is_gone(self):
        record = self.state('nothing', '1:$2:3')
        self.assertEqual((record['session'], record['name'], record['identity']), ('gone', 'nothing', '1:$2:3'))
        self.assertEqual((record['program'], record['agent'], record['pending'], record['clients'], record['writable_clients']),
                         (None, 'none', None, 0, 0))

    def test_state_of_a_replaced_session(self):
        self.agent('lead', 'claude')
        self.option('lead', '@tokiwa_agent', 'idle:100')
        record = self.state('lead', '1:$99:1')
        self.assertEqual(record['session'], 'replaced')
        # Nothing of the other session shows.
        self.assertEqual((record['program'], record['agent'], record['turn'], record['driver']), (None, 'none', None, None))

    def test_state_after_rename(self):
        self.agent('lead', 'claude')
        identity = self.identity('lead')
        self.assertEqual(self.helper('rename', 'lead', self.b64({'to': 'lead-2', 'identity': identity})).returncode, 0)
        self.assertEqual(self.state('lead', identity)['session'], 'gone')
        self.assertEqual(self.state('lead-2', identity)['session'], 'live')

    def test_state_shows_the_pending_id_but_not_its_text(self):
        self.agent('lead', 'claude')
        item = {'id': 'toolu_x', 'kind': 'question', 'summary': 'Which database should it use?', 'options': ['sqlite', 'postgres'], 'at': 90}
        self.option('lead', '@tokiwa_agent_pending', self.b64(item))
        result = self.helper('agent-state', 'lead', self.identity('lead'))
        self.assertEqual(json.loads(result.stdout)['pending'], {'id': 'toolu_x', 'kind': 'question', 'at': 90})
        for text in ['Which database', 'sqlite']:
            self.assertNotIn(text, result.stdout)

    def test_state_reports_a_pending_item_that_cannot_be_read(self):
        self.agent('lead', 'claude')
        self.option('lead', '@tokiwa_agent_pending', 'not-base64!')
        self.assertIsNotNone(self.state('lead')['pending'])

    def test_state_reports_a_dialog(self):
        self.agent('lead', 'claude', 'Enter to confirm · Esc to cancel')
        self.screen('lead', 'Esc to cancel')
        self.assertTrue(self.state('lead')['dialog'])

    def test_a_dialog_marker_is_read_for_the_running_agent_only(self):
        self.agent('coder', 'codex', 'Do you want to proceed?')
        self.screen('coder', 'Do you want')
        self.assertFalse(self.state('coder')['dialog'])
        self.assertEqual(self.helper('ensure', 'plain').returncode, 0)
        self.tm('send-keys', '-t', '=plain:', 'echo "Enter to confirm"', 'Enter')
        self.screen('plain', 'Enter to confirm')
        self.assertFalse(self.state('plain')['dialog'])

    def test_screen_dialog_matches_only_the_last_15_lines(self):
        text = 'Do you want to run it?' + '\n' * 3 + '\n'.join(f'line {i}' for i in range(20))
        self.agent('lead', 'claude', text)
        self.screen('lead', 'line 19')
        self.assertFalse(self.state('lead')['dialog'])

    def test_agent_state_holds_the_core_facts(self):
        self.agent('lead', 'claude')
        self.attach_client('lead', self.identity('lead'), 'attach')
        record = self.state('lead')
        self.assertTrue({'name', 'identity', 'session', 'program', 'clients', 'writable_clients', 'driver', 'sampled_at'} <= set(record))
        self.assertEqual((record['clients'], record['writable_clients']), (1, 1))
        self.assertTrue({'agent', 'agent_at', 'turn', 'pending', 'dialog'} <= set(record))

    def test_wait_returns_turn_ended(self):
        self.agent('lead', 'claude')
        self.option('lead', '@tokiwa_agent', 'working:100')
        self.option('lead', '@tokiwa_agent_turn', '3')

        def finish():
            # The order of the hook: the state first, then the turn.
            self.option('lead', '@tokiwa_agent', 'idle:200')
            time.sleep(0.2)
            self.option('lead', '@tokiwa_agent_turn', '4')
        self.later(0.5, finish)
        record = self.wait('lead', 3)
        self.assertEqual((record['reason'], record['turn'], record['agent']), ('turn-ended', 4, 'idle'))

    def test_wait_does_not_return_for_a_turn_that_is_still_working(self):
        self.agent('lead', 'claude')
        self.option('lead', '@tokiwa_agent', 'working:100')
        self.option('lead', '@tokiwa_agent_turn', '4')
        self.assertEqual(self.wait('lead', 3, seconds='1')['reason'], 'timeout')

    def test_wait_on_limited_and_error_is_turn_ended(self):
        self.agent('lead', 'claude')
        self.option('lead', '@tokiwa_agent_turn', '4')
        for state in ['limited', 'error']:
            self.option('lead', '@tokiwa_agent', f'{state}:100')
            self.assertEqual(self.wait('lead', 3)['reason'], 'turn-ended', state)

    def test_wait_returns_pending(self):
        self.agent('lead', 'claude')
        self.option('lead', '@tokiwa_agent', 'working:100')
        self.option('lead', '@tokiwa_agent_turn', '3')
        item = {'id': 'toolu_p', 'kind': 'permission', 'summary': 'Bash: ls', 'options': [], 'at': 150}

        def ask():
            self.option('lead', '@tokiwa_agent', 'waiting:150')
            self.option('lead', '@tokiwa_agent_pending', self.b64(item))
        self.later(0.5, ask)
        record = self.wait('lead', 3)
        self.assertEqual((record['reason'], record['pending']['id']), ('pending', 'toolu_p'))

    def test_wait_returns_dialog(self):
        self.agent('lead', 'claude', 'Do you want to trust this folder?')
        self.option('lead', '@tokiwa_agent', 'working:100')
        self.screen('lead', 'trust this folder')
        record = self.wait('lead', 3)
        self.assertEqual((record['reason'], record['dialog']), ('dialog', True))

    def test_wait_reports_ended_when_the_agent_exits(self):
        self.agent('lead', 'claude')
        self.option('lead', '@tokiwa_agent', 'working:100')
        self.later(0.5, lambda: self.tm('send-keys', '-t', '=lead:', 'C-c'))
        record = self.wait('lead', 3)
        self.assertEqual((record['reason'], record['program'], record['agent']), ('ended', 'shell', 'none'))

    def test_wait_reports_ended_for_a_dead_pane_and_for_agent_none(self):
        self.agent('lead', 'claude')
        self.option('lead', '@tokiwa_agent', 'working:100')
        self.tm('set-option', '-w', '-t', '=lead:', 'remain-on-exit', 'on')
        self.tm('send-keys', '-t', '=lead:', 'C-c')
        self.tm('send-keys', '-t', '=lead:', 'exit', 'Enter')
        for _ in range(100):
            if self.tm('display-message', '-p', '-t', '=lead:', '#{pane_dead}').stdout.strip() == '1':
                break
            time.sleep(.05)
        record = self.wait('lead', 3)
        self.assertEqual((record['reason'], record['agent']), ('ended', 'none'))

    def test_wait_reports_ended_for_a_missing_or_replaced_session(self):
        self.assertEqual(self.wait('nothing', 3, '1:$2:3')['reason'], 'ended')
        self.agent('lead', 'claude')
        record = self.wait('lead', 3, '1:$99:1')
        self.assertEqual((record['reason'], record['session']), ('ended', 'replaced'))

    def test_wait_times_out(self):
        self.agent('lead', 'claude')
        self.option('lead', '@tokiwa_agent', 'working:100')
        self.option('lead', '@tokiwa_agent_turn', '3')
        started = time.monotonic()
        record = self.wait('lead', 3, seconds='1')
        self.assertEqual((record['reason'], record['turn']), ('timeout', 3))
        self.assertTrue(1 <= time.monotonic() - started < 5)

    def test_state_and_wait_check_their_arguments(self):
        for args in [('agent-state', 'lead'), ('agent-state', 'lead', 'x'), ('agent-state', 'bad name', '1:$2:3'),
                     ('agent-wait', 'lead', '1:$2:3'), ('agent-wait', 'lead', '1:$2:3', 'x'), ('agent-wait', 'lead', '1:$2:3', '-1'),
                     ('agent-wait', 'lead', '1:$2:3', '3', '4'), ('state', 'lead', '1:$2:3', 'more'), ('wait', 'lead', '1:$2:3', '3')]:
            result = self.helper(*args)
            self.assertNotEqual(result.returncode, 0, args)
            self.assertEqual(result.stdout, '', args)

    def test_state_changes_nothing_and_is_not_logged(self):
        self.agent('lead', 'claude')
        self.state('lead')
        self.assertFalse((Path(self.temp.name) / 'state' / 'audit.log').exists())


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


class Driver(Pty, ModelHelpers, Server):
    """The driver is the one actor that may send to a session. `claim` and `release` change it."""

    def setUp(self):
        super().setUp()
        self.assertEqual(self.helper('ensure', 'lead').returncode, 0)
        self.identity = self.rows()['lead']['identity']

    def as_actor(self, actor, *args):
        self.env['TOKIWA_ACTOR'] = actor
        return self.helper(*args)

    def driver(self, name='lead'):
        return json.loads(self.helper('state', name, self.identity).stdout)['driver']

    def audit(self):
        file = Path(self.env['TOKIWA_STATE']) / 'audit.log'
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

    def create(self, name, actor=None):
        root = Path(self.temp.name) / 'workspaces'
        root.mkdir(exist_ok=True)
        self.env['TOKIWA_WORKSPACES'] = str(root)
        self.env.pop('TOKIWA_ACTOR', None)
        if actor:
            self.env['TOKIWA_ACTOR'] = actor
        result = self.helper('create', name, self.b64({'folder': 'inbox'}))
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(self.helper('state', name, self.rows()[name]['identity']).stdout)

    def test_create_with_an_actor_records_the_driver(self):
        self.assertEqual(self.create('made', 'orchestrator-a')['driver'], 'orchestrator-a')

    def test_create_without_an_actor_records_none(self):
        self.assertIsNone(self.create('made')['driver'])

    def test_claim_without_a_driver(self):
        result = self.as_actor('worker-a', 'claim', 'lead', self.identity)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.driver(), 'worker-a')
        self.assertEqual([(e['action'], e['actor']) for e in self.audit()], [('claim', 'worker-a')])

    def test_claim_by_the_driver_again_succeeds(self):
        self.as_actor('worker-a', 'claim', 'lead', self.identity)
        result = self.as_actor('worker-a', 'claim', 'lead', self.identity)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.driver(), 'worker-a')

    def test_claim_of_another_drivers_session_is_refused(self):
        self.as_actor('worker-a', 'claim', 'lead', self.identity)
        result = self.as_actor('worker-b', 'claim', 'lead', self.identity)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Another actor is the driver. Nothing was changed.', result.stderr)
        self.assertEqual(self.driver(), 'worker-a')

    def test_claim_replace_takes_it_and_audits_both_names(self):
        self.as_actor('worker-a', 'claim', 'lead', self.identity)
        result = self.as_actor('worker-b', 'claim', 'lead', self.identity, 'replace')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.driver(), 'worker-b')
        last = self.audit()[-1]
        self.assertEqual((last['action'], last['actor'], last['replaced']), ('claim', 'worker-b', 'worker-a'))

    def test_claim_takes_no_other_fourth_argument(self):
        for flag in ['force', '--replace', '']:
            self.assertNotEqual(self.as_actor('worker-a', 'claim', 'lead', self.identity, flag).returncode, 0, flag)
        self.assertIsNone(self.driver())

    def test_claim_is_refused_while_a_writable_client_is_attached(self):
        self.attach_client('lead', self.identity, 'attach')
        result = self.as_actor('worker-a', 'claim', 'lead', self.identity)
        self.assertEqual(result.returncode, 1)
        self.assertIn('A client is attached. Nothing was changed.', result.stderr)
        self.assertIsNone(self.driver())

    def test_claim_with_a_read_only_viewer_succeeds(self):
        self.attach_client('lead', self.identity, 'view')
        result = self.as_actor('worker-a', 'claim', 'lead', self.identity)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.driver(), 'worker-a')

    def test_claim_refuses_a_replaced_identity(self):
        result = self.as_actor('worker-a', 'claim', 'lead', '1:$99:1')
        self.assertEqual(result.returncode, 1)
        self.assertIn('Session identity changed. Nothing was changed.', result.stderr)
        self.assertIsNone(self.driver())

    def test_a_stale_identity_reaches_the_client_filter(self):
        # With a writable client attached, only the session id filter of the count lets the answer
        # be a changed identity: without it the answer would be that a client is attached.
        self.attach_client('lead', self.identity, 'attach')
        for args in [('claim', 'lead', '1:$99:1'), ('end', 'lead', '1:$99:1', 'check-clients')]:
            result = self.as_actor('worker-a', *args)
            self.assertEqual(result.returncode, 1, args)
            self.assertIn('Session identity changed.', result.stderr)
            self.assertNotIn('client is attached', result.stderr)

    def test_claim_refuses_a_client_that_attaches_between_count_and_claim(self):
        tools = Path(self.temp.name) / 'wrap'
        tools.mkdir()
        flag = Path(self.temp.name) / 'attached'
        (tools / 'tmux').write_text(f"""#!/bin/bash
{self.tmux} "$@"; code=$?
if [[ " $* " == *' list-clients '* && ! -e {flag} ]]; then
 touch {flag}
 ( sleep 30 | {self.tmux} -N -S {self.socket} -C attach-session -t =lead ) </dev/null >/dev/null 2>&1 &
 for _ in $(seq 100); do
  [[ $({self.tmux} -N -S {self.socket} list-clients -t =lead | wc -l) -gt 0 ]] && break
  sleep 0.05
 done
fi
exit $code
""")
        (tools / 'tmux').chmod(0o755)
        self.env['PATH'] = f"{tools}:{os.environ['PATH']}"
        result = self.as_actor('worker-a', 'claim', 'lead', self.identity)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('A client is attached. Nothing was changed.', result.stderr)
        self.assertIsNone(self.driver())

    def test_claim_without_an_actor_is_refused(self):
        for actor in ['', 'bad;rm', '-x']:
            result = self.as_actor(actor, 'claim', 'lead', self.identity)
            self.assertEqual(result.returncode, 1, actor)
            self.assertIn('Nothing was changed.', result.stderr)
        self.assertIsNone(self.driver())

    def test_release_by_the_driver(self):
        self.as_actor('worker-a', 'claim', 'lead', self.identity)
        result = self.as_actor('worker-a', 'release', 'lead', self.identity)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(self.driver())
        self.assertEqual([e['action'] for e in self.audit()], ['claim', 'release'])

    def test_release_by_another_actor_is_refused(self):
        self.as_actor('worker-a', 'claim', 'lead', self.identity)
        result = self.as_actor('worker-b', 'release', 'lead', self.identity)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Only the driver can release. Nothing was changed.', result.stderr)
        self.assertEqual(self.driver(), 'worker-a')

    def test_release_without_a_driver_is_refused(self):
        result = self.as_actor('worker-a', 'release', 'lead', self.identity)
        self.assertEqual(result.returncode, 1)
        self.assertEqual([e['action'] for e in self.audit()], [])

    def test_release_refuses_a_replaced_identity(self):
        self.as_actor('worker-a', 'claim', 'lead', self.identity)
        result = self.as_actor('worker-a', 'release', 'lead', '1:$99:1')
        self.assertEqual(result.returncode, 1)
        self.assertIn('Session identity changed. Nothing was changed.', result.stderr)
        self.assertEqual(self.driver(), 'worker-a')


FAKE_AGENT = r'''
#include <fcntl.h>
#include <stdio.h>
#include <termios.h>
#include <unistd.h>
/* Turns on bracketed paste, reads raw input and appends every byte to the log in argv[1]. */
int main(int argc, char **argv) {
    struct termios t;
    tcgetattr(0, &t);
    cfmakeraw(&t);
    tcsetattr(0, TCSANOW, &t);
    int log = open(argv[1], O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (argc > 2) puts(argv[2]);
    printf("\033[?2004h");
    fflush(stdout);
    char buffer[4096];
    ssize_t n;
    while ((n = read(0, buffer, sizeof buffer)) > 0) write(log, buffer, n);
    return 0;
}
'''


class AgentSession(Pty, ModelHelpers, Server):
    """A stand-in agent in the session `lead`, claimed by the actor `worker-a`, and the log of its input."""

    def setUp(self):
        super().setUp()
        if not shutil.which('cc'):
            self.skipTest('the stand-in agent needs a C compiler')
        self.tools = Path(self.temp.name) / 'tools'
        self.tools.mkdir()
        (self.tools / 'agent.c').write_text(FAKE_AGENT)
        for program in ('claude', 'codex'):
            subprocess.run(['cc', '-o', str(self.tools / program), str(self.tools / 'agent.c')], check=True)
        self.log = Path(self.temp.name) / 'agent.log'
        self.start_agent('lead')
        self.identity = self.rows()['lead']['identity']
        self.claim('worker-a')

    def start_agent(self, name, program='claude', screen=''):
        """A Tokiwa session whose pane runs the stand-in agent in the idle state, with bracketed paste on."""
        self.assertEqual(self.helper('ensure', name).returncode, 0)
        self.tm('send-keys', '-t', f'={name}:', f"{self.tools / program} {self.log} '{screen}'", 'Enter')
        for _ in range(150):
            command = self.tm('display-message', '-p', '-t', f'={name}:', '#{pane_current_command}').stdout.strip()
            if command == program and self.log.exists():
                break
            time.sleep(.02)
        else:
            self.fail(f'{program} did not start')
        time.sleep(.1)
        self.option(name, '@tokiwa_agent', 'idle:100')
        self.option(name, '@tokiwa_agent_turn', '4')

    def option(self, name, key, value):
        self.assertEqual(self.tm('set-option', '-t', f'={name}:', key, value).returncode, 0)

    def claim(self, actor, name='lead'):
        self.env['TOKIWA_ACTOR'] = actor
        result = self.helper('claim', name, self.rows()[name]['identity'], 'replace')
        self.assertEqual(result.returncode, 0, result.stderr)

    def send(self, text, name='lead', identity=None, actor='worker-a'):
        env = dict(self.env)
        env.pop('TOKIWA_ACTOR', None)
        if actor is not None:
            env['TOKIWA_ACTOR'] = actor
        data = text if isinstance(text, bytes) else text.encode('utf-8')
        return subprocess.run(['bash', str(ROOT / 'terminal-session.sh'), 'agent-send', name, identity or self.identity],
                              env=env, input=data, capture_output=True, timeout=30)

    def events(self, count=None):
        """The log of the stand-in agent as ('paste', text) and ('enter',) events. Waits for `count` of them."""
        for _ in range(150):
            data = self.log.read_bytes()
            found = []
            for part in re.split(rb'(\x1b\[200~.*?\x1b\[201~|\r)', data, flags=re.S):
                if part == b'\r':
                    found.append(('enter',))
                elif part.startswith(b'\x1b[200~'):
                    found.append(('paste', part[6:-6].decode('utf-8')))
                elif part:
                    found.append(('other', part))
            if count is None or len(found) >= count:
                return found
            time.sleep(.02)
        return found

    def refused(self, result, sentence):
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(sentence, result.stderr.decode())
        time.sleep(.2)
        self.assertEqual(self.events(), [])
        self.assertEqual(self.tm('list-buffers').stdout, '')


class AgentSend(AgentSession):
    """`agent-send` delivers one message to an idle agent as one bracketed paste, or refuses."""

    LABEL = '[Message from agent worker-a through Tokiwa. It is not from the owner and carries no owner approval.]'

    def test_send_to_an_idle_agent(self):
        result = self.send('Please read LEAD.md.')
        self.assertEqual(result.returncode, 0, result.stderr)
        reply = json.loads(result.stdout)
        self.assertEqual(reply['turn_before'], 4)
        self.assertLessEqual(abs(reply['sent_at'] - time.time()), 5)
        self.assertEqual(self.events(2), [('paste', self.LABEL + '\nPlease read LEAD.md.'), ('enter',)])

    def test_message_starts_with_the_agent_label(self):
        self.claim('orchestrator-a')
        self.assertEqual(self.send('hi', actor='orchestrator-a').returncode, 0)
        expected = '[Message from agent orchestrator-a through Tokiwa. It is not from the owner and carries no owner approval.]\nhi'
        self.assertEqual(self.events(2)[0], ('paste', expected))

    def test_send_with_a_read_only_viewer(self):
        self.attach_client('lead', self.identity, 'view')
        self.assertEqual(self.send('hello').returncode, 0)
        self.assertEqual(self.events(2)[1], ('enter',))

    def test_send_when_limited(self):
        self.option('lead', '@tokiwa_agent', 'limited:100')
        self.assertEqual(self.send('hello').returncode, 0)
        self.assertEqual(len(self.events(2)), 2)

    def test_send_when_error(self):
        self.option('lead', '@tokiwa_agent', 'error:100')
        self.assertEqual(self.send('hello').returncode, 0)
        self.assertEqual(len(self.events(2)), 2)

    def test_send_to_a_codex_pane(self):
        self.start_agent('other', 'codex')
        self.claim('worker-a', 'other')
        result = self.send('hello', 'other', self.rows()['other']['identity'])
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_unicode_multiline_message_arrives_as_one_paste(self):
        text = 'Grüße ☃ 日本語\n\n  indented line\twith tab\n' + ('Zeile mit Äpfeln und Öl.\n' * 400) + 'end'
        self.assertLess(len(text.encode()), 16384)
        self.assertEqual(self.send(text).returncode, 0)
        self.assertEqual(self.events(2), [('paste', self.LABEL + '\n' + text), ('enter',)])

    def test_the_paste_buffer_is_deleted(self):
        self.assertEqual(self.send('hello').returncode, 0)
        self.events(2)
        self.assertEqual(self.tm('list-buffers').stdout, '')

    def test_send_sets_working_in_the_same_queue(self):
        before = int(time.time())
        reply = json.loads(self.send('hello').stdout)
        state = self.tm('show-options', '-qv', '-t', '=lead:', '@tokiwa_agent').stdout.strip()
        self.assertEqual(state, f"working:{reply['sent_at']}")
        self.assertGreaterEqual(reply['sent_at'], before)

    def test_second_send_before_the_hook_is_refused(self):
        self.assertEqual(self.send('first').returncode, 0)
        self.events(2)
        result = self.send('second')
        self.assertEqual(result.returncode, 1)
        self.assertIn('The agent is not idle. Nothing was sent.', result.stderr.decode())
        time.sleep(.2)
        self.assertEqual(len(self.events()), 2)

    def test_send_writes_an_audit_line_without_the_text(self):
        self.env['TOKIWA_VIA'] = 'mcp'
        self.assertEqual(self.send('marker-text-77 hello').returncode, 0)
        lines = (Path(self.env['TOKIWA_STATE']) / 'audit.log').read_text().splitlines()
        entry = json.loads(lines[-1])
        self.assertEqual((entry['action'], entry['name'], entry['identity'], entry['via'], entry['actor']),
                         ('send', 'lead', self.identity, 'mcp', 'worker-a'))
        self.assertNotIn('marker-text', '\n'.join(lines))

    def test_send_refuses_a_replaced_identity(self):
        self.refused(self.send('hello', identity='1:$99:1'), 'Session identity changed. Nothing was sent.')

    def test_send_refuses_a_shell_pane(self):
        self.assertEqual(self.helper('ensure', 'plain').returncode, 0)
        self.claim('worker-a', 'plain')
        self.option('plain', '@tokiwa_agent', 'idle:100')
        result = self.send('hello', 'plain', self.rows()['plain']['identity'])
        self.assertEqual(result.returncode, 1)
        self.assertIn('The pane does not run an agent. Nothing was sent.', result.stderr.decode())
        # The shell never saw the text.
        self.assertNotIn('Tokiwa', self.tm('capture-pane', '-p', '-t', '=plain:').stdout)

    def test_send_refuses_a_writable_client(self):
        self.attach_client('lead', self.identity, 'attach')
        self.refused(self.send('hello'), 'A client is attached. Nothing was sent.')

    def test_send_refuses_a_client_that_attaches_between_count_and_paste(self):
        tools = Path(self.temp.name) / 'wrap'
        tools.mkdir()
        flag = Path(self.temp.name) / 'attached'
        (tools / 'tmux').write_text(f"""#!/bin/bash
{self.tmux} "$@"; code=$?
if [[ " $* " == *' list-clients '* && ! -e {flag} ]]; then
 touch {flag}
 ( sleep 30 | {self.tmux} -N -S {self.socket} -C attach-session -t =lead ) </dev/null >/dev/null 2>&1 &
 for _ in $(seq 100); do
  [[ $({self.tmux} -N -S {self.socket} list-clients -t =lead | wc -l) -gt 0 ]] && break
  sleep 0.05
 done
fi
exit $code
""")
        (tools / 'tmux').chmod(0o755)
        self.env['PATH'] = f"{tools}:{os.environ['PATH']}"
        self.refused(self.send('hello'), 'A client is attached. Nothing was sent.')

    def test_send_refuses_without_an_actor(self):
        for actor in [None, '', 'bad;rm', '-x']:
            self.refused(self.send('hello', actor=actor), 'Nothing was sent.')

    def test_send_refuses_another_driver(self):
        self.claim('worker-b')
        self.refused(self.send('hello'), 'Only the driver can send.')

    def test_send_refuses_without_a_driver(self):
        self.assertEqual(self.tm('set-option', '-u', '-t', '=lead:', '@tokiwa_driver').returncode, 0)
        self.refused(self.send('hello'), 'Only the driver can send.')

    def test_send_refuses_while_working(self):
        self.option('lead', '@tokiwa_agent', 'working:100')
        self.refused(self.send('hello'), 'The agent is not idle. Nothing was sent.')

    def test_send_refuses_an_agent_that_has_reported_nothing(self):
        self.assertEqual(self.tm('set-option', '-u', '-t', '=lead:', '@tokiwa_agent').returncode, 0)
        self.refused(self.send('hello'), 'The agent is not idle. Nothing was sent.')

    def test_send_refuses_with_a_pending_item(self):
        self.option('lead', '@tokiwa_agent_pending', self.b64({'id': 'q1', 'kind': 'question', 'at': 5}))
        self.refused(self.send('hello'), 'An item waits for a person. Nothing was sent.')

    def test_send_refuses_a_pane_in_copy_mode(self):
        self.assertEqual(self.tm('copy-mode', '-t', '=lead:').returncode, 0)
        self.refused(self.send('hello'), 'The pane is in copy mode. Nothing was sent.')
        self.assertEqual(self.tm('show-options', '-qv', '-t', '=lead:', '@tokiwa_agent').stdout.strip(), 'idle:100')

    def test_send_refuses_a_pane_that_enters_copy_mode_between_check_and_paste(self):
        # The wrapper puts the pane in copy mode right after the buffer is loaded.
        tools = Path(self.temp.name) / 'mode-bin'
        tools.mkdir()
        (tools / 'tmux').write_text(f'''#!/bin/bash
{self.tmux} "$@"; code=$?
if [[ " $* " == *' load-buffer '* ]]; then {self.tmux} -N -S {self.socket} copy-mode -t =lead:; fi
exit $code
''')
        (tools / 'tmux').chmod(0o755)
        self.env['PATH'] = f"{tools}:{os.environ['PATH']}"
        self.refused(self.send('hello'), 'The pane cannot take input now. Nothing was sent.')
        self.assertEqual(self.tm('show-options', '-qv', '-t', '=lead:', '@tokiwa_agent').stdout.strip(), 'idle:100')

    def test_send_refuses_a_pane_with_input_off(self):
        self.assertEqual(self.tm('select-pane', '-d', '-t', '=lead:').returncode, 0)
        self.refused(self.send('hello'), 'The pane does not take input. Nothing was sent.')

    def test_send_refuses_a_dialog_on_screen(self):
        self.log.unlink()
        self.tm('kill-session', '-t', '=lead')
        self.start_agent('lead', screen='Enter to confirm')
        self.identity = self.rows()['lead']['identity']
        self.claim('worker-a')
        self.refused(self.send('hello'), 'A dialog is on the screen. Nothing was sent.')

    def test_send_refuses_control_characters(self):
        for bad in ['bell\a', 'esc\x1b[31m', 'cr\rreturn', 'nul\x00', 'del\x7f', 'c1\x85next', 'csi\x9b31m']:
            self.refused(self.send(bad), 'control character')

    def test_send_refuses_a_leading_slash_bang_or_hash(self):
        for bad in ['/clear', '!ls', '#note', '   /clear', '\t!ls', '  \n#x']:
            self.refused(self.send(bad), 'starts with')
        # The same characters later in the text are fine.
        self.assertEqual(self.send('read /etc and #3 and !x').returncode, 0)

    def test_send_refuses_text_over_the_limit(self):
        self.refused(self.send('x' * 16385), 'over 16384 bytes')
        self.refused(self.send('ä' * 8193), 'over 16384 bytes')
        self.assertEqual(self.send('x' * 16384).returncode, 0)

    def test_send_refuses_empty_text(self):
        for bad in ['', '\n', '  \t \n']:
            self.refused(self.send(bad), 'The message is empty. Nothing was sent.')

    def test_send_refuses_text_that_is_not_utf8(self):
        self.refused(self.send(b'bad \xff\xfe'), 'not UTF-8 text')

    def test_core_delivery_has_no_agent_checks(self):
        # The core function pastes into a shell pane: the shell refusal lives in the agent layer.
        self.assertEqual(self.helper('ensure', 'plain').returncode, 0)
        self.claim('worker-a', 'plain')
        identity = self.rows()['plain']['identity']
        result = subprocess.run(['bash', '-c', 'identity=$1; set --; source "$0"; name=plain; core_deliver "$identity"', str(ROOT / 'terminal-session.sh'), identity],
                                env=dict(self.env, TOKIWA_SOURCE_ONLY='1', TOKIWA_ACTOR='worker-a'),
                                input=b'echo core-text-$((6 * 7))', capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.screen('plain', 'core-text-42')

    def test_core_delivery_still_refuses_another_driver(self):
        self.assertEqual(self.helper('ensure', 'plain').returncode, 0)
        self.claim('worker-b', 'plain')
        identity = self.rows()['plain']['identity']
        result = subprocess.run(['bash', '-c', 'identity=$1; set --; source "$0"; name=plain; core_deliver "$identity"', str(ROOT / 'terminal-session.sh'), identity],
                                env=dict(self.env, TOKIWA_SOURCE_ONLY='1', TOKIWA_ACTOR='worker-a'),
                                input=b'echo core-text', capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Only the driver can send.', result.stderr.decode())
        self.assertEqual(self.tm('list-buffers').stdout, '')

    def test_a_failed_paste_leaves_no_text_and_no_buffer(self):
        folder = Path(self.temp.name) / 'fail-bin'
        folder.mkdir()
        (folder / 'tmux').write_text(f'''#!/bin/bash
if [[ " $* " == *" paste-buffer "* ]]; then echo 'tmux failed' >&2; exit 1; fi
exec {self.tmux} "$@"
''')
        (folder / 'tmux').chmod(0o755)
        self.env['PATH'] = f"{folder}:{self.env['PATH']}"
        result = self.send('hello')
        self.assertEqual(result.returncode, 1)
        time.sleep(.2)
        self.assertEqual(self.events(), [])
        self.assertEqual(self.tm('list-buffers').stdout, '')
        # The state did not change, so the caller may try again.
        self.assertEqual(self.tm('show-options', '-qv', '-t', '=lead:', '@tokiwa_agent').stdout.strip(), 'idle:100')

    def test_one_paste_call_holds_the_paste_and_the_enter(self):
        folder = Path(self.temp.name) / 'rec-bin'
        folder.mkdir()
        record = Path(self.temp.name) / 'argv.log'
        (folder / 'tmux').write_text(f'''#!/bin/bash
printf '%s\\n' "$*" >> {record}
exec {self.tmux} "$@"
''')
        (folder / 'tmux').chmod(0o755)
        self.env['PATH'] = f"{folder}:{self.env['PATH']}"
        self.assertEqual(self.send('marker-text-88').returncode, 0)
        calls = record.read_text()
        self.assertNotIn('marker-text', calls)
        deliveries = [c for c in calls.splitlines() if 'paste-buffer' in c]
        self.assertEqual(len(deliveries), 1)
        self.assertIn('send-keys', deliveries[0])
        self.assertIn('set-option', deliveries[0])
        self.assertIn('working:', deliveries[0])


class AgentAnswer(AgentSession):
    """`agent-answer` presses the digit of an option for a pending question, or refuses."""

    ITEM = {'id': 'toolu_q1', 'kind': 'question', 'summary': 'Which parser?', 'options': ['Text', 'Binary'],
            'tool': 'AskUserQuestion', 'questions': 1, 'multi_select': False, 'at': 5}

    def setUp(self):
        super().setUp()
        # A question that is live shows its dialog.
        self.restart('Enter to confirm')
        self.ask(self.ITEM)

    def restart(self, screen):
        """Run the stand-in agent again in `lead` with `screen` as its screen text."""
        self.log.unlink()
        self.tm('kill-session', '-t', '=lead')
        self.start_agent('lead', screen=screen)
        self.identity = self.rows()['lead']['identity']
        self.claim('worker-a')

    def ask(self, item):
        self.option('lead', '@tokiwa_agent', 'waiting:100')
        self.option('lead', '@tokiwa_agent_pending', self.b64(item))
        # The `note` of the question's own tool call, which the PreToolUse hook records.
        self.option('lead', '@tokiwa_agent_last_tool', self.b64(self.tool_call(item.get('id'), 'AskUserQuestion')))

    def tool_call(self, tool_use_id, tool):
        return {'id': tool_use_id, 'tool': tool, 'summary': '', 'at': 5}

    def note(self, event):
        """Run tokiwa-state `note` in the pane of `lead`, as the PreToolUse hook of a tool call does."""
        pane = self.tm('display-message', '-p', '-t', '=lead:', '#{pane_id}').stdout.strip()
        env = dict(self.env, TMUX=f'{self.socket},0,0', TMUX_PANE=pane)
        result = subprocess.run([sys.executable, str(ROOT / 'tokiwa-state'), 'note'], env=env, input=json.dumps(event),
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def change_after_checks(self, key, value):
        """Make tmux set the option `key` of `lead` to `value` right after the checks read the session."""
        folder = Path(tempfile.mkdtemp(dir=self.temp.name))
        (folder / 'tmux').write_text(f"""#!/bin/bash
{self.tmux} "$@"; code=$?
if [[ " $* " == *' list-clients '* ]]; then {self.tmux} -N -S {self.socket} set-option -t =lead: {key} '{value}'; fi
exit $code
""")
        (folder / 'tmux').chmod(0o755)
        self.env['PATH'] = f"{folder}:{os.environ['PATH']}"

    def test_answer_refuses_when_the_agent_is_not_waiting(self):
        for state in ['idle:100', 'working:100', 'waiting']:
            self.option('lead', '@tokiwa_agent', state)
            self.refused_with(self.answer('1'), 'The agent is not waiting for an answer. Nothing was sent.')
        self.tm('set-option', '-u', '-t', '=lead:', '@tokiwa_agent')
        self.refused_with(self.answer('1'), 'The agent is not waiting for an answer. Nothing was sent.')

    def test_answer_after_interrupt_is_refused(self):
        self.env['TOKIWA_ACTOR'] = 'worker-a'
        self.assertEqual(self.helper('interrupt', 'lead', self.identity).returncode, 0)
        # Esc closes the question, so the interrupt clears the item with the state.
        self.assertEqual(self.value('@tokiwa_agent_pending'), '')
        self.assertTrue(self.value('@tokiwa_agent').startswith('idle:'))
        result = self.answer('1')
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('Nothing was sent.', result.stderr.decode())
        time.sleep(.2)
        self.assertEqual(self.events(), [('other', b'\x1b')])
        self.assertEqual(self.value('@tokiwa_agent_input'), '')

    def test_answer_after_a_later_tool_call_is_refused(self):
        self.note({'hook_event_name': 'PreToolUse', 'tool_name': 'Bash', 'tool_use_id': 'toolu_bash_b',
                   'tool_input': {'command': 'make check'}})
        self.refused_with(self.answer('1'), 'The question is not the last tool call of the agent. Nothing was sent.')

    def test_answer_refuses_without_a_record_of_the_question_tool_call(self):
        self.tm('set-option', '-u', '-t', '=lead:', '@tokiwa_agent_last_tool')
        self.refused_with(self.answer('1'), 'The question is not the last tool call of the agent. Nothing was sent.')
        self.option('lead', '@tokiwa_agent_last_tool', 'not-base64!')
        self.refused_with(self.answer('1'), 'The question is not the last tool call of the agent. Nothing was sent.')

    def test_answer_after_the_note_of_the_question_itself_is_accepted(self):
        # The recorder writes the note of the question's own call: its id is the pending id.
        self.note({'hook_event_name': 'PreToolUse', 'tool_name': 'AskUserQuestion', 'tool_use_id': 'toolu_q1',
                   'tool_input': {'questions': []}})
        result = self.answer('2')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.events(2), [('other', b'2'), ('enter',)])

    def test_answer_refuses_a_state_that_changes_between_check_and_keys(self):
        self.change_after_checks('@tokiwa_agent', 'idle:200')
        result = self.answer('1')
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('The agent is not waiting for an answer. Nothing was sent.', result.stderr.decode())
        time.sleep(.2)
        self.assertEqual(self.events(), [])
        self.assertEqual(self.value('@tokiwa_agent_input'), '')

    def test_answer_refuses_a_tool_call_that_starts_between_check_and_keys(self):
        self.change_after_checks('@tokiwa_agent_last_tool', self.b64(self.tool_call('toolu_bash_b', 'Bash')))
        result = self.answer('1')
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('The question is not the last tool call of the agent. Nothing was sent.', result.stderr.decode())
        time.sleep(.2)
        self.assertEqual(self.events(), [])
        self.assertEqual(self.value('@tokiwa_agent_input'), '')

    def answer(self, choice='2', pending='toolu_q1', name='lead', identity=None, actor='worker-a', text=None):
        env = dict(self.env)
        env.pop('TOKIWA_ACTOR', None)
        if actor is not None:
            env['TOKIWA_ACTOR'] = actor
        data = b'' if text is None else text if isinstance(text, bytes) else text.encode('utf-8')
        return subprocess.run(['bash', str(ROOT / 'terminal-session.sh'), 'agent-answer', name, identity or self.identity, pending, choice],
                              env=env, input=data, capture_output=True, timeout=30)

    def value(self, key):
        return self.tm('show-options', '-qv', '-t', '=lead:', key).stdout.strip()

    def refused_with(self, result, sentence):
        self.refused(result, sentence)
        # The item still waits, and no label was recorded.
        self.assertEqual(self.value('@tokiwa_agent_pending'), self.b64(self.ITEM))
        self.assertEqual(self.value('@tokiwa_agent_input'), '')

    def refused_item(self, item, sentence):
        self.ask(item)
        result = self.answer('1')
        self.refused(result, sentence)
        self.assertEqual(self.value('@tokiwa_agent_pending'), self.b64(item))
        self.assertEqual(self.value('@tokiwa_agent_input'), '')

    def test_answer_refuses_an_item_without_options(self):
        # An elicitation form of an MCP server: no hook of the question tool follows it, so no label would
        # reach the worker, and a digit would be typed into a form field.
        self.refused_item(dict(self.ITEM, tool='Elicitation', options=[], summary='Please provide a name'),
                          'The pending item has no options to choose. Nothing was sent.')
        self.refused_item(dict(self.ITEM, options=[]), 'The pending item has no options to choose. Nothing was sent.')

    def test_answer_refuses_an_elicitation_item_that_has_options(self):
        self.refused_item(dict(self.ITEM, tool='Elicitation'), 'The pending item has no options to choose. Nothing was sent.')

    def test_answer_refuses_an_item_that_does_not_name_its_tool(self):
        # An item that an older recorder wrote has no source, so it is not known to be a question of the tool.
        item = {key: value for key, value in self.ITEM.items() if key not in ('tool', 'questions', 'multi_select')}
        self.refused_item(item, 'The pending item has no options to choose. Nothing was sent.')

    def test_answer_refuses_a_question_with_more_than_one_part(self):
        self.refused_item(dict(self.ITEM, questions=2), 'The question has more than one part or allows several choices. Nothing was sent.')

    def test_answer_refuses_a_multi_select_question(self):
        self.refused_item(dict(self.ITEM, multi_select=True), 'The question has more than one part or allows several choices. Nothing was sent.')

    def test_answer_sends_the_digit_and_enter(self):
        result = self.answer('2')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'pending_id': 'toolu_q1', 'choice': 2})
        self.assertEqual(self.events(2), [('other', b'2'), ('enter',)])
        # The item is answered, so it no longer waits.
        self.assertEqual(self.value('@tokiwa_agent_pending'), '')
        self.assertEqual(self.tm('list-buffers').stdout, '')

    def test_answer_with_a_read_only_viewer(self):
        self.attach_client('lead', self.identity, 'view')
        self.assertEqual(self.answer('1').returncode, 0)
        self.assertEqual(self.events(2), [('other', b'1'), ('enter',)])

    def test_answer_refuses_another_pending_id(self):
        self.refused_with(self.answer(pending='toolu_other'), 'The pending item is not the one named. Nothing was sent.')

    def test_answer_refuses_a_permission_item(self):
        item = dict(self.ITEM, kind='permission', options=[])
        self.ask(item)
        result = self.answer('1')
        self.refused(result, 'A permission item has no answer path. Use interrupt to refuse it. Nothing was sent.')
        self.assertEqual(self.value('@tokiwa_agent_pending'), self.b64(item))
        self.assertEqual(self.value('@tokiwa_agent_input'), '')

    def test_answer_refuses_without_a_pending_item(self):
        self.tm('set-option', '-u', '-t', '=lead:', '@tokiwa_agent_pending')
        self.refused(self.answer('1'), 'No item waits for an answer. Nothing was sent.')

    def test_answer_refuses_an_item_that_cannot_be_read(self):
        self.option('lead', '@tokiwa_agent_pending', 'not-base64!')
        self.refused(self.answer('1'), 'The pending item cannot be read. Nothing was sent.')

    def test_answer_refuses_a_choice_that_is_not_an_option(self):
        self.refused_with(self.answer('3'), 'The choice is not one of the options. Nothing was sent.')

    def test_answer_refuses_another_driver(self):
        self.claim('worker-b')
        self.refused_with(self.answer('1'), 'Only the driver can send.')

    def test_answer_refuses_without_an_actor(self):
        for actor in [None, '', 'bad;rm']:
            self.refused_with(self.answer('1', actor=actor), 'Nothing was sent.')

    def test_answer_refuses_a_writable_client(self):
        self.attach_client('lead', self.identity, 'attach')
        self.refused_with(self.answer('1'), 'A client is attached. Nothing was sent.')

    def test_answer_refuses_a_replaced_identity(self):
        self.refused_with(self.answer('1', identity='1:$99:1'), 'Session identity changed. Nothing was sent.')

    def test_answer_refuses_a_shell_pane(self):
        self.assertEqual(self.helper('ensure', 'plain').returncode, 0)
        self.claim('worker-a', 'plain')
        self.option('plain', '@tokiwa_agent_pending', self.b64(self.ITEM))
        result = self.answer('1', name='plain', identity=self.rows()['plain']['identity'])
        self.assertEqual(result.returncode, 1)
        self.assertIn('The pane does not run an agent. Nothing was sent.', result.stderr.decode())
        # The shell never saw the key: its prompt line is empty.
        self.assertTrue(self.tm('capture-pane', '-p', '-t', '=plain:').stdout.strip().endswith('$'))

    def test_answer_refuses_an_item_that_changes_between_check_and_keys(self):
        # The wrapper replaces the item right after the checks read it, as a new hook event would.
        folder = Path(self.temp.name) / 'swap-bin'
        folder.mkdir()
        other = self.b64(dict(self.ITEM, id='toolu_q2'))
        (folder / 'tmux').write_text(f"""#!/bin/bash
{self.tmux} "$@"; code=$?
if [[ " $* " == *' list-clients '* ]]; then {self.tmux} -N -S {self.socket} set-option -t =lead: @tokiwa_agent_pending {other}; fi
exit $code
""")
        (folder / 'tmux').chmod(0o755)
        self.env['PATH'] = f"{folder}:{os.environ['PATH']}"
        result = self.answer('1')
        self.assertEqual(result.returncode, 1, result.stdout)
        time.sleep(.2)
        self.assertEqual(self.events(), [])
        self.assertEqual(self.value('@tokiwa_agent_pending'), other)

    def test_answer_refuses_a_pane_in_copy_mode(self):
        self.assertEqual(self.tm('copy-mode', '-t', '=lead:').returncode, 0)
        self.refused_with(self.answer('1'), 'The pane is in copy mode. Nothing was sent.')

    def test_answer_with_the_dialog_on_the_screen_succeeds(self):
        self.assertEqual(self.answer('1').returncode, 0)
        self.assertEqual(self.events(2), [('other', b'1'), ('enter',)])

    def test_answer_refuses_when_no_dialog_is_on_the_screen(self):
        # The person pressed Esc on the question: no hook event followed, so the state still says `waiting`.
        self.restart('')
        self.ask(self.ITEM)
        self.refused_with(self.answer('1'), 'No question is on the screen. Nothing was sent.')
        time.sleep(.2)
        self.assertEqual(self.events(), [])
        self.assertEqual(self.value('@tokiwa_agent_input'), '')
        self.assertEqual(self.value('@tokiwa_agent_pending'), self.b64(self.ITEM))

    def test_answer_text_applies_the_text_checks(self):
        for bad, sentence in [('bell\a', 'control character'), ('c1\x85next', 'control character'), ('/clear', 'starts with'),
                              ('  !ls', 'starts with'), ('#x', 'starts with'), ('', 'The message is empty.'),
                              ('x' * 16385, 'over 16384 bytes')]:
            self.refused_with(self.answer('text', text=bad), sentence)
        self.refused_with(self.answer('text', text=b'bad \xff'), 'not UTF-8 text')

    def test_answer_text_is_refused_until_the_free_text_path_is_known(self):
        self.refused_with(self.answer('text', text='Use the binary parser.'),
                          'Free-text answers are not supported for this agent. Nothing was sent.')

    def test_answer_checks_its_arguments(self):
        for choice in ['0', '10', 'x', '', '-1', '1 ', 'TEXT']:
            self.refused_with(self.answer(choice), 'Nothing was sent.')
        self.refused_with(self.answer('1', pending=''), 'Nothing was sent.')
        self.refused_with(self.answer('1', pending='a b'), 'Nothing was sent.')
        self.refused_with(self.answer('1', pending='x' * 129), 'Nothing was sent.')

    def test_answer_writes_an_audit_line(self):
        self.env['TOKIWA_VIA'] = 'mcp'
        self.assertEqual(self.answer('1').returncode, 0)
        entry = json.loads((Path(self.env['TOKIWA_STATE']) / 'audit.log').read_text().splitlines()[-1])
        self.assertEqual((entry['action'], entry['name'], entry['identity'], entry['via'], entry['actor'], entry['pending']),
                         ('answer', 'lead', self.identity, 'mcp', 'worker-a', 'toolu_q1'))

    def test_a_refused_answer_is_not_logged(self):
        self.refused_with(self.answer('1', pending='toolu_other'), 'Nothing was sent.')
        lines = (Path(self.env['TOKIWA_STATE']) / 'audit.log').read_text().splitlines()
        self.assertNotIn('answer', [json.loads(line)['action'] for line in lines])

    def test_answer_records_the_input_label(self):
        before = int(time.time())
        self.assertEqual(self.answer('1').returncode, 0)
        label = json.loads(base64.b64decode(self.value('@tokiwa_agent_input')))
        self.assertEqual(set(label), {'actor', 'pending_id', 'at'})
        self.assertEqual((label['actor'], label['pending_id']), ('worker-a', 'toolu_q1'))
        self.assertGreaterEqual(label['at'], before)
        self.assertLessEqual(label['at'], int(time.time()))

    def test_one_call_holds_the_checks_the_keys_and_the_label(self):
        folder = Path(self.temp.name) / 'rec-bin'
        folder.mkdir()
        record = Path(self.temp.name) / 'argv.log'
        (folder / 'tmux').write_text(f"""#!/bin/bash
printf '%s\\n' "$*" >> {record}
exec {self.tmux} "$@"
""")
        (folder / 'tmux').chmod(0o755)
        self.env['PATH'] = f"{folder}:{self.env['PATH']}"
        self.assertEqual(self.answer('1').returncode, 0)
        calls = [c for c in record.read_text().splitlines() if 'send-keys' in c]
        self.assertEqual(len(calls), 1)
        for part in ['@tokiwa_agent_input', '@tokiwa_agent_pending']:
            self.assertIn(part, calls[0])


class AgentRead(ModelHelpers, Server):
    """`agent-read` reads the transcript that an agent's hooks name, in pages, sealed to the caller."""

    FIXTURES = ROOT / 'tests/fixtures/transcripts'
    KINDS = ['user', 'assistant', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'notice', 'user', 'assistant']
    TEXTS = ['Request one', 'Answer one', '', '', '', '', 'Notice one', 'Request two', 'Answer two']

    def setUp(self):
        super().setUp()
        self.assertEqual(self.helper('ensure', 'lead').returncode, 0)
        self.identity = self.rows()['lead']['identity']
        self.folder = Path(self.temp.name) / 'transcripts'
        self.folder.mkdir()
        self.transcript = self.use('claude.jsonl', 'one.jsonl')
        self.keys()

    def use(self, fixture, name):
        """Copy a fixture to a transcript file that the session names. Return its path."""
        path = self.folder / name
        shutil.copy(self.FIXTURES / fixture, path)
        self.name(path)
        return path

    def name(self, path, session='lead'):
        self.tm('set-option', '-t', f'={session}:', '@tokiwa_agent_transcript', str(path))

    def keys(self):
        self.key = Path(self.temp.name) / 'key.pem'
        self.cert = Path(self.temp.name) / 'cert.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(self.key),
                        '-out', str(self.cert), '-subj', '/CN=tokiwa-capture', '-days', '1'],
                       check=True, capture_output=True)
        self.recipient = base64.b64encode(self.cert.read_bytes()).decode()

    def run_read(self, cursor='-', flags='-', identity=None, name='lead'):
        return self.helper('agent-read', name, identity or self.identity, cursor, flags, self.recipient)

    def open(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        opened = subprocess.run(['openssl', 'smime', '-decrypt', '-binary', '-inform', 'DER', '-inkey', str(self.key),
                                 '-recip', str(self.cert)], input=base64.b64decode(result.stdout), capture_output=True)
        self.assertEqual(opened.returncode, 0, opened.stderr)
        self.opened = opened.stdout
        return json.loads(opened.stdout)

    def read(self, cursor='-', flags='-'):
        return self.open(self.run_read(cursor, flags))

    def cursor_of(self, path, offset):
        return hashlib.sha256(str(path).encode()).hexdigest()[:12] + f':{offset}'

    def test_read_from_the_start(self):
        page = self.read()
        self.assertEqual([e['kind'] for e in page['events']], self.KINDS)
        self.assertEqual([e['text'] for e in page['events']], self.TEXTS)
        self.assertEqual(page['events'][0], {'at': 1767225601, 'kind': 'user', 'text': 'Request one', 'tool': None, 'error': False})
        self.assertEqual(page['cursor'], self.cursor_of(self.transcript, self.transcript.stat().st_size))
        self.assertIs(page['more'], False)
        self.assertIs(page['transcript_changed'], False)

    def test_read_resumes_at_the_cursor(self):
        first = self.read()
        line = {'type': 'assistant', 'timestamp': '2026-01-01T00:00:12.000Z',
                'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'Answer three'}]}}
        with self.transcript.open('a') as f:
            f.write(json.dumps(line) + '\n')
        page = self.read(first['cursor'])
        self.assertEqual([e['text'] for e in page['events']], ['Answer three'])
        self.assertIs(page['transcript_changed'], False)
        self.assertEqual(self.read(page['cursor'])['events'], [])

    def test_a_partial_last_line_waits(self):
        complete = self.transcript.stat().st_size
        line = json.dumps({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'Answer three'}]}})
        with self.transcript.open('a') as f:
            f.write(line[:30])
        page = self.read()
        self.assertEqual(len(page['events']), len(self.KINDS))
        self.assertEqual(page['cursor'], self.cursor_of(self.transcript, complete))
        with self.transcript.open('a') as f:
            f.write(line[30:] + '\n')
        self.assertEqual([e['text'] for e in self.read(page['cursor'])['events']], ['Answer three'])

    def test_pages_at_the_limit_and_sets_more(self):
        lines = [json.dumps({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': f'{i:03d}' + 'x' * 997}]}})
                 for i in range(60)]
        self.transcript.write_text('\n'.join(lines) + '\n')
        cursor, texts, pages = '-', [], 0
        while True:
            page = self.read(cursor)
            pages += 1
            self.assertLessEqual(len(self.opened), 15000)
            self.assertTrue(page['events'])
            texts += [e['text'][:3] for e in page['events']]
            cursor = page['cursor']
            if not page['more']:
                break
        self.assertGreater(pages, 3)
        self.assertEqual(texts, [f'{i:03d}' for i in range(60)])

    def test_a_line_with_more_text_than_a_page_still_moves_on(self):
        big = json.dumps({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'y' * 200000}]}})
        self.transcript.write_text(big + '\n')
        page = self.read()
        self.assertLessEqual(len(self.opened), 15000)
        self.assertEqual(len(page['events']), 1)
        self.assertIs(page['more'], False)

    def test_thinking_is_left_out(self):
        page = self.read(flags='tools')
        self.assertNotIn(b'Private reasoning', self.opened)
        self.assertEqual(len(page['events']), len(self.KINDS))

    def test_tool_results_carry_no_text_without_tools(self):
        page = self.read()
        self.assertNotIn(b'Result body one', self.opened)
        self.assertNotIn(b'Failure body two', self.opened)
        self.assertNotIn(b'notes-a.txt', self.opened)
        self.assertEqual([e['text'] for e in page['events'] if e['kind'].startswith('tool')], [''] * 4)
        self.assertEqual([e['error'] for e in page['events']], [False] * 5 + [True] + [False] * 3)
        self.assertEqual([e['tool'] for e in page['events'] if e['kind'].startswith('tool')], ['Read', 'Read', 'Bash', 'Bash'])

    def test_tool_results_carry_text_with_tools(self):
        events = self.read(flags='tools')['events']
        self.assertEqual([e['text'] for e in events if e['kind'] == 'tool_result'], ['Result body one', 'Failure body two'])
        self.assertIn('notes-a.txt', events[2]['text'])

    def test_new_transcript_path_restarts(self):
        first = self.read()
        other = self.use('claude.jsonl', 'two.jsonl')
        page = self.read(first['cursor'])
        self.assertIs(page['transcript_changed'], True)
        self.assertEqual(len(page['events']), len(self.KINDS))
        self.assertEqual(page['cursor'], self.cursor_of(other, other.stat().st_size))

    def test_cursor_past_the_end_restarts(self):
        first = self.read()
        self.transcript.write_text((self.FIXTURES / 'claude.jsonl').read_text().splitlines()[1] + '\n')
        page = self.read(first['cursor'])
        self.assertIs(page['transcript_changed'], True)
        self.assertEqual([e['text'] for e in page['events']], ['Request one'])

    def test_codex_transcript_maps_to_the_same_events(self):
        self.use('codex.jsonl', 'three.jsonl')
        page = self.read()
        self.assertEqual([e['kind'] for e in page['events']], self.KINDS)
        self.assertEqual([e['text'] for e in page['events']], self.TEXTS)
        self.assertEqual([e['error'] for e in page['events']], [False] * 5 + [True] + [False] * 3)
        self.assertEqual([e['tool'] for e in page['events'] if e['kind'].startswith('tool')], ['shell'] * 4)
        self.assertEqual(page['events'][0]['at'], 1767225601)
        events = self.read(flags='tools')['events']
        self.assertEqual([e['text'] for e in events if e['kind'] == 'tool_result'], ['Result body one', 'Failure body two'])
        self.assertNotIn(b'encrypted_content', self.opened)

    def test_read_without_a_transcript_names_capture(self):
        self.tm('set-option', '-u', '-t', '=lead:', '@tokiwa_agent_transcript')
        result = self.run_read()
        self.assertEqual(result.returncode, 1)
        self.assertIn('capture', result.stderr)
        self.assertIn('Nothing was read.', result.stderr)
        self.assertEqual(result.stdout, '')

    def test_read_pending_returns_the_summary(self):
        item = {'id': 'item-a', 'kind': 'question', 'summary': 'Which folder?', 'options': ['a', 'b'], 'at': 1767225601}
        self.assertEqual(self.read(flags='pending')['pending'], None)
        self.tm('set-option', '-t', '=lead:', '@tokiwa_agent_pending', self.b64(item))
        self.assertEqual(self.read(flags='pending'), {'pending': item})
        self.assertEqual(self.read(flags='tools,pending'), {'pending': item})

    def test_read_pending_needs_no_transcript(self):
        self.tm('set-option', '-u', '-t', '=lead:', '@tokiwa_agent_transcript')
        self.assertEqual(self.read(flags='pending'), {'pending': None})

    def test_read_output_holds_no_plain_text(self):
        result = self.run_read(flags='tools')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r'^[A-Za-z0-9+/=]+\n$')
        raw = base64.b64decode(result.stdout)
        for text in ['Answer one', 'Result body one', 'Request two']:
            self.assertNotIn(text.encode(), raw)
            self.assertNotIn(text, result.stdout)

    def test_read_refuses_a_replaced_identity(self):
        old = self.identity
        self.tm('kill-session', '-t', '=lead')
        self.assertEqual(self.helper('ensure', 'lead').returncode, 0)
        self.name(self.transcript)
        result = self.run_read(identity=old)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Session identity changed. Nothing was read.', result.stderr)
        self.assertEqual(result.stdout, '')
        gone = self.helper('agent-read', 'absent', old, '-', '-', self.recipient)
        self.assertEqual(gone.returncode, 1)
        self.assertIn('Nothing was read.', gone.stderr)

    def test_a_link_or_a_non_transcript_file_is_refused(self):
        secret = Path(self.temp.name) / 'secret.txt'
        secret.write_text('secret-value-a\n')
        link = self.folder / 'link.jsonl'
        link.symlink_to(self.transcript)
        folder_link = self.folder / 'folder.jsonl'
        folder_link.mkdir()
        fifo = self.folder / 'fifo.jsonl'
        os.mkfifo(fifo)
        for path in [link, folder_link, fifo, secret, self.folder / 'missing.jsonl', 'relative.jsonl']:
            with self.subTest(path=str(path)):
                self.name(path)
                result = self.run_read()
                self.assertEqual(result.returncode, 1)
                self.assertIn('Nothing was read.', result.stderr)
                self.assertNotIn('secret-value-a', result.stderr + result.stdout)
                self.assertNotIn('Traceback', result.stderr)

    def test_untrusted_lines_become_notices_and_never_leak(self):
        lines = ['secret-value-a', '[1, 2]', '"text"', '{"type": "user", "message": 5}',
                 '{"type": "assistant", "message": {"content": [5, null, {"type": "text", "text": 7}]}}',
                 '[' * 100000, '{"type": "response_item", "payload": 3}', '', '{"type": "user", "message": {"content": "kept"}}']
        self.transcript.write_text('\n'.join(lines) + '\n')
        page = self.read(flags='tools')
        self.assertNotIn(b'secret-value-a', self.opened)
        self.assertEqual([e['text'] for e in page['events']][-1], 'kept')
        notices = [e for e in page['events'] if e['kind'] == 'notice']
        self.assertTrue(notices)
        self.assertEqual({e['text'] for e in notices}, {'unreadable line'})
        self.assertIs(page['more'], False)

    def test_a_lone_surrogate_in_a_line_does_not_stop_the_reader(self):
        # JavaScript can cut a string between the halves of a pair, so a real transcript can hold one.
        bad = '{"type": "assistant", "message": {"content": [{"type": "text", "text": "a\\ud800b"}]}}\n'
        good = '{"type": "user", "message": {"content": "kept"}}\n'
        self.transcript.write_text(bad + good)
        for flags in ('-', 'tools'):
            page = self.read(flags=flags)
            self.assertEqual(len(page['events']), 2)
            self.assertEqual(page['events'][1]['text'], 'kept')
            self.assertEqual(page['cursor'], self.cursor_of(self.transcript, self.transcript.stat().st_size))

    def test_a_lone_surrogate_in_a_pending_item_is_read(self):
        item = {'id': 'item\ud800', 'kind': 'question', 'summary': 'Which\udfff folder?', 'options': ['a\ud800'], 'at': 5}
        self.tm('set-option', '-t', '=lead:', '@tokiwa_agent_pending', self.b64(item))
        pending = self.read(flags='pending')['pending']
        self.assertEqual((pending['kind'], pending['at']), ('question', 5))
        self.assertIn('Which', pending['summary'])

    def set_big(self, value):
        """Set the pending option from a file: a tmux command line is too short for a big value."""
        script = Path(self.temp.name) / 'big.conf'
        script.write_text(f"set-option -t =lead: @tokiwa_agent_pending '{value}'\n")
        self.assertEqual(self.tm('source-file', str(script)).returncode, 0)

    def test_a_pending_item_is_held_to_the_limit(self):
        item = {'id': 'i' * 200, 'kind': 'k' * 80, 'summary': '\x01' * 5000, 'options': ['\x01' * 500] * 40, 'at': 7}
        self.set_big(self.b64(item))
        pending = self.read(flags='pending')['pending']
        self.assertLessEqual(len(self.opened), 15000)
        self.assertEqual((pending['id'], pending['at']), ('i' * 200, 7))
        self.assertTrue(pending['summary'])
        wide = dict(item, summary='\u20ac' * 5000, options=['\u20ac' * 500] * 40)
        self.set_big(self.b64(wide))
        self.read(flags='pending')
        self.assertLessEqual(len(self.opened), 15000)

    def test_bad_arguments_are_refused(self):
        for cursor, flags in [('abc', '-'), ('0123456789ab:', '-'), ('0123456789ab:1234567890123', '-'), ('-', 'all'),
                              ('-', 'tools,'), ('-', ''), ('0123456789AB:1', '-')]:
            with self.subTest(cursor=cursor, flags=flags):
                result = self.run_read(cursor, flags)
                self.assertEqual(result.returncode, 1)
                self.assertIn('Nothing was read.', result.stderr)
        no_recipient = self.helper('agent-read', 'lead', self.identity, '-', '-', 'not base64!')
        self.assertEqual(no_recipient.returncode, 1)
        self.assertIn('Nothing was read.', no_recipient.stderr)


RELAUNCH_AGENT = r'''
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>
/* A stand-in Claude Code for a relaunch. It appends its arguments to $FAKE_ARGS, one line, the arguments
   separated by a tab. At its start it reports SessionStart through the real tokiwa-state, with the session id
   of --resume or --session-id. A pasted /exit and Enter make it report SessionEnd and exit, unless
   FAKE_STUCK is set. A settings path that holds `exit-at-start` makes it exit at once, and one that holds
   `dialog` makes it show a dialog and report nothing. */
static void report(const char *state, const char *session) {
    char command[1024];
    snprintf(command, sizeof command,
             "printf '{\"session_id\":\"%s\"}' | python3 %s %s >/dev/null 2>&1", session, getenv("FAKE_STATE"), state);
    system(command);
}
int main(int argc, char **argv) {
    const char *session = "11111111-2222-3333-4444-555555555555", *settings = "";
    FILE *log = fopen(getenv("FAKE_ARGS"), "a");
    for (int i = 0; i < argc; i++) {
        fprintf(log, "%s%s", i ? "\t" : "", argv[i]);
        if ((!strcmp(argv[i], "--resume") || !strcmp(argv[i], "--session-id")) && i + 1 < argc) session = argv[i + 1];
        if (!strcmp(argv[i], "--settings") && i + 1 < argc) settings = argv[i + 1];
    }
    fprintf(log, "\n");
    fclose(log);
    if (strstr(settings, "exit-at-start")) return 1;
    struct termios t;
    tcgetattr(0, &t);
    cfmakeraw(&t);
    tcsetattr(0, TCSANOW, &t);
    printf("\033[?2004h");
    if (strstr(settings, "dialog")) printf("Settings Error\r\n Enter to confirm\r\n");
    else report("idle", session);
    fflush(stdout);
    char seen[8192] = "", buffer[1024];
    ssize_t n;
    while ((n = read(0, buffer, sizeof buffer - 1)) > 0) {
        buffer[n] = 0;
        if (strlen(seen) + n < sizeof seen) strcat(seen, buffer);
        if (strstr(seen, "\033[200~/exit\033[201~\r") && !getenv("FAKE_STUCK")) {
            report("ended", session);
            return 0;
        }
    }
    return 0;
}
'''

SESSION = '11111111-2222-3333-4444-555555555555'


class AgentRelaunch(Pty, ModelHelpers, Server):
    """`agent-relaunch` restarts the Claude Code agent of one session with a settings file, or refuses."""

    def setUp(self):
        super().setUp()
        if not shutil.which('cc'):
            self.skipTest('the stand-in agent needs a C compiler')
        self.tools = Path(self.temp.name) / 'tools'
        self.tools.mkdir()
        (self.tools / 'relaunch.c').write_text(RELAUNCH_AGENT)
        (self.tools / 'agent.c').write_text(FAKE_AGENT)
        subprocess.run(['cc', '-o', str(self.tools / 'claude'), str(self.tools / 'relaunch.c')], check=True)
        subprocess.run(['cc', '-o', str(self.tools / 'codex'), str(self.tools / 'agent.c')], check=True)
        self.args = Path(self.temp.name) / 'args.log'
        self.settings = Path(self.temp.name) / 'grant.settings.json'
        self.settings.write_text('{"permissions": {"allow": ["Bash(gh pr merge *)"]}}\n')
        self.env.update(TOKIWA_RELAUNCH_EXIT_SECONDS='3', TOKIWA_RELAUNCH_START_SECONDS='5')
        self.start('lead', 'claude --model opus --permission-mode auto "first task"')
        self.identity = self.rows()['lead']['identity']
        self.env['TOKIWA_ACTOR'] = 'worker-a'
        self.assertEqual(self.helper('claim', 'lead', self.identity, 'replace').returncode, 0)

    def start(self, name, command, stuck=False):
        """A session whose shell runs `command` with the stand-in agent first on PATH, after its start report."""
        self.assertEqual(self.helper('ensure', name).returncode, 0)
        setup = (f'export PATH={self.tools}:$PATH FAKE_ARGS={self.args} FAKE_STATE={ROOT / "tokiwa-state"}'
                 + (' FAKE_STUCK=1' if stuck else ''))
        self.tm('send-keys', '-t', f'={name}:', f'{setup}; {command}', 'Enter')
        for _ in range(250):
            values = self.tm('display-message', '-p', '-t', f'={name}:',
                             '#{pane_current_command} #{@tokiwa_agent_session}').stdout.split()
            if values == ['claude', SESSION]:
                return
            time.sleep(.02)
        self.fail('the stand-in agent did not start')

    def relaunch(self, settings=None, digest='-', name='lead', identity=None):
        return self.helper('agent-relaunch', name, identity or self.identity, str(settings or self.settings), digest)

    def launches(self):
        return [line.split('\t') for line in self.args.read_text().splitlines()] if self.args.exists() else []

    def refused(self, result, sentence):
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(sentence, result.stderr)
        time.sleep(.2)
        self.assertEqual(len(self.launches()), 1)
        self.assertEqual(self.tm('display-message', '-p', '-t', '=lead:', '#{pane_current_command}').stdout.strip(),
                         'claude')
        self.assertEqual(self.tm('list-buffers').stdout, '')

    def test_relaunch_keeps_the_session_the_pane_and_the_conversation(self):
        pane = self.tm('display-message', '-p', '-t', '=lead:', '#{pane_id}').stdout.strip()
        digest = hashlib.sha256(self.settings.read_bytes()).hexdigest()
        result = self.relaunch(digest=digest)
        self.assertEqual(result.returncode, 0, result.stderr)
        reply = json.loads(result.stdout)
        self.assertEqual((reply['relaunched'], reply['session_id'], reply['settings'], reply['sha256']),
                         (True, SESSION, str(self.settings), digest))
        # The first prompt is not sent again; the options that set the model and the mode stay.
        self.assertEqual(self.launches()[-1], ['claude', '--model', 'opus', '--permission-mode', 'auto',
                                               '--resume', SESSION, '--settings', str(self.settings)])
        self.assertEqual(self.rows()['lead']['identity'], self.identity)
        self.assertEqual(self.tm('display-message', '-p', '-t', '=lead:', '#{pane_id}').stdout.strip(), pane)
        self.assertEqual(self.tm('list-buffers').stdout, '')
        entry = json.loads((Path(self.env['TOKIWA_STATE']) / 'audit.log').read_text().splitlines()[-1])
        self.assertEqual((entry['action'], entry['identity'], entry['actor']), ('relaunch', self.identity, 'worker-a'))

    def test_a_second_relaunch_replaces_the_settings(self):
        self.assertEqual(self.relaunch().returncode, 0)
        other = Path(self.temp.name) / 'grant.r2.settings.json'
        other.write_text('{}')
        result = self.relaunch(other)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.launches()[-1][-4:], ['--resume', SESSION, '--settings', str(other)])
        self.assertEqual(self.launches()[-1].count('--settings'), 1)

    def test_refused_while_the_agent_works(self):
        self.tm('set-option', '-t', '=lead:', '@tokiwa_agent', 'working:100')
        self.refused(self.relaunch(), 'The agent is not idle. Nothing was changed.')

    def test_refused_while_an_item_waits(self):
        self.tm('set-option', '-t', '=lead:', '@tokiwa_agent_pending', 'e30=')
        self.refused(self.relaunch(), 'An item waits for a person. Nothing was changed.')

    def test_refused_while_a_client_is_attached(self):
        self.attach_client('lead', self.identity, 'attach')
        self.refused(self.relaunch(), 'A client is attached. Nothing was sent.')

    def test_refused_for_an_actor_that_does_not_drive(self):
        self.env['TOKIWA_ACTOR'] = 'worker-b'
        self.refused(self.relaunch(), 'Only the driver can send.')

    def test_refused_for_another_identity(self):
        result = self.relaunch(identity='1:$9:1')
        self.assertEqual(result.returncode, 1)
        self.assertIn('Session identity changed.', result.stderr)
        self.assertEqual(len(self.launches()), 1)

    def test_refused_without_a_reported_session_id(self):
        self.tm('set-option', '-u', '-t', '=lead:', '@tokiwa_agent_session')
        self.refused(self.relaunch(), 'The agent has not reported its session id. Nothing was changed.')

    def test_refused_for_a_settings_file_that_is_not_usable(self):
        bad = Path(self.temp.name) / 'bad.json'
        bad.write_text('{not json')
        self.refused(self.relaunch(bad), 'The settings file is not a JSON object.')
        self.refused(self.relaunch(Path(self.temp.name) / 'missing.json'), 'The settings file cannot be read.')
        link = Path(self.temp.name) / 'link.json'
        link.symlink_to(self.settings)
        self.refused(self.relaunch(link), 'The settings path is not a regular file.')
        self.refused(self.relaunch('relative.json'), 'Use an absolute settings path')
        self.refused(self.relaunch(f'{self.temp.name}/with space.json'), 'Use an absolute settings path')
        self.refused(self.relaunch(digest='0' * 64), 'The settings file does not have the expected SHA-256.')

    def test_refused_for_an_option_that_a_relaunch_does_not_keep(self):
        self.start('other', 'claude --dangerously-skip-permissions')
        identity = self.rows()['other']['identity']
        self.assertEqual(self.helper('claim', 'other', identity, 'replace').returncode, 0)
        result = self.relaunch(name='other', identity=identity)
        self.assertEqual(result.returncode, 1)
        self.assertIn('The Claude command has --dangerously-skip-permissions, which a relaunch does not keep.',
                      result.stderr)
        self.assertEqual(len(self.launches()), 2)

    def test_refused_for_a_codex_pane(self):
        self.assertEqual(self.helper('ensure', 'other').returncode, 0)
        self.tm('send-keys', '-t', '=other:', f"{self.tools / 'codex'} {Path(self.temp.name) / 'codex.log'}", 'Enter')
        for _ in range(150):
            if self.tm('display-message', '-p', '-t', '=other:', '#{pane_current_command}').stdout.strip() == 'codex':
                break
            time.sleep(.02)
        self.tm('set-option', '-t', '=other:', '@tokiwa_agent', 'idle:100')
        identity = self.rows()['other']['identity']
        self.assertEqual(self.helper('claim', 'other', identity, 'replace').returncode, 0)
        result = self.relaunch(name='other', identity=identity)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Only Claude Code can be relaunched.', result.stderr)

    def test_refused_when_another_pane_runs_an_agent(self):
        self.tm('split-window', '-d', '-t', '=lead:', f'{self.tools / "codex"} {Path(self.temp.name) / "codex.log"}')
        for _ in range(150):
            commands = self.tm('list-panes', '-s', '-t', '=lead', '-F', '#{pane_current_command}').stdout.split()
            if 'codex' in commands:
                break
            time.sleep(.02)
        self.refused(self.relaunch(), 'Another pane of the session runs an agent. Nothing was changed.')

    def test_an_agent_that_does_not_exit_is_left_running(self):
        self.start('other', 'claude', stuck=True)
        identity = self.rows()['other']['identity']
        self.assertEqual(self.helper('claim', 'other', identity, 'replace').returncode, 0)
        result = self.relaunch(name='other', identity=identity)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Claude Code did not exit after /exit.', result.stderr)
        self.assertEqual(len(self.launches()), 2)
        # The agent stays marked busy, so that no send types into it; an interrupt makes it idle again.
        self.assertTrue(self.tm('show-options', '-qv', '-t', '=other:', '@tokiwa_agent').stdout.startswith('working:'))
        self.assertIn('The agent is not idle.', self.relaunch(name='other', identity=identity).stderr)
        self.assertEqual(self.tm('display-message', '-p', '-t', '=other:', '#{pane_current_command}').stdout.strip(),
                         'claude')

    def test_an_agent_that_exits_at_its_start_is_reported_with_the_way_back(self):
        failing = Path(self.temp.name) / 'exit-at-start.json'
        failing.write_text('{}')
        result = self.relaunch(failing)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Claude Code exited after the relaunch.', result.stderr)
        self.assertIn(f'claude --resume {SESSION}', result.stderr)
        self.assertEqual(self.rows()['lead']['identity'], self.identity)
        audit = Path(self.env['TOKIWA_STATE']) / 'audit.log'
        actions = [json.loads(line)['action'] for line in audit.read_text().splitlines()] if audit.exists() else []
        self.assertNotIn('relaunch', actions)

    def test_a_dialog_after_the_start_is_a_failure(self):
        dialog = Path(self.temp.name) / 'dialog.json'
        dialog.write_text('{}')
        result = self.relaunch(dialog)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Claude Code shows a dialog after the relaunch.', result.stderr)


class PasteImage(ModelHelpers, Server):
    """`paste-image` downloads one checked image into the tmp folder of a session, or refuses and leaves no file."""

    IMAGE = b'\x89PNG\r\n\x1a\n' + bytes(range(256))
    URL = 'https://example.com/image.png'

    def setUp(self):
        super().setUp()
        self.root = Path(self.temp.name) / 'cache-root'
        self.root.mkdir()
        self.tools = Path(self.temp.name) / 'tools'
        self.tools.mkdir()
        self.image = Path(self.temp.name) / 'fixture.png'
        self.image.write_bytes(self.IMAGE)
        self.calls = Path(self.temp.name) / 'curl.log'
        stand_in = self.tools / 'curl'
        stand_in.write_text('#!/bin/bash\n'
                            'echo "$*" >> "$FAKE_CURL_LOG"\n'
                            '[[ $* != *" -K -" ]] || cat > "$FAKE_CURL_CONFIG"\n'
                            'while [[ $# -gt 0 ]]; do [[ $1 != -o ]] || out=$2; shift; done\n'
                            'cp "$FAKE_IMAGE" "$out"\n'
                            'exit "${FAKE_CURL_EXIT:-0}"\n')
        stand_in.chmod(0o755)
        self.env.update(PATH=f'{self.tools}:{os.environ["PATH"]}', TOKIWA_CACHE_ROOT=str(self.root),
                        FAKE_IMAGE=str(self.image), FAKE_CURL_LOG=str(self.calls),
                        FAKE_CURL_CONFIG=str(Path(self.temp.name) / 'curl.config'))
        self.assertEqual(self.helper('ensure', 'lead').returncode, 0)
        self.identity = self.rows()['lead']['identity']

    def helper_with_stdin(self, text, *args):
        return subprocess.run(['bash', str(ROOT / 'terminal-session.sh'), *args], env=self.env, input=text,
                              capture_output=True, text=True, timeout=30)

    def paste(self, url=None, sha=None, size=None, identity=None, name='lead'):
        return self.helper_with_stdin(self.URL if url is None else url, 'paste-image', name,
                                      identity or self.identity,
                                      sha or hashlib.sha256(self.IMAGE).hexdigest(),
                                      str(len(self.IMAGE) if size is None else size))

    def pasted(self):
        folder = self.root / 'lead' / 'tmp'
        return sorted(folder.glob('*')) if folder.is_dir() else []

    def refused(self, result, sentence, curl_called=False):
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertEqual(result.stdout, '')
        self.assertIn(sentence, result.stderr)
        self.assertEqual(self.pasted(), [])
        self.assertEqual(self.calls.exists(), curl_called)

    def test_places_a_checked_image_in_the_session_tmp_folder(self):
        result = self.paste()
        self.assertEqual(result.returncode, 0, result.stderr)
        path = json.loads(result.stdout)['path']
        self.assertRegex(path, rf'^{re.escape(str(self.root))}/lead/tmp/paste-\d{{8}}T\d{{6}}Z-[0-9a-f]{{8}}\.png$')
        self.assertEqual(Path(path).read_bytes(), self.IMAGE)
        self.assertEqual(Path(path).stat().st_mode & 0o777, 0o600)
        self.assertEqual([p.name for p in self.pasted()], [Path(path).name])
        # The URL reaches curl on stdin, not in its arguments.
        arguments = self.calls.read_text()
        self.assertNotIn('https://', arguments)
        self.assertTrue(arguments.startswith('-q '), arguments)
        self.assertIn('--globoff', arguments)
        # The download fails on an HTTP error, uses https only, and stops at the announced size.
        self.assertIn(' --fail ', arguments)
        self.assertIn(' --proto =https ', arguments)
        self.assertIn(f' --max-filesize {len(self.IMAGE)} ', arguments)
        self.assertEqual(Path(self.env['FAKE_CURL_CONFIG']).read_text(), f'url = "{self.URL}"\n')

    def test_escapes_quotes_and_backslashes_in_the_url_config(self):
        url = 'https://example.com/a"b\\c.png'
        self.assertEqual(self.paste(url=url).returncode, 0)
        self.assertEqual(Path(self.env['FAKE_CURL_CONFIG']).read_text(), 'url = "https://example.com/a\\"b\\\\c.png"\n')

    def test_makes_the_tmp_folder_of_a_session_that_has_none(self):
        # The shell of the session made its folder at start; a session from before the cache root has none.
        shutil.rmtree(self.root / 'lead', ignore_errors=True)
        self.assertEqual(self.paste().returncode, 0)
        self.assertEqual((self.root / 'lead/tmp').stat().st_mode & 0o777, 0o700)

    def test_refuses_a_wrong_sha256_and_leaves_no_file(self):
        self.refused(self.paste(sha='0' * 64),
                     'The image on the host does not match the image on the Mac. Nothing was pasted.', True)

    def test_refuses_a_wrong_size_and_leaves_no_file(self):
        self.refused(self.paste(size=len(self.IMAGE) + 1),
                     'The image on the host does not match the image on the Mac. Nothing was pasted.', True)

    def test_refuses_a_failed_download_and_leaves_no_file(self):
        self.env['FAKE_CURL_EXIT'] = '22'
        self.refused(self.paste(), 'The image could not be downloaded to the host. Nothing was pasted.', True)

    def test_refuses_another_identity(self):
        self.refused(self.paste(identity='1:$99:1'), 'Session identity changed. Nothing was pasted.')

    def test_refuses_a_size_over_the_limit_and_a_malformed_sha256(self):
        usage = 'Use paste-image NAME IDENTITY SHA256 SIZE.'
        self.refused(self.paste(size=10485761), usage)
        self.refused(self.paste(size=0), usage)
        self.refused(self.paste(size='abc'), usage)
        self.refused(self.paste(sha='A' * 64), usage)
        self.refused(self.paste(sha='ab'), usage)

    def test_refuses_a_url_that_is_not_https(self):
        for url in ('http://example.com/a.png', '', 'https://example.com/a b.png', 'file:///etc/passwd'):
            self.refused(self.paste(url=url), 'The image URL is not valid. Nothing was pasted.')

    def test_refuses_a_tmp_folder_that_is_a_link(self):
        shutil.rmtree(self.root / 'lead')
        (self.root / 'lead').mkdir()
        elsewhere = Path(self.temp.name) / 'elsewhere'
        elsewhere.mkdir()
        (self.root / 'lead/tmp').symlink_to(elsewhere)
        result = self.paste()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('The session cache folder is not usable. Nothing was pasted.', result.stderr)
        self.assertEqual(list(elsewhere.iterdir()), [])
        self.assertFalse(self.calls.exists())


class TransferModes(ModelHelpers, Server):
    """`transfer-in` and `transfer-out` run the transfer program as this user and log each success."""

    def setUp(self):
        super().setUp()
        self.cache = Path(self.temp.name) / 'cache-root'
        self.cache.mkdir()
        # The disk of the test machine can be fuller than the host's limit.
        self.env.update(TOKIWA_CACHE_ROOT=str(self.cache), TOKIWA_MIN_FREE_SHARE='0')

    def run_bytes(self, args, data=b''):
        return subprocess.run(['bash', str(ROOT / 'terminal-session.sh'), *args], env=self.env, input=data,
                              capture_output=True, timeout=30)

    def audit_lines(self):
        log = Path(self.env['TOKIWA_STATE']) / 'audit.log'
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def test_a_file_goes_in_and_out_and_both_are_logged(self):
        data = b'report bytes'
        sha = hashlib.sha256(data).hexdigest()
        target = Path(os.path.realpath(self.cache)) / 'report.txt'
        result = self.run_bytes(['transfer-in', str(self.cache), 'file', 'report.txt', sha, str(len(data)), '644', '0'], data)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['path'], str(target))
        self.assertEqual(target.read_bytes(), data)
        sent = self.run_bytes(['transfer-out', str(target)])
        self.assertEqual(sent.returncode, 0, sent.stderr)
        # stdout is the stream and nothing else; the report goes to stderr.
        self.assertEqual(sent.stdout, data)
        self.assertIn(b'tokiwa-transfer {"kind": "file"', sent.stderr)
        logged = self.audit_lines()
        self.assertEqual([e['action'] for e in logged], ['transfer-in', 'transfer-out'])
        self.assertEqual({k: logged[0][k] for k in ('path', 'kind', 'files', 'bytes', 'sha256')},
                         {'path': str(target), 'kind': 'file', 'files': 1, 'bytes': len(data), 'sha256': sha})
        self.assertEqual((logged[1]['source'], logged[1]['files']), (str(target), 1))

    def test_a_refusal_passes_its_sentence_and_logs_nothing(self):
        # The test's workbench folder is its whole temporary folder, so "outside" is another folder.
        other = tempfile.TemporaryDirectory(prefix='tokiwa-outside-')
        self.addCleanup(other.cleanup)
        outside = Path(other.name) / 'outside.txt'
        result = self.run_bytes(['transfer-in', str(outside), 'file', 'outside.txt', '0' * 64, '1', '644', '0'], b'x')
        self.assertEqual(result.returncode, 1)
        self.assertIn(b'outside the workbench folder', result.stderr)
        self.assertFalse(outside.exists())
        sent = self.run_bytes(['transfer-out', str(outside)])
        self.assertEqual((sent.returncode, sent.stdout), (1, b''))
        self.assertEqual(self.audit_lines(), [])
        self.assertEqual(self.run_bytes(['transfer-in', 'a']).returncode, 1)
        self.assertEqual(self.run_bytes(['transfer-out']).returncode, 1)

    def test_a_session_path_resolves_in_the_session_folder(self):
        self.assertEqual(self.helper('ensure', 'lead').returncode, 0)
        folder = self.rows()['lead']['cwd']
        data = b'x'
        result = self.run_bytes(['transfer-in', 'lead:', 'file', 'note.txt', hashlib.sha256(data).hexdigest(), '1', '600', '0'], data)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(Path(json.loads(result.stdout)['path']).resolve(), (Path(folder) / 'note.txt').resolve())

