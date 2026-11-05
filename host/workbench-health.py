"""Read host and workspace metrics without changing services or workloads."""

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

PROC = Path("/proc")
DISKS = [
    ("Root disk", "/"),
    ("State disk", "/srv/development/state"),
    ("Cache disk", "/srv/development/cache"),
]


def cpu_counters(text):
    values = [int(value) for value in text.splitlines()[0].split()[1:9]]
    return sum(values), values[3] + values[4]


def memory_values(text):
    return {
        line.split(":")[0]: int(line.split()[1]) * 1024 for line in text.splitlines()
    }


def pairs(text):
    return dict(line.split(None, 1) for line in text.splitlines())


def gib(value):
    return f"{int(value) / 1024**3:.1f} GiB"


def limit(text):
    """Return a cgroup limit as an integer, or None when the file says max."""
    value = text.strip()
    return None if value == "max" else int(value)


def quota_cores(text):
    quota, period = text.split()
    return None if quota == "max" else int(quota) / int(period)


def primary_interface(route):
    """Name the interface that carries the IPv4 default route."""
    for line in route.splitlines()[1:]:
        fields = line.split()
        if len(fields) > 1 and fields[1] == "00000000":
            return fields[0]
    raise ValueError("No default route.")


def interface_bytes(dev, name):
    for line in dev.splitlines()[2:]:
        label, _, counters = line.partition(":")
        if label.strip() == name:
            values = counters.split()
            return int(values[0]), int(values[8])
    raise KeyError(name)


def network_counters():
    name = primary_interface((PROC / "net/route").read_text())
    counters = interface_bytes((PROC / "net/dev").read_text(), name)
    return name, counters, time.monotonic()


def workbench_limits(path, cores):
    return {
        "unit": "cloud-workbench.service",
        "cpu_used_cores": cores,
        "cpu_quota_cores": quota_cores((path / "cpu.max").read_text()),
        "memory_bytes": int((path / "memory.current").read_text()),
        "memory_max_bytes": limit((path / "memory.max").read_text()),
        "tasks": int((path / "pids.current").read_text()),
        "tasks_max": limit((path / "pids.max").read_text()),
    }


def unit(name):
    output = subprocess.check_output(
        ["systemctl", "show", name, "-p", "ControlGroup", "-p", "ActiveState"],
        text=True,
        timeout=5,
    )
    fields = dict(line.split("=", 1) for line in output.splitlines())
    relative = fields.get("ControlGroup", "").lstrip("/")
    if not relative:
        return fields.get("ActiveState", "unknown"), None
    root = Path("/sys/fs/cgroup")
    path = (root / relative).resolve()
    if root not in path.parents:
        raise ValueError("The resource group path is invalid.")
    return fields.get("ActiveState", "unknown"), path


