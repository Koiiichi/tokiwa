"""Check CLI routing without AWS calls or provider requests."""
import base64
import io
import json
import tarfile
import hashlib
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
 *sso\ login*) printf '%s\\n' "${BROWSER:-}" >> "$HOME/browsers"; touch "$HOME/logged-in" ;;
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
 *s3api\ put-object*) echo "${TEST_VERSION-v123}" ;;
 *s3api\ delete-object*) [ -z "${TEST_VDEL_FAIL:-}" ] || { echo 'versioned delete failed' >&2; exit 1; } ;;
 *s3\ presign*) echo 'https://example-bucket.s3.us-east-1.amazonaws.com/inputs/clipboard/key.png?X-Amz-Signature=sig0' ;;
 *s3\ rm*) [ -z "${TEST_RM_FAIL:-}" ] || { echo 'delete failed' >&2; exit 1; } ;;
 *s3\ cp\ -\ s3://*) cat > "$HOME/uploaded" ;;
 *s3\ cp\ s3://*) [ -z "${TEST_DOWNLOAD_FAIL:-}" ] || exit 1; for target; do :; done; [ "$target" != --only-show-errors ] || target=$(printf '%s\n' "$@" | tail -2 | head -1); cp "$HOME/remote-fixture" "$target" ;;
 *s3api\ head-object*) echo "${TEST_VERSION-v123}" ;;
 *send-command*)
  if [ -n "${TEST_SEND_FAIL:-}" ] && [[ $* == *paste-image* ]]; then
   echo 'Error when retrieving token from sso: Token has expired and refresh failed' >&2; exit 255
  fi
  echo test-command ;;
 *get-command-invocation*StandardOutputContent*)
  # The newest Run Command call decides the result for state and wait.
  last=$(grep 'send-command' "$HOME/calls" | tail -1)
  core='"name": "lead", "identity": "1:$2:3", "session": "live", "program": "claude", "clients": %s, "writable_clients": %s, "driver": null, "sampled_at": 2'
  agent='"agent": "idle", "agent_at": 1, "turn": 4, "pending": null, "dialog": false'
  if [[ $last == *'input-cert.pem'* && -n ${TEST_NO_INPUT_KEY:-} ]]; then
   # A host from before encrypted input: the check of the launcher finds no certificate.
   echo tokiwa-no-input-key
  elif [[ $last == *'input-cert.pem'* ]]; then
   # The host input certificate; the key stays here so that a test can decrypt what was sealed.
   [ -e "$HOME/host-input-cert.pem" ] || openssl req -x509 -newkey rsa:2048 -nodes -keyout "$HOME/host-input-key.pem" -out "$HOME/host-input-cert.pem" -subj /CN=tokiwa-input -days 1 >/dev/null 2>&1
   cat "$HOME/host-input-cert.pem"
  elif [[ $last == *'tokiwa-s3-pipe.py get '* ]]; then
   # Act as the host: report the bytes that were uploaded, or the SHA-256 that a test sets.
   python3 -c 'import hashlib,json,os,sys; d=open(sys.argv[1],"rb").read(); print(json.dumps({"path": "/srv/development/cache/sessions/lead/tmp/a.txt", "kind": "file", "files": 1, "bytes": len(d), "sha256": os.environ.get("TEST_REPORTED_SHA") or hashlib.sha256(d).hexdigest()}))' "$HOME/uploaded"
  elif [[ $last == *'tokiwa-s3-pipe.py put '* ]]; then
   cat "$HOME/remote-report.json"
  elif [[ $last == *'terminal-session.sh paste-image '* ]]; then
   echo '{"path": "/home/agent/.cache/tokiwa/lead/tmp/paste-20261118T000000Z-abcd1234.png"}'
  elif [ -n "${TEST_FETCH_FAIL:-}" ] && [[ $last == *'terminal-session.sh agent-wait '* ]]; then
   exit 1
  elif [[ $last == *'terminal-session.sh state '* ]]; then
   printf "{$core}\\n" "${TEST_WRITABLE:-0}" "${TEST_WRITABLE:-0}"
  elif [[ $last == *'terminal-session.sh agent-state '* ]]; then
   printf "{$core, $agent}\\n" "${TEST_WRITABLE:-0}" "${TEST_WRITABLE:-0}"
  elif [[ $last == *'terminal-session.sh agent-wait '* ]]; then
   # TEST_WAIT_REASONS lists the reason of each call; the last one repeats.
   count=$(( $(cat "$HOME/wait-count" 2>/dev/null || echo 0) + 1 )); echo "$count" > "$HOME/wait-count"
   read -ra reasons <<< "${TEST_WAIT_REASONS:-turn-ended}"
   index=$(( count > ${#reasons[@]} ? ${#reasons[@]} - 1 : count - 1 ))
   printf "{$core, $agent, \\"reason\\": \\"%s\\"}\\n" "${TEST_WRITABLE:-0}" "${TEST_WRITABLE:-0}" "${reasons[$index]}"
  elif grep -q 'terminal-session.sh digest' "$HOME/calls"; then
   now=$(date +%s)
   printf '{"sampled_at": %s, "sessions": [{"name": "lead-a", "identity": "1:$2:3", "active_at": %s, "agent": {"state": "waiting", "at": %s}, "git": {"branch": "main", "unpushed": 2, "changed": 1, "commit": "abc1234", "committed_at": %s}}, {"name": "notes", "identity": "1:$3:3", "active_at": %s, "agent": null, "git": null}]}\n' "$now" "$now" "$((now - 180))" "$((now - 7200))" "$((now - 86400))"
  elif grep -q 'tokiwa-run.py \(start\|status\)' "$HOME/calls"; then
   cert=$(grep -oE 'tokiwa-run.py (start [A-Za-z0-9+/=]+|status [^ ]+ [0-9]+) [A-Za-z0-9+/=]+' "$HOME/calls" | tail -1 | awk '{print $NF}')
   printf '%s' "$cert" | base64 --decode > "$HOME/recipient.pem"
   printf '{"id": "20261112T183000-7f3a", "state": "done", "exit": 0, "text": "ok"}' | openssl smime -encrypt -aes256 -binary -outform DER "$HOME/recipient.pem" | base64 | tr -d '\\n'
   echo
  elif [[ $last == *'terminal-session.sh agent-read '* ]]; then
   ls -l "$TMPDIR"/*/ >> "$HOME/modes" 2>/dev/null || true
   # Act as the host: encrypt to the certificate that the launcher sent.
   cert=$(grep -o "agent-read [^ ]* '[^']*' [^ ]* [^ ]* [A-Za-z0-9+/=]*" "$HOME/calls" | tail -1 | awk '{print $NF}')
   printf '%s' "$cert" | base64 --decode > "$HOME/recipient.pem"
   printf '{"events": [], "cursor": "0123456789ab:0", "more": false, "transcript_changed": false}' | openssl smime -encrypt -aes256 -binary -outform DER "$HOME/recipient.pem" | base64 | tr -d '\n'
   echo
  elif grep -q 'terminal-session.sh capture' "$HOME/calls"; then
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
 *get-command-invocation*StandardErrorContent*)
  printf '%s\n' "${TEST_STDERR:-Workbench unavailable.}"
  # The SSM agent adds this line after a script that exits non-zero.
  [ "${TEST_STATUS:-}" != Failed ] || echo 'failed to run commands: exit status 1' ;;
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
        self.env.pop('BROWSER', None)
        self.env.pop('TOKIWA_SIGN_IN_BROWSER', None)

    def tearDown(self):
        self.temp.cleanup()

    def run_cli(self, *args):
        return subprocess.run(['bash', str(CLI), *args], check=False, env=self.env, capture_output=True, text=True, timeout=30)

    PNG_MAGIC = b'\x89PNG\r\n\x1a\n'

    def paste_setup(self, body=b'image bytes', bucket=True, magic=PNG_MAGIC):
        if bucket:
            with open(self.home / '.config/tokiwa/host.env', 'a') as config:
                config.write('paste_bucket=example-bucket\n')
        image = self.home / 'shot.png'
        image.write_bytes(magic + body)
        return image

    def s3_calls(self):
        calls = (self.home / 'calls').read_text() if (self.home / 'calls').exists() else ''
        return [line for line in calls.splitlines() if ' s3 ' in line or ' s3api ' in line]

    def test_paste_image_uploads_seals_and_deletes(self):
        import hashlib
        image = self.paste_setup()
        result = self.run_cli('paste-image', 'lead', '1:$2:3', str(image))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '{"path": "/home/agent/.cache/tokiwa/lead/tmp/paste-20261118T000000Z-abcd1234.png"}\n')
        calls = (self.home / 'calls').read_text()
        s3 = self.s3_calls()
        self.assertEqual(len(s3), 3, s3)
        found = re.search(r's3api put-object --bucket example-bucket --key (inputs/clipboard/[0-9a-f]{32}\.png) --body %s --query VersionId --output text' % re.escape(str(image)), s3[0])
        self.assertIsNotNone(found, s3[0])
        key = found.group(1)
        self.assertIn('s3 presign s3://example-bucket/%s' % key, s3[1])
        self.assertIn('--expires-in 300', s3[1])
        # A versioned bucket: the delete names the uploaded version, so that no copy stays behind.
        self.assertIn('s3api delete-object --bucket example-bucket --key %s --version-id v123' % key, s3[2])
        send = [line for line in calls.splitlines() if 'send-command' in line and 'paste-image' in line][-1]
        self.assertIn('tokiwa-input.py', send)
        data = image.read_bytes()
        # The identity is quoted twice: for the inner shell and for bash -c.
        self.assertRegex(send, r"terminal-session\.sh paste-image lead .{1,12}1:\$2:3.{1,12} %s %d" % (hashlib.sha256(data).hexdigest(), len(data)))
        self.assertNotIn('https://', calls)
        self.assertEqual(self.host_decrypt(calls), b'tokiwa-input-v1\nhttps://example-bucket.s3.us-east-1.amazonaws.com/inputs/clipboard/key.png?X-Amz-Signature=sig0')

    def test_paste_image_falls_back_to_a_plain_delete_when_the_versioned_delete_fails(self):
        image = self.paste_setup()
        self.env.update(TEST_VDEL_FAIL='1')
        result = self.run_cli('paste-image', 'lead', '1:$2:3', str(image))
        self.assertEqual(result.returncode, 0, result.stderr)
        s3 = self.s3_calls()
        self.assertEqual(len(s3), 4, s3)
        self.assertIn('s3api delete-object', s3[2])
        self.assertRegex(s3[3], r's3 rm s3://example-bucket/inputs/clipboard/[0-9a-f]{32}\.png')

    def test_paste_image_on_an_unversioned_bucket_uses_the_plain_delete(self):
        image = self.paste_setup()
        for version in ('None', ''):
            with self.subTest(version=version):
                (self.home / 'calls').unlink(missing_ok=True)
                self.env.update(TEST_VERSION=version)
                result = self.run_cli('paste-image', 'lead', '1:$2:3', str(image))
                self.assertEqual(result.returncode, 0, result.stderr)
                s3 = self.s3_calls()
                self.assertEqual(len(s3), 3, s3)
                self.assertNotIn('delete-object', ' '.join(s3))
                self.assertIn(' s3 rm s3://example-bucket/inputs/clipboard/', s3[2])

    def test_paste_image_deletes_the_object_when_the_host_fails(self):
        image = self.paste_setup()
        # A first paste pins the host certificate; the failing paste then reaches the helper.
        self.assertEqual(self.run_cli('paste-image', 'lead', '1:$2:3', str(image)).returncode, 0)
        (self.home / 'calls').unlink()
        self.env.update(TEST_STATUS='Failed', TEST_STDERR='The image URL is not valid. Nothing was pasted.')
        result = self.run_cli('paste-image', 'lead', '1:$2:3', str(image))
        self.assertEqual(result.returncode, 1)
        self.assertIn('The image URL is not valid. Nothing was pasted.', result.stderr)
        self.assertIn('Tokiwa: The image was not pasted.', result.stderr)
        self.assertEqual(len([c for c in self.s3_calls() if ' s3api delete-object ' in c]), 1)

    def test_paste_image_deletes_the_object_when_the_sign_in_expires(self):
        image = self.paste_setup()
        self.env.update(TEST_SEND_FAIL='1', TEST_RM_FAIL='1')
        result = self.run_cli('paste-image', 'lead', '1:$2:3', str(image))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len([c for c in self.s3_calls() if ' s3api delete-object ' in c]), 1)
        # A failed delete does not hide the first error.
        self.assertIn('Tokiwa:', result.stderr)
        self.assertNotIn('delete failed', result.stderr)

    def test_paste_image_without_a_bucket(self):
        image = self.paste_setup(bucket=False)
        result = self.run_cli('paste-image', 'lead', '1:$2:3', str(image))
        self.assertEqual(result.returncode, 1)
        self.assertIn('Tokiwa: Image paste is not set up. Set paste_bucket= in ~/.config/tokiwa/host.env.', result.stderr)
        self.assertEqual(self.s3_calls(), [])

    def test_paste_image_refuses_a_file_that_is_not_png(self):
        image = self.paste_setup(magic=b'GIF89a\x00\x00')
        result = self.run_cli('paste-image', 'lead', '1:$2:3', str(image))
        self.assertEqual(result.returncode, 1)
        self.assertIn('Tokiwa: The file is not a PNG image of at most 10 MB.', result.stderr)
        self.assertEqual(self.s3_calls(), [])

    def test_paste_image_refuses_a_file_over_the_limit(self):
        image = self.paste_setup(body=b'\0' * (10485761 - 8))
        self.assertEqual(image.stat().st_size, 10485761)
        result = self.run_cli('paste-image', 'lead', '1:$2:3', str(image))
        self.assertEqual(result.returncode, 1)
        self.assertIn('Tokiwa: The file is not a PNG image of at most 10 MB.', result.stderr)
        self.assertEqual(self.s3_calls(), [])

    def test_paste_image_is_not_in_the_help(self):
        self.assertNotIn('paste-image', self.run_cli('--help').stdout)

    def test_host_settings_accept_paste_bucket(self):
        image = self.paste_setup()
        self.assertEqual(self.run_cli('paste-image', 'lead', '1:$2:3', str(image)).returncode, 0)
        with open(self.home / '.config/tokiwa/host.env', 'a') as config:
            config.write('paste_bucket=Bad_Bucket\n')
        result = self.run_cli('paste-image', 'lead', '1:$2:3', str(image))
        self.assertEqual(result.returncode, 1)
        self.assertIn('paste_bucket= must be an S3 bucket name.', result.stderr)

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

    def test_create_sends_the_command_to_run_encrypted(self):
        command = 'git clone https://example.com/app.git . && claude "Read LEAD.md and start."'
        result = self.run_cli('create', 'lead', '--dir', '/w/proj', '--subfolder', 'lead', '--run', command)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = (self.home / 'calls').read_text()
        # The request names stdin; the line is in the sealed argument of the input program.
        self.assertEqual(self.encoded_payload(calls, 'create'),
                         {'dir': '/w/proj', 'subfolder': 'lead', 'run_stdin': True})
        self.assertNotIn('Read LEAD.md', calls)
        # The host sees one marker line, then the line of the command.
        self.assertEqual(self.host_decrypt(calls), b'tokiwa-input-v1\n' + command.encode())

    def host_decrypt(self, calls):
        """Decrypt the sealed argument of tokiwa-input.py in the last recorded call, as the host does."""
        sealed = re.findall(r'tokiwa-input\.py ([A-Za-z0-9+/=]+)', calls)[-1]
        opened = subprocess.run(['openssl', 'smime', '-decrypt', '-binary', '-inform', 'DER', '-inkey',
                                 str(self.home / 'host-input-key.pem')],
                                input=base64.b64decode(sealed), capture_output=True, check=True)
        return opened.stdout

    def test_create_run_text_is_not_in_the_run_command_parameters(self):
        command = 'echo marker-text-9f3c'
        result = self.run_cli('create', 'lead', '--dir', '/w/proj', '--run', command)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = (self.home / 'calls').read_text()
        encoded = base64.b64encode(command.encode()).decode()
        self.assertNotIn('marker-text', calls)
        self.assertNotIn(encoded, calls)
        self.assertNotIn(encoded.rstrip('='), calls)
        # The host decrypts as root and pipes the text to the helper, which reads it from stdin.
        send = [line for line in calls.splitlines() if 'tokiwa-input.py' in line][-1]
        self.assertRegex(send, r'set -o pipefail; python3 -I /opt/agent-platform/rootless/tokiwa-input\.py [A-Za-z0-9+/=]+ \| sudo -n runuser -u agent-workspace')

    def test_first_use_pins_the_host_certificate(self):
        pin = self.home / '.config/tokiwa/input-cert.pem'
        self.assertFalse(pin.exists())
        for _ in range(2):
            result = self.run_cli('create', 'lead', '--dir', '/w/proj', '--run', 'echo hi')
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(pin.read_text(), (self.home / 'host-input-cert.pem').read_text())
        # The second call used the pin: the certificate was fetched once.
        calls = (self.home / 'calls').read_text()
        self.assertEqual(calls.count('cat /etc/tokiwa/input-cert.pem'), 1)

    def test_a_host_without_an_input_key_fails_closed(self):
        # A new launcher with an old host: nothing falls back to plain text, and nothing is created or sent.
        self.env['TEST_NO_INPUT_KEY'] = '1'
        for args, sentence in [(('create', 'lead', '--dir', '/w/proj', '--run', 'echo hi'),
                                'The host has no input key. Update the host with host/install.sh. Nothing was created.'),
                               (('agent', 'send', 'lead', '1:$2:3', '--text', 'Read LEAD.md.'),
                                'The host has no input key. Update the host with host/install.sh. Nothing was sent.')]:
            self.env['TOKIWA_ACTOR'] = 'worker-a'
            result = self.run_cli(*args)
            self.assertEqual(result.returncode, 1, args)
            self.assertIn(sentence, result.stderr)
            calls = (self.home / 'calls').read_text()
            self.assertNotIn('terminal-session.sh create', calls)
            self.assertNotIn('terminal-session.sh agent-send', calls)
            self.assertNotIn('tokiwa-input.py', calls)
            self.assertNotIn('Read LEAD.md', calls)
        self.assertFalse((self.home / '.config/tokiwa/input-cert.pem').exists())

    def test_input_cert_prints_the_host_certificate(self):
        result = self.run_cli('input-cert')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, (self.home / 'host-input-cert.pem').read_text())
        self.assertFalse((self.home / '.config/tokiwa/input-cert.pem').exists())

    def test_decrypt_refusal_prints_the_pin_advice(self):
        # The key is pinned first. The host then refuses the message, as it does after a key change.
        self.assertEqual(self.run_cli('create', 'lead', '--dir', '/w/proj', '--run', 'echo hi').returncode, 0)
        self.env.update(TEST_STATUS='Failed', TEST_STDERR='The message could not be decrypted with the host input key. Nothing was sent.')
        result = self.run_cli('create', 'lead', '--dir', '/w/proj', '--run', 'echo hi')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('The host input key changed or is missing. Check the host, then delete '
                      '~/.config/tokiwa/input-cert.pem to pin the new key.', result.stderr)

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

    def test_control_commands_need_a_name_and_an_identity_before_aws(self):
        for mode in ['interrupt', 'freeze', 'resume']:
            for args in [(mode,), (mode, 'lead'), (mode, 'lead', 'x;y'), (mode, 'bad name', '1:$2:3'), (mode, 'lead', '1:$2:3', 'more')]:
                self.assertNotEqual(self.run_cli(*args).returncode, 0, args)
        self.assertFalse((self.home / 'calls').exists())
        result = self.run_cli('freeze', 'lead', '1:$2:3')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("terminal-session.sh freeze lead '1:$2:3'", (self.home / 'calls').read_text())

    def test_the_interface_reaches_the_helper_for_the_audit_log(self):
        self.run_cli('freeze', 'lead', '1:$2:3')
        self.assertIn('TOKIWA_VIA=cli ', (self.home / 'calls').read_text())
        for via, expected in [('mcp', 'mcp'), ('app', 'app'), ('x;rm', 'cli')]:
            (self.home / 'calls').unlink()
            self.env['TOKIWA_VIA'] = via
            self.run_cli('freeze', 'lead', '1:$2:3')
            self.assertIn(f'TOKIWA_VIA={expected} ', (self.home / 'calls').read_text(), via)
        self.assertNotIn('x;rm', (self.home / 'calls').read_text())

    def test_search_sends_the_text_encoded_after_the_certificate(self):
        result = self.run_cli('search', 'web-lead', '1:$2:3', "it's done && more")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = (self.home / 'calls').read_text()
        encoded = base64.b64encode("it's done && more".encode()).decode()
        self.assertRegex(calls, r"terminal-session.sh capture web-lead '1:\$2:3' 50 [A-Za-z0-9+/=]+ " + re.escape(encoded))
        self.assertNotIn('done &&', calls)
        for args in [('search', 'web-lead', '1:$2:3'), ('search', 'web-lead', 'x', 'text'),
                     ('search', 'web-lead', '1:$2:3', 'x' * 201), ('search', 'web-lead', '1:$2:3', 'a\tb')]:
            (self.home / 'calls').unlink(missing_ok=True)
            self.assertNotEqual(self.run_cli(*args).returncode, 0, args)
            self.assertFalse((self.home / 'calls').exists(), args)

    def test_digest_prints_one_line_per_session_and_json_on_request(self):
        result = self.run_cli('digest')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('terminal-session.sh digest', (self.home / 'calls').read_text())
        lines = result.stdout.splitlines()
        lead = next(line for line in lines if line.startswith('lead-a'))
        for part in ['waiting 3m', 'active now', 'main', '2 unpushed', '1 changed', 'abc1234 2h ago']:
            self.assertIn(part, lead)
        notes = next(line for line in lines if line.startswith('notes'))
        self.assertIn('active 1d ago', notes)
        self.assertIn('no git', notes)
        raw = self.run_cli('digest', '--json')
        self.assertEqual(json.loads(raw.stdout)['sessions'][0]['name'], 'lead-a')
        self.assertNotEqual(self.run_cli('digest', 'x').returncode, 0)

    def test_the_actor_reaches_the_helper_only_when_well_formed(self):
        self.env['TOKIWA_ACTOR'] = 'orchestrator-a'
        self.run_cli('freeze', 'lead', '1:$2:3')
        self.assertIn('TOKIWA_ACTOR=orchestrator-a ', (self.home / 'calls').read_text())
        (self.home / 'calls').unlink()
        self.env['TOKIWA_ACTOR'] = 'bad;rm'
        self.run_cli('freeze', 'lead', '1:$2:3')
        self.assertNotIn('TOKIWA_ACTOR', (self.home / 'calls').read_text())

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

    def calls(self):
        return (self.home / 'calls').read_text()

    def test_state_calls_the_helper_state_mode(self):
        result = self.run_cli('state', 'lead', '1:$2:3')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("terminal-session.sh state lead '1:$2:3'", self.calls())
        self.assertEqual(sorted(json.loads(result.stdout)), sorted(
            ['name', 'identity', 'session', 'program', 'clients', 'writable_clients', 'driver', 'sampled_at']))
        self.assertNotIn('start-session', self.calls())

    def test_state_refuses_a_bad_identity(self):
        for args in [('state', 'lead'), ('state', 'lead', 'x;y'), ('state', 'bad name', '1:$2:3'), ('state', 'lead', '1:$2:3', 'more')]:
            self.assertNotEqual(self.run_cli(*args).returncode, 0, args)
        self.assertFalse((self.home / 'calls').exists())

    def test_agent_state_calls_the_helper_agent_state_mode(self):
        result = self.run_cli('agent', 'state', 'lead', '1:$2:3')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("terminal-session.sh agent-state lead '1:$2:3'", self.calls())
        self.assertEqual(json.loads(result.stdout)['agent'], 'idle')
        for args in [('agent', 'state', 'lead'), ('agent', 'state', 'lead', 'x;y'), ('agent', 'state', 'bad name', '1:$2:3'),
                     ('agent', 'state', 'lead', '1:$2:3', 'more')]:
            (self.home / 'calls').unlink(missing_ok=True)
            self.assertNotEqual(self.run_cli(*args).returncode, 0, args)
            self.assertFalse((self.home / 'calls').exists(), args)

    def test_agent_without_a_subcommand_prints_usage(self):
        for args in [('agent',), ('agent', 'delete'), ('agent', 'bogus', 'lead', '1:$2:3')]:
            result = self.run_cli(*args)
            self.assertEqual(result.returncode, 2, args)
            self.assertIn('Usage: tokiwa agent', result.stderr)
            self.assertIn('state NAME IDENTITY', result.stderr)
            self.assertIn('wait NAME IDENTITY --after TURN', result.stderr)
            self.assertIn('send NAME IDENTITY', result.stderr)
            self.assertIn('read NAME IDENTITY', result.stderr)
        self.assertFalse((self.home / 'calls').exists())

    def test_the_old_top_level_wait_is_not_a_command(self):
        self.assertEqual(self.run_cli('wait', 'lead', '1:$2:3', '--after', '3').returncode, 2)
        self.assertFalse((self.home / 'calls').exists())

    def test_agent_wait_calls_the_helper_agent_wait_mode(self):
        result = self.run_cli('agent', 'wait', 'lead', '1:$2:3', '--after', '3')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("terminal-session.sh agent-wait lead '1:$2:3' 3", self.calls())
        self.assertEqual(json.loads(result.stdout)['reason'], 'turn-ended')

    def test_agent_wait_repeats_until_a_reason(self):
        self.env['TEST_WAIT_REASONS'] = 'timeout timeout turn-ended'
        result = self.run_cli('agent', 'wait', 'lead', '1:$2:3', '--after', '3')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls().count('terminal-session.sh agent-wait'), 3)
        # Only the last object is printed.
        self.assertEqual(json.loads(result.stdout)['reason'], 'turn-ended')
        self.assertEqual(len(result.stdout.strip().splitlines()), 1)

    def test_agent_wait_stops_at_its_timeout(self):
        self.env['TEST_WAIT_REASONS'] = 'timeout'
        result = self.run_cli('agent', 'wait', 'lead', '1:$2:3', '--after', '3', '--timeout', '1')
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(json.loads(result.stdout)['reason'], 'timeout')

    def test_agent_wait_asks_the_host_for_no_more_than_the_time_left(self):
        self.env['TEST_WAIT_REASONS'] = 'timeout'
        self.run_cli('agent', 'wait', 'lead', '1:$2:3', '--after', '3', '--timeout', '1')
        self.assertIn('TOKIWA_WAIT_SECONDS=1 ', self.calls())
        (self.home / 'calls').unlink()
        del self.env['TEST_WAIT_REASONS']
        self.run_cli('agent', 'wait', 'lead', '1:$2:3', '--after', '3')
        self.assertIn('TOKIWA_WAIT_SECONDS=20 ', self.calls())

    def test_agent_wait_refuses_bad_arguments_before_aws(self):
        base = ('agent', 'wait', 'lead', '1:$2:3')
        for args in [base, base + ('--after',), base + ('--after', 'x'), base + ('--after', '-1'), base + ('3',),
                     base + ('--after', '3', '--timeout'), base + ('--after', '3', '--timeout', '0'),
                     base + ('--after', '3', '--timeout', '3601'), base + ('--after', '3', '--timeout', 'x'),
                     base + ('--after', '3', '--timeout', '5', 'more'), ('agent', 'wait', 'lead', 'x', '--after', '3')]:
            self.assertNotEqual(self.run_cli(*args).returncode, 0, args)
        self.assertFalse((self.home / 'calls').exists())

    def test_agent_wait_reports_a_failed_call_as_a_wait(self):
        self.env['TEST_STATUS'] = 'Failed'
        result = self.run_cli('agent', 'wait', 'lead', '1:$2:3', '--after', '3')
        self.assertEqual(result.returncode, 1)
        self.assertIn('The wait call returned Failed. Nothing was changed.', result.stderr)
        self.assertNotIn('workbench check', result.stderr)

    def test_agent_wait_fails_when_its_output_cannot_be_read(self):
        self.env['TEST_FETCH_FAIL'] = '1'
        self.env['TEST_WAIT_REASONS'] = 'timeout'
        result = self.run_cli('agent', 'wait', 'lead', '1:$2:3', '--after', '3', '--timeout', '1')
        self.assertEqual(result.returncode, 1)
        self.assertIn('The wait result could not be read. Nothing was changed.', result.stderr)
        self.assertNotIn('timeout', result.stdout)

    def test_claim_passes_the_actor_to_the_helper(self):
        self.env['TOKIWA_ACTOR'] = 'worker-a'
        result = self.run_cli('claim', 'lead', '1:$2:3')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("TOKIWA_ACTOR=worker-a ", self.calls())
        self.assertIn("terminal-session.sh claim lead '1:$2:3'\"", self.calls())
        (self.home / 'calls').unlink()
        self.assertEqual(self.run_cli('claim', 'lead', '1:$2:3', '--replace').returncode, 0)
        self.assertIn("terminal-session.sh claim lead '1:$2:3' replace", self.calls())
        (self.home / 'calls').unlink()
        self.assertEqual(self.run_cli('release', 'lead', '1:$2:3').returncode, 0)
        self.assertIn("TOKIWA_ACTOR=worker-a ", self.calls())
        self.assertIn("terminal-session.sh release lead '1:$2:3'\"", self.calls())

    def test_claim_without_tokiwa_actor_is_refused_on_the_mac(self):
        for actor in [None, '', 'bad;rm']:
            self.env.pop('TOKIWA_ACTOR', None)
            if actor is not None:
                self.env['TOKIWA_ACTOR'] = actor
            for mode in ['claim', 'release']:
                result = self.run_cli(mode, 'lead', '1:$2:3')
                self.assertEqual(result.returncode, 1, (mode, actor))
                self.assertIn('TOKIWA_ACTOR', result.stderr)
        self.assertFalse((self.home / 'calls').exists())

    def send_calls(self):
        return (self.home / 'calls').read_text()

    def test_send_text_is_not_in_the_parameters(self):
        self.env['TOKIWA_ACTOR'] = 'worker-a'
        text = 'marker-text-9f3c and \u00e4\u00f6 more'
        result = self.run_cli('agent', 'send', 'lead', '1:$2:3', '--text', text)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.send_calls()
        encoded = base64.b64encode(text.encode()).decode()
        for part in ['marker-text', encoded, encoded.rstrip('=')]:
            self.assertNotIn(part, calls)
        self.assertEqual(self.host_decrypt(calls), b'tokiwa-input-v1\n' + text.encode())
        send = [line for line in calls.splitlines() if 'tokiwa-input.py' in line][-1]
        self.assertRegex(send, r"set -o pipefail; python3 -I /opt/agent-platform/rootless/tokiwa-input\.py [A-Za-z0-9+/=]+ \| sudo -n runuser -u agent-workspace -- env TOKIWA_QUIET=1 TOKIWA_VIA=cli TOKIWA_ACTOR=worker-a /opt/agent-platform/rootless/terminal-session\.sh agent-send lead")

    def test_send_reads_a_file_and_stdin(self):
        self.env['TOKIWA_ACTOR'] = 'worker-a'
        text = 'line one\n\u00dcber line two\n'
        path = self.home / 'message.txt'
        path.write_text(text, encoding='utf-8')
        self.assertEqual(self.run_cli('agent', 'send', 'lead', '1:$2:3', '--file', str(path)).returncode, 0)
        self.assertEqual(self.host_decrypt(self.send_calls()), b'tokiwa-input-v1\n' + text.encode())
        result = subprocess.run(['bash', str(CLI), 'agent', 'send', 'lead', '1:$2:3', '-'], env=self.env, input=text.encode(),
                                capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.host_decrypt(self.send_calls()), b'tokiwa-input-v1\n' + text.encode())

    def test_send_refuses_text_checks_on_the_mac_first(self):
        self.env['TOKIWA_ACTOR'] = 'worker-a'
        for bad in ['/clear', '  !ls', '#x', 'bell\a', 'c1\x85next', '', '  \n', 'x' * 16385]:
            result = self.run_cli('agent', 'send', 'lead', '1:$2:3', '--text', bad)
            self.assertEqual(result.returncode, 1, repr(bad))
            self.assertIn('Nothing was sent.', result.stderr)
        self.assertFalse((self.home / 'calls').exists())
        missing = self.run_cli('agent', 'send', 'lead', '1:$2:3', '--file', str(self.home / 'none'))
        self.assertEqual(missing.returncode, 1)
        for args in [('agent', 'send', 'lead'), ('agent', 'send', 'lead', '1:$2:3'), ('agent', 'send', 'lead', '1:$2:3', '--text'),
                     ('agent', 'send', 'lead', '1:$2:3', '--bogus', 'x'), ('agent', 'send', 'bad name', '1:$2:3', '--text', 'x')]:
            self.assertNotEqual(self.run_cli(*args).returncode, 0, args)
        self.assertFalse((self.home / 'calls').exists())

    def test_answer_choice_must_be_1_to_9(self):
        self.env['TOKIWA_ACTOR'] = 'worker-a'
        base = ('agent', 'answer', 'lead', '1:$2:3', '--pending', 'toolu_q1')
        for bad in [('--choice', '0'), ('--choice', '10'), ('--choice', 'x'), ('--choice', ''), ('--choice', '-1'), ('--choice',), (),
                    ('--choice', '1', '--text', 'x'), ('--text',), ('--bogus', '1'), ('--choice', '1', 'more')]:
            self.assertNotEqual(self.run_cli(*base, *bad).returncode, 0, bad)
        for pending in ['', 'a b', 'x' * 129, 'a;b', '$(x)']:
            self.assertNotEqual(self.run_cli('agent', 'answer', 'lead', '1:$2:3', '--pending', pending, '--choice', '1').returncode, 0, pending)
        for args in [('agent', 'answer', 'lead', '1:$2:3', '--choice', '1'), ('agent', 'answer', 'lead', '--pending', 'toolu_q1', '--choice', '1'),
                     ('agent', 'answer', 'bad name', '1:$2:3', '--pending', 'toolu_q1', '--choice', '1')]:
            self.assertNotEqual(self.run_cli(*args).returncode, 0, args)
        self.assertFalse((self.home / 'calls').exists())
        for choice in '19':
            result = self.run_cli(*base, '--choice', choice)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(f"terminal-session.sh agent-answer lead '1:$2:3' toolu_q1 {choice}", self.send_calls())

    def test_relaunch_passes_the_settings_path_and_the_digest(self):
        self.env['TOKIWA_ACTOR'] = 'worker-a'
        path = '/srv/development/private/homes/workbench/.grants/merge.r1.settings.json'
        result = self.run_cli('agent', 'relaunch', 'lead', '1:$2:3', '--settings', path)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"TOKIWA_ACTOR=worker-a /opt/agent-platform/rootless/terminal-session.sh agent-relaunch lead '1:$2:3' {path} -",
                      self.send_calls())
        digest = 'a' * 64
        result = self.run_cli('agent', 'relaunch', 'lead', '1:$2:3', '--settings', path, '--sha256', digest)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"agent-relaunch lead '1:$2:3' {path} {digest}", self.send_calls())

    def test_relaunch_arguments_are_checked_on_the_mac(self):
        self.env['TOKIWA_ACTOR'] = 'worker-a'
        base = ('agent', 'relaunch', 'lead', '1:$2:3')
        for bad in [(), ('--settings',), ('--settings', 'relative.json'), ('--settings', '/a b.json'),
                    ('--settings', '/a;b.json'), ('--settings', '/x.json', '--sha256', 'A' * 64),
                    ('--settings', '/x.json', '--sha256', 'a' * 63), ('--settings', '/x.json', '--sha256'),
                    ('--settings', '/x.json', '--bogus', 'a' * 64), ('--file', '/x.json')]:
            self.assertNotEqual(self.run_cli(*base, *bad).returncode, 0, bad)
        self.env.pop('TOKIWA_ACTOR')
        result = self.run_cli(*base, '--settings', '/x.json')
        self.assertEqual(result.returncode, 1)
        self.assertIn('TOKIWA_ACTOR', result.stderr)
        self.assertFalse((self.home / 'calls').exists())

    def test_answer_without_tokiwa_actor_is_refused(self):
        for actor in [None, '', 'bad;rm']:
            self.env.pop('TOKIWA_ACTOR', None)
            if actor is not None:
                self.env['TOKIWA_ACTOR'] = actor
            result = self.run_cli('agent', 'answer', 'lead', '1:$2:3', '--pending', 'toolu_q1', '--choice', '1')
            self.assertEqual(result.returncode, 1, actor)
            self.assertIn('TOKIWA_ACTOR', result.stderr)
            self.assertIn('Nothing was sent.', result.stderr)
        self.assertFalse((self.home / 'calls').exists())

    def test_answer_text_is_not_in_the_parameters(self):
        self.env['TOKIWA_ACTOR'] = 'worker-a'
        text = 'marker-text-5d1e and \u00e4\u00f6 more'
        result = self.run_cli('agent', 'answer', 'lead', '1:$2:3', '--pending', 'toolu_q1', '--text', text)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.send_calls()
        encoded = base64.b64encode(text.encode()).decode()
        for part in ['marker-text', encoded, encoded.rstrip('=')]:
            self.assertNotIn(part, calls)
        self.assertEqual(self.host_decrypt(calls), b'tokiwa-input-v1\n' + text.encode())
        answer = [line for line in calls.splitlines() if 'tokiwa-input.py' in line][-1]
        self.assertRegex(answer, r"set -o pipefail; python3 -I /opt/agent-platform/rootless/tokiwa-input\.py [A-Za-z0-9+/=]+ \| sudo -n runuser -u agent-workspace -- env TOKIWA_QUIET=1 TOKIWA_VIA=cli TOKIWA_ACTOR=worker-a /opt/agent-platform/rootless/terminal-session\.sh agent-answer lead")
        self.assertTrue(answer.endswith("toolu_q1 text'\"], \"executionTimeout\": [\"30\"]} --query Command.CommandId --output text"))

    def test_answer_text_refuses_text_checks_on_the_mac_first(self):
        self.env['TOKIWA_ACTOR'] = 'worker-a'
        for bad in ['/clear', '  !ls', '#x', 'bell\a', 'c1\x85next', '', '  \n', 'x' * 16385]:
            result = self.run_cli('agent', 'answer', 'lead', '1:$2:3', '--pending', 'toolu_q1', '--text', bad)
            self.assertEqual(result.returncode, 1, repr(bad))
            self.assertIn('Nothing was sent.', result.stderr)
        self.assertFalse((self.home / 'calls').exists())

    def test_send_without_tokiwa_actor_is_refused(self):
        for actor in [None, '', 'bad;rm']:
            self.env.pop('TOKIWA_ACTOR', None)
            if actor is not None:
                self.env['TOKIWA_ACTOR'] = actor
            result = self.run_cli('agent', 'send', 'lead', '1:$2:3', '--text', 'hello')
            self.assertEqual(result.returncode, 1, actor)
            self.assertIn('TOKIWA_ACTOR', result.stderr)
            self.assertIn('Nothing was sent.', result.stderr)
        self.assertFalse((self.home / 'calls').exists())

    def test_the_temporary_folder_is_gone_after_a_call(self):
        # A message and a create line leave no temporary folder, after a success and after a refusal.
        scratch = self.home / 'scratch'
        scratch.mkdir()
        self.env.update(TMPDIR=str(scratch), TOKIWA_ACTOR='worker-a')
        self.assertEqual(self.run_cli('agent', 'send', 'lead', '1:$2:3', '--text', 'hello').returncode, 0)
        self.assertNotEqual(self.run_cli('agent', 'send', 'lead', '1:$2:3', '--text', '/x').returncode, 0)
        self.assertEqual(self.run_cli('create', 'lead', '--dir', '/w/proj', '--run', 'echo hi').returncode, 0)
        self.assertEqual(self.run_cli('capture', 'lead', '1:$2:3').returncode, 0)
        self.assertEqual(list(scratch.iterdir()), [])

    def test_no_here_string_carries_message_text(self):
        # macOS /bin/bash 3.2 writes a here-string to a temporary file.
        for path in [CLI, CLI.parents[1] / 'host/terminal-session.sh']:
            for line in path.read_text().splitlines():
                if any(word in line for word in ('create_out', 'run_b64', '$request', 'input_file')):
                    self.assertNotIn('<<<', line, line)

    def test_claim_and_release_refuse_bad_arguments_before_aws(self):
        self.env['TOKIWA_ACTOR'] = 'worker-a'
        for args in [('claim',), ('claim', 'lead'), ('claim', 'lead', 'x;y'), ('claim', 'lead', '1:$2:3', '--force'),
                     ('claim', 'lead', '1:$2:3', '--replace', 'more'), ('release', 'lead'),
                     ('release', 'lead', '1:$2:3', '--replace'), ('release', 'bad name', '1:$2:3')]:
            self.assertNotEqual(self.run_cli(*args).returncode, 0, args)
        self.assertFalse((self.home / 'calls').exists())

    def test_end_is_the_documented_form_of_end_confirmed(self):
        result = self.run_cli('end', 'lead', '1:$2:3')
        self.assertEqual(result.returncode, 0, result.stderr)
        # The host checks for a client. The launcher reads no state first.
        self.assertIn("terminal-session.sh end lead '1:$2:3' check-clients", self.calls())
        self.assertNotIn('attached-ok', self.calls())
        self.assertNotIn('terminal-session.sh state', self.calls())

    def test_end_attached_ok_sends_no_flag(self):
        result = self.run_cli('end', 'lead', '1:$2:3', '--attached-ok')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("terminal-session.sh end lead '1:$2:3'\"", self.calls())
        self.assertNotIn('check-clients', self.calls())

    def test_end_confirmed_is_unchanged(self):
        # The call that the base version sent, byte for byte: no flag after the identity.
        result = self.run_cli('--end-confirmed', 'lead', '1:$2:3')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("terminal-session.sh end lead '1:$2:3'\"", self.calls())
        self.assertNotIn('check-clients', self.calls())
        self.assertNotIn('terminal-session.sh state', self.calls())

    def test_end_refuses_bad_arguments_before_aws(self):
        for args in [('end',), ('end', 'lead'), ('end', 'lead', 'x;y'), ('end', 'lead', '1:$2:3', '--force'),
                     ('end', 'lead', '1:$2:3', '--attached-ok', 'more'), ('end', 'bad name', '1:$2:3')]:
            self.assertNotEqual(self.run_cli(*args).returncode, 0, args)
        self.assertFalse((self.home / 'calls').exists())

    def test_the_host_refusal_of_end_is_shown(self):
        self.env['TEST_STATUS'] = 'Failed'
        self.env['TEST_STDERR'] = 'A client is attached. Nothing was changed. Use --attached-ok to end it anyway.'
        result = self.run_cli('end', 'lead', '1:$2:3')
        self.assertEqual(result.returncode, 1)
        self.assertIn('A client is attached. Nothing was changed.', result.stderr)

    def test_existing_commands_are_unchanged(self):
        # The helper modes and arguments that these commands sent at the base of the layer split.
        expected = {
            ('sessions', '--json'): 'terminal-session.sh snapshot',
            ('capture', 'lead', '1:$2:3', '60'): "terminal-session.sh capture lead '1:$2:3' 60 ",
            ('interrupt', 'lead', '1:$2:3'): "terminal-session.sh interrupt lead '1:$2:3'",
        }
        for args, call in expected.items():
            (self.home / 'calls').unlink(missing_ok=True)
            self.assertEqual(self.run_cli(*args).returncode, 0, args)
            self.assertIn(call, self.calls(), args)

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

    NOTE = 'the sign-in opens with TOKIWA_SIGN_IN_BROWSER'
    REFUSAL = 'TOKIWA_SIGN_IN_BROWSER must name an executable file. Its path cannot contain : or %.'

    def opener(self, name='opener'):
        path = self.home / name
        path.write_text('#!/bin/bash\nexit 0\n')
        path.chmod(0o755)
        return str(path)

    def browsers(self):
        return (self.home / 'browsers').read_text().splitlines()

    def test_sign_in_without_a_browser_setting_leaves_browser_empty(self):
        code, output, _ = self.run_cli_in_terminal('login')
        self.assertEqual(code, 0, output)
        self.assertEqual(self.browsers(), [''])
        self.assertNotIn(self.NOTE.encode(), output)

    def test_login_opens_the_sign_in_with_the_browser_setting(self):
        self.env['TOKIWA_SIGN_IN_BROWSER'] = opener = self.opener()
        code, output, _ = self.run_cli_in_terminal('login')
        self.assertEqual(code, 0, output)
        self.assertEqual(self.browsers(), [opener])
        self.assertIn(self.NOTE.encode(), output)

    def test_expired_session_opens_the_sign_in_with_the_browser_setting(self):
        self.env['TEST_EXPIRED'] = '1'
        self.env['TOKIWA_SIGN_IN_BROWSER'] = opener = self.opener()
        code, output, _ = self.run_cli_in_terminal('attach', 'backend')
        self.assertEqual(code, 0, output)
        self.assertEqual(self.browsers(), [opener])
        self.assertIn(self.NOTE.encode(), output)

    def test_browser_setting_that_is_not_valid_stops_before_the_sign_in(self):
        (self.home / 'folder:name').mkdir()
        for value in [str(self.home / 'missing'), self.opener('with:colon'), self.opener('with%percent'), str(self.home / 'folder:name')]:
            with self.subTest(value=value):
                self.env['TOKIWA_SIGN_IN_BROWSER'] = value
                code, output, _ = self.run_cli_in_terminal('login')
                self.assertNotEqual(code, 0, output)
                self.assertIn(self.REFUSAL.encode(), output)
                self.assertFalse((self.home / 'browsers').exists())
                self.assertNotIn(self.NOTE.encode(), output)

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

    def test_agent_read_runs_the_helper_and_opens_the_sealed_result(self):
        self.scratch()
        cursor = '0123456789ab:42'
        cases = [(('agent', 'read', 'backend', '1:$2:3'), "agent-read backend '1:$2:3' - - "),
                 (('agent', 'read', 'backend', '1:$2:3', '--tools'), "agent-read backend '1:$2:3' - tools "),
                 (('agent', 'read', 'backend', '1:$2:3', '--pending'), "agent-read backend '1:$2:3' - pending "),
                 (('agent', 'read', 'backend', '1:$2:3', '--pending', '--tools', '--after', cursor),
                  f"agent-read backend '1:$2:3' {cursor} tools,pending ")]
        for args, expected in cases:
            with self.subTest(args=args):
                (self.home / 'calls').unlink(missing_ok=True)
                result = self.run_cli(*args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(expected, self.sent())
                self.assertEqual(json.loads(result.stdout)['cursor'], '0123456789ab:0')
                self.assertNotIn('PRIVATE KEY', (self.home / 'calls').read_text())
        self.assertEqual(list((self.home / 'scratch').iterdir()), [])

    def test_agent_read_files_are_private_and_the_key_is_new_each_time(self):
        self.scratch()
        result = subprocess.run(['bash', '-c', 'umask 022; exec bash "$@"', 'bash', str(CLI), 'agent', 'read', 'backend', '1:$2:3'],
                                env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotRegex((self.home / 'modes').read_text(), r'(?m)^-r[w-]-r')
        first = re.findall(r'[A-Za-z0-9+/=]{200,}', self.sent())[-1]
        self.run_cli('agent', 'read', 'backend', '1:$2:3')
        self.assertNotEqual(re.findall(r'[A-Za-z0-9+/=]{200,}', self.sent())[-1], first)

    def test_failed_agent_read_prints_no_sealed_output(self):
        self.env['TEST_STATUS'] = 'Failed'
        result = self.run_cli('agent', 'read', 'backend', '1:$2:3')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')

    def test_agent_read_rejects_bad_input_before_aws(self):
        cursor = '0123456789ab:42'
        for args in [('bad;name', '1:$2:3'), ('backend', '123;id'), ('backend',), ('backend', '1:$2:3', '--after'),
                     ('backend', '1:$2:3', '--after', 'x'), ('backend', '1:$2:3', '--after', '0123456789AB:1'),
                     ('backend', '1:$2:3', '--after', cursor, '--after', cursor), ('backend', '1:$2:3', '--tools', '--tools'),
                     ('backend', '1:$2:3', '--all'), ('backend', '1:$2:3', 'extra')]:
            with self.subTest(args=args):
                self.assertNotEqual(self.run_cli('agent', 'read', *args).returncode, 0)
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

    def test_mcp_passes_the_allowed_classes_to_the_server(self):
        self.stub_app()
        result = self.run_cli('mcp', '--allow', 'control,run')
        self.assertEqual((result.returncode, result.stdout), (0, 'app mcp --allow control,run'), result.stderr)
        for classes in ['commands', 'commands,control', 'run,commands,control']:
            result = self.run_cli('mcp', '--allow', classes)
            self.assertEqual((result.returncode, result.stdout), (0, f'app mcp --allow {classes}'), result.stderr)
        # A person or a terminal is needed for the human commands, so no flag offers them.
        for args in [('mcp', '--allow'), ('mcp', '--allow', 'human'), ('mcp', '--allow', 'control;x'), ('mcp', 'x'),
                     ('mcp', '--allow', 'run,run'), ('mcp', '--allow', 'control,run,commands,run'),
                     ('mcp', '--allow', 'shell')]:
            self.assertNotEqual(self.run_cli(*args).returncode, 0, args)

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

    def run_calls(self):
        return (self.home / 'calls').read_text()

    def run_payload(self):
        found = re.search(r'tokiwa-run\.py start ([A-Za-z0-9+/=]+) ', self.sent())
        self.assertIsNotNone(found, self.sent())
        return json.loads(base64.b64decode(found.group(1)))

    def test_run_sends_the_entry_and_pairs_encoded(self):
        result = self.run_cli('run', 'review-pr', 'pr=42', 'commit=1a2b3c4')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.run_payload(), {'entry': 'review-pr', 'args': {'pr': '42', 'commit': '1a2b3c4'}})
        self.assertNotIn('runuser', self.sent())
        self.assertIn('env TOKIWA_VIA=cli python3 -I /opt/agent-platform/rootless/tokiwa-run.py start ', self.sent())

    def test_run_decrypts_the_result(self):
        result = self.run_cli('run', 'review-pr', 'pr=42')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'id': '20261112T183000-7f3a', 'state': 'done', 'exit': 0, 'text': 'ok'})

    def test_run_refuses_bad_arguments(self):
        cases = [('Bad',), ('review-pr', 'pr'), ('review-pr', 'pr=a\tb'), ('review-pr', 'Pr=1'), ('review-pr', 'pr='),
                 ('review-pr', 'pr=' + 'x' * 1001), ('review-pr', *[f'a{n}=1' for n in 'abcdefghijklmnopq'])]
        self.assertEqual(len(cases[-1]), 18)
        for args in cases:
            with self.subTest(args=args):
                (self.home / 'calls').unlink(missing_ok=True)
                result = self.run_cli('run', *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.home / 'calls').exists())

    def test_run_accepts_sixteen_pairs_and_a_value_of_1000_characters(self):
        result = self.run_cli('run', 'review-pr', 'pr=' + 'x' * 1000, *[f'a{n}=1' for n in 'abcdefghijklmno'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.run_payload()['args']), 16)

    def test_run_status_checks_the_id(self):
        result = self.run_cli('run-status', '../x')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.home / 'calls').exists())
        for args in [('20261112T183000-7f3a', '-1'), ('20261112T183000-7f3a', 'x'), ('20261112T183000-7f3a', '1', '2')]:
            self.assertNotEqual(self.run_cli('run-status', *args).returncode, 0, args)
        self.assertFalse((self.home / 'calls').exists())
        result = self.run_cli('run-status', '20261112T183000-7f3a', '15000')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(self.sent(), r'tokiwa-run\.py status 20261112T183000-7f3a 15000 [A-Za-z0-9+/=]+')
        self.assertEqual(json.loads(result.stdout)['state'], 'done')
        self.run_cli('run-status', '20261112T183000-7f3a')
        self.assertRegex(self.sent(), r'tokiwa-run\.py status 20261112T183000-7f3a 0 ')

    def stub_sleep(self):
        """Make the launcher's one-second waits between polls instant."""
        sleep = self.home / '.local/lib/cloud-access/sleep'
        sleep.write_text('#!/bin/sh\nexit 0\n')
        sleep.chmod(0o755)

    def polls(self):
        return len([c for c in self.run_calls().splitlines() if 'get-command-invocation' in c and '--query Status' in c])

    def test_sealed_calls_poll_until_run_command_ends_them(self):
        # Run Command stops a call after 30 seconds, so 40 polls see the end of each sealed call.
        self.stub_sleep()
        self.env['TEST_STATUS'] = 'InProgress'
        cases = [(('run', 'review-pr', 'pr=42'), 40), (('run-status', '20261112T183000-7f3a'), 40),
                 (('capture', 'backend', '1:$2:3'), 40), (('agent', 'read', 'backend', '1:$2:3'), 40), (('status',), 15), (('commands',), 15)]
        for args, polls in cases:
            with self.subTest(args=args):
                (self.home / 'calls').unlink(missing_ok=True)
                self.assertNotEqual(self.run_cli(*args).returncode, 0)
                self.assertEqual(self.polls(), polls)

    def test_a_refusal_of_the_host_fails_with_its_own_line(self):
        self.env['TEST_STATUS'] = 'Failed'
        self.env['TEST_STDERR'] = 'The entry is not in the command list. Nothing was run.\n'
        for args in [('run', 'review-pr', 'pr=42'), ('run-status', '20261112T183000-7f3a'), ('commands',)]:
            with self.subTest(args=args):
                result = self.run_cli(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(result.stderr.endswith('Tokiwa: The entry is not in the command list. Nothing was run.\n'),
                                result.stderr)
                self.assertNotIn('returned', result.stderr)
                self.assertNotIn('A run may have started', result.stderr)
                # The whole stderr of the host is still shown.
                self.assertIn('failed to run commands: exit status 1\n', result.stderr)

    def test_a_run_call_that_did_not_end_may_have_started_a_run(self):
        self.stub_sleep()
        for status in ['TimedOut', 'Cancelled', 'InProgress']:
            with self.subTest(status=status):
                self.env['TEST_STATUS'] = status
                result = self.run_cli('run', 'review-pr', 'pr=42')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f'Tokiwa: The run call returned {status}. A run may have started: use tokiwa run-status with its id.',
                              result.stderr)
        # A Failed call without a refusal line: the runner can fail after systemd-run started the run.
        self.env['TEST_STATUS'] = 'Failed'
        self.env['TEST_STDERR'] = 'Traceback (most recent call last):\nOSError: [Errno 28] No space left on device\n'
        result = self.run_cli('run', 'review-pr', 'pr=42')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(result.stderr.endswith('Tokiwa: The run call returned Failed. A run may have started: '
                                               'use tokiwa run-status with its id.\n'), result.stderr)
        # Other modes keep their text for the same failure.
        self.assertIn('No service was started', self.run_cli('commands').stderr)

    def test_a_failed_run_status_call_changed_nothing(self):
        self.stub_sleep()
        for status in ['Failed', 'TimedOut', 'InProgress']:
            with self.subTest(status=status):
                self.env['TEST_STATUS'] = status
                result = self.run_cli('run-status', '20261112T183000-7f3a')
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(result.stderr.endswith(f'Tokiwa: The run-status call returned {status}. Nothing was changed.\n'),
                                result.stderr)
                self.assertNotIn('may have started', result.stderr)

    def test_a_value_with_shell_characters_reaches_the_host_only_in_the_payload(self):
        result = self.run_cli('run', 'review-pr', 'pr=$(id);x')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('$(', self.sent())
        self.assertNotIn(';x', self.sent())
        self.assertEqual(self.run_payload(), {'entry': 'review-pr', 'args': {'pr': '$(id);x'}})

    def test_help_names_each_class_of_mcp(self):
        self.assertIn('mcp [--allow control,run,commands,answer] [--actor NAME]', self.run_cli('--help').stdout)

    def test_commands_is_plain(self):
        result = self.run_cli('commands')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(self.sent(), r'tokiwa-run\.py commands(?!\s+[A-Za-z0-9+/=])')
        self.assertFalse((self.home / 'recipient.pem').exists())


class Copy(unittest.TestCase):
    """`tokiwa cp` moves one file or directory through the bucket and deletes the object on every exit."""

    # The stand-in AWS CLI and the runner of TerminalCLI, without running its tests again here.
    tearDown = TerminalCLI.tearDown
    run_cli = TerminalCLI.run_cli
    s3_calls = TerminalCLI.s3_calls

    def setUp(self):
        TerminalCLI.setUp(self)
        with open(self.home / '.config/tokiwa/host.env', 'a') as config:
            config.write('paste_bucket=example-bucket\n')
        self.local = self.home / 'local'
        self.local.mkdir()

    def call_lines(self):
        path = self.home / 'calls'
        return path.read_text().splitlines() if path.exists() else []

    def send_line(self):
        return [line for line in self.call_lines() if 'send-command' in line][-1]

    def deleted_key(self):
        deletes = [line for line in self.call_lines() if 'delete-object' in line or ' s3 rm ' in line]
        self.assertEqual(len(deletes), 1, deletes)
        return deletes[0]

    def remote(self, data, report):
        (self.home / 'remote-fixture').write_bytes(data)
        report = dict(report, bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        (self.home / 'remote-report.json').write_text(json.dumps(report))

    def test_upload_of_a_file_streams_it_runs_the_root_pipe_and_deletes_the_object(self):
        source = self.local / 'report.txt'
        source.write_bytes(b'report bytes')
        source.chmod(0o640)
        result = self.run_cli('cp', str(source), 'lead:docs/')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.home / 'uploaded').read_bytes(), b'report bytes')
        upload = [line for line in self.call_lines() if ' s3 cp - ' in line][0]
        key = re.search(r's3://example-bucket/(inputs/transfers/[0-9a-f]{32}) ', upload).group(1)
        send = self.send_line()
        sha = hashlib.sha256(b'report bytes').hexdigest()
        self.assertIn(f'tokiwa-s3-pipe.py get us-east-1 example-bucket {key} -- sudo -n runuser -u agent-workspace', send)
        self.assertIn(f'terminal-session.sh transfer-in lead:docs/ file report.txt {sha} 12 640 0', send)
        self.assertIn('"executionTimeout": ["120"]', send)
        self.assertIn(f'delete-object --bucket example-bucket --key {key} --version-id v123', self.deleted_key())
        self.assertEqual(result.stdout,
                         f'Copied 1 file, 12 bytes, to host:/srv/development/cache/sessions/lead/tmp/a.txt (sha256 {sha[:12]}).\n')

    def test_upload_of_a_directory_sends_a_tar_stream_and_json_on_request(self):
        top = self.local / 'fixtures'
        (top / 'sub').mkdir(parents=True)
        (top / 'sub/a.txt').write_bytes(b'a')
        result = self.run_cli('cp', '--json', str(top), 'host:/srv/development/cache/sessions/lead/tmp/')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['files'], 1)
        with tarfile.open(self.home / 'uploaded') as archive:
            self.assertEqual(sorted(m.name for m in archive.getmembers()), ['fixtures', 'fixtures/sub', 'fixtures/sub/a.txt'])
            self.assertTrue(all(m.uid == 0 and m.uname == '' for m in archive.getmembers()))
        # host:/PATH reaches the host as the absolute path alone.
        self.assertIn(' transfer-in /srv/development/cache/sessions/lead/tmp/ dir fixtures ', self.send_line())

    def test_upload_refused_by_the_host_passes_the_sentence_and_deletes_the_object(self):
        source = self.local / 'a.txt'
        source.write_bytes(b'x')
        self.env.update(TEST_STATUS='Failed',
                        TEST_STDERR='The path is outside the workbench folder and the session cache. Nothing was copied.')
        result = self.run_cli('cp', str(source), 'host:/etc/a.txt')
        self.assertEqual(result.returncode, 1)
        self.assertIn('outside the workbench folder', result.stderr)
        self.assertIn('inputs/transfers/', self.deleted_key())

    def test_upload_fails_when_the_host_reports_another_sha256(self):
        source = self.local / 'a.txt'
        source.write_bytes(b'x')
        self.env.update(TEST_REPORTED_SHA='0' * 64)
        result = self.run_cli('cp', str(source), 'lead:')
        self.assertEqual(result.returncode, 1)
        self.assertIn('different SHA-256', result.stderr)

    def test_upload_refuses_a_missing_source_before_any_s3_call(self):
        result = self.run_cli('cp', str(self.local / 'missing'), 'lead:')
        self.assertEqual(result.returncode, 1)
        self.assertIn('does not exist', result.stderr)
        self.assertEqual(self.s3_calls(), [])

    def test_download_of_a_file_checks_it_places_it_and_deletes_the_object(self):
        self.remote(b'{"ok": true}', {'kind': 'file', 'name': 'out.json', 'files': 1, 'mode': 0o600})
        result = self.run_cli('cp', 'lead:out/out.json', str(self.local))
        self.assertEqual(result.returncode, 0, result.stderr)
        target = self.local / 'out.json'
        self.assertEqual(target.read_bytes(), b'{"ok": true}')
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        send = self.send_line()
        key = re.search(r'tokiwa-s3-pipe\.py put us-east-1 example-bucket (results/transfers/[0-9a-f]{32}) -- ', send).group(1)
        self.assertIn('terminal-session.sh transfer-out lead:out/out.json', send)
        self.assertIn(f'--key {key} --version-id v123', self.deleted_key())
        self.assertEqual([p.name for p in self.local.iterdir()], ['out.json'])

    def test_download_keeps_an_existing_file_unless_forced(self):
        self.remote(b'new', {'kind': 'file', 'name': 'a.txt', 'files': 1, 'mode': 0o644})
        target = self.local / 'a.txt'
        target.write_bytes(b'old')
        result = self.run_cli('cp', 'lead:a.txt', str(target))
        self.assertEqual(result.returncode, 1)
        self.assertIn('Use --force to replace it', result.stderr)
        self.assertEqual(target.read_bytes(), b'old')
        self.assertEqual(self.run_cli('cp', '--force', 'lead:a.txt', str(target)).returncode, 0)
        self.assertEqual(target.read_bytes(), b'new')

    def test_download_that_does_not_match_leaves_nothing(self):
        self.remote(b'right', {'kind': 'file', 'name': 'a.txt', 'files': 1, 'mode': 0o644})
        (self.home / 'remote-fixture').write_bytes(b'wrong')
        result = self.run_cli('cp', 'lead:a.txt', str(self.local))
        self.assertEqual(result.returncode, 1)
        self.assertIn('does not match the source', result.stderr)
        self.assertEqual(list(self.local.iterdir()), [])
        self.assertIn('results/transfers/', self.deleted_key())

    def test_download_of_a_directory_unpacks_it(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w', format=tarfile.PAX_FORMAT) as archive:
            for name, data in (('results', None), ('results/a.txt', b'a')):
                info = tarfile.TarInfo(name)
                if data is None:
                    info.type, info.mode = tarfile.DIRTYPE, 0o755
                    archive.addfile(info)
                else:
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
        self.remote(buffer.getvalue(), {'kind': 'dir', 'name': 'results', 'files': 2, 'mode': 0o755})
        result = self.run_cli('cp', 'lead:results', str(self.local))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.local / 'results/a.txt').read_bytes(), b'a')
        self.assertEqual([p.name for p in self.local.iterdir()], ['results'])

    def run_in(self, folder, *args):
        return subprocess.run(['bash', str(CLI), *args], check=False, env=self.env, capture_output=True,
                              text=True, timeout=30, cwd=folder)

    def test_relative_local_paths_are_relative_to_the_current_folder(self):
        (self.local / 'here.txt').write_bytes(b'from the current folder')
        (self.home / 'here.txt').write_bytes(b'from home')
        result = self.run_in(self.local, 'cp', 'here.txt', 'lead:')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.home / 'uploaded').read_bytes(), b'from the current folder')
        self.remote(b'down', {'kind': 'file', 'name': 'down.txt', 'files': 1, 'mode': 0o644})
        self.assertEqual(self.run_in(self.local, 'cp', 'lead:down.txt', '.').returncode, 0)
        self.assertEqual((self.local / 'down.txt').read_bytes(), b'down')
        self.assertFalse((self.home / 'down.txt').exists())

    def tar_of(self, entries):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w', format=tarfile.PAX_FORMAT) as archive:
            for name, kind, linkname in entries:
                info = tarfile.TarInfo(name)
                info.type, info.linkname, info.mode = kind, linkname, 0o755
                archive.addfile(info)
        return buffer.getvalue()

    def test_download_refuses_links_that_leave_the_copied_tree(self):
        (self.local / 'secretdir').mkdir()
        for linkname in ('../secretdir', '/etc'):
            with self.subTest(linkname=linkname):
                data = self.tar_of([('results', tarfile.DIRTYPE, ''), ('results/esc', tarfile.SYMTYPE, linkname)])
                self.remote(data, {'kind': 'dir', 'name': 'results', 'files': 2, 'mode': 0o755})
                result = self.run_cli('cp', 'lead:results', str(self.local))
                self.assertEqual(result.returncode, 1)
                self.assertIn('outside results', result.stderr)
                self.assertEqual(sorted(p.name for p in self.local.iterdir()), ['secretdir'])

    def test_download_refuses_a_size_over_the_limit_before_it_downloads(self):
        self.remote(b'x', {'kind': 'file', 'name': 'big', 'files': 1, 'mode': 0o644})
        report = json.loads((self.home / 'remote-report.json').read_text())
        report['bytes'] = 11 * 1024**3
        (self.home / 'remote-report.json').write_text(json.dumps(report))
        result = self.run_cli('cp', 'lead:big', str(self.local))
        self.assertEqual(result.returncode, 1)
        self.assertIn('at most 10 GB', result.stderr)
        self.assertEqual([line for line in self.call_lines() if ' s3 cp s3://' in line], [])

    def test_download_into_a_missing_folder_with_a_slash_is_refused(self):
        self.remote(b'x', {'kind': 'file', 'name': 'a.txt', 'files': 1, 'mode': 0o644})
        result = self.run_cli('cp', 'lead:a.txt', f'{self.local}/missing/')
        self.assertEqual(result.returncode, 1)
        self.assertIn('does not exist', result.stderr)
        self.assertEqual(list(self.local.iterdir()), [])

    def test_usage_errors_make_no_aws_call(self):
        cases = [
            ('cp',), ('cp', 'a'), ('cp', 'a', 'b'), ('cp', 'lead:a', 'host:/b'), ('cp', '--bad', 'a', 'lead:'),
            ('cp', 'a', 'lead:', 'extra'),
        ]
        for args in cases:
            with self.subTest(args=args):
                result = self.run_cli(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('cp', result.stderr)
        self.assertEqual(self.call_lines(), [])

    def test_without_a_bucket_it_says_how_to_set_it_up(self):
        config = self.home / '.config/tokiwa/host.env'
        config.write_text(config.read_text().replace('paste_bucket=example-bucket\n', ''))
        result = self.run_cli('cp', 'a', 'lead:')
        self.assertEqual(result.returncode, 1)
        self.assertIn('File transfer is not set up. Set paste_bucket=', result.stderr)


if __name__ == '__main__':
    unittest.main()
