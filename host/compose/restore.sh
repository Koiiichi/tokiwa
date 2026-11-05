#!/bin/bash
# Restore only into a new qualification project. Never overwrite an existing volume.
source "$(dirname "$0")/lib.sh"
[[ $# == 1 ]]
source_dir=$(realpath "$1")
python3 - "$source_dir" <<'PY'
from pathlib import Path
import json,hashlib,sys
p=Path(sys.argv[1]);d=json.loads((p/'manifest.json').read_text());assert set(d['files'])=={'postgres.sql','redis.rdb'}
for name,item in d['files'].items():
 f=p/name;assert not f.is_symlink();assert f.stat().st_size==item['bytes'];assert hashlib.sha256(f.read_bytes()).hexdigest()==item['sha256']
PY
for volume in pgdata redisdata receipts; do
 if docker volume inspect "${PARITY_PROJECT}_${volume}" >/dev/null 2>&1; then echo 'The restore volume already exists.' >&2; exit 2; fi
done
"${dc[@]}" up -d --wait postgres redis
"${dc[@]}" exec -T postgres psql -U app -d app -v ON_ERROR_STOP=1 < "$source_dir/postgres.sql"
"${dc[@]}" stop redis
"${dc[@]}" cp "$source_dir/redis.rdb" redis:/data/dump.rdb
"${dc[@]}" run --rm --no-deps redis sh -c 'rm -rf /data/appendonlydir'
override=$(mktemp "$PWD/.restore-redis.XXXXXX.json")
trap 'rm -f "$override"' EXIT
printf '{"services":{"redis":{"command":["redis-server","--appendonly","no"]}}}' > "$override"
"${dc[@]}" -f "$override" up -d --wait redis
"${dc[@]}" exec -T redis redis-cli CONFIG SET appendonly yes
for attempt in $(seq 1 60); do
 if "${dc[@]}" exec -T redis redis-cli INFO persistence | tr -d '\r' | grep -q '^aof_rewrite_in_progress:0$'; then break; fi
 sleep 1
done
"${dc[@]}" exec -T redis redis-cli INFO persistence | tr -d '\r' | grep -q '^aof_last_bgrewrite_status:ok$'
"${dc[@]}" up -d --wait --wait-timeout 120
"${dc[@]}" exec -T -e TEST_MODE=read app python /app/integration.py
"${dc[@]}" down
"${dc[@]}" up -d --wait --wait-timeout 120
"${dc[@]}" exec -T -e TEST_MODE=read app python /app/integration.py
