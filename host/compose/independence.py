"""Write a durable two-hour receipt from an existing application container."""
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.request

root=Path('/receipts')
root.mkdir(exist_ok=True)
claim=root/'independence-start.json'
start={'pid':os.getpid(),'epoch':time.time(),'duration_seconds':7200,'boot_id':Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
with claim.open('x') as f:json.dump(start,f);f.flush();os.fsync(f.fileno())

def save(name,data):
    temporary=root/(name+'.tmp')
    with temporary.open('w') as f:json.dump(data,f);f.flush();os.fsync(f.fileno())
    temporary.replace(root/name)
    fd=os.open(root,os.O_RDONLY);os.fsync(fd);os.close(fd)

origin=time.monotonic();samples=[]
try:
    while True:
        with urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=5) as r:health=json.load(r)
        if health!={'postgres':True,'redis':True}:raise RuntimeError('A database health check failed.')
        elapsed=time.monotonic()-origin;samples.append({'epoch':time.time(),'elapsed':elapsed,'health':health})
        save('independence-progress.json',{**start,'samples':len(samples),'elapsed':elapsed})
        if elapsed>=7200:break
        time.sleep(min(60,7200-elapsed))
    save('independence-samples.json',{'samples':samples})
    save('independence-result.json',{**start,'result':'PASS','elapsed':elapsed,'samples':len(samples),'samples_sha256':hashlib.sha256((root/'independence-samples.json').read_bytes()).hexdigest()})
except BaseException as error:
    save('independence-result.json',{**start,'result':'FAIL','error_type':type(error).__name__,'samples':len(samples)})
    raise