def collect():
    rows, errors = [], []
    metrics = {}
    # Older readers ignore this field. A missing part carries its error, never a zero.
    usage = {
        "uptime_seconds": None,
        "workbench": {"error": "no control group"},
        "storage": [],
        "network": None,
    }
    before, groups, network = None, {}, None
    try:
        before = cpu_counters((PROC / "stat").read_text())
    except (OSError, ValueError, IndexError) as exc:
        errors.append("Host CPU: " + type(exc).__name__)
    try:
        network = network_counters()
    except (OSError, ValueError, KeyError, IndexError) as exc:
        usage["network"] = {"error": type(exc).__name__}
    for label, name in [
        ("Workbench", "cloud-workbench.service"),
        ("Containers", "user@2200.service"),
    ]:
        try:
            state, path = unit(name)
            rows.append(
                [
                    "Container manager"
                    if label == "Containers"
                    else label + " service",
                    state,
                ]
            )
            if path:
                groups[label] = (
                    path,
                    int(pairs((path / "cpu.stat").read_text())["usage_usec"]),
                    time.monotonic(),
                )
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
            rows.append([label + " service", "Unavailable"])
            errors.append(label + ": " + type(exc).__name__)
            if label == "Workbench":
                usage["workbench"] = {"error": type(exc).__name__}
    time.sleep(1)
    host = []
    try:
        after = cpu_counters((PROC / "stat").read_text())
        if before is not None:
            total, idle = after[0] - before[0], after[1] - before[1]
            if total <= 0:
                raise ValueError("The CPU sample did not advance.")
            host.append(
                [
                    "Host CPU",
                    f"{100 * (total - idle) / total:.1f}% busy / {os.cpu_count()} CPUs",
                ]
            )
            metrics["cpu_percent"] = 100 * (total - idle) / total
        mem = memory_values((PROC / "meminfo").read_text())
        metrics["ram_percent"] = 100 * (1 - mem["MemAvailable"] / mem["MemTotal"])
        host.append(
            [
                "Host RAM available",
                gib(mem["MemAvailable"]) + " / " + gib(mem["MemTotal"]),
            ]
        )
        host.append(
            [
                "Host load (1/5/15m)",
                " / ".join((PROC / "loadavg").read_text().split()[:3]),
            ]
        )
    except (OSError, ValueError, KeyError, IndexError) as exc:
        errors.append("Host sample: " + type(exc).__name__)
    try:
        usage["uptime_seconds"] = float((PROC / "uptime").read_text().split()[0])
    except (OSError, ValueError, IndexError) as exc:
        errors.append("Uptime: " + type(exc).__name__)
    if network:
        try:
            name, (rx, tx), started = network
            now = network_counters()
            if now[0] != name:
                raise ValueError("The default route changed.")
            elapsed = now[2] - started
            usage["network"] = {
                "interface": name,
                "rx_bytes": now[1][0],
                "tx_bytes": now[1][1],
                "rx_bytes_per_second": (now[1][0] - rx) / elapsed,
                "tx_bytes_per_second": (now[1][1] - tx) / elapsed,
            }
        except (OSError, ValueError, KeyError, IndexError, ZeroDivisionError) as exc:
            usage["network"] = {"error": type(exc).__name__}
    disks = {}
    for label, directory in DISKS:
        try:
            disk = shutil.disk_usage(directory)
            host.append([label, gib(disk.free) + " free / " + gib(disk.total)])
            disks[label] = {
                "label": label,
                "path": directory,
                "total_bytes": disk.total,
                "used_bytes": disk.used,
                "free_bytes": disk.free,
            }
        except OSError as exc:
            host.append([label, "Unavailable"])
            disks[label] = {
                "label": label,
                "path": directory,
                "error": type(exc).__name__,
            }
    usage["storage"] = [disks[key] for key in ("State disk", "Cache disk", "Root disk")]
    for label, (path, initial, started) in groups.items():
        try:
            current = pairs((path / "cpu.stat").read_text())
            elapsed = time.monotonic() - started
            cores = (int(current["usage_usec"]) - initial) / 1e6 / elapsed
            if label == "Workbench":
                try:
                    usage["workbench"] = workbench_limits(path, cores)
                except (OSError, ValueError) as exc:
                    usage["workbench"] = {"error": type(exc).__name__}
            quota, period = (path / "cpu.max").read_text().split()
            cap = "unlimited" if quota == "max" else f"{int(quota) / int(period):g}"
            rows.append([label + " CPU", f"{cores:.2f} / {cap} cores"])
            for title, used, maximum, fmt in [
                ("RAM", "memory.current", "memory.max", gib),
                ("tasks", "pids.current", "pids.max", str),
            ]:
                maximum = (path / maximum).read_text().strip()
                cap = "unlimited" if maximum == "max" else fmt(int(maximum))
                rows.append(
                    [
                        label + " " + title,
                        fmt(int((path / used).read_text())) + " / " + cap,
                    ]
                )
            rows.append(
                [
                    label + " swap cap",
                    (path / "memory.swap.max").read_text().strip() + " bytes",
                ]
            )
        except (OSError, ValueError, KeyError) as exc:
            errors.append(label + " limits: " + type(exc).__name__)
            if label == "Workbench" and "unit" not in usage["workbench"]:
                usage["workbench"] = {"error": type(exc).__name__}
    return {
        "sampled_at": time.time(),
        "rows": host + rows,
        "errors": errors,
        "metrics": metrics,
        "host": usage,
    }


if __name__ == "__main__":
    print(json.dumps(collect()))
