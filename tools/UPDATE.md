# Daily objectives update

Run every day at 11:45pm IST (after EA's 6pm UK content drop).

1. Read https://www.fut.gg/objectives/ and list every objective group link
   (`/objectives/<category>/<num>-<slug>/`) with its category (Campaigns, Seasonal,
   Foundations, Milestones, Mastery).
2. Read each group page and write one JSON line per group to a scratch file
   (`scraped.jsonl`), in this shape:
   `{"path","category","name","description","expires","groupRewards","modes","objectives":[{"name","task","target","requirement","reward"}]}`
   - `target` is the whole number needed to complete it (1 for one-off tasks).
   - `requirement` is only the squad requirement (e.g. "Min. 1 Scottish player in your starting XI"), otherwise null.
   - Put game-mode rules that apply to the whole group in `modes`.
3. `python3 tools/merge_objectives.py scraped.jsonl --date <today, IST>`
   The script keeps every existing id, marks vanished groups as expired and dates new ones,
   so progress on people's phones is never lost. Never rename or hand-edit ids.
4. Sanity check: `python3 -c "import json;json.load(open('data/objectives.json'))"`, and that the
   active group count did not drop sharply (a failed scrape must not expire everything; if fewer
   than half the previous groups were found, stop and report instead of committing).
5. Commit only `data/objectives.json` with a message like
   `Objectives update 2026-10-25: +2 groups (Name, Name), 1 expired` and push to `main`.
   No app-file changes means no CACHE_VERSION bump is needed.
