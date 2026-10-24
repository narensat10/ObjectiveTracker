#!/usr/bin/env python3
"""Merge freshly scraped Evolutions into data/evos.json.

Usage: python3 tools/merge_evos.py scraped-evos.jsonl [--date YYYY-MM-DD] [--now ISO-8601 time]

Each line of the input is one Evolution:
  {"path": "/evolutions/<num>-<slug>/" or null, "name": ..., "cost": "125 points" or null (free),
   "repeatable": null, "expiringSoon": false, "requirements": ["Overall: max 80", ...],
   "levels": [{"objectives": ["Play 1 match ..."], "upgrades": ["+5 OVR85", "+7 Sprint Speed77", ...]}]}
Requirements and upgrades may be copied as fut.gg prints them ("Overall Max. 80", "+10 OVR85"); they are
normalised to "Overall: max 80" and "+10 OVR (max 85)" so the app can work out Evolution chains.
A line may leave out "levels" or "picks"; the Evolution then keeps what it already has. "picks" are players
recommended by guides: [{"name", "ovr" (optional), "pos": ["CM", ...] (optional), "note", "src": guide URL}].

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


STAT_NAMES = {'OVR': 'OVR', 'WF': 'Weak Foot', 'SM': 'Skill Moves', 'POS': 'Positioning', 'Fk Accuracy': 'FK Accuracy',
              'Defensive Awareness': 'Def. Awareness', 'Heading Accuracy': 'Heading Acc.'}


def norm_upgrade(u):
    """fut.gg prints the cap glued to the stat ("+10 OVR85"); store it as "+10 OVR (max 85)"."""
    u = text(u)
    if not u or re.fullmatch(r'\d+', u):
        return None
    m = re.fullmatch(r'(Option [A-Z]): (.+)', u)
    if m:
        parts = [norm_upgrade(x) for x in re.split(r',\s*(?=\+)', m.group(2))]
        return m.group(1) + ': ' + ', '.join(x for x in parts if x)
    m = re.fullmatch(r'\+(\d+) ([A-Za-z.+ ]+?)\s*(\d+)', u)
    if m:
        stat = STAT_NAMES.get(m.group(2).strip(), m.group(2).strip())
        star = '★' if stat in ('Weak Foot', 'Skill Moves') else ''
        return f'+{m.group(1)} {stat} (max {m.group(3)}{star})'
    m = re.fullmatch(r'([A-Z]{2,3}?)([A-Z][a-z]+\+)', u)  # "RBWingback+"
    if m:
        return f'Role: {m.group(2)} ({m.group(1)})'
    return u


def norm_req(reqs):
    """fut.gg's "Overall Max. 80" / "Position CM, CDM" style into "Overall: max 80" / "Position: CM or CDM"."""
    out, lo, hi = [], None, None
    for r in reqs:
        r = text(r)
        if not r:
            continue
        m = re.fullmatch(r'Overall (Min|Max)\. (\d+)', r)
        if m:
            if m.group(1) == 'Min': lo = m.group(2)
            else: hi = m.group(2)
            continue
        def join(v):
            v = [x.strip() for x in v.split(',')]
            return v[0] if len(v) == 1 else ', '.join(v[:-1]) + ' or ' + v[-1]
        m = re.fullmatch(r'(Excluded Position|Position|Rarity:?|Born After|Max Pos\.|Max PS\+|Max PS) ?(.+)', r)
        if m:
            k, v = m.group(1).rstrip(':'), m.group(2).strip()
            out.append({'Position': 'Position: ' + join(v), 'Excluded Position': 'Excluded positions: ' + v, 'Rarity': 'Rarity: ' + v,
                        'Born After': 'Born after ' + v, 'Max Pos.': 'Max positions: ' + v, 'Max PS+': 'Max PlayStyles+: ' + v,
                        'Max PS': 'Max PlayStyles: ' + v}[k])
            continue
        m = re.fullmatch(r'(.+?) (Min|Max)\. (\d+)', r)
        out.append(f'{m.group(1)}: {m.group(2).lower()} {m.group(3)}' if m else r)
    if hi or lo:
        out.insert(0, f'Overall: exactly {hi}' if lo and lo == hi else f'Overall: max {hi}' if hi else f'Overall: min {lo}')
    return out


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
                    'upgrades': [x for x in (norm_upgrade(u) for u in lv.get('upgrades') or []) if x],
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
                'requirements': norm_req(raw['requirements']) if raw.get('requirements') else old.get('requirements') or [],
                'levels': levels,
                'url': 'https://www.fut.gg' + raw['path'] if raw.get('path') else old.get('url'),
                # Players recommended by guides ({name, ovr?, pos?: [..], note, src}); kept until replaced.
                'picks': raw['picks'] if raw.get('picks') else old.get('picks', []),
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
