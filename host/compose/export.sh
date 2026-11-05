#!/bin/bash
source "$(dirname "$0")/lib.sh"
[[ $# == 1 ]]
[[ $1 =~ ^[a-z0-9-]+$ ]]
target="$PWD/exports/$1"
[[ ! -e "$target" ]]
mkdir -p -m 0700 "$PWD/exports"
mkdir -m 0700 "$target"
"${dc[@]}" exec -T postgres pg_dump -U app -d app --no-owner --no-acl > "$target/postgres.sql"
"${dc[@]}" exec -T redis redis-cli SAVE
"${dc[@]}" cp redis:/data/dump.rdb "$target/redis.rdb"
python3 - "$target" <<'PY'
from pathlib import Path
import json,hashlib,os,sys,time
p=Path(sys.argv[1]);files={}
for name in ('postgres.sql','redis.rdb'):
 f=p/name
 with f.open('rb') as stream:os.fsync(stream.fileno())
 files[name]={'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()}
with (p/'manifest.json').open('x') as stream:json.dump({'epoch':time.time(),'files':files},stream,indent=2);stream.flush();os.fsync(stream.fileno())
fd=os.open(p,os.O_RDONLY);os.fsync(fd);os.close(fd)
print(json.dumps(files))
PY
