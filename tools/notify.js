// Sends a Web Push alert when a commit adds new objective groups or objectives.
// Run by .github/workflows/notify.yml after data/objectives.json changes.
// Needs the VAPID_PRIVATE_KEY secret; subscriptions live in push/subscriptions.json.
'use strict';
const fs = require('fs');
const { execSync } = require('child_process');
const webpush = require('web-push');

const PUBLIC_KEY = 'BK5UnrgC7Zx2lG2_Wm6W4j4Nq6gkqlcLHtPGMzYywSRC7fBjd_aWaE4XdqEt78SCwtlZXFKdOyFJ8ekrGpCC8W8';
const SITE = 'https://narensat10.github.io/ObjectiveTracker/';

function ids(data) {
  const out = new Map();
  for (const g of data.groups || []) {
    if (g.active === false) continue;
    out.set(g.id, g.name);
    for (const o of g.objectives || []) if (!o.retired) out.set(g.id + '/' + o.id, g.name + ': ' + o.name);
  }
  return out;
}

async function main() {
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!privateKey) { console.log('VAPID_PRIVATE_KEY secret not set, skipping alerts.'); return; }
  const subs = JSON.parse(fs.readFileSync('push/subscriptions.json', 'utf8'));
  if (!subs.length) { console.log('No subscriptions yet.'); return; }

  const now = JSON.parse(fs.readFileSync('data/objectives.json', 'utf8'));
  let before = { groups: [] };
  try { before = JSON.parse(execSync('git show HEAD~1:data/objectives.json', { encoding: 'utf8', maxBuffer: 1 << 26 })); } catch (e) { /* first commit */ }
  const old = ids(before);
  const added = [];
  for (const [id, name] of ids(now)) {
    if (old.has(id)) continue;
    const parent = id.split('/')[0];
    if (id.includes('/') && !old.has(parent)) continue; // the whole group is new; name the group once
    added.push(name);
  }
  if (process.env.FORCE_TEST === 'true') added.push('Test alert');
  if (!added.length) { console.log('Nothing new.'); return; }

  const body = added.slice(0, 3).join(', ') + (added.length > 3 ? ` and ${added.length - 3} more` : '');
  const payload = JSON.stringify({ title: `${added.length} new FC 27 objective${added.length > 1 ? 's' : ''}`, body, url: SITE + '?filter=new' });
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

main().catch(e => { console.error(e); process.exit(1); });
