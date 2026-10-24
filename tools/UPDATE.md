# Daily objectives update

Run every day at 11:45pm IST (after EA's 6pm UK content drop).

1. Read https://www.fut.gg/objectives/ and list every objective group link
   (`/objectives/<category>/<num>-<slug>/`) with its category (Campaigns, Seasonal,
   Foundations, Milestones, Mastery). The index page misses some groups, so also read each
   category page (`/objectives/campaigns/`, `/objectives/seasonal/`, `/objectives/foundations/`,
   `/objectives/milestones/`, `/objectives/mastery/`) and add any links found there.
   Then read https://www.fut.gg/objectives/expiring-soon/ and note which groups it lists.
2. Read each group page and write one JSON line per group to a scratch file
   (`scraped.jsonl`), in this shape:
   `{"path","category","name","description","expires","expiringSoon","groupRewards","modes","objectives":[{"name","task","target","requirement","reward"}]}`
   - `expiringSoon` is true only for groups on the expiring-soon page (drives the app's Ending soon filter).
   - `target` is the whole number needed to complete it (1 for one-off tasks).
   - `requirement` is only the squad requirement (e.g. "Min. 1 Scottish player in your starting XI"), otherwise null.
   - Put game-mode rules that apply to the whole group in `modes`.
3. `python3 tools/merge_objectives.py scraped.jsonl --date <today, IST>`
   The script keeps every existing id, marks vanished groups as expired and dates new ones,
   so progress on people's phones is never lost. Never rename or hand-edit ids.
   It stamps new groups and new objectives with firstSeenAt (now), which drives the
   app's 24-hour New filter.
4. Sanity check: `python3 -c "import json;json.load(open('data/objectives.json'))"`, and that the
   active group count did not drop sharply (a failed scrape must not expire everything; if fewer
   than half the previous groups were found, stop and report instead of committing).
5. Commit only `data/objectives.json` with a message like
   `Objectives update 2026-10-25: +2 groups (Name, Name), 1 expired` and push to `main`.
   No app-file changes means no CACHE_VERSION bump is needed.

## SBCs (same run)

6. Read https://www.fut.gg/sbc/ and its further pages (`/sbc/?page=2`, …) plus
   https://www.fut.gg/sbc/category/expiring-soon/ and list every SBC link
   (`/sbc/<category>/<num>-<slug>/`) with its category, reward, listed coin cost and repeatable info.
7. For SBCs not yet in `data/sbcs.json`, read the SBC page for its description and each challenge's
   name, reward and requirements. Known SBCs only need the list-page fields (leave out `challenges`
   and the merge keeps the ones already stored). Write one JSON line per SBC to a scratch file:
   `{"path","category","name","description","reward","cost","repeatable","expiringSoon","challenges":[{"name","reward","requirements":[...]}]}`
8. `python3 tools/merge_sbcs.py scraped-sbcs.jsonl --date <today, IST>`, apply the same
   "fewer than half" safety check, and commit `data/sbcs.json` together with `data/objectives.json`.
   (and `data/evos.json`, below). The push triggers `.github/workflows/notify.yml`, which sends iPhone alerts for new objectives,
   new SBCs and anything that just started ending soon.

## Evolutions (same run)

9. Read https://www.fut.gg/evolutions/ (and further pages) for every live Evolution: name, cost
   (null when free), repeatable info and whether it is expiring soon. fut.gg pages read through a
   summarizer lose their links, so find each new Evolution's detail URL
   (`/evolutions/<num>-<slug>/`) with a web search for `fut.gg evolutions <name>`.
10. For Evolutions not yet in `data/evos.json`, read the detail page for requirements and each
    level's objectives and upgrades. Known ones only need the list fields (leave out `levels`).
    One JSON line per Evolution:
    `{"path","name","cost","repeatable","expiringSoon","requirements":[...],"levels":[{"objectives":[...],"upgrades":[...]}]}`
11. `python3 tools/merge_evos.py scraped-evos.jsonl --date <today, IST>`, apply the same
    "fewer than half" check, and commit `data/evos.json` in the same commit.
