"""Check the acceptance project's intended boundaries without a Docker daemon."""
import json
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]

class ComposeContract(unittest.TestCase):
    def setUp(self):self.spec=json.loads((ROOT/'compose/compose.json').read_text())
    def test_has_real_application_database_and_cache(self):self.assertEqual(set(self.spec['services']),{'app','postgres','redis'})
    def test_no_privileged_or_host_socket(self):
        for service in self.spec['services'].values():
            self.assertFalse(service.get('privileged'));self.assertNotEqual(service.get('network_mode'),'host');self.assertNotIn('docker.sock',json.dumps(service));self.assertNotIn('devices',service)
    def test_database_ports_are_private(self):
        self.assertNotIn('ports',self.spec['services']['postgres']);self.assertNotIn('ports',self.spec['services']['redis']);self.assertTrue(self.spec['services']['app']['ports'][0].startswith('127.0.0.1:'))
    def test_each_service_has_limits(self):
        for s in self.spec['services'].values():self.assertGreater(s['cpus'],0);self.assertLessEqual(s['pids_limit'],128);self.assertIn('mem_limit',s)
    def test_named_volumes_and_persistence_are_enabled(self):
        self.assertEqual(set(self.spec['volumes']),{'pgdata','redisdata','receipts'});self.assertIn('--appendonly',self.spec['services']['redis']['command'])
    def test_registry_images_are_pinned(self):
        for name in ['postgres','redis']:self.assertRegex(self.spec['services'][name]['image'],r'@sha256:[a-f0-9]{64}$')
        self.assertIn('@sha256:',self.spec['services']['app']['build']['args']['BASE'])
    def test_build_copies_only_fixture_sources(self):
        self.assertTrue((ROOT/'compose/.dockerignore').read_text().startswith('*\n'));self.assertNotIn('COPY . ',(ROOT/'compose/Dockerfile').read_text())
    def test_private_staging_modes_do_not_hide_public_app_sources(self):
        import re
        import subprocess
        import tempfile
        dockerfile = (ROOT/'compose/Dockerfile').read_text()
        command = re.search(r'^RUN (chmod 0644 /app/app.py /app/integration.py /app/independence.py)$', dockerfile, re.M)
        self.assertIsNotNone(command, 'The image must normalize public fixture file modes.')
        self.assertLess(command.start(), dockerfile.index('USER 1000:1000'))
        with tempfile.TemporaryDirectory() as directory:
            for name in ('app.py', 'integration.py', 'independence.py'):
                path = Path(directory)/name; path.write_text('synthetic fixture'); path.chmod(0o600)
            subprocess.run(command.group(1).replace('/app/', directory+'/').split(), check=True)
            for path in Path(directory).iterdir():
                self.assertEqual(path.stat().st_mode & 0o777, 0o644)
                self.assertEqual(path.read_text(), 'synthetic fixture')

    def test_dependencies_have_hashes(self):
        for line in (ROOT/'compose/requirements.lock').read_text().splitlines():self.assertIn('==',line);self.assertIn('--hash=sha256:',line)

if __name__=='__main__':unittest.main()
