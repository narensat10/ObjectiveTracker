#!/usr/bin/env python3
"""Merge freshly scraped SBCs into data/sbcs.json.

Usage: python3 tools/merge_sbcs.py scraped-sbcs.jsonl [--date YYYY-MM-DD] [--now ISO-8601 time]

Each line of the input is one SBC:
  {"path": "/sbc/<category>/<num>-<slug>/", "category": "Players", "name": ..., "description": ...,
   "reward": ..., "cost": "50,000" or null, "repeatable": "Unlimited" / "Every 2 days" / null,
   "expiringSoon": false,
   "challenges": [{"name", "reward", "requirements": ["Chemistry: Min. 14", ...]}]}
A line may leave out "challenges" (list page only); the SBC then keeps the challenges it already has.

Same rules as merge_objectives.py: ids come from the fut.gg path and never change, SBCs missing
from the scrape are marked active=false, and new SBCs get firstSeenAt=<now> for the New filter.
"""
import json, re, sys, datetime

sys.path.insert(0, __file__.rsplit('/', 1)[0])
from merge_objectives import slug, text  # noqa: E402

DATA = 'data/sbcs.json'
CATEGORIES = ['Players', 'Upgrades', 'Challenges', 'Foundations']


def sbc_id(raw):
    m = re.search(r'/sbc/[^/]+/(\d+-\d+-[^/]+)/?$', raw.get('path') or '')
    return m.group(1) if m else slug(raw['name'])


def coins(v):
    try:
        n = int(re.sub(r'[^\d]', '', str(v)))
        return n if n > 0 else None
    except ValueError:
        return None


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
        data = {'schema': 1, 'source': 'https://www.fut.gg/sbc/', 'sbcs': []}
        first_run = True

    existing = {s['id']: s for s in data['sbcs']}
    seen = []
    with open(args[0], encoding='utf-8') as f:
        for line in f:
            if not line.strip():
                continue
            raw = json.loads(line)
            sid = sbc_id(raw)
            if sid in seen:
                continue
            old = existing.get(sid, {})
            if raw.get('challenges'):
                old_by_name = {c['name']: c['id'] for c in old.get('challenges', [])}
                chs, used = [], set()
                for c in raw['challenges']:
                    cid = old_by_name.get(c['name']) or slug(c['name'])
                    base, n = cid, 2
                    while cid in used:
                        cid = f'{base}-{n}'; n += 1
                    used.add(cid)
                    chs.append({
                        'id': cid,
                        'name': text(c['name']),
                        'reward': text(c.get('reward')),
                        'requirements': [text(r) for r in c.get('requirements') or [] if text(r)],
                    })
                # Challenges that vanished keep their id so saved ticks still line up.
                for c in old.get('challenges', []):
                    if c['id'] not in used:
                        chs.append(dict(c, retired=True))
            else:
                chs = old.get('challenges', [])
            m = re.search(r'/sbc/([^/]+)/', raw.get('path') or '')
            existing[sid] = {
                'id': sid,
                'name': text(raw['name']),
                'category': raw.get('category') or old.get('category') or (m.group(1).title() if m else 'Other'),
                'description': text(raw.get('description')) or old.get('description'),
                'reward': text(raw.get('reward')) or old.get('reward'),
                'cost': coins(raw.get('cost')) if raw.get('cost') else old.get('cost'),
                'repeatable': text(raw.get('repeatable')),
                'expiringSoon': bool(raw.get('expiringSoon')),
                'url': 'https://www.fut.gg' + raw['path'] if raw.get('path') else old.get('url'),
                'firstSeen': old.get('firstSeen', date),
                'firstSeenAt': old.get('firstSeenAt') or (None if old or first_run else now),
                'active': True,
                'challenges': chs,
            }
            seen.append(sid)

    for sid, s in existing.items():
        if sid not in seen and s.get('active', True):
            s['active'] = False
            s['removedOn'] = date

    order = {c: i for i, c in enumerate(CATEGORIES)}
    sbcs = sorted(existing.values(), key=lambda s: (
        not s.get('active', True), order.get(s['category'], 99), seen.index(s['id']) if s['id'] in seen else 999))
    data.update({'schema': 1, 'updatedAt': date, 'sbcs': sbcs})
    with open(DATA, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write('\n')
    active = [s for s in sbcs if s.get('active', True)]
    new = [s['name'] for s in active if s.get('firstSeenAt') == now]
    print(f"{len(active)} active SBCs, {sum(len(s['challenges']) for s in active)} challenges; "
          f"new today: {', '.join(new) if new else 'none'}; expired: {len(sbcs) - len(active)}")


if __name__ == '__main__':
    main()
