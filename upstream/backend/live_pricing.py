"""DeepSeek Flash CNY list-price estimate, verified 2026-11-06.

https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
Holiday schedule: 国办发明电〔2025〕7号. No guessed future calendar.
Amounts are integer nano-yuan to avoid per-call rounding loss.
"""
from datetime import datetime, timezone, timedelta

HOLIDAYS_2026 = ((101,103),(215,223),(404,406),(501,505),(619,621),(925,927),(1001,1007))


def flash_cost(usage, timestamp):
    date = datetime.fromtimestamp(timestamp, timezone(timedelta(hours=8)))
    if date.year != 2026:
        return None
    hit = usage.get('prompt_cache_hit_tokens')
    miss = usage.get('prompt_cache_miss_tokens')
    output = usage.get('completion_tokens')
    prompt = usage.get('prompt_tokens')
    if any(type(v) is not int or v < 0 for v in (hit,miss,output,prompt)) or hit+miss != prompt:
        return None
    if usage.get('total_tokens') != prompt+output:
        return None
    holiday = any(start <= date.month*100+date.day <= end for start,end in HOLIDAYS_2026)
    peak = date.weekday()<5 and not holiday and (9<=date.hour<12 or 14<=date.hour<18)
    multiplier=2 if peak else 1
    return {'nanoYuan':(hit*20+miss*1000+output*4000)*multiplier,
            'period':'peak' if peak else 'off-peak', 'priceVersion':'flash-cny-2026-11-06',
            'requestTime':timestamp}
