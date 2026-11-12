"""Bounded queue coalescing keyed by stable viewer identity, never display name."""

def identity(uid):
    value = str(uid or '')
    return value if value.isdecimal() and int(value) > 0 else None


def merge_comments(items):
    first = dict(items[0])
    messages = [m for item in items for m in item.get('messages', [dict(id=item.get('id'),text=item['text'],received=item['received'])])]
    first['messages'] = messages
    first['mergedCount'] = len(messages)
    first['text'] = '\n'.join(f'{i+1}. {m["text"]}' for i,m in enumerate(messages)) if len(messages)>1 else messages[0]['text']
    return first


def take_same_viewer(queue, first, key, limit=5):
    """Caller owns queue lock. Preserve the order of all unselected entries."""
    selected = [first]
    uid = key(first)
    if not uid: return selected
    keep = []
    for item in queue:
        if len(selected)<limit and key(item)==uid: selected.append(item)
        else: keep.append(item)
    queue.clear(); queue.extend(keep)
    return selected
