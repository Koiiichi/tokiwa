"""tokiwa-open writes a link request to its terminal for Tokiwa on the Mac."""
import base64
import os
import pty
import subprocess
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parents[1] / 'tokiwa-open'
URL = 'https://github.com/openai/codex/releases/latest'


def run_in_terminal(env, *args):
    """Run the helper with a terminal of its own and return its exit code and the bytes it wrote."""
    pid, fd = pty.fork()
    if pid == 0:
        os.execve('/bin/sh', ['/bin/sh', str(HELPER), *args], env)
    output = b''
    while True:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status), output


class TokiwaOpen(unittest.TestCase):
    def setUp(self):
        self.env = {'PATH': os.environ['PATH']}
        self.code = base64.b64encode(URL.encode()).decode()

    def test_writes_the_request_to_its_terminal(self):
        status, output = run_in_terminal(self.env, URL)
        self.assertEqual(status, 0)
        self.assertEqual(output, f'\x1b]7717;open;{self.code}\x07'.encode())

    def test_inside_tmux_the_request_is_a_passthrough(self):
        status, output = run_in_terminal({**self.env, 'TMUX': '/tmp/s,1,0'}, URL)
        self.assertEqual(status, 0)
        self.assertEqual(output, f'\x1bPtmux;\x1b\x1b]7717;open;{self.code}\x07\x1b\\'.encode())

    def test_only_web_links_are_sent(self):
        for link in ['file:///etc/passwd', 'javascript:alert(1)', '']:
            result = subprocess.run(['/bin/sh', str(HELPER), link], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2, link)
            self.assertIn('only http and https', result.stderr)


if __name__ == '__main__':
    unittest.main()
