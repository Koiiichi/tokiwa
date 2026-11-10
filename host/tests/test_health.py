"""Test Linux resource metric calculations without host changes."""

import importlib.util
import tempfile
import unittest
from collections import namedtuple
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location(
    "health", Path(__file__).resolve().parents[1] / "workbench-health.py"
)
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


class HealthTests(unittest.TestCase):
    def test_cpu_avoids_double_counting_guest_time(self):
        self.assertEqual(health.cpu_counters("cpu 10 2 3 80 5 0 0 0 7 1\n"), (100, 85))

    def test_available_memory_and_units(self):
        values = health.memory_values("MemTotal: 1048576 kB\nMemAvailable: 524288 kB\n")
        self.assertEqual(health.gib(values["MemTotal"]), "1.0 GiB")
        self.assertEqual(health.gib(values["MemAvailable"]), "0.5 GiB")

    def test_limit_values_read_max_as_unlimited(self):
        self.assertIsNone(health.limit("max\n"))
        self.assertEqual(health.limit("25769803776\n"), 25769803776)

    def test_cpu_quota_in_cores(self):
        self.assertEqual(health.quota_cores("600000 100000\n"), 6.0)
        self.assertIsNone(health.quota_cores("max 100000\n"))

    def test_primary_interface_has_the_default_route(self):
        route = (
            "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n"
            "docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\n"
            "ens5\t00000000\t0100000A\t0003\t0\t0\t100\t00000000\n"
        )
        self.assertEqual(health.primary_interface(route), "ens5")
        with self.assertRaises(ValueError):
            health.primary_interface(route.splitlines()[0] + "\n")

    def test_interface_counters_are_received_and_sent_bytes(self):
        dev = (
            "Inter-|   Receive |  Transmit\n"
            " face |bytes packets errs drop fifo frame compressed multicast|bytes\n"
            "    lo: 900 9 0 0 0 0 0 0 900 9 0 0 0 0 0 0\n"
            "  ens5: 5000 40 0 0 0 0 0 0 7000 50 0 0 0 0 0 0\n"
        )
        self.assertEqual(health.interface_bytes(dev, "ens5"), (5000, 7000))
        with self.assertRaises(KeyError):
            health.interface_bytes(dev, "eth9")


Usage = namedtuple("Usage", "total used free")


