"""Keep provider configuration inside the independent private workbench home."""
from pathlib import Path
import unittest
import subprocess

ROOT = Path(__file__).resolve().parents[1]
HOME = '/srv/development/private/homes/workbench'

class WorkbenchPaths(unittest.TestCase):
    def test_configuration_is_independent(self):
        unit = (ROOT / 'units/cloud-workbench.service').read_text()
        self.assertIn('Environment=CLAUDE_CONFIG_DIR=' + HOME + '/.claude', unit)
        self.assertIn('Environment=CODEX_HOME=' + HOME + '/.codex', unit)
        self.assertNotIn('acceptance-', unit)
        self.assertNotIn('/homes/acceptance/', unit)

    def test_writes_have_declared_existing_roots(self):
        unit = (ROOT / 'units/cloud-workbench.service').read_text()
        writes = next(line.split('=', 1)[1].split() for line in unit.splitlines() if line.startswith('ReadWritePaths='))
        self.assertEqual(set(writes), {'/srv/development/state/workspaces/workbench', HOME, '/srv/development/private/peermesh'})
        install = (ROOT / 'install.sh').read_text()
        self.assertIn('home=' + HOME + '\n', install)
        for folder in ('"$home"', '"$home/.claude"', '"$home/.codex"'):
            self.assertIn('agent-workspace agent-workspace 700 ' + folder, install)

    def test_provider_homes_are_not_source_mounts(self):
        installer = (ROOT / 'install.sh').read_text()
        for line in installer.splitlines():
            if line.startswith('setfacl'):
                self.assertNotIn('/private/', line)

class RootlessServicePath(unittest.TestCase):
    def test_official_launcher_can_find_system_administration_tools(self):
        unit = (ROOT / 'units/docker.service').read_text()
        path = next(line.split('=', 2)[2] for line in unit.splitlines() if line.startswith('Environment=PATH='))
        result = subprocess.run(['/bin/sh', '-c', 'command -v sysctl'], env={'PATH': path}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.strip().startswith(('/usr/sbin/', '/sbin/')))

class WorkbenchLauncher(unittest.TestCase):
    def test_login_routes_cannot_touch_acceptance_homes(self):
        source = (ROOT.parent / 'bin/tokiwa').read_text()
        self.assertNotIn('acceptance auth', source)
        self.assertNotIn('auth-team)', source)
        self.assertIn('claude auth login', source)
        self.assertIn('codex login', source)

class NativeEngineContract(unittest.TestCase):
    def test_long_lived_child_can_notify_without_automatic_retry(self):
        unit = (ROOT / 'units/docker.service').read_text()
        self.assertIn('NotifyAccess=all\n', unit)
        self.assertIn('Restart=no\n', unit)
        self.assertIn('Type=notify\n', unit)
        self.assertIn('ExecStartPost=/usr/bin/setfacl', unit)

    def test_native_slice_preserves_rootless_manager_limits(self):
        manager = (ROOT / 'units/user-manager.conf').read_text()
        self.assertIn('Slice=user-2200.slice\n', manager)
        self.assertIn('Delegate=cpu cpuset io memory pids\n', manager)
        self.assertIn('MemoryMax=8G\n', manager)
        self.assertIn('CPUQuota=300%\n', manager)
        self.assertIn('Requires=user-2200.slice\n', manager)
        self.assertIn('nftables.service user-2200.slice\n', manager)
        discovery = (ROOT / 'units/user-2200.slice').read_text()
        self.assertIn('CPUWeight=100\n', discovery)
        self.assertIn('StopWhenUnneeded=yes\n', discovery)
        self.assertNotIn('ExecStart', discovery)
        self.assertIn('user-2200.slice', (ROOT / 'install.sh').read_text())


class SocketVisibility(unittest.TestCase):
    def test_only_rootless_socket_is_exposed_with_home_protection(self):
        source = (ROOT / 'units/cloud-workbench.service').read_text()
        docker = (ROOT / 'units/cloud-workbench-docker.conf').read_text()
        self.assertIn('ProtectHome=yes\n', source)
        # The base unit has no Docker; the drop-in of --with-docker adds only the read-only socket.
        self.assertNotIn('docker.sock:', source)
        self.assertIn('BindReadOnlyPaths=/run/user/2200/docker.sock:/run/cloud-workbench/docker.sock\n', docker)
        self.assertIn('InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock', source)
        self.assertNotIn('BindPaths=', source)
        self.assertIn('Environment=DOCKER_HOST=unix:///run/cloud-workbench/docker.sock\n', docker)
        self.assertIn('export DOCKER_HOST=unix:///run/cloud-workbench/docker.sock\n', (ROOT / 'compose/lib.sh').read_text())

if __name__ == '__main__':
    unittest.main()


class WorkbenchTmuxOptions(unittest.TestCase):
    def test_start_sets_mouse_and_clipboard_options_before_the_first_session(self):
        """The server starts with -f /dev/null; the start script sets the options that viewers need."""
        import shutil, tempfile, time
        tmux = shutil.which('tmux')
        if not tmux:
            self.skipTest('tmux is not installed')
        with tempfile.TemporaryDirectory(dir='/tmp') as folder:
            socket = folder + '/s'
            source = (ROOT / 'start-workbench.sh').read_text()
            source = source.replace('/run/cloud-workbench/tmux.sock', socket).replace('/usr/bin/tmux', tmux)
            source = source.replace('/srv/development/state/workspaces/workbench', folder)
            script = Path(folder) / 'start.sh'
            script.write_text(source)
            subprocess.run([tmux, '-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'seed'], check=True)
            try:
                subprocess.run(['bash', str(script)], check=True, timeout=20)
                show = lambda *args: subprocess.run([tmux, '-S', socket, 'show', *args], capture_output=True, text=True).stdout.strip()
                self.assertEqual(show('-gv', 'mouse'), 'on')
                self.assertEqual(show('-sv', 'set-clipboard'), 'on')
                self.assertEqual(show('-gv', 'allow-passthrough'), 'on')
                self.assertEqual(show('-gwv', 'window-size'), 'latest')
                browser = subprocess.run([tmux, '-S', socket, 'show-environment', '-g', 'BROWSER'], capture_output=True, text=True).stdout.strip()
                self.assertEqual(browser, 'BROWSER=/opt/agent-platform/rootless/tokiwa-open')
                sessions = subprocess.run([tmux, '-S', socket, 'list-sessions', '-F', '#{session_name}'], capture_output=True, text=True).stdout.split()
                self.assertIn('workbench', sessions)
                for _ in range(100):
                    screen = subprocess.run([tmux, '-S', socket, 'capture-pane', '-p', '-t', '=workbench:'], capture_output=True, text=True).stdout
                    if 'tokiwa:' in screen:
                        break
                    time.sleep(.05)
                self.assertIn('tokiwa:', screen)
            finally:
                subprocess.run([tmux, '-S', socket, 'kill-server'], check=False)
