"""Model-selected presentation commands. No scene or sentiment triggers."""
import math
EXPRESSIONS=['keep','neutral','微笑','脸红','流冷汗','屑屑眼','＞＜','加载','流泪','圈圈眼']
MOTIONS=['none','nod','shake_head','tilt_left','tilt_right','hand_on_chest','point']
GESTURES={'hand_on_chest':['默认手切举手','举手切默认手'],'point':['竖手指切出来动画','竖手指切回默认']}
PERFORMANCE_PROMPT='你可以自行选择Live2D表情与动作，也可保持原样，不要求每次表演；沉默时也可以动。增加performance对象：expression可选'+str(EXPRESSIONS)+'；motion可选'+str(MOTIONS)+'；duration是动作或表情持续的原片秒数（1到10），reason写自己的选择理由。keep保留现有表情，neutral回到自然表情，none不开始新动作。当前动作未结束时可以保持，不能自由行走或创造未支持的动作。不要把配音当作必须做动作的信号。'
def validate_performance(value):
    if value is None:return {'expression':'keep','motion':'none','duration':3,'reason':''}
    if not isinstance(value,dict):raise ValueError('invalid performance')
    expression=value.get('expression','keep');motion=value.get('motion','none');duration=value.get('duration',3)
    if expression not in EXPRESSIONS or motion not in MOTIONS:raise ValueError('unsupported performance')
    if isinstance(duration,bool) or not isinstance(duration,(int,float)) or not math.isfinite(duration) or not 1<=duration<=10:raise ValueError('invalid performance duration')
    reason=value.get('reason','')
    if not isinstance(reason,str) or len(reason)>600:raise ValueError('invalid performance reason')
    return {'expression':expression,'motion':motion,'duration':duration,'reason':reason}
