#!/bin/bash
# Run inside the unprivileged workbench after operator-created canaries exist.
source "$(dirname "$0")/lib.sh"
[[ $(id -u) == 2100 ]]
[[ ! -r /srv/development/private/rootless-canary/token ]]
[[ ! -w /run/docker.sock ]]
mkdir -p boundary-receipts
image=$(python3 -c 'import json; print(json.load(open("compose.json"))["services"]["app"]["build"]["args"]["BASE"])')
# Require a functioning local image before interpreting an access failure.
docker run --rm --network none --cpus .25 --memory 64m --pids-limit 32 "$image" python -c 'print("engine-ready")'
# The engine must refuse a bind mount from the private host directory.
if docker run --rm --network none --cpus .25 --memory 64m --pids-limit 32 --mount type=bind,src=/srv/development/private/rootless-canary,dst=/canary,readonly "$image" python -c 'from pathlib import Path; print(len(Path("/canary/token").read_bytes()))' > boundary-receipts/private.out 2> boundary-receipts/private.err; then
 echo 'The container can read the private canary.' >&2; exit 1
fi
grep -qiE 'permission denied|operation not permitted' boundary-receipts/private.err
# The socket path must be inaccessible to the dedicated engine identity.
if docker run --rm --network none --cpus .25 --memory 64m --pids-limit 32 --mount type=bind,src=/run/docker.sock,dst=/rootful.sock "$image" python -c 'import socket; s=socket.socket(socket.AF_UNIX); s.connect("/rootful.sock")' > boundary-receipts/socket.out 2> boundary-receipts/socket.err; then
 echo 'The container can connect to the rootful socket.' >&2; exit 1
fi
grep -qiE 'permission denied|operation not permitted' boundary-receipts/socket.err
# Timeout or refusal is required. An HTTP error is evidence of network access.
docker run --rm --memory 64m --cpus .25 --pids-limit 32 "$image" python -c 'import urllib.request, urllib.error, socket
for url in ("http://169.254.169.254/latest/meta-data/","http://[fd00:ec2::254]/latest/meta-data/"):
 try:
  urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url,timeout=2)
 except urllib.error.HTTPError:
  raise SystemExit("A container reached instance metadata.")
 except (urllib.error.URLError,TimeoutError,socket.timeout):
  continue
 raise SystemExit("A container reached instance metadata.")'
# A normal source file must be readable by the application's mapped UID.
mkdir -p source-fixture
printf 'source-readable\n' > source-fixture/input.txt
setfacl -m u:2200:r-x,u:1049575:r-x source-fixture
setfacl -m u:2200:r--,u:1049575:r-- source-fixture/input.txt
docker run --rm --user 1000:1000 --memory 64m --cpus .25 --pids-limit 32 --mount "type=bind,src=$PWD/source-fixture,dst=/source,readonly" "$image" python -c 'from pathlib import Path; assert Path("/source/input.txt").read_text()=="source-readable\n"'
# A non-root container writes only to the explicit generated-file directory.
mkdir -p bind-fixture
setfacl -m u:2200:--x .
setfacl -m u:2200:rwx,u:1049575:rwx,d:u:2100:rwx,d:u:2200:rwx,d:u:1049575:rwx bind-fixture
docker run --rm --user 1000:1000 --memory 64m --cpus .25 --pids-limit 32 --mount "type=bind,src=$PWD/bind-fixture,dst=/generated" "$image" python -c 'from pathlib import Path; Path("/generated/created-by-container").write_text("cloud-only\n")'
[[ $(cat bind-fixture/created-by-container) == cloud-only ]]
printf 'Model-free rootless client checks passed. Verify host cgroups and firewall rules separately.\n'
