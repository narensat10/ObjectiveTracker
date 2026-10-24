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
- NEW badges and a New tab after each daily update; groups that leave the game move to Expired
  (progress kept).
- Token tally for token campaigns (e.g. Phantom Playgrounds 0/450), plus a squad guide for
  Phantom Playgrounds.
- Search, per-group reset (for daily/weekly objectives), reset all (with confirmation),
  export/import backup.

## Files

| Path | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app |
| `data/objectives.json` | Objective data, the only file the daily update changes |
| `manifest.json`, `sw.js`, `icons/` | PWA install + offline cache |
| `tools/merge_objectives.py`, `tools/UPDATE.md` | Daily data update script and steps |

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
- When changing app files, bump `CACHE_VERSION` in `sw.js` and `APP_VERSION` in `app.js`.
- Unofficial fan tool, not affiliated with EA Sports. Data comes from fut.gg, so always check the
  in-game Objectives screen.