class CollectTests(unittest.TestCase):
    """Run collect() against a fake /proc and cgroup tree."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.proc = root / "proc"
        (self.proc / "net").mkdir(parents=True)
        (self.proc / "stat").write_text("cpu 10 0 10 80 0 0 0 0 0 0\n")
        (self.proc / "meminfo").write_text(
            "MemTotal: 1048576 kB\nMemAvailable: 524288 kB\n"
        )
        (self.proc / "loadavg").write_text("0.10 0.20 0.30 1/100 42\n")
        (self.proc / "uptime").write_text("273600.25 900000.00\n")
        (self.proc / "net/route").write_text(
            "Iface\tDestination\tGateway\nens5\t00000000\t0100000A\n"
        )
        (self.proc / "net/dev").write_text(
            "h1\nh2\n  ens5: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n"
        )
        self.group = root / "workbench"
        self.group.mkdir()
        for name, value in {
            "cpu.stat": "usage_usec 1000000\n",
            "cpu.max": "600000 100000\n",
            "memory.current": str(6 * 1024**3),
            "memory.max": str(24 * 1024**3),
            "memory.swap.max": "0",
            "pids.current": "212",
            "pids.max": "4096",
        }.items():
            (self.group / name).write_text(value)

    def tearDown(self):
        self.temp.cleanup()

    def collect(self):
        slept = []

        def advance(seconds):
            # The CPU, cgroup and network counters advance during the sample window.
            slept.append(seconds)
            (self.proc / "stat").write_text("cpu 35 0 35 130 0 0 0 0 0 0\n")
            (self.group / "cpu.stat").write_text("usage_usec 2500000\n")
            (self.proc / "net/dev").write_text(
                "h1\nh2\n  ens5: 3000 0 0 0 0 0 0 0 2500 0 0 0 0 0 0 0\n"
            )

        with (
            mock.patch.object(health, "PROC", self.proc),
            mock.patch.object(health, "unit", lambda name: ("active", self.group)),
            mock.patch.object(health.time, "sleep", advance),
            mock.patch.object(
                health.time, "monotonic", lambda: 101.0 if slept else 100.0
            ),
            mock.patch.object(
                health.shutil,
                "disk_usage",
                lambda path: Usage(100 * 1024**3, 40 * 1024**3, 55 * 1024**3),
            ),
        ):
            return health.collect()

    def test_existing_fields_remain_for_older_readers(self):
        sample = self.collect()
        self.assertEqual(
            set(sample) - {"host"}, {"sampled_at", "rows", "errors", "metrics"}
        )
        self.assertEqual(sample["metrics"]["cpu_percent"], 50.0)
        rows = dict(sample["rows"])
        self.assertEqual(rows["Root disk"], "55.0 GiB free / 100.0 GiB")
        self.assertEqual(rows["Workbench RAM"], "6.0 GiB / 24.0 GiB")
        self.assertEqual(sample["errors"], [])

    def test_host_reports_live_workbench_limits(self):
        workbench = self.collect()["host"]["workbench"]
        self.assertEqual(workbench["unit"], "cloud-workbench.service")
        self.assertEqual(workbench["cpu_quota_cores"], 6.0)
        self.assertAlmostEqual(workbench["cpu_used_cores"], 1.5)
        self.assertEqual(workbench["memory_bytes"], 6 * 1024**3)
        self.assertEqual(workbench["memory_max_bytes"], 24 * 1024**3)
        self.assertEqual((workbench["tasks"], workbench["tasks_max"]), (212, 4096))

    def test_unlimited_workbench_limits_are_null(self):
        (self.group / "cpu.max").write_text("max 100000\n")
        (self.group / "memory.max").write_text("max\n")
        (self.group / "pids.max").write_text("max\n")
        workbench = self.collect()["host"]["workbench"]
        self.assertIsNone(workbench["cpu_quota_cores"])
        self.assertIsNone(workbench["memory_max_bytes"])
        self.assertIsNone(workbench["tasks_max"])

    def test_host_reports_uptime_storage_and_network(self):
        host = self.collect()["host"]
        self.assertEqual(host["uptime_seconds"], 273600.25)
        self.assertEqual(
            [disk["label"] for disk in host["storage"]],
            ["State disk", "Cache disk", "Root disk"],
        )
        self.assertEqual(
            host["storage"][0],
            {
                "label": "State disk",
                "path": "/srv/development/state",
                "total_bytes": 100 * 1024**3,
                "used_bytes": 40 * 1024**3,
                "free_bytes": 55 * 1024**3,
            },
        )
        self.assertEqual(
            host["network"],
            {
                "interface": "ens5",
                "rx_bytes": 3000,
                "tx_bytes": 2500,
                "rx_bytes_per_second": 2000.0,
                "tx_bytes_per_second": 500.0,
            },
        )

    def test_a_stuck_connection_is_a_tokiwa_sudo_that_lost_its_parent(self):
        """Only an adopted `sudo -n runuser -u agent-workspace` counts; a live one keeps its parent."""
        helper = ["sudo", "-n", "runuser", "-u", "agent-workspace", "--", "env"]

        def process(pid, comm, ppid, cmdline, utime=0, stime=0, start=0):
            folder = self.proc / str(pid)
            folder.mkdir()
            rest = ["S", str(ppid)] + ["0"] * 9 + [str(utime), str(stime)] + ["0"] * 6 + [str(start)]
            (folder / "stat").write_text(f"{pid} ({comm}) " + " ".join(rest) + "\n")
            (folder / "cmdline").write_text("\0".join(cmdline) + "\0")

        # Uptime is 273600.25 s; at 100 ticks a second the stuck one started 86400.25 s before.
        process(4242, "sudo", 1, helper, utime=8_000_000, stime=640_000, start=18_720_000)
        process(4300, "sudo", 4299, helper, start=27_000_000)
        process(4400, "sudo", 1, ["sudo", "-n", "/bin/bash", "-l"], start=27_000_000)
        process(4500, "python3", 1, ["python3", "x"], start=27_000_000)
        (self.proc / "4600").mkdir()  # A process that ended during the scan.
        with mock.patch.object(health.os, "sysconf", lambda name: 100):
            sample = self.collect()
        self.assertEqual(
            sample["host"]["stuck_connections"],
            [{"pid": 4242, "cpu_seconds": 86400.0, "age_seconds": 86400.25}],
        )
        self.assertEqual(
            dict(sample["rows"])["Stuck connection"],
            "PID 4242 · 1 day · 100% of a core",
        )

    def test_no_stuck_connection_gives_an_empty_list_and_no_row(self):
        sample = self.collect()
        self.assertEqual(sample["host"]["stuck_connections"], [])
        self.assertNotIn("Stuck connection", dict(sample["rows"]))

    def test_unreadable_parts_report_an_error_instead_of_zero(self):
        (self.proc / "uptime").unlink()
        (self.proc / "net/route").unlink()
        (self.group / "memory.current").unlink()
        sample = self.collect()
        host = sample["host"]
        self.assertEqual(host["uptime_seconds"], None)
        self.assertEqual(host["network"], {"error": "FileNotFoundError"})
        self.assertEqual(host["workbench"], {"error": "FileNotFoundError"})
        self.assertIn("Uptime: FileNotFoundError", sample["errors"])


if __name__ == "__main__":
    unittest.main()
