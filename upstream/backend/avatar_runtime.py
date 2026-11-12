"""Embedded, read-only model assets and bounded, agent-selected performance queue."""
import json
import math
import threading
import time
from pathlib import Path, PurePosixPath
from urllib.parse import unquote

ROOT=Path(__file__).with_name('avatar')

class AvatarAssets:
    def __init__(self, model, core):
        self.root=Path(model).resolve();self.core=Path(core).resolve()
        if not self.core.is_file():raise ValueError('Configure a local Cubism Core JavaScript file')
        candidates=list(self.root.glob('*.model3.json'))
        if len(candidates)!=1:raise ValueError('Model directory must contain one model3.json')
        self.model=candidates[0].name;self.allowed={self.model}
        self.settings=self.read(self.model)
        refs=self.settings.get('FileReferences',{})
        for name in ['Moc','Physics','Pose','DisplayInfo','UserData']:
            if refs.get(name):self.allow(refs[name])
        for f in refs.get('Textures',[]):self.allow(f)
        self.expressions={};self.motions={}
        for e in refs.get('Expressions',[]):self.add(self.expressions,e['Name'],e['File'])
        for group,items in refs.get('Motions',{}).items():
            for i,item in enumerate(items):self.add(self.motions,group+'/'+str(i),item['File'])
        # Some public models ship unlisted expression/motion files.
        for directory,suffix,target in [('Exp3','.exp3.json',self.expressions),('Animation','.motion3.json',self.motions)]:
            for p in sorted((self.root/directory).glob('*'+suffix)):
                self.add(target,p.name.removesuffix(suffix),p.relative_to(self.root).as_posix())
        self.physics_outputs=set()
        if refs.get('Physics'):
            physics=self.read(refs['Physics'])
            self.physics_outputs={o['Destination']['Id'] for item in physics.get('PhysicsSettings',[]) for o in item.get('Output',[]) if o.get('Destination',{}).get('Target')=='Parameter'}
    def local(self,name):
        if not isinstance(name,str) or '\\' in name or ':' in name or '?' in name or '#' in name:raise ValueError('Invalid model reference')
        path=PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts:raise ValueError('Model reference escaped root')
        p=(self.root/name).resolve()
        if not p.is_relative_to(self.root) or not p.is_file():raise ValueError('Missing or escaped model asset')
        return p
    def allow(self,name):
        self.local(name);self.allowed.add(name)
    def read(self,name):return json.loads(self.local(name).read_text(encoding='utf-8-sig'))
    def add(self,target,name,file):
        self.allow(file)
        if name in target and target[name]['file']!=file:raise ValueError('Duplicate model capability name')
        target[name]={'file':file,'data':self.read(file)}
    def catalog(self):
        return {'modelFile':self.model,'expressions':list(self.expressions),'motions':list(self.motions),
                'controls':['keep','neutral','stop'],'source':'local model','automaticEmotion':False}
    def render_catalog(self):
        return {**self.catalog(),'settings':self.settings,'expressions':{k:v['data'] for k,v in self.expressions.items()},
                'motions':{k:v['data'] for k,v in self.motions.items()},'physicsOutputs':sorted(self.physics_outputs)}
    def asset(self,path):
        path=unquote(path)
        if path=='/vendor/live2dcubismcore.min.js':return self.core
        if path.startswith('/model/'):
            name=path[7:]
            return self.local(name) if name in self.allowed else None
        public={'/avatar':ROOT/'index.html','/avatar/client.mjs':ROOT/'client.mjs',
                '/avatar/controller.mjs':ROOT/'controller.mjs',
                '/avatar/upstream/driver-pipeline.mjs':ROOT/'upstream/driver-pipeline.mjs',
                '/avatar/upstream/motion-sampling.mjs':ROOT/'upstream/motion-sampling.mjs',
                '/vendor/pixi.min.js':ROOT/'vendor/pixi.min.js','/vendor/cubism4.colors.min.js':ROOT/'vendor/cubism4.colors.min.js'}
        return public.get(path)

class AvatarQueue:
    def __init__(self,assets):self.assets=assets;self.lock=threading.Lock();self.events=[];self.next=0
    def submit(self,plan):
        if not isinstance(plan,dict):raise ValueError('Expected performance object')
        expression=plan.get('expression','keep');motion=plan.get('motion','none');seconds=plan.get('seconds',3)
        if expression not in ['keep','neutral',*self.assets.expressions] or motion not in ['none','stop',*self.assets.motions]:raise ValueError('Choose a capability from avatar catalog')
        if isinstance(seconds,bool) or not isinstance(seconds,(int,float)) or not math.isfinite(seconds) or not 0.2<=seconds<=30:raise ValueError('Duration must be 0.2..30 seconds')
        with self.lock:
            self.next+=1;e={'id':self.next,'expression':expression,'motion':motion,'seconds':seconds,'at':time.time(),'state':'queued'}
            self.events.append(e);self.events=self.events[-100:];return dict(e)
    def poll(self,after):
        with self.lock:return [dict(e) for e in self.events if e['id']>after and time.time()-e['at']<30]
    def ack(self,ident,state):
        if state not in ('playing','completed','failed','superseded'):raise ValueError('Invalid receipt')
        with self.lock:
            e=next((e for e in self.events if e['id']==ident),None)
            if e is None:raise ValueError('Unknown performance')
            # A second viewer cannot regress a terminal receipt.
            if e['state'] not in ('completed','failed','superseded'):e['state']=state
            return dict(e)
    def status(self):
        with self.lock:return [{**e,'state':'expired' if e['state']=='queued' and time.time()-e['at']>=30 else e['state']} for e in self.events[-10:]]
