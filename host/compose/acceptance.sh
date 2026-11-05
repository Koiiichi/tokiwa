#!/bin/bash
source "$(dirname "$0")/lib.sh"
case ${1:-} in
 up)
  "${dc[@]}" build --pull
  if "${dc[@]}" up -d --wait --wait-timeout 120; then
   :
  else
   status=$?
   "${dc[@]}" logs --no-color --tail 100 || true
   exit "$status"
  fi
  "${dc[@]}" exec -T app python /app/integration.py
  "${dc[@]}" logs --no-color --tail 20
  "${dc[@]}" exec -T app python -c 'from pathlib import Path; assert Path("/sys/fs/cgroup/memory.max").read_text().strip()=="268435456"; assert Path("/sys/fs/cgroup/pids.max").read_text().strip()=="128"; q,p=map(int,Path("/sys/fs/cgroup/cpu.max").read_text().split()); assert q/p==0.5'
  ;;
 persistence)
  "${dc[@]}" down
  if "${dc[@]}" up -d --wait --wait-timeout 120; then
   :
  else
   status=$?
   "${dc[@]}" logs --no-color --tail 100 || true
   exit "$status"
  fi
  "${dc[@]}" exec -T -e TEST_MODE=read app python /app/integration.py
  ;;
 disconnect-start)
  "${dc[@]}" exec -d app python -u /app/independence.py
  ;;
 disconnect-read)
  "${dc[@]}" exec -T app cat /receipts/independence-result.json
  "${dc[@]}" exec -T -e TEST_MODE=read app python /app/integration.py
  ;;
 cleanup)
  "${dc[@]}" down --volumes --remove-orphans
  [[ -z $(docker ps -aq --filter "label=com.docker.compose.project=$PARITY_PROJECT") ]]
  [[ -z $(docker volume ls -q --filter "label=com.docker.compose.project=$PARITY_PROJECT") ]]
  ;;
 *) echo 'Use up, persistence, disconnect-start, disconnect-read or cleanup.' >&2; exit 2 ;;
esac
