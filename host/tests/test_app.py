"""Check application connection lifecycle before native database qualification."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch
spec=importlib.util.spec_from_file_location('fixture_app',Path(__file__).resolve().parents[1]/'compose/app.py');app=importlib.util.module_from_spec(spec);spec.loader.exec_module(app)

class ApplicationTests(unittest.TestCase):
    def test_health_uses_one_database_connection(self):
        db=MagicMock();db.__enter__.return_value=db;cache=MagicMock();cache.ping.return_value=True
        with patch.object(app,'databases',return_value=(db,cache)) as connect:
            self.assertEqual(app.operation('GET','/health'),(200,{'postgres':True,'redis':True}));connect.assert_called_once();db.__exit__.assert_called_once()
    def test_unknown_route_does_not_open_databases(self):
        with patch.object(app,'databases') as connect:self.assertEqual(app.operation('GET','/missing')[0],404);connect.assert_not_called()
