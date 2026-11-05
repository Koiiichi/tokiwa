set -euo pipefail
[[ ${PARITY_APPROVED:-} == 1 ]] || { echo 'The native test requires approval.' >&2; exit 2; }
[[ ${PARITY_PROJECT:-} =~ ^cloud-parity-[a-z0-9-]{1,24}$ ]] || { echo 'Supply an exact qualification project name.' >&2; exit 2; }
export DOCKER_HOST=unix:///run/cloud-workbench/docker.sock
cd "$(dirname "${BASH_SOURCE[0]}")"
docker info --format '{{json .}}' | python3 -c 'import json,sys; d=json.load(sys.stdin); assert "name=rootless" in d["SecurityOptions"]; assert d["CgroupVersion"]=="2" and d["CgroupDriver"]=="systemd"; assert d["DockerRootDir"]=="/srv/development/cache/rootless-engine/data"'
dc=(docker compose --project-name "$PARITY_PROJECT" --file compose.json)
