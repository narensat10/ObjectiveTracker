# FC 27 Objectives Tracker

A Home Screen web app (PWA) for tracking every EA Sports FC 27 Ultimate Team objective on iPhone,
refreshed daily from [fut.gg](https://www.fut.gg/objectives/). No account or backend: progress is
saved on the phone (localStorage) and the app works offline.

## Features

- All live objective groups (Campaigns, Seasonal, Foundations, Milestones, Mastery), each with its
  objectives, squad requirements, rewards and a fut.gg link.
- Per objective: progress counter with − / + (bigger steps for very large targets), typed value,
  progress bar, Complete button, and a Player added checkbox wherever there is a squad requirement.
- ★ Track groups to pin them to the Tracking tab; the dashboard totals follow what you track.
- A New tab holding anything added in the last 24 hours (new groups and new objectives inside
  existing groups); groups that leave the game move to Expired
  (progress kept).
- A "Squad needed" summary per group listing each required player and the objectives it covers,
  plus a switch to mark a whole group complete.
- Token tally for token campaigns (e.g. Phantom Playgrounds 0/450), plus a squad guide for
  Phantom Playgrounds.
- Quick match log (+ button): pick the mode and result, optionally goals/assists/etc., and every
  matching objective is updated at once (preview lets you untick any; ⋯ → Undo last match log).
- Ending soon filter and countdowns; Daily and Weekly objectives auto-reset at EA's refresh
  (6pm UK; weekly on Thursday), keeping Player added ticks.
- Rewards summary (tokens, SP, coins, packs, picks) and a combined squad planner across tracked
  groups, flagging players that can cover several requirements.
- Optional iPhone alerts when new objectives land (⋯ → New-objective alerts; Home Screen app,
  iOS 16.4+). Sent by `.github/workflows/notify.yml` when the data file changes; needs the
  `VAPID_PRIVATE_KEY` repo secret and subscriptions in `push/subscriptions.json`.
- Search, per-group reset (for daily/weekly objectives), reset all (with confirmation),
  export/import backup.

## Files

| Path | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app |
| `data/objectives.json` | Objective data, the only file the daily update changes |
| `manifest.json`, `sw.js`, `icons/` | PWA install + offline cache |
| `tools/merge_objectives.py`, `tools/UPDATE.md` | Daily data update script and steps |
| `tools/notify.js`, `.github/workflows/notify.yml`, `push/subscriptions.json` | New-objective push alerts |

## Hosting (GitHub Pages)

1. Push these files to the root of a public GitHub repo.
2. Settings → Pages → Build and deployment → Source: *Deploy from a branch*, `main`, `/ (root)`.
3. The app is live at `https://<username>.github.io/<repo>/` a minute later.

Any static HTTPS host works too (Netlify Drop, Cloudflare Pages).

## Install on iPhone

1. Open the HTTPS link in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open it from the Home Screen. It runs full-screen and works offline after the first load.
   New objectives appear when you reopen the app (or ⋯ → Check for new objectives).

## Notes

- Progress is stored under a fixed key that app and data updates never touch. Saves from the
  first Phantom Playgrounds-only version are migrated automatically, and old backups import fine.
- iOS keeps Home Screen app storage separate from Safari, and may clear data for web apps that
  go unused for weeks, so export a backup now and then (⋯ → Export backup → Save to Files).
- Files are fetched network-first, so a deploy shows up the next time the app is opened (offline it falls back to the cache).
  When changing app files, bump `CACHE_VERSION` in `sw.js` and `APP_VERSION` in `app.js`; the version shows at the bottom of the app.
- Unofficial fan tool, not affiliated with EA Sports. Data comes from fut.gg, so always check the
  in-game Objectives screen.
