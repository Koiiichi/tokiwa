#!/bin/bash
# Run inside the Codex sandbox with the approved workbench profile.
source "$(dirname "$0")/lib.sh"
[[ $(id -u) == 2100 ]]
[[ $DOCKER_HOST == unix:///run/cloud-workbench/docker.sock ]]
docker info --format '{{.SecurityOptions}} {{.CgroupDriver}} {{.CgroupVersion}}'
"${dc[@]}" ps
"${dc[@]}" exec -T -e TEST_MODE=read app python /app/integration.py
"${dc[@]}" exec -T app python -c 'from pathlib import Path; assert Path("/sys/fs/cgroup/memory.max").read_text().strip()=="268435456"; assert Path("/sys/fs/cgroup/pids.max").read_text().strip()=="128"; q,p=map(int,Path("/sys/fs/cgroup/cpu.max").read_text().split()); assert q/p==0.5'
python3 - <<'PY'
import errno
import os
import pathlib
import socket
import urllib.error
import urllib.request

outside = pathlib.Path(os.environ['TOKIWA_WRITE_CANARY'])
assert outside.read_text() == 'unchanged\n'
try:
    outside.write_text('changed\n')
except OSError as error:
    if error.errno not in (errno.EACCES, errno.EPERM, errno.EROFS):
        raise
else:
    raise SystemExit('The sandbox permits writes outside the workspace.')
for path in ['/run/docker.sock', '/var/run/docker.sock']:
    with socket.socket(socket.AF_UNIX) as connection:
        try:
            connection.connect(path)
        except (PermissionError, FileNotFoundError):
            pass
        else:
            raise SystemExit('The sandbox can connect to the rootful socket.')
for url in ['http://169.254.169.254/latest/meta-data/', 'http://[fd00:ec2::254]/latest/meta-data/']:
    try:
        urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url, timeout=2)
    except urllib.error.HTTPError:
        raise SystemExit('The sandbox reached instance metadata.')
    except (urllib.error.URLError, TimeoutError):
        continue
    raise SystemExit('The sandbox reached instance metadata.')
print('Codex sandbox Docker, Compose, resource limits and host boundary passed.')
PY
