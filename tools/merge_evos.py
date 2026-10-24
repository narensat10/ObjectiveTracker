#!/usr/bin/env python3
"""Merge freshly scraped Evolutions into data/evos.json.

Usage: python3 tools/merge_evos.py scraped-evos.jsonl [--date YYYY-MM-DD] [--now ISO-8601 time]

Each line of the input is one Evolution:
  {"path": "/evolutions/<num>-<slug>/" or null, "name": ..., "cost": "125 points" or null (free),
   "repeatable": null, "expiringSoon": false, "requirements": ["Overall: max 80", ...],
   "levels": [{"objectives": ["Play 1 match ..."], "upgrades": ["+5 OVR", ...]}]}
A line may leave out "levels"; the Evolution then keeps the levels it already has.

Same rules as merge_objectives.py: ids come from the fut.gg path and never change, Evolutions missing
from the scrape are marked active=false, and new ones get firstSeenAt=<now> for the New filter.
"""
import json, re, sys, datetime

sys.path.insert(0, __file__.rsplit('/', 1)[0])
from merge_objectives import slug, text  # noqa: E402

DATA = 'data/evos.json'


def evo_id(raw):
    m = re.search(r'/evolutions/(\d+-[^/]+)/?$', raw.get('path') or '')
    return m.group(1) if m else slug(raw['name'])


def kind(levels):
    """How the Evolution progresses: by playing matches, in training camp, or straight away."""
    objs = ' '.join(o for lv in levels for o in lv.get('objectives', [])).lower()
    if not levels:
        return None
    if 'training' in objs:
        return 'training'
    if not objs.strip():
        return 'instant'
    return 'matches'


def main():
    args = sys.argv[1:]
    date = datetime.date.today().isoformat()
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
    if '--date' in args:
        i = args.index('--date'); date = args[i + 1]; del args[i:i + 2]
    if '--now' in args:
        i = args.index('--now'); now = args[i + 1]; del args[i:i + 2]
    try:
        with open(DATA, encoding='utf-8') as f:
            data = json.load(f)
        first_run = False
    except FileNotFoundError:
        data = {'schema': 1, 'source': 'https://www.fut.gg/evolutions/', 'evos': []}
        first_run = True

    existing = {e['id']: e for e in data['evos']}
    seen = []
    with open(args[0], encoding='utf-8') as f:
        for line in f:
            if not line.strip():
                continue
            raw = json.loads(line)
            eid = evo_id(raw)
            if eid in seen:
                continue
            old = existing.get(eid, {})
            if raw.get('levels') is not None and (raw['levels'] or not old.get('levels')):
                levels = [{
                    'objectives': [text(o) for o in lv.get('objectives') or [] if text(o)],
                    'upgrades': [text(u) for u in lv.get('upgrades') or [] if text(u)],
                } for lv in raw['levels']]
            else:
                levels = old.get('levels', [])
            existing[eid] = {
                'id': eid,
                'name': text(raw['name']),
                'cost': text(raw.get('cost')),
                'repeatable': text(raw.get('repeatable')),
                'expiringSoon': bool(raw.get('expiringSoon')),
                'kind': kind(levels),
                'requirements': [text(r) for r in raw.get('requirements') or old.get('requirements') or [] if text(r)],
                'levels': levels,
                'url': 'https://www.fut.gg' + raw['path'] if raw.get('path') else old.get('url'),
                'firstSeen': old.get('firstSeen', date),
                'firstSeenAt': old.get('firstSeenAt') or (None if old or first_run else now),
                'active': True,
            }
            seen.append(eid)

    for eid, e in existing.items():
        if eid not in seen and e.get('active', True):
            e['active'] = False
            e['removedOn'] = date

    evos = sorted(existing.values(), key=lambda e: (not e.get('active', True), seen.index(e['id']) if e['id'] in seen else 999))
    data.update({'schema': 1, 'updatedAt': date, 'evos': evos})
    with open(DATA, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write('\n')
    active = [e for e in evos if e.get('active', True)]
    new = [e['name'] for e in active if e.get('firstSeenAt') == now]
    print(f"{len(active)} active Evolutions; new today: {', '.join(new) if new else 'none'}; expired: {len(evos) - len(active)}")


if __name__ == '__main__':
    main()
