"""Check application, database and cache behavior through the Compose network."""
import json
import os
import urllib.request

base=os.environ.get('APP_URL','http://app:8080')
key=os.environ.get('RECEIPT_KEY','persistent-check')
mode=os.environ.get('TEST_MODE','write')
if mode=='write':
    request=urllib.request.Request(base+'/items',data=json.dumps({'key':key,'value':'survives-disconnect'}).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=10) as response:json.load(response)
with urllib.request.urlopen(base+'/health',timeout=10) as response:
    health=json.load(response);assert health=={'postgres':True,'redis':True},health
with urllib.request.urlopen(base+'/items',timeout=10) as response:
    result=json.load(response);assert result['items'][key]=='survives-disconnect',result;assert result['writes']>=1,result
print(json.dumps({'result':'PASS','mode':mode,'key':key,'database_and_cache':result}))
