"""Check CLI routing without AWS calls or provider requests."""
import base64
import os
import pty
import re
import shutil
import subprocess
import tempfile
import termios
import unittest
from pathlib import Path

CLI = Path(__file__).resolve().parents[2] / 'bin/tokiwa'

class TerminalCLI(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        tools = self.home / '.local/lib/cloud-access'
        tools.mkdir(parents=True)
        aws = tools / 'aws'
        aws.write_text('''#!/bin/bash
printf '%s\\n' "$*" >> "$HOME/calls"
case "$*" in
 *sso\ login*) touch "$HOME/logged-in" ;;
 *get-caller-identity*)
  if [ -n "${TEST_EXPIRED:-}" ] && [ ! -e "$HOME/logged-in" ]; then
   echo 'Error when retrieving token from sso: Token has expired and refresh failed' >&2; exit 255
  fi
  echo "${TEST_ACCOUNT:-123456789012}" ;;
 *describe-instances*InstanceType*)
  printf '{"type": "m7i.2xlarge", "state": "%s", "launch_time": "2026-10-30T02:05:11+00:00", "public_ip": "198.51.100.7", "availability_zone": "us-east-1a"}\n' "${TEST_STATE:-running}" ;;
 *describe-instances*) echo "${TEST_STATE:-running}" ;;
 *describe-volumes*) echo '[{"id": "vol-1", "type": "gp3", "size_gib": 100}, {"id": "vol-2", "type": "gp3", "size_gib": 500}]' ;;
 *describe-addresses*) echo '[]' ;;
 *send-command*) echo test-command ;;
 *get-command-invocation*StandardOutputContent*)
  if grep -q 'terminal-session.sh capture' "$HOME/calls"; then
   ls -l "$TMPDIR"/*/ >> "$HOME/modes" 2>/dev/null || true
   # Act as the host: encrypt to the certificate that the launcher sent.
   cert=$(grep -o "capture [^ ]* '[^']*' [0-9]* [A-Za-z0-9+/=]*" "$HOME/calls" | tail -1 | awk '{print $NF}')
   printf '%s' "$cert" | base64 --decode > "$HOME/recipient.pem"
   if [ -n "${TEST_BAD_CIPHER:-}" ]; then echo 'bm90IGNpcGhlcg=='; exit 0; fi
   printf '{"text": "screen text"}' | openssl smime -encrypt -aes256 -binary -outform DER "$HOME/recipient.pem" | base64 | tr -d '\\n'
   echo
  else
   echo 'Workbench server ready.'
  fi ;;
 *get-command-invocation*StandardErrorContent*) echo 'Workbench unavailable.' ;;
 *get-command-invocation*) echo "${TEST_STATUS:-Success}" ;;
 *start-session*)
  # The local terminal as the Session Manager plugin finds it.
  stty -a > "$HOME/session-tty" 2>&1
  if [ -n "${TEST_LINE_FEED:-}" ]; then
   # The Session Manager plugin's own terminal setup, then a bare line feed from tmux.
   stty cbreak; stty -echo
   printf 'A\nB'
   exit 0
  fi
  # Act like a remote terminal: raw mode, mouse reporting and the alternate screen, then end.
  stty raw -echo
  printf '\033[?1049h\033[?1003h\033[?1006h'
  exit "${TEST_SESSION_EXIT:-0}" ;;
 *) exit 90 ;;
esac
''')
        aws.chmod(0o755)
        config = self.home / '.config/tokiwa'
        config.mkdir(parents=True)
        # 2030-01-01T00:00:00Z is 1893456000.
        (config / 'host.env').write_text('# the test host\ninstance=i-0123456789abcdef0\nprofile=work\n'
                                         'region=us-east-1\naccount=123456789012\nend=2030-01-01T00:00:00Z\n')
        self.env = dict(os.environ, HOME=str(self.home))

    def tearDown(self):
        self.temp.cleanup()

    def run_cli(self, *args):
        return subprocess.run(['bash', str(CLI), *args], check=False, env=self.env, capture_output=True, text=True, timeout=30)

    def test_help_does_not_connect_or_expose_acceptance_routes(self):
        result = self.run_cli('--help')
        self.assertEqual(result.returncode, 0)
        for term in ['new NAME', 'attach NAME', 'sessions', 'status']:
            self.assertIn(term, result.stdout)
        for term in ['claude-cloud', 'auth-team', 'acceptance']:
            self.assertNotIn(term, result.stdout)
        self.assertFalse((self.home / 'calls').exists())

    def test_dashboard_requires_terminal_without_cloud_calls(self):
        for args in [(), ('dashboard',)]:
            result = self.run_cli(*args)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('interactive terminal', result.stderr)
            self.assertFalse((self.home / 'calls').exists())

    def install_app(self):
        app = self.home / '.local/lib/tokiwa/opentui/run'
        app.parent.mkdir(parents=True)
        app.write_text('#!/bin/bash\necho "app $*" >> "$HOME/app-calls"\n')
        app.chmod(0o755)

    def test_dashboard_opens_the_installed_app_in_a_terminal(self):
        self.install_app()
        code, output, _ = self.run_cli_in_terminal()
        self.assertEqual(code, 0, output)
        self.assertEqual((self.home / 'app-calls').read_text().splitlines(), ['app '])
        self.assertFalse((self.home / 'calls').exists())

    def test_dashboard_app_needs_a_terminal(self):
        self.install_app()
        result = self.run_cli('dashboard')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('interactive terminal', result.stderr)
        self.assertFalse((self.home / 'app-calls').exists())

    def test_dashboard_without_the_app_fails_and_names_the_install(self):
        code, output, _ = self.run_cli_in_terminal('dashboard')
        self.assertNotEqual(code, 0)
        self.assertIn(b'install.sh', output)
        self.assertFalse((self.home / 'calls').exists())

    def test_classic_is_no_longer_a_command(self):
        result = self.run_cli('classic')
        self.assertEqual(result.returncode, 2)
        self.assertNotIn('classic', result.stderr)

    def test_snapshot_uses_only_read_only_helper(self):
        result = self.run_cli('--snapshot')
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = (self.home / 'calls').read_text()
        self.assertIn('terminal-session.sh snapshot', calls)
        self.assertNotIn('start-session', calls)

    def encoded_payload(self, calls, command):
        """The base64 argument that follows `terminal-session.sh COMMAND` in the recorded call."""
        import base64, json, re
        found = re.search(r"terminal-session\.sh " + command + r" (?:[A-Za-z0-9_-]+ )?'?([A-Za-z0-9+/=]+)", calls)
        self.assertIsNotNone(found, calls)
        return json.loads(base64.b64decode(found.group(1)))

    def test_create_and_move_project_send_one_encoded_request(self):
        result = self.run_cli('create', 'notes', '--folder', 'inbox', '--project', 'inbox')
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = (self.home / 'calls').read_text()
        self.assertEqual(self.encoded_payload(calls, 'create'), {'folder': 'inbox', 'project': 'inbox'})
        result = self.run_cli('move-project', 'api', 'studio/api')
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = (self.home / 'calls').read_text()
        self.assertEqual(self.encoded_payload(calls, 'relabel'), {'from': 'api', 'to': 'studio/api'})
        result = self.run_cli('forget-project', 'studio/api')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('terminal-session.sh forget-project ', (self.home / 'calls').read_text())
        self.assertNotIn('start-session', calls)
        for args in [('create', 'notes'), ('create', 'notes', '--dir', '/a', '--folder', 'b'), ('move-project', 'api')]:
            self.assertNotEqual(self.run_cli(*args).returncode, 0, args)

    def test_create_sends_the_own_folder_of_the_session(self):
        result = self.run_cli('create', 'lead', '--dir', '/w/proj', '--subfolder', 'lead', '--project', 'proj')
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = (self.home / 'calls').read_text()
        self.assertEqual(self.encoded_payload(calls, 'create'), {'dir': '/w/proj', 'subfolder': 'lead', 'project': 'proj'})

    def test_create_sends_the_command_to_run_encoded(self):
        command = 'git clone https://example.com/app.git . && claude "Read LEAD.md and start."'
        result = self.run_cli('create', 'lead', '--dir', '/w/proj', '--subfolder', 'lead', '--run', command)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = (self.home / 'calls').read_text()
        self.assertEqual(self.encoded_payload(calls, 'create'), {'dir': '/w/proj', 'subfolder': 'lead', 'run': command})
        # The quotes and && of the command never reach the remote shell unencoded.
        self.assertNotIn('Read LEAD.md', calls)

    def test_secret_reads_the_value_on_the_host_in_a_terminal(self):
        self.run_cli_in_terminal('secret', 'API_KEY')
        calls = (self.home / 'calls').read_text()
        self.assertIn('start-session', calls)
        self.assertIn('terminal-session.sh secret API_KEY ||', calls)
        # Run Command keeps its parameters and output in the account, so a value never goes there.
        self.assertNotIn('send-command', calls)

    def test_secret_turns_local_echo_off_before_the_session_and_restores_it(self):
        # The plugin turns echo off only after it starts; a paste before that would show locally.
        code, _, local_modes = self.run_cli_in_terminal('secret', 'API_KEY')
        self.assertEqual(code, 0)
        self.assertRegex((self.home / 'session-tty').read_text(), r'(^|\s)-echo(\s|$)')
        self.assertTrue(local_modes & termios.ECHO)
        self.run_cli_in_terminal('attach', 'backend')
        self.assertRegex((self.home / 'session-tty').read_text(), r'(^|\s)echo(\s|$)')

    def test_secret_list_and_remove_send_only_names(self):
        result = self.run_cli('secrets')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('terminal-session.sh secrets', (self.home / 'calls').read_text())
        result = self.run_cli('secret', '--remove', 'API_KEY')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('terminal-session.sh secret-remove API_KEY', (self.home / 'calls').read_text())

    def test_secret_needs_a_terminal_and_a_safe_name_before_aws(self):
        for args in [('secret',), ('secret', 'bad-name'), ('secret', 'PATH'), ('secret', 'TOKIWA_X'),
                     ('secret', '--remove'), ('secret', 'A', 'B'), ('secrets', 'x')]:
            self.assertNotEqual(self.run_cli(*args).returncode, 0, args)
        result = self.run_cli('secret', 'API_KEY')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('interactive terminal', result.stderr)
        self.assertFalse((self.home / 'calls').exists())

    def test_rename_sends_the_new_name_and_identity_encoded(self):
        result = self.run_cli('rename', 'agent', 'claude-api', '1:$4:5')
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = (self.home / 'calls').read_text()
        self.assertEqual(self.encoded_payload(calls, 'rename'), {'to': 'claude-api', 'identity': '1:$4:5'})
        self.assertNotIn('start-session', calls)
        for args in [('rename', 'agent', 'bad name', '1:$4:5'), ('rename', 'agent', 'x', 'nope'), ('rename', 'agent', 'x')]:
            self.assertNotEqual(self.run_cli(*args).returncode, 0, args)

    def test_name_reads_and_sets_the_prompt_name(self):
        self.assertEqual(self.run_cli('name').returncode, 0)
        self.assertEqual(self.run_cli('name', 'myname').returncode, 0)
        calls = (self.home / 'calls').read_text()
        self.assertIn('terminal-session.sh name', calls)
        self.assertIn('myname', calls)
        self.assertNotEqual(self.run_cli('name', 'bad name!').returncode, 0)

    def test_project_path_is_encoded_before_remote_execution(self):
        path = '/work/repo with spaces;$(touch /tmp/not-executed)'
        result = self.run_cli('project', 'backend', path)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = (self.home / 'calls').read_text()
        self.assertNotIn(path, calls)
        self.assertIn('terminal-session.sh project backend ', calls)
        self.assertNotIn('start-session', calls)

    def test_health_and_end_use_bounded_noninteractive_commands(self):
        self.assertEqual(self.run_cli('health').returncode,0)
        self.assertEqual(self.run_cli('--end-confirmed','backend','123:$4:567').returncode,0)
        calls=(self.home/'calls').read_text()
        self.assertIn('terminal-session.sh health',calls)
        self.assertIn("end backend '123:$4:567'",calls)
        self.assertNotIn('start-session',calls)

    def test_invalid_end_identity_fails_before_aws(self):
        self.assertNotEqual(self.run_cli('--end-confirmed','backend','123;echo bad').returncode,0)
        self.assertFalse((self.home/'calls').exists())

    def test_source_name_and_argument_count_fail_before_aws(self):
        for args in [('new','shell','--from','a;b'), ('new','shell','bad'), ('attach','shell','extra'), ('project','shell','bad label!'), ('project','shell','a//b')]:
            self.assertNotEqual(self.run_cli(*args).returncode, 0)
        self.assertFalse((self.home / 'calls').exists())

    def run_cli_in_terminal(self, *args, session_exit=0, cli=CLI):
        """Run an interactive CLI command in a PTY. Return the exit code, the output and the final local modes."""
        plugin = self.home / '.local/lib/cloud-access/session-manager-plugin'
        plugin.write_text('#!/bin/bash\nexit 0\n')
        plugin.chmod(0o755)
        pid, fd = pty.fork()
        if pid == 0:
            os.environ.clear()
            os.environ.update(self.env, TEST_SESSION_EXIT=str(session_exit))
            os.execv('/bin/bash', ['bash', str(cli), *args])
        output = b''
        try:
            while True:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output += chunk
            code = os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
            local_modes = termios.tcgetattr(fd)[3]
            self.output_modes = termios.tcgetattr(fd)[1]
        finally:
            os.close(fd)
        return code, output, local_modes

    def test_attach_identity_is_quoted_for_the_remote_shell(self):
        self.run_cli_in_terminal('attach', 'backend', '123:$4:567')
        calls = (self.home / 'calls').read_text()
        self.assertIn('start-session', calls)
        self.assertIn("terminal-session.sh attach backend '123:$4:567' || {", calls)

    def test_attach_without_identity_is_unchanged(self):
        self.run_cli_in_terminal('attach', 'backend')
        calls = (self.home / 'calls').read_text()
        self.assertIn('terminal-session.sh attach backend ||', calls)

    def test_dropped_connection_restores_the_local_terminal(self):
        code, output, local_modes = self.run_cli_in_terminal('attach', 'backend', session_exit=255)
        self.assertEqual(code, 255)
        tail = output[output.rindex(b'\x1b[?1003h'):]
        for mode in [b'1000', b'1002', b'1003', b'1006', b'2004', b'1049']:
            self.assertIn(b'\x1b[?' + mode + b'l', tail)
        self.assertTrue(local_modes & termios.ECHO and local_modes & termios.ICANON)

    def test_attach_passes_a_bare_line_feed_and_restores_output_modes(self):
        # tmux moves down one row in the same column with a bare line feed. The plugin's
        # `stty cbreak` turns opost on in macOS, so with onlcr on the row lands at column 0.
        self.env['TEST_LINE_FEED'] = '1'
        code, output, _ = self.run_cli_in_terminal('attach', 'backend')
        self.assertEqual(code, 0)
        self.assertIn(b'A\nB', output)
        self.assertNotIn(b'A\r\nB', output)
        self.assertTrue(self.output_modes & termios.ONLCR)

    def test_clean_detach_keeps_the_screen_and_resets_input_modes(self):
        code, output, local_modes = self.run_cli_in_terminal('attach', 'backend')
        self.assertEqual(code, 0)
        tail = output[output.rindex(b'\x1b[?1003h'):]
        self.assertIn(b'\x1b[?1003l', tail)
        self.assertNotIn(b'\x1b[?1049l', tail)
        self.assertTrue(local_modes & termios.ECHO and local_modes & termios.ICANON)

    def test_expired_session_starts_login_in_a_terminal(self):
        self.env['TEST_EXPIRED'] = '1'
        code, output, _ = self.run_cli_in_terminal('attach', 'backend')
        self.assertEqual(code, 0, output)
        calls = (self.home / 'calls').read_text().splitlines()
        login = [i for i, c in enumerate(calls) if c.startswith('sso login --profile work')]
        self.assertEqual(len(login), 1, calls)
        self.assertTrue(any('start-session' in c for c in calls[login[0]:]))

    def test_expired_session_without_terminal_fails_without_login(self):
        self.env['TEST_EXPIRED'] = '1'
        result = self.run_cli('--snapshot')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('aws sso login --profile work', result.stderr)
        self.assertNotIn('sso login', (self.home / 'calls').read_text())

    def test_login_runs_the_sign_in_of_the_configured_profile(self):
        code, output, _ = self.run_cli_in_terminal('login')
        self.assertEqual(code, 0, output)
        calls = (self.home / 'calls').read_text().splitlines()
        self.assertEqual([c for c in calls if 'sso login' in c], ['sso login --profile work'])
        self.assertFalse(any('sts' in c or 'ssm' in c for c in calls), calls)

    def test_login_needs_a_terminal(self):
        result = self.run_cli('login')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('interactive terminal', result.stderr)
        self.assertFalse((self.home / 'calls').exists() and 'sso login' in (self.home / 'calls').read_text())

    def sent(self):
        """The remote command of the last send-command call."""
        calls = (self.home / 'calls').read_text().splitlines()
        return [c for c in calls if 'send-command' in c][-1]

    def test_capture_runs_the_helper_with_quoted_arguments(self):
        result = self.run_cli('capture', 'backend', '1:$2:3')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("capture backend '1:$2:3' 60 ", self.sent())
        (self.home / 'calls').unlink()
        self.run_cli('capture', 'backend', '1:$2:3', '200')
        self.assertIn("capture backend '1:$2:3' 200 ", self.sent())

    def test_capture_decrypts_with_a_one_time_key(self):
        scratch = self.home / 'scratch'
        scratch.mkdir()
        self.env['TMPDIR'] = str(scratch)
        result = self.run_cli('capture', 'backend', '1:$2:3')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), '{"text": "screen text"}')
        calls = (self.home / 'calls').read_text()
        self.assertNotIn('PRIVATE KEY', calls)
        self.assertNotIn('PRIVATE KEY', base64.b64decode(self.recipient()).decode())
        self.assertEqual(list(scratch.iterdir()), [])

    def scratch(self):
        folder = self.home / 'scratch'
        folder.mkdir()
        self.env['TMPDIR'] = str(folder)

    def test_capture_files_are_private_under_any_umask(self):
        self.scratch()
        result = subprocess.run(['bash', '-c', 'umask 022; exec bash "$@"', 'bash', str(CLI), 'capture', 'backend', '1:$2:3'],
                                env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        modes = (self.home / 'modes').read_text()
        self.assertIn('key.pem', modes)
        self.assertNotRegex(modes, r'(?m)^-r[w-]-r')

    def test_capture_writes_no_decrypted_file(self):
        self.scratch()
        real = shutil.which('openssl')
        wrapper = self.home / '.local/lib/cloud-access/openssl'
        wrapper.parent.mkdir(parents=True, exist_ok=True)
        wrapper.write_text(f'#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/openssl-calls"\nexec {real} "$@"\n')
        wrapper.chmod(0o755)
        result = self.run_cli('capture', 'backend', '1:$2:3')
        self.assertEqual(result.stdout.strip(), '{"text": "screen text"}', result.stderr)
        calls = (self.home / 'openssl-calls').read_text().splitlines()
        decrypt = [c for c in calls if '-decrypt' in c]
        self.assertEqual(len(decrypt), 1)
        self.assertNotIn('-out', decrypt[0])

    def test_failed_capture_prints_no_sealed_output(self):
        self.env['TEST_STATUS'] = 'Failed'
        result = self.run_cli('capture', 'backend', '1:$2:3')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')

    def recipient(self):
        sent = re.findall(r"capture backend '[^']*' \d+ ([A-Za-z0-9+/=]+)", self.sent())
        self.assertEqual(len(sent), 1)
        return sent[0]

    def test_each_capture_uses_a_new_key(self):
        self.run_cli('capture', 'backend', '1:$2:3')
        first = self.recipient()
        (self.home / 'calls').unlink()
        self.run_cli('capture', 'backend', '1:$2:3')
        self.assertNotEqual(self.recipient(), first)

    def test_capture_that_cannot_be_decrypted_fails(self):
        self.env['TEST_BAD_CIPHER'] = '1'
        scratch = self.home / 'scratch'
        scratch.mkdir()
        self.env['TMPDIR'] = str(scratch)
        result = self.run_cli('capture', 'backend', '1:$2:3')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('could not be decrypted', result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertEqual(list(scratch.iterdir()), [])

    def test_capture_rejects_bad_input_before_aws(self):
        for args in [('bad;name', '1:$2:3'), ('backend', '123;id'), ('backend',), ('backend', '1:$2:3', '0'),
                     ('backend', '1:$2:3', '201'), ('backend', '1:$2:3', 'x'), ('backend', '1:$2:3', '5', '6')]:
            result = self.run_cli('capture', *args)
            self.assertNotEqual(result.returncode, 0, args)
        self.assertFalse((self.home / 'calls').exists())

    def test_capture_starts_no_service(self):
        self.run_cli('capture', 'backend', '1:$2:3')
        self.assertIn('systemctl is-active', self.sent())
        self.assertNotIn('systemctl start', self.sent())

    def test_sessions_json_reads_the_snapshot(self):
        self.assertEqual(self.run_cli('sessions', '--json').returncode, 0)
        self.assertIn('terminal-session.sh snapshot', self.sent())
        # The helper refuses an argument after snapshot.
        self.assertNotIn('--json', self.sent())

    def test_plain_sessions_is_unchanged(self):
        self.assertEqual(self.run_cli('sessions').returncode, 0)
        self.assertIn('terminal-session.sh sessions', self.sent())
        self.assertNotEqual(self.run_cli('sessions', '--other').returncode, 0)

    def stub_app(self):
        app = self.home / '.local/lib/tokiwa/opentui/run'
        app.parent.mkdir(parents=True)
        app.write_text('#!/bin/sh\nprintf "app %s" "$*"\n')
        app.chmod(0o755)

    def test_mcp_starts_without_host_settings(self):
        self.stub_app()
        (self.home / '.config/tokiwa/host.env').unlink()
        result = self.run_cli('mcp')
        self.assertEqual((result.returncode, result.stdout), (0, 'app mcp'), result.stderr)
        self.assertFalse((self.home / 'calls').exists())

    def test_mcp_needs_the_installed_app(self):
        result = self.run_cli('mcp')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('not installed', result.stderr)

    def test_view_needs_an_identity_and_a_terminal(self):
        self.assertNotEqual(self.run_cli('view', 'backend').returncode, 0)
        self.assertNotEqual(self.run_cli('view', 'backend', 'x;y').returncode, 0)
        self.assertFalse((self.home / 'calls').exists())
        code, output, _ = self.run_cli_in_terminal('view', 'backend', '1:$2:3')
        self.assertEqual(code, 0, output)
        calls = (self.home / 'calls').read_text()
        self.assertIn("terminal-session.sh view backend '1:$2:3'", calls)

    def test_valid_session_does_not_log_in(self):
        self.assertEqual(self.run_cli('--snapshot').returncode, 0)
        self.assertNotIn('sso login', (self.home / 'calls').read_text())

    def test_invalid_attach_identity_fails_before_aws(self):
        for value in ['123;id', "1:$2:3' x", '1:2:3']:
            self.assertNotEqual(self.run_cli('attach', 'backend', value).returncode, 0)
        self.assertFalse((self.home / 'calls').exists())

    def test_reject_names_before_aws(self):
        for name in ['x;id', '-a', 'a b', 'a:b', 'x' * 49]:
            self.assertNotEqual(self.run_cli('new', name).returncode, 0)
        self.assertFalse((self.home / 'calls').exists())

    def run_cli_at(self, epoch, *args):
        """Run the CLI with a fake `date` that reports the given UTC epoch."""
        fake = self.home / '.local/lib/cloud-access/date'
        fake.write_text(f'#!/bin/bash\nif [ "$*" = "-u +%s" ]; then echo {epoch}; else exec /bin/date "$@"; fi\n')
        fake.chmod(0o755)
        try:
            return self.run_cli(*args)
        finally:
            fake.unlink()

    def test_end_time_in_host_env_stops_new_connections(self):
        self.assertEqual(self.run_cli_at(1893455999, 'status').returncode, 0)
        # At the end time, the launcher refuses before any AWS call.
        (self.home / 'calls').unlink()
        result = self.run_cli_at(1893456000, 'status')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('end time', result.stderr)
        self.assertFalse((self.home / 'calls').exists())

    def test_host_env_is_required_and_checked_before_aws(self):
        config = self.home / '.config/tokiwa/host.env'
        good = config.read_text()
        for text, message in [(None, 'Set the host in'),
                              ('instance=i-0123456789abcdef0\nprofile=work\n', 'region='),
                              (good + 'x=$(id)\n', 'not KEY=VALUE'),
                              (good.replace('account=123456789012', 'account=12'), '12-digit'),
                              (good.replace('end=2030-01-01T00:00:00Z', 'end=2030-01-01'), 'offset')]:
            if text is None:
                config.unlink()
            else:
                config.write_text(text)
            result = self.run_cli('status')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(message, result.stderr)
        self.assertFalse((self.home / 'calls').exists())
        config.write_text(good)
        self.env['TEST_ACCOUNT'] = '999999999999'
        result = self.run_cli('status')
        self.assertIn('does not match account=', result.stderr)

    def test_check_reaches_remote_service_without_starting_workloads(self):
        result = self.run_cli('--check')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Workbench server ready.', result.stdout)
        calls = (self.home / 'calls').read_text()
        self.assertIn('terminal-session.sh status', calls)
        self.assertNotIn('start-session', calls)
        self.assertNotIn('start-instances', calls)

    def test_wrong_account_and_stopped_host_fail_before_remote_execution(self):
        for key, value in [('TEST_ACCOUNT', 'wrong'), ('TEST_STATE', 'stopped')]:
            self.env[key] = value
            self.assertNotEqual(self.run_cli('status').returncode, 0)
            del self.env[key]
        self.assertNotIn('send-command', (self.home / 'calls').read_text())

    def test_service_failure_is_not_reported_as_ready(self):
        self.env['TEST_STATUS'] = 'Failed'
        result = self.run_cli('status')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('No service was started', result.stderr)

    def test_spend_prints_one_json_object_from_read_only_calls(self):
        import json
        result = self.run_cli('spend')
        self.assertEqual(result.returncode, 0, result.stderr)
        reading = json.loads(result.stdout)
        self.assertEqual(reading['instance_id'], 'i-0123456789abcdef0')
        self.assertEqual(reading['region'], 'us-east-1')
        self.assertEqual(reading['instance']['type'], 'm7i.2xlarge')
        self.assertEqual(reading['instance']['launch_time'], '2026-10-30T02:05:11+00:00')
        self.assertEqual([v['size_gib'] for v in reading['volumes']], [100, 500])
        self.assertEqual(reading['addresses'], [])
        self.assertIsInstance(reading['read_at'], float)
        calls = (self.home / 'calls').read_text()
        self.assertIn('get-caller-identity', calls)
        self.assertIn('describe-volumes --filters Name=attachment.instance-id,Values=i-0123456789abcdef0', calls)
        self.assertIn('describe-addresses --filters Name=instance-id,Values=i-0123456789abcdef0', calls)
        for term in ['send-command', 'start-session', 'start-instances']:
            self.assertNotIn(term, calls)

    def test_spend_reads_a_stopped_host_without_starting_it(self):
        self.env['TEST_STATE'] = 'stopped'
        result = self.run_cli('spend')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"state": "stopped"', result.stdout)
        self.assertNotIn('start-instances', (self.home / 'calls').read_text())

    def test_spend_checks_the_account_before_reading_resources(self):
        self.env['TEST_ACCOUNT'] = 'wrong'
        result = self.run_cli('spend')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('describe-', (self.home / 'calls').read_text())

    def test_spend_rejects_arguments_before_aws(self):
        self.assertNotEqual(self.run_cli('spend', 'extra').returncode, 0)
        self.assertFalse((self.home / 'calls').exists())

    def test_help_lists_spend(self):
        self.assertIn('spend', self.run_cli('--help').stdout)

if __name__ == '__main__':
    unittest.main()
