# FC 27 Objectives Tracker

A Home Screen web app (PWA) for tracking every EA Sports FC 27 Ultimate Team objective and SBC on iPhone,
refreshed daily from [fut.gg](https://www.fut.gg/objectives/). No account or backend: progress is
saved on the phone (localStorage) and the app works offline.

## Features

- **Home** (v5.5, the page the app opens on): your favourites (☆ objectives, ★ tracked groups,
  ★ SBCs and Evolutions) with a quick + for objectives, and everything added in the last 24 hours
  across objectives, SBCs and Evolutions, each a tap away from its full card.
- Finished and skipped groups fold into one "✓ Done" row at the bottom of the Objectives lists (tap to show
  them). Categories you never play can be hidden in Settings; tracked groups always show. (v5.6)
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
- Optional iPhone alerts (⋯ → Alerts; Home Screen app, iOS 16.4+): new objectives and SBCs, a
  heads-up when something you're working on starts ending soon, and a Sunday 8pm IST weekly recap.
  Sent by `.github/workflows/notify.yml`; needs the `VAPID_PRIVATE_KEY` repo secret and
  subscriptions in `push/subscriptions.json`. The phone personalises each alert from a summary
  the app keeps in IndexedDB.
- Play next card: the mode where one match moves the most of your unfinished objectives, and which
  players your XI still needs.
- Screenshot import (📷 on the dashboard): reads progress like 3/10 from screenshots of the in-game
  Objectives screen, on the phone (Tesseract.js in `vendor/tesseract/`, nothing is uploaded).
- SBCs tab: every live SBC from fut.gg with challenges, requirements, rewards and coin estimates;
  tick challenges off, count repeatables, filter by category, New and Ending soon.
- Evos tab: live Evolutions from fut.gg with requirements, levels and upgrades; note the player
  you're evolving, tick levels off, skip ones you don't want, filters for free, new, ending soon.
- Evo planner (Evos tab): each Evolution's best player to use (position, OVR range that reaches the
  cap, pace limit), the best chains of Evolutions to stack on one card for the highest overall, and a
  "Your players" list showing which Evolutions each of your players fits and their best order. Chains and
  Evolution cards name players recommended by FC 27 guides (stored as `picks` in `data/evos.json`), each
  run through the chain to check it fits and show where it finishes. The maths is in `evo-plan.js`.
- Calendar tab: daily and weekly resets, the usual Wednesday TOTW and Friday promo drops, and end
  times you set yourself (fut.gg doesn't publish them) for objective groups, SBCs and Evolutions.
- Completed or skipped objective groups, SBCs and Evolutions collapse automatically; objective
  groups can be skipped too (hidden from the dashboard, Play next and badge).
- Bottom tab bar (Objectives, SBCs, Evos, Calendar) and progress rings on every card.
- Squad suggestion (⋯ → Squad for a mode, or Squad on the Play next card): pick a mode and it packs
  the squad requirements of every unfinished objective you can play there into one XI, ☆ favourite
  objectives first, then ★ tracked groups, then whatever ends soonest. It combines requirements on
  one player only when the 11 spots run out, lists objectives that need no specific players, and
  "I've built this XI" ticks Player added for you.
- Cloud sync (⋯ → Settings): progress, favourites and stats sync between devices through a secret
  GitHub gist, using a token with only the gist permission that stays on each device.
- Stats: matches, win rate, goals, objectives and SBCs done per day (last 14 days), day streak.
- Light/dark/system theme and an app-icon badge with tracked objectives left (⋯ → Theme & badge).
- Search, per-group reset (for daily/weekly objectives), reset all (with confirmation),
  export/import backup.

## Files

| Path | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `app.js`, `evo-plan.js` | The app (`evo-plan.js`: Evolution chain maths) |
| `data/objectives.json`, `data/sbcs.json`, `data/evos.json` | Objective, SBC and Evolution data, the only files the daily update changes |
| `manifest.json`, `sw.js`, `icons/` | PWA install + offline cache |
| `tools/merge_objectives.py`, `tools/merge_sbcs.py`, `tools/merge_evos.py`, `tools/UPDATE.md` | Daily data update scripts and steps |
| `vendor/tesseract/` | On-device text reader for screenshot import (Apache 2.0) |
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
