#!/usr/bin/env python3
"""Merge freshly scraped objective groups into data/objectives.json.

Usage: python3 tools/merge_objectives.py scraped.jsonl [--date YYYY-MM-DD]

Each line of scraped.jsonl is one group:
  {"path": "/objectives/<category>/<num>-<slug>/", "category": "Campaigns",
   "name": ..., "description": ..., "expires": null, "groupRewards": ..., "modes": ...,
   "objectives": [{"name", "task", "target", "requirement", "reward"}]}

Rules (so progress on people's phones is never lost):
  - Group ids come from the fut.gg slug and objective ids from the objective name,
    and an id never changes once it is in the file.
  - Groups missing from the scrape are kept and marked active=false (shown as Expired).
  - New groups get firstSeen=<date> so the app can badge them as NEW.
"""
import json, re, sys, unicodedata, datetime

DATA = 'data/objectives.json'
CATEGORIES = ['Campaigns', 'Seasonal', 'Foundations', 'Milestones', 'Mastery']


def slug(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode()
    s = s.lower().replace("'", '').replace('’', '')
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-') or 'item'


def text(v):
    if v is None:
        return None
    if isinstance(v, list):
        v = ', '.join(str(x) for x in v if x)
    v = str(v).strip()
    return v or None


def target(v):
    try:
        n = int(str(v).replace(',', ''))
        return n if n > 0 else 1
    except (TypeError, ValueError):
        return 1


def group_id(raw):
    m = re.search(r'/objectives/[^/]+/\d+-([^/]+)/?$', raw.get('path') or '')
    return m.group(1) if m else slug(raw['name'])


def main():
    args = sys.argv[1:]
    date = datetime.date.today().isoformat()
    if '--date' in args:
        i = args.index('--date'); date = args[i + 1]; del args[i:i + 2]
    try:
        with open(DATA, encoding='utf-8') as f:
            data = json.load(f)
    except FileNotFoundError:
        data = {'schema': 1, 'source': 'https://www.fut.gg/objectives/', 'groups': []}

    existing = {g['id']: g for g in data['groups']}
    seen = []
    with open(args[0], encoding='utf-8') as f:
        for line in f:
            if not line.strip():
                continue
            raw = json.loads(line)
            gid = group_id(raw)
            old = existing.get(gid, {})
            old_objs = {o['id']: o for o in old.get('objectives', [])}
            old_by_name = {o['name']: o['id'] for o in old.get('objectives', [])}
            objs, used = [], set()
            for o in raw.get('objectives', []):
                oid = o.get('id') or old_by_name.get(o['name']) or slug(o['name'])
                base, n = oid, 2
                while oid in used:
                    oid = f'{base}-{n}'; n += 1
                used.add(oid)
                objs.append({
                    'id': oid,
                    'name': text(o['name']),
                    'task': text(o.get('task')) or text(o['name']),
                    'target': target(o.get('target')),
                    'requirement': text(o.get('requirement')),
                    'reward': text(o.get('reward')),
                })
            cat = raw.get('category') or old.get('category')
            if not cat:
                m = re.search(r'/objectives/([^/]+)/', raw.get('path') or '')
                cat = m.group(1).title() if m else 'Other'
            existing[gid] = {
                'id': gid,
                'name': text(raw['name']),
                'category': cat,
                'description': text(raw.get('description')),
                'modes': text(raw.get('modes')),
                'groupRewards': text(raw.get('groupRewards')),
                'expires': text(raw.get('expires')),
                'url': 'https://www.fut.gg' + raw['path'] if raw.get('path') else old.get('url'),
                'firstSeen': old.get('firstSeen', date),
                'active': True,
                'objectives': objs,
            }
            # Keep objectives that vanished from a still-active group so their progress survives.
            for oid, o in old_objs.items():
                if oid not in used:
                    existing[gid]['objectives'].append(dict(o, retired=True))
            seen.append(gid)

    for gid, g in existing.items():
        if gid not in seen and g.get('active', True):
            g['active'] = False
            g['removedOn'] = date

    order = {c: i for i, c in enumerate(CATEGORIES)}
    groups = sorted(existing.values(), key=lambda g: (
        not g.get('active', True), order.get(g['category'], 99), seen.index(g['id']) if g['id'] in seen else 999))
    data.update({'schema': 1, 'updatedAt': date, 'groups': groups})
    data.setdefault('baseline', date)
    with open(DATA, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write('\n')
    active = [g for g in groups if g.get('active', True)]
    new = [g['name'] for g in active if g['firstSeen'] == date]
    print(f"{len(active)} active groups, {sum(len(g['objectives']) for g in active)} objectives; "
          f"new today: {', '.join(new) if new else 'none'}; expired: {len(groups) - len(active)}")


if __name__ == '__main__':
    main()
