"""Check install.sh in --dry-run with stand-in system commands: a fresh host and an installed one."""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Each stand-in answers as a fresh Ubuntu host, or as an installed one when TEST_INSTALLED=1.
STUBS = {
    'id': '''case "$*" in
 -u) echo 1000 ;;
 "-u agent-workspace") echo "${TEST_WORKSPACE_UID:-2100}" ;;
 "-u cloud-containers") echo 2200 ;;
 agent-workspace|cloud-containers) [ -n "$TEST_INSTALLED" ] || [ -n "$TEST_WORKSPACE_UID" ] ;;
 *) exit 1 ;;
esac''',
    'getent': 'exit 2',
    'dpkg-query': '[ -n "$TEST_INSTALLED" ] && printf "install ok installed" || printf "unknown"',
    'stat': '[ "$*" = "-fc %T /sys/fs/cgroup" ] && echo cgroup2fs || exit 1',
    'nft': '[ -n "$TEST_INSTALLED" ]',
    'systemctl': 'case "$1" in is-active) [ -n "$TEST_INSTALLED" ] ;; *) exit 0 ;; esac',
    'mountpoint': '[ -n "$TEST_INSTALLED" ]',
    # Like df, fail for a path that does not exist.
    'df': 'for a; do p=$a; done; [ -e "$p" ] || { echo "df: $p: No such file or directory" >&2; exit 1; }; printf "Avail\\n40000000000\\n"',
}


class HostInstall(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        fakes = root / 'bin'
        fakes.mkdir()
        for name, body in STUBS.items():
            (fakes / name).write_text('#!/bin/sh\n' + body + '\n')
            (fakes / name).chmod(0o755)
        check = root / 'check'
        (check / 'etc').mkdir(parents=True)
        (check / 'etc/os-release').write_text('ID=ubuntu\nPRETTY_NAME="Ubuntu 24.04 LTS"\n')
        (check / 'run/systemd/system').mkdir(parents=True)
        self.env = dict(os.environ, PATH=f'{fakes}:/usr/bin:/bin', TOKIWA_INSTALL_CHECK_ROOT=str(check))

    def tearDown(self):
        self.temp.cleanup()

    def install(self, *args, **env):
        return subprocess.run(['bash', str(ROOT / 'install.sh'), '--dry-run', *args], env=dict(self.env, **env),
                              capture_output=True, text=True, timeout=60)

    def test_a_fresh_host_gets_the_core(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        out = result.stdout
        self.assertIn('would run: apt-get install -y -qq --no-install-recommends tmux python3 acl nftables openssl', out)
        self.assertIn('would run: useradd --uid 2100 --user-group --no-create-home --shell /bin/bash agent-workspace', out)
        self.assertIn('/opt/agent-platform/rootless/terminal-session.sh', out)
        self.assertIn('/etc/systemd/system/cloud-workbench.service', out)
        self.assertIn('include "/opt/agent-platform/rootless/workspace-metadata.nft"', out)
        self.assertIn('would run: systemctl start cloud-workbench.service', out)
        self.assertNotIn('docker', out.lower().replace('dry run', ''))
        self.assertIn('nothing changed', out)

    def test_with_docker_adds_the_engine_and_the_socket_drop_in(self):
        out = self.install('--with-docker').stdout
        self.assertIn('docker.io docker-compose-v2 rootlesskit slirp4netns uidmap', out)
        self.assertIn('would run: useradd --uid 2200 --gid 2200', out)
        self.assertIn('would run: truncate -s 24G /srv/development/cache/rootless-engine.ext4', out)
        self.assertIn('/etc/systemd/system/cloud-workbench.service.d/docker.conf', out)
        self.assertIn('/etc/systemd/system/cloud-workbench-docker-wait.service', out)
        self.assertIn('would run: loginctl enable-linger cloud-containers', out)
        self.assertIn('would run: systemctl start user@2200.service', out)

    def test_an_installed_host_keeps_its_running_service(self):
        out = self.install(TEST_INSTALLED='1').stdout
        self.assertNotIn('apt-get', out)
        self.assertNotIn('useradd', out)
        self.assertNotIn('include "', out)
        self.assertNotIn('systemctl start cloud-workbench.service', out)
        self.assertNotIn('restart', out.replace('was not restarted', ''))
        self.assertIn('is running and was not restarted', out)

    def test_refuses_a_conflicting_user_and_other_systems(self):
        result = self.install(TEST_WORKSPACE_UID='3000')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('UID other than 2100', result.stderr)
        os_release = Path(self.env['TOKIWA_INSTALL_CHECK_ROOT']) / 'etc/os-release'
        os_release.write_text('ID=fedora\n')
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('supports Ubuntu', result.stderr)

    def test_without_dry_run_it_needs_root(self):
        result = subprocess.run(['bash', str(ROOT / 'install.sh')], env=self.env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Run as root', result.stderr)


if __name__ == '__main__':
    unittest.main()
