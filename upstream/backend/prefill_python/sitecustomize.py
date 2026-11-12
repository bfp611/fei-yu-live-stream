"""Opt-in Dafeiyu text prefill; tools and control JSON remain native."""
import os
if os.environ.get('DAFEIYU_PREFILL_HOME'):
    import json, copy, hashlib
    from pathlib import Path
    from datetime import datetime, timezone
    import aiohttp
    _request = aiohttp.ClientSession._request
    def settings(home):
        path=home/'bili-duty/comment-prefill.json'
        c=json.loads(path.read_text('utf-8-sig')) if path.exists() else {'enabled':False,'prefix':''}
        if type(c.get('enabled')) is not bool or not isinstance(c.get('prefix'),str) or len(c['prefix'])>500 or '\0' in c['prefix'] or (c['enabled'] and not c['prefix'].strip()):raise ValueError('Invalid Dafeiyu reasoning prefill configuration')
        return c
    def filled(body,cfg):
        b=copy.deepcopy(body);tail=b['messages'][-1] if b['messages'] else {}
        if tail.get('prefix') is True and tail.get('role')=='assistant' and tail.get('content')=='' and isinstance(tail.get('reasoning_content'),str):b['messages'].pop()
        if cfg['enabled']:
            b['messages'].append({'role':'assistant','content':'','prefix':True,'reasoning_content':cfg['prefix']})
            b['thinking']={'type':'enabled'}
            if b.get('reasoning_effort') in (None,'off','none'):b['reasoning_effort']='low'
        return b
    def log(home,cfg,status,stage):
        try:
            directory=home/'feiyu-runtime';directory.mkdir(exist_ok=True)
            with (directory/'prefill-requests.jsonl').open('a',encoding='utf8') as f:f.write(json.dumps({'at':datetime.now(timezone.utc).isoformat(),'pid':os.getpid(),'transport':stage,'enabled':cfg['enabled'],'status':status,'prefixHash':hashlib.sha256(cfg['prefix'].encode()).hexdigest() if cfg['enabled'] else None})+'\n')
        except OSError:pass
    async def _prefilled_request(self,method,url,**kwargs):
        from urllib.parse import urlsplit
        u=urlsplit(str(url));body=kwargs.get('json')
        if not (u.scheme=='https' and u.netloc=='api.deepseek.com' and u.path.endswith('/chat/completions') and isinstance(body,dict)):
            return await _request(self,method,url,**kwargs)
        home=Path(os.environ['DAFEIYU_PREFILL_HOME']);cfg=settings(home)
        if body.get('tools') or any(m.get('tool_calls') or m.get('role')=='tool' for m in body['messages']):return await _request(self,method,url,**kwargs)
        if body.get('response_format'):
            # The provider rejects JSON mode + prefix. Never weaken control schemas.
            response=await _request(self,method,url,**kwargs)
            if body.get('stream'):return response
            if not cfg['enabled'] or response.status>=400:return response
            payload=await response.json();choice=payload['choices'][0]
            if choice.get('finish_reason')!='stop':return response
            try:data=json.loads(choice['message']['content'])
            except (ValueError,KeyError):return response
            if not isinstance(data,dict) or set(data)!={'text'} or not isinstance(data['text'],str):
                log(home,cfg,response.status,'structured-control-native');return response
            cfg=settings(home)
            if not cfg['enabled']:return response
            speech={'model':body['model'],'max_tokens':body.get('max_tokens',2200),'messages':[{'role':'system','content':'你是大肥鱼，给自己的观众回复定稿。只返回口语正文，保留事实、数字、限制和未确认状态，不增添游戏动作，不把失败说成成功，不加承诺。'}, {'role':'user','content':json.dumps({'draft':data['text']},ensure_ascii=False)}]}
            extra=await _request(self,method,'https://api.deepseek.com/beta/chat/completions',**dict(kwargs,json=filled(speech,cfg)))
            extra.raise_for_status();revised=await extra.json();c=revised['choices'][0];text=c['message'].get('content','').strip()
            if c.get('finish_reason')!='stop' or not text or len(text)>700:raise ValueError('Prefill final wording incomplete')
            data['text']=text;choice['message']['content']=json.dumps(data,ensure_ascii=False)
            for k,v in revised.get('usage',{}).items():
                if isinstance(v,(int,float)):payload.setdefault('usage',{})[k]=payload.get('usage',{}).get(k,0)+v
            response._body=json.dumps(payload,ensure_ascii=False).encode('utf8');log(home,cfg,extra.status,'game-final-expression');return response
        kwargs['json']=filled(body,cfg)
        response=await _request(self,method,'https://api.deepseek.com/beta/chat/completions' if cfg['enabled'] else url,**kwargs)
        log(home,cfg,response.status,'python-text');return response
    aiohttp.ClientSession._request=_prefilled_request
