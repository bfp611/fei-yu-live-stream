"""Loopback rehearsal viewer with authenticated local chat. No Bilibili writes."""
import argparse
import asyncio
import json
import mimetypes
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit, parse_qs

def handler(pet, take, port, model=None, chat=None, credit=None, live=None, jingyu_url=None, ledger=None, game=None, avatar=None):
    from game_video import GameVideo
    video = GameVideo()
    page = Path(__file__).with_name('live-pilot.html')
    token = secrets.token_urlsafe(32)
    model_files = list(model.glob('*.model3.json')) if model else []
    if model and len(model_files)!=1: raise ValueError('Expected one model3.json')
    class Handler(BaseHTTPRequestHandler):
        def video_origin(self):
            return self.headers.get('Origin') in (f'http://127.0.0.1:{port}', 'http://127.0.0.1:15184')
        def do_OPTIONS(self):
            if self.path != '/api/game/video' or not game or not self.video_origin():
                self.send_error(403); return
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Video-Token')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.end_headers()
        def send_body(self, body, content_type='application/json', status=200):
            self.send_response(status)
            self.send_header('Content-Type',content_type)
            self.send_header('Content-Length',str(len(body)))
            self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff')
            self.send_header('Cross-Origin-Resource-Policy','same-origin')
            if self.path == '/api/game/video' and self.video_origin():
                self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
                self.send_header('Vary', 'Origin')
            self.end_headers(); self.wfile.write(body)
        def json(self, value, status=200):
            self.send_body(json.dumps(value,ensure_ascii=False).encode(),status=status)
        def do_POST(self):
            host=self.headers.get('Host','')
            if self.path == '/api/game/video' and game:
                if host != f'127.0.0.1:{port}' or not self.video_origin() or not secrets.compare_digest(self.headers.get('X-Video-Token',''),video.token):
                    self.send_error(403); return
                try:
                    size=int(self.headers.get('Content-Length','0'))
                    if not 0 < size <= 66000: raise ValueError('size')
                    body=json.loads(self.rfile.read(size))
                    if not isinstance(body,dict): raise ValueError('body')
                    # Only the game origin publishes an answer; it cannot submit viewer offers.
                    source=self.headers['Origin']=='http://127.0.0.1:15184'
                    if source != (body.get('kind') in ('answer','stats')): raise ValueError('role')
                    video.write(body); self.json({'ok':True})
                except (ValueError,UnicodeError): self.json({'error':'Invalid or busy video session'},409)
                return
            if (host not in (f'127.0.0.1:{port}',f'localhost:{port}') or
                self.headers.get('Origin')!='http://'+host or
                not secrets.compare_digest(self.headers.get('X-Pilot-Token',''),token)):
                self.send_error(403); return
            avatar_request=avatar is not None and self.path in ('/api/avatar/perform','/api/avatar/ack')
            if not avatar_request and (self.path not in ('/api/chat','/api/live/next','/api/game/control','/api/game/message','/api/game/next','/api/game/review') or chat is None): self.send_error(404); return
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=8192 or self.headers.get('Content-Type')!='application/json':
                    self.send_error(400); return
                body=json.loads(self.rfile.read(size))
                if not isinstance(body,dict): raise ValueError('格式不正确')
                if avatar_request:
                    self.json(avatar.submit(body) if self.path.endswith('/perform') else avatar.ack(body.get('id'),body.get('state'))); return
                if self.path.startswith('/api/game/'):
                    if game is None: self.send_error(404); return
                    if self.path=='/api/game/control':
                        if 'autoNext' in body:
                            game.rounds.configure(body['autoNext']); self.json(game.snapshot()); return
                        if body.get('mode')=='chat': game.chat_mode(); self.json(game.snapshot()); return
                        game.set_enabled(body.get('enabled')); self.json(game.snapshot()); return
                    if self.path=='/api/game/message':
                        event_id=game.submit(body.get('name','本地观众'),body.get('text'),body.get('id'))
                        self.json({'id':event_id}); return
                    if self.path=='/api/game/review':
                        self.json({'lessons':game.review(),'reviewJobs':game.review_jobs.status() if game.review_jobs else []}); return
                    result=game.next_reply(body.get('session'))
                    if result:
                        result.update(asyncio.run(chat.render_text(result['text'])))
                    self.json({'reply':result,'game':game.snapshot()}); return
                if self.path=='/api/live/next':
                    if live is None: self.send_error(404); return
                    if not chat.lock.acquire(blocking=False):
                        from live_pilot_chat import Busy
                        raise Busy('正在回复上一条，请稍后再发')
                    try:
                        item=live.next(body.get('session'))
                        if item is None: self.json({'jingyuUrl':jingyu_url,'live':live.snapshot()}); return
                        if game is not None and game.mode=='game':
                            [game.submit(item['name'],m['text'],m.get('id'),uid=item.get('uid')) for m in item.get('messages',[item])]
                            self.json({'live':live.snapshot(),'queuedGame':True}); return
                        result=asyncio.run(chat._reply(live.session, json.dumps({'观众':item['name'],'弹幕':item['text']},ensure_ascii=False),live=True))
                        result['comment']=item;result['live']=live.snapshot()
                    finally: chat.lock.release()
                else:
                    result=chat.reply(body.get('session'),body.get('text'))
                self.json(result)
            except (ValueError,UnicodeError): self.json({'error':'请输入有效弹幕（1–500字）或刷新页面重试'},400)
            except Exception as exc:
                from live_pilot_chat import Busy
                if isinstance(exc,Busy): self.json({'error':str(exc)},409)
                else: self.json({'error':'本轮生成失败，请稍后重试；未向 B 站发送任何内容'},502)
        def do_GET(self):
            if self.headers.get('Host') not in (f'127.0.0.1:{port}',f'localhost:{port}'):
                self.send_error(403); return
            path = unquote(urlsplit(self.path).path)
            if avatar:
                if path=='/api/avatar/catalog': self.json(avatar.assets.catalog()); return
                if path=='/api/avatar/render': self.json(avatar.assets.render_catalog()); return
                if path=='/api/avatar/status': self.json(avatar.status()); return
                if path=='/api/avatar/events':
                    try: self.json(avatar.poll(int(parse_qs(urlsplit(self.path).query).get('after',['0'])[0])))
                    except ValueError: self.json({'error':'Invalid cursor'},400)
                    return
                if path.startswith(('/avatar','/vendor/','/model/')):
                    file=avatar.assets.asset(path)
                    if not file or not file.is_file(): self.send_error(404); return
                    self.send_body(file.read_bytes(),mimetypes.guess_type(file.name)[0] or 'application/octet-stream'); return
            if path=='/api/game/video' and game:
                if self.headers.get('Origin') and not self.video_origin(): self.send_error(403); return
                self.json({'token':video.token,'signal':video.read()}); return
            if path=='/api/game/status':
                self.json(game.snapshot() if game else None); return
            if path=='/api/game/records' and game:
                self.json(game.store.events(30)); return
            if path=='/api/game/frame' and game:
                try: self.json(game.adapter.frame())
                except Exception: self.json({'error':'游戏画面暂不可用'},503)
                return
            if path=='/api/ledger':
                self.json(ledger.snapshot() if ledger else None); return
            if path=='/api/service':
                self.json({'name':'dsh-game-agent' if game else 'dsh-live-studio','version':'0.1.0-alpha.1'}); return
            if path=='/api/config':
                self.json({'avatarUrl':'/avatar' if avatar else None,'game':game is not None,'jingyuUrl':jingyu_url,'live':live.snapshot() if live else None,'credit':credit,'token':token,'chat':chat is not None,'model':('/model/'+model_files[0].name) if model else '/pet/model/c_0120.model3.json'}); return
            if path.startswith('/live-audio/') and chat:
                body=chat.audio.get(path.removeprefix('/live-audio/'))
                if body: self.send_body(body,'audio/mpeg'); return
            file = None
            if path == '/': file = page
            elif path == '/game-live.js': file = page.parent/'game-live.js'
            elif path == '/game-video.js': file = page.parent/'game-video.js'
            elif path == '/live-assets/ocean-room.png':
                file = page.parent/'live-assets'/'ocean-room.png'
            elif path in ('/live-vendor/pixi-7.4.3.min.js', '/live-vendor/cubism4-0.5.0-beta.min.js'):
                file = page.parent/path.lstrip('/')
            elif path.startswith('/model/') and model:
                candidate=(model/path[7:]).resolve()
                if candidate.is_relative_to(model.resolve()): file=candidate
            elif path.startswith('/pet/'):
                candidate = (pet/'assets'/path[5:]).resolve()
                if candidate.is_relative_to((pet/'assets').resolve()): file = candidate
            elif path.startswith('/take/'):
                name = path[6:]
                if name == 'rehearsal.json' or name in [f'{i}.mp3' for i in range(1,7)]:
                    file = take/name
            if path=='/take/rehearsal.json' and not file.is_file(): self.json({'rows':[]}); return
            if not file or not file.is_file(): self.send_error(404); return
            body = file.read_bytes()
            self.send_body(body,mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
        def log_message(self,*args): pass
    return Handler

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--managed', action='store_true', help='Exit when host stdin closes')
    parser.add_argument('--pet',type=Path,default=Path(__file__).parent/'empty-pet')
    parser.add_argument('--take',type=Path,default=Path(__file__).parent/'empty-take')
    parser.add_argument('--port',type=int,default=3088)
    parser.add_argument('--model',type=Path)
    parser.add_argument('--cubism-core',type=Path,help='User-supplied licensed Cubism Core JavaScript; not bundled')
    parser.add_argument('--credit')
    parser.add_argument('--live-room',type=int)
    parser.add_argument('--jingyu-url')
    parser.add_argument('--ledger',type=Path,help='Separate persistent live allowance database')
    parser.add_argument('--live-credential',type=Path,help='Separate optional live read credential; never reuse the publishing account implicitly')
    parser.add_argument('--home',type=Path)
    parser.add_argument('--persona',type=Path)
    parser.add_argument('--game-control-skill',type=Path)
    parser.add_argument('--game-state',type=Path,help='Isolated game experience database; never use production memory DB')
    parser.add_argument('--game-channel',default='1')
    parser.add_argument('--game-plugin',type=Path)
    args=parser.parse_args()
    avatar=None
    if args.cubism_core:
        if not args.model: parser.error('--cubism-core requires --model')
        from avatar_runtime import AvatarAssets, AvatarQueue
        avatar=AvatarQueue(AvatarAssets(args.model,args.cubism_core))
    if args.managed:
        import threading, sys, os
        def watch_host():
            sys.stdin.buffer.read()
            os._exit(0)  # Host lifetime owns this isolated process; SQLite WAL remains recoverable.
        threading.Thread(target=watch_host, daemon=True).start()
    if args.jingyu_url and (urlsplit(args.jingyu_url).scheme!='http' or urlsplit(args.jingyu_url).hostname not in ('127.0.0.1','localhost')): parser.error('--jingyu-url must use loopback HTTP')
    if bool(args.home)!=bool(args.persona): parser.error('--home and --persona are required together')
    from live_pilot_chat import LiveChat
    from live_ledger import LiveLedger
    ledger=LiveLedger(args.ledger.resolve(),args.live_room or 'local-game') if args.ledger and (args.live_room or args.game_state) else None
    chat=LiveChat(args.home.resolve(),args.persona.resolve(),ledger) if args.home else None
    game=None
    if bool(args.game_control_skill)!=bool(args.game_state): parser.error('Game skill and state must be provided together')
    if args.game_control_skill:
        if not args.game_plugin: parser.error('--game-plugin is required for game mode')
        import sys
        sys.path.insert(0,str(args.game_plugin.resolve()))
        if not chat: parser.error('Game mode requires persona and home')
        from game_director import GameDirector, GameStore
        from game_adapter import Ra2Adapter
        from game_model import GameModel
        game=GameDirector(GameStore(args.game_state),GameModel(args.home.resolve(),args.persona.resolve(),ledger),Ra2Adapter(args.game_control_skill,args.game_channel))
        from game_rounds import GameRounds
        game.rounds=GameRounds(game.store,game.adapter)
    live=None
    room_lock=None
    if args.live_room:
        if not args.home: parser.error('--live-room requires --home')
        from service_lock import ServiceLock
        room_lock=ServiceLock(args.home,args.live_room)
    if args.live_room:
        if not args.home: parser.error('--live-room requires --home')
        from live_room import LiveRoom
        live=LiveRoom(args.live_room,args.live_credential,ledger,game.receive_live if game else None)
    server=ThreadingHTTPServer(('127.0.0.1',args.port),handler(args.pet.resolve(),args.take.resolve(),args.port,args.model.resolve() if args.model else None,chat,args.credit,live,args.jingyu_url,ledger,game,avatar))
    if game: game.start()
    if live: live.start()
    print(f'Local rehearsal: http://127.0.0.1:{args.port}',flush=True)
    server.serve_forever()

if __name__ == '__main__': main()
