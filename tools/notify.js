// Sends Web Push alerts. Run by .github/workflows/notify.yml.
//   After a data commit: new objectives, new SBCs, and groups/SBCs that just started "ending soon".
//   MODE=recap (Sunday schedule): a weekly recap; the phone fills in its own stats (see sw.js).
// Needs the VAPID_PRIVATE_KEY secret; subscriptions live in push/subscriptions.json.
'use strict';
const fs = require('fs');
const { execSync } = require('child_process');

const PUBLIC_KEY = 'BK5UnrgC7Zx2lG2_Wm6W4j4Nq6gkqlcLHtPGMzYywSRC7fBjd_aWaE4XdqEt78SCwtlZXFKdOyFJ8ekrGpCC8W8';
const SITE = 'https://narensat10.github.io/ObjectiveTracker/';

function read(file, rev) {
  try {
    return JSON.parse(rev
      ? execSync(`git show ${rev}:${file}`, { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] })
      : fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function ids(data) {
  const out = new Map();
  for (const g of (data && data.groups) || []) {
    if (g.active === false) continue;
    out.set(g.id, g.name);
    for (const o of g.objectives || []) if (!o.retired) out.set(g.id + '/' + o.id, g.name + ': ' + o.name);
  }
  return out;
}

// Items that are live and flagged expiringSoon now but weren't before this commit.
function newlyEnding(list, beforeList) {
  const was = new Set((beforeList || []).filter(x => x.expiringSoon).map(x => x.id));
  return (list || []).filter(x => x.active !== false && x.expiringSoon && !was.has(x.id)).map(x => ({ id: x.id, name: x.name }));
}

function changes() {
  const now = read('data/objectives.json') || { groups: [] };
  const before = read('data/objectives.json', 'HEAD~1') || { groups: [] };
  const old = ids(before);
  const added = [];
  for (const [id, name] of ids(now)) {
    if (old.has(id)) continue;
    if (id.includes('/') && !old.has(id.split('/')[0])) continue; // the whole group is new; name the group once
    added.push(name);
  }
  const sbcNow = read('data/sbcs.json') || { sbcs: [] };
  const sbcBefore = read('data/sbcs.json', 'HEAD~1');
  // The first SBC file is a baseline, not "new".
  const oldSbc = new Set(((sbcBefore || sbcNow).sbcs || []).map(s => s.id));
  const sbcs = sbcNow.sbcs.filter(s => s.active !== false && !oldSbc.has(s.id)).map(s => s.name);
  return {
    type: 'update',
    added,
    sbcs,
    ending: newlyEnding(now.groups, before.groups),
    sbcEnding: sbcBefore ? newlyEnding(sbcNow.sbcs, sbcBefore.sbcs) : []
  };
}

async function main() {
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!privateKey) { console.log('VAPID_PRIVATE_KEY secret not set, skipping alerts.'); return; }
  const subs = JSON.parse(fs.readFileSync('push/subscriptions.json', 'utf8'));
  if (!subs.length) { console.log('No subscriptions yet.'); return; }

  let msg;
  if (process.env.MODE === 'recap') {
    msg = { type: 'recap' };
  } else {
    msg = changes();
    if (process.env.FORCE_TEST === 'true') msg.added.push('Test alert');
    if (!msg.added.length && !msg.sbcs.length && !msg.ending.length && !msg.sbcEnding.length) { console.log('Nothing new.'); return; }
  }
  // Older app versions only understand title/body/url, so those are always included.
  const n = (msg.added || []).length + (msg.sbcs || []).length;
  msg.title = msg.type === 'recap' ? 'Your FC 27 weekly recap' : n ? `${n} new in FC 27` : 'Ending soon in FC 27';
  msg.body = msg.type === 'recap' ? 'Open the tracker to see your week.'
    : [...(msg.added || []), ...(msg.sbcs || []), ...(msg.ending || []).map(e => e.name)].slice(0, 4).join(', ');
  msg.url = SITE + (msg.type === 'recap' ? '?view=stats' : n ? '?filter=new' : '?filter=soon');
  console.log('Payload:', JSON.stringify(msg));

  const payload = JSON.stringify(msg);
  const webpush = require('web-push');
  webpush.setVapidDetails(SITE, PUBLIC_KEY, privateKey);
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload, { TTL: 12 * 3600 });
      console.log('Sent to', new URL(sub.endpoint).host);
    } catch (e) {
      console.log('Failed for', new URL(sub.endpoint).host, e.statusCode, e.body || e.message);
    }
  }
}

module.exports = { changes };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
