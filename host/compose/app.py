"""A small HTTP application that stores records in PostgreSQL and reads a Redis counter."""
import json
from contextlib import closing
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def databases():
    import psycopg
    import redis
    return psycopg.connect(os.environ['DATABASE_URL']), redis.Redis.from_url(os.environ['REDIS_URL'], decode_responses=True)


def operation(method, path, payload=None):
    if path not in ('/health', '/items'):
        return 404, {'error':'Unknown path.'}
    db,cache=databases()
    with db, closing(cache):
        db.execute('CREATE TABLE IF NOT EXISTS items (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        if path=='/health':
            db.execute('SELECT 1')
            return 200, {'postgres':True,'redis':bool(cache.ping())}
        if method=='POST':
            if not isinstance(payload,dict) or set(payload)!= {'key','value'} or not all(isinstance(x,str) and len(x)<=200 for x in payload.values()):
                return 400, {'error':'Supply a key and a value of at most 200 characters.'}
            db.execute('INSERT INTO items VALUES (%s,%s) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value',(payload['key'],payload['value']))
            db.commit()
            cache.incr('writes')
        elif method!='GET':
            return 405, {'error':'Use GET or POST.'}
        rows=db.execute('SELECT key,value FROM items ORDER BY key').fetchall()
        return 200, {'items':dict(rows),'writes':int(cache.get('writes') or 0)}


class Handler(BaseHTTPRequestHandler):
    def handle_request(self):
        size=int(self.headers.get('Content-Length','0'))
        if size>4096:
            status,data=413,{'error':'The request is too large.'}
        else:
            try:
                payload=json.loads(self.rfile.read(size)) if size else None
                status,data=operation(self.command,self.path,payload)
            except (ValueError,TypeError):
                status,data=400,{'error':'Supply a valid JSON object.'}
            except Exception:
                status,data=503,{'error':'A database is unavailable.'}
        body=json.dumps(data).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    do_GET=handle_request
    do_POST=handle_request

if __name__=='__main__':ThreadingHTTPServer(('0.0.0.0',8080),Handler).serve_forever()
