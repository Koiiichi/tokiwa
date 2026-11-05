"""Check install.sh with a stand-in npm and Bun. Nothing is downloaded and the real ~/.local is not touched."""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / 'install.sh'
REPO = HERE.parent

# npm ci: create the pinned Bun binary as a stand-in that logs its arguments and exits with TEST_BUN_EXIT.
FAKE_NPM = ('#!/bin/bash\necho "npm $*" >> "$TEST_LOG"\n'
            'mkdir -p node_modules/bun/bin\n'
            'printf "#!/bin/bash\\necho \\"bun \\$*\\" >> \\"\\$TEST_LOG\\"\\nexit \\"\\${TEST_BUN_EXIT:-0}\\"\\n"'
            ' > node_modules/bun/bin/bun.exe\n'
            'chmod +x node_modules/bun/bin/bun.exe\n')


class Install(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        fakes = self.root / 'fakes'
        fakes.mkdir()
        (fakes / 'npm').write_text(FAKE_NPM)
        (fakes / 'npm').chmod(0o755)
        self.app = self.root / 'lib/tokiwa/opentui'
        self.log = self.root / 'log'
        self.env = dict(os.environ, PATH=f'{fakes}:/usr/bin:/bin', TOKIWA_APP_DIR=str(self.app),
                        TEST_LOG=str(self.log))

    def tearDown(self):
        self.temp.cleanup()

    def install(self, *args, **env):
        return subprocess.run(['bash', str(SCRIPT), *args], env=dict(self.env, **env), capture_output=True,
                              text=True, timeout=120, cwd=REPO)

    def test_installs_a_committed_copy_with_pinned_dependencies(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertTrue(os.access(self.app / 'run', os.X_OK))
        self.assertIn('/app/run', (self.app / 'run').read_text())
        self.assertTrue((self.app / 'app/app.ts').is_file())
        self.assertTrue((self.app / 'app/package-lock.json').is_file())
        log = self.log.read_text()
        self.assertIn('npm ci --omit=dev --no-fund --no-audit', log)
        self.assertIn('bun -e await import("./app.ts")', log)
        self.assertTrue((self.app / 'INSTALLED').read_text().startswith('commit '))

    def test_second_install_keeps_the_previous_copy(self):
        self.assertEqual(self.install().returncode, 0)
        (self.app / 'marker').write_text('first')
        self.assertEqual(self.install().returncode, 0)
        self.assertEqual((self.app.with_name('opentui.previous') / 'marker').read_text(), 'first')
        self.assertFalse((self.app / 'marker').exists())

    def test_rollback_restores_the_previous_copy(self):
        self.assertEqual(self.install().returncode, 0)
        (self.app / 'marker').write_text('first')
        self.assertEqual(self.install().returncode, 0)
        result = self.install('--rollback')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.app / 'marker').read_text(), 'first')

    def test_failed_start_check_leaves_the_installed_copy(self):
        self.assertEqual(self.install().returncode, 0)
        (self.app / 'marker').write_text('first')
        result = self.install(TEST_BUN_EXIT='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('start check', result.stderr)
        self.assertEqual((self.app / 'marker').read_text(), 'first')
        self.assertFalse(self.app.with_name('opentui.new').exists())


class StrayDependencyLink(unittest.TestCase):
    def test_a_committed_node_modules_link_never_reaches_npm(self):
        """A node_modules link in the committed folder must not let npm ci empty the folder it names."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo, ui = root / 'repo', root / 'repo/app'
            ui.mkdir(parents=True)
            for name in ('package-lock.json', 'app.ts'):
                (ui / name).write_text('{}' if name.endswith('json') else '')
            (ui / 'run').write_text('#!/bin/sh\n')
            (ui / 'run').chmod(0o755)
            (ui / 'install.sh').write_text(SCRIPT.read_text())
            decoy = root / 'other-worktree-node_modules'
            decoy.mkdir()
            (decoy / 'keep').write_text('owner files')
            (ui / 'node_modules').symlink_to(decoy)
            git = ['git', '-C', str(repo), '-c', 'user.name=t', '-c', 'user.email=t@t']
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            subprocess.run(git + ['add', '-A'], check=True)
            subprocess.run(git + ['commit', '-q', '-m', 'fixture'], check=True)
            fakes = root / 'fakes'
            fakes.mkdir()
            # A stand-in npm ci that, like the real one, removes node_modules first, then installs.
            (fakes / 'npm').write_text('#!/bin/bash\nrm -rf node_modules/* 2>/dev/null; rm -rf node_modules\n'
                                       + FAKE_NPM.split('\n', 2)[2])
            (fakes / 'npm').chmod(0o755)
            app = root / 'lib/tokiwa/opentui'
            env = dict(os.environ, PATH=f'{fakes}:/usr/bin:/bin', TOKIWA_APP_DIR=str(app),
                       TEST_LOG=str(root / 'log'))
            result = subprocess.run(['bash', str(ui / 'install.sh')], env=env, capture_output=True, text=True,
                                    timeout=120, cwd=repo)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertEqual((decoy / 'keep').read_text(), 'owner files')
            self.assertFalse((app / 'app/node_modules').is_symlink())


if __name__ == '__main__':
    unittest.main()
