(function () {
  'use strict';

  var APP_VERSION = '5.1.0';
  // Storage keys are deliberately not tied to APP_VERSION so app and data updates never wipe progress.
  var STORAGE_KEY = 'fc27Objectives.progress';
  var DATA_CACHE_KEY = 'fc27Objectives.dataCache';
  var LEGACY_KEY = 'phantomPlaygrounds.progress'; // v1 (Phantom Playgrounds only)
  var DATA_URL = 'data/objectives.json';
  var SBC_URL = 'data/sbcs.json';
  var SBC_CACHE_KEY = 'fc27Objectives.sbcCache';
  var SBC_CATEGORIES = ['Players', 'Upgrades', 'Challenges', 'Foundations'];
  var EVO_URL = 'data/evos.json';
  var EVO_CACHE_KEY = 'fc27Objectives.evoCache';
  var VIEWS = ['obj', 'sbc', 'evo', 'cal'];
  var CATEGORIES = ['Campaigns', 'Seasonal', 'Foundations', 'Milestones', 'Mastery'];
  var NEW_MS = 24 * 3600 * 1000; // things stay in the New filter for a day after they appear
  var SOON_MS = 24 * 3600 * 1000; // daily/weekly groups count as "ending soon" in their last day
  // Public half of the Web Push key pair; the private half is the VAPID_PRIVATE_KEY repo secret.
  var VAPID_PUBLIC_KEY = 'BK5UnrgC7Zx2lG2_Wm6W4j4Nq6gkqlcLHtPGMzYywSRC7fBjd_aWaE4XdqEt78SCwtlZXFKdOyFJ8ekrGpCC8W8';

  var STAT_KEYS = ['m', 'w', 'd', 'l', 'g', 'a', 'done', 'sbc'];
  var data = null;     // { updatedAt, baseline, groups: [...] }
  var sbcData = null;  // { updatedAt, sbcs: [...] }
  var evoData = null;  // { updatedAt, evos: [...] }
  var groupsById = {};
  var state = load();
  var ui = { filter: state.ui.filter || null, query: '', open: {}, view: state.ui.view || 'obj', sbcFilter: state.ui.sbcFilter || 'all', sbcQuery: '', sbcOpen: state.ui.sbcOpen || {}, evoFilter: state.ui.evoFilter || 'all', evoQuery: '', evoOpen: state.ui.evoOpen || {} };
  if (state.ui.open) ui.open = state.ui.open;

  // ---------- Persistence ----------
  function emptyState() {
    return {
      schema: 2, progress: {}, snap: {}, cycles: {}, logMode: 'rivals', lastLog: null,
      tracked: { 'phantom-playgrounds': true }, ui: { open: { 'phantom-playgrounds': true } },
      sbc: {}, sbcReps: {}, sbcSkip: {}, skip: {}, evo: {}, evoSkip: {}, evoPlayer: {}, ends: {}, fav: {}, stats: {}, doneCount: null, settings: { theme: 'dark', badge: true },
      updatedAt: null
    };
  }

  function toInt(v) {
    var n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
    return isFinite(n) ? n : 0;
  }

  function normalize(raw) {
    var s = emptyState();
    if (!raw || typeof raw !== 'object') return s;
    if (raw.progress && typeof raw.progress === 'object') {
      s.progress = {};
      Object.keys(raw.progress).forEach(function (k) {
        var r = raw.progress[k];
        if (!r || typeof r !== 'object') return;
        s.progress[k] = { p: Math.max(0, toInt(r.p)), added: r.added === true };
      });
    }
    if (raw.tracked && typeof raw.tracked === 'object') {
      s.tracked = {};
      Object.keys(raw.tracked).forEach(function (k) { if (raw.tracked[k] === true) s.tracked[k] = true; });
    }
    // Progress saved before a "mark whole group complete", so switching it off can restore it.
    if (raw.snap && typeof raw.snap === 'object') {
      Object.keys(raw.snap).forEach(function (gid) {
        var g = raw.snap[gid];
        if (!g || typeof g !== 'object') return;
        s.snap[gid] = {};
        Object.keys(g).forEach(function (oid) { s.snap[gid][oid] = Math.max(0, toInt(g[oid])); });
      });
    }
    // Which daily/weekly cycle each auto-resetting group's progress belongs to.
    if (raw.cycles && typeof raw.cycles === 'object') {
      Object.keys(raw.cycles).forEach(function (gid) { if (typeof raw.cycles[gid] === 'number') s.cycles[gid] = raw.cycles[gid]; });
    }
    // SBC challenge ticks ("sbcId/challengeId": true) and how often each repeatable SBC was done.
    if (raw.sbc && typeof raw.sbc === 'object') {
      Object.keys(raw.sbc).forEach(function (k) { if (raw.sbc[k] === true) s.sbc[k] = true; });
    }
    // Skipped objective groups and Evolutions, ticked Evolution levels ("evoId/levelIndex"),
    // the player each Evolution is used on, and end times typed in from the in-game timers.
    ['skip', 'evoSkip', 'evo', 'fav'].forEach(function (f) {
      if (raw[f] && typeof raw[f] === 'object') Object.keys(raw[f]).forEach(function (k) { if (raw[f][k] === true) s[f][k] = true; });
    });
    if (raw.evoPlayer && typeof raw.evoPlayer === 'object') {
      Object.keys(raw.evoPlayer).forEach(function (k) { if (typeof raw.evoPlayer[k] === 'string' && raw.evoPlayer[k].trim()) s.evoPlayer[k] = raw.evoPlayer[k].slice(0, 60); });
    }
    if (raw.ends && typeof raw.ends === 'object') {
      Object.keys(raw.ends).forEach(function (k) { if (typeof raw.ends[k] === 'number' && isFinite(raw.ends[k])) s.ends[k] = raw.ends[k]; });
    }
    // SBCs the player decided not to do; they drop out of To do, totals and coin estimates.
    if (raw.sbcSkip && typeof raw.sbcSkip === 'object') {
      Object.keys(raw.sbcSkip).forEach(function (k) { if (raw.sbcSkip[k] === true) s.sbcSkip[k] = true; });
    }
    if (raw.sbcReps && typeof raw.sbcReps === 'object') {
      Object.keys(raw.sbcReps).forEach(function (k) { var n = Math.max(0, toInt(raw.sbcReps[k])); if (n) s.sbcReps[k] = n; });
    }
    // Per-day activity for the Stats sheet: { 'YYYY-MM-DD': { m, w, d, l, g, a, done, sbc } }.
    if (raw.stats && typeof raw.stats === 'object') {
      Object.keys(raw.stats).forEach(function (day) {
        var r = raw.stats[day];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !r || typeof r !== 'object') return;
        s.stats[day] = {};
        STAT_KEYS.forEach(function (k) { s.stats[day][k] = Math.max(0, toInt(r[k] || 0)); });
      });
    }
    if (typeof raw.doneCount === 'number') s.doneCount = raw.doneCount;
    if (raw.settings && typeof raw.settings === 'object') {
      if (['dark', 'light', 'system'].indexOf(raw.settings.theme) !== -1) s.settings.theme = raw.settings.theme;
      s.settings.badge = raw.settings.badge !== false;
    }
    if (typeof raw.logMode === 'string') s.logMode = raw.logMode;
    if (raw.lastLog && Array.isArray(raw.lastLog.changes)) s.lastLog = raw.lastLog;
    if (raw.ui && typeof raw.ui === 'object') {
      s.ui = {
        filter: typeof raw.ui.filter === 'string' ? raw.ui.filter : null,
        open: raw.ui.open && typeof raw.ui.open === 'object' ? raw.ui.open : {},
        view: VIEWS.indexOf(raw.ui.view) !== -1 ? raw.ui.view : 'obj',
        evoFilter: typeof raw.ui.evoFilter === 'string' ? raw.ui.evoFilter : 'all',
        evoOpen: raw.ui.evoOpen && typeof raw.ui.evoOpen === 'object' ? raw.ui.evoOpen : {},
        sbcFilter: typeof raw.ui.sbcFilter === 'string' ? raw.ui.sbcFilter : 'all',
        sbcOpen: raw.ui.sbcOpen && typeof raw.ui.sbcOpen === 'object' ? raw.ui.sbcOpen : {}
      };
    }
    s.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
    s.editedAt = typeof raw.editedAt === 'string' ? raw.editedAt : s.updatedAt;
    return s;
  }

  // Turn a v1 Phantom Playgrounds save (or backup) into v2 progress entries.
  function fromLegacy(raw) {
    var s = emptyState();
    if (raw && raw.objectives && typeof raw.objectives === 'object') {
      Object.keys(raw.objectives).forEach(function (id) {
        var r = raw.objectives[id] || {};
        s.progress['phantom-playgrounds/' + id] = { p: Math.max(0, toInt(r.progress)), added: r.playerAdded === true };
      });
    }
    return s;
  }

  function load() {
    try {
      var txt = localStorage.getItem(STORAGE_KEY);
      if (txt) return normalize(JSON.parse(txt));
      var legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        var migrated = fromLegacy(JSON.parse(legacy));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated)); // the v1 key is left in place as a safety copy
        return migrated;
      }
    } catch (e) { /* fall through */ }
    return emptyState();
  }

  var storageOk = true;
  // quiet: the done count changed for a reason that isn't the player finishing things
  // (auto-reset, import, reset), so it must not show up in Stats.
  function save(quiet) {
    state.updatedAt = new Date().toISOString();
    state.ui = { filter: ui.filter, open: ui.open, view: ui.view, sbcFilter: ui.sbcFilter, sbcOpen: ui.sbcOpen, evoFilter: ui.evoFilter, evoOpen: ui.evoOpen };
    trackDone(quiet);
    if (SYNCED) noteEdit();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      storageOk = true;
    } catch (e) {
      if (storageOk) toast('Could not save on this device (private browsing?)');
      storageOk = false;
    }
    if (SYNCED) scheduleSync();
  }

  // ---------- Stats bookkeeping ----------
  function dayKey(t) {
    var d = new Date(t || Date.now());
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function today() {
    var k = dayKey();
    if (!state.stats[k]) {
      state.stats[k] = {};
      STAT_KEYS.forEach(function (x) { state.stats[k][x] = 0; });
      // Keep about four months of history.
      Object.keys(state.stats).sort().slice(0, -120).forEach(function (old) { delete state.stats[old]; });
    }
    return state.stats[k];
  }
  function countDone() {
    var n = 0;
    data.groups.forEach(function (g) { g.objectives.forEach(function (o) { if (isDone(g, o)) n++; }); });
    return n;
  }
  // Objectives finished today = rise in the overall done count (an undo the same day takes it back).
  function trackDone(quiet) {
    if (!data) return;
    var n = countDone();
    if (state.doneCount !== null && !quiet && n !== state.doneCount) {
      var t = today();
      t.done = Math.max(0, t.done + n - state.doneCount);
    }
    state.doneCount = n;
  }

  // ---------- Helpers ----------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function $(id) { return document.getElementById(id); }
  function key(g, o) { return g.id + '/' + o.id; }
  function prog(g, o) { return state.progress[key(g, o)] || { p: 0, added: false }; }
  function value(g, o) { return Math.min(o.target, prog(g, o).p); }
  function isDone(g, o) { return value(g, o) >= o.target; }
  function liveObjectives(g) { return g.objectives.filter(function (o) { return !o.retired; }); }
  function groupDone(g) { var l = liveObjectives(g); return l.length > 0 && l.every(function (o) { return isDone(g, o); }); }
  function skipped(g) { return !!state.skip[g.id]; }
  // Groups that count: live and not skipped.
  function inPlay(g) { return g.active !== false && !skipped(g); }
  function stepFor(t) { return t >= 20000 ? 500 : t >= 2000 ? 100 : 1; }
  function fmt(n) { return Number(n).toLocaleString('en-GB'); }
  function tokensIn(s) { var m = /(\d[\d,]*)\s*Tokens?\b/i.exec(s || ''); return m ? toInt(m[1]) : 0; }
  // firstSeenAt is when the daily update first saw it; older data only has a date, which
  // means the 11:45pm IST run of that day.
  function seenRecently(at, day) {
    if (!data) return false;
    if (!at) {
      if (!day || day <= (data.baseline || '')) return false; // the first import is not "new"
      at = day + 'T23:45:00+05:30';
    }
    var t = Date.parse(at);
    return isFinite(t) && Date.now() - t < NEW_MS;
  }
  function objNew(g, o) { return !o.retired && seenRecently(o.firstSeenAt, null); }
  function groupNew(g) { return g.active !== false && seenRecently(g.firstSeenAt, g.firstSeen); }
  function isNew(g) { return g.active !== false && (groupNew(g) || g.objectives.some(function (o) { return objNew(g, o); })); }
  function nextResetAt(g) {
    if (!g.resets) return null;
    // Step a period ahead (plus slack for a clock change) and snap back to that reset.
    var approx = lastReset(g.resets, Date.now()) + (g.resets === 'daily' ? 1 : 7) * 864e5;
    return lastReset(g.resets, approx + 2 * 36e5);
  }
  function endsAt(g) {
    if (state.ends['g:' + g.id]) return state.ends['g:' + g.id]; // typed in from the in-game timer
    var t = g.expires ? Date.parse(g.expires) : NaN;
    return isFinite(t) ? t : nextResetAt(g);
  }
  function endingSoon(g) {
    if (g.active === false || groupDone(g)) return false;
    var t = endsAt(g);
    return !!g.expiringSoon || (t != null && t - Date.now() < SOON_MS);
  }
  function countdown(t) {
    var ms = t - Date.now();
    if (ms <= 0) return 'now';
    var h = Math.floor(ms / 36e5), m = Math.floor(ms % 36e5 / 6e4);
    return h >= 48 ? Math.floor(h / 24) + 'd ' + (h % 24) + 'h' : h ? h + 'h ' + m + 'm' : m + 'm';
  }
  function niceDate(iso) {
    var d = new Date(iso + 'T12:00:00Z');
    return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  function setProgress(g, o, v) {
    var k = key(g, o);
    var cur = state.progress[k] || { p: 0, added: false };
    var was = cur.p >= o.target;
    var next = Math.max(0, Math.min(o.target, toInt(v)));
    state.progress[k] = { p: next, added: cur.added };
    save();
    refresh();
    if (!was && next >= o.target) {
      toast(groupDone(g) ? g.name + ' complete! 🎉' : o.name + ' complete');
      if (navigator.vibrate) navigator.vibrate(30);
    }
  }

  function setGroupComplete(g, on) {
    var live = liveObjectives(g);
    if (on) {
      var snap = {};
      live.forEach(function (o) {
        var cur = prog(g, o);
        snap[o.id] = cur.p;
        state.progress[key(g, o)] = { p: o.target, added: cur.added };
      });
      state.snap[g.id] = snap;
      toast(g.name + ' marked complete');
    } else {
      var saved = state.snap[g.id] || {};
      // If there is nothing unfinished to go back to, switching off clears the group instead.
      var restore = live.some(function (o) { return (saved[o.id] || 0) < o.target; });
      live.forEach(function (o) {
        var cur = prog(g, o);
        state.progress[key(g, o)] = { p: restore ? Math.min(o.target, saved[o.id] || 0) : 0, added: cur.added };
      });
      delete state.snap[g.id];
      toast(restore && Object.keys(saved).length ? 'Previous progress restored' : g.name + ' cleared');
    }
    save();
    refresh();
  }

  function setSkipped(g, on) {
    if (on) state.skip[g.id] = true; else delete state.skip[g.id];
    toast(on ? g.name + ' skipped' : g.name + ' back on your list');
    save();
    renderChips();
    refresh();
  }

  function setAdded(g, o, on) {
    var k = key(g, o);
    var cur = state.progress[k] || { p: 0, added: false };
    state.progress[k] = { p: cur.p, added: on };
    save();
    refresh();
  }

  // ---------- Rendering ----------
  var groupsEl = $('groups');
  var views = {}; // gid -> { root, ... , rows: { oid: {...} } }

  function buildObjective(g, o, index) {
    var card = el('article', 'card' + (o.retired ? ' retired' : ''));
    card.dataset.key = key(g, o);

    var head = el('div', 'card-head');
    head.appendChild(el('span', 'card-num', String(index + 1)));
    var title = el('div', 'card-title');
    title.appendChild(el('h3', null, o.name));
    if (o.task && o.task !== o.name) title.appendChild(el('p', 'card-desc', o.task));
    head.appendChild(title);
    var newTag = el('span', 'tag new', 'New');
    head.appendChild(newTag);
    head.appendChild(el('span', 'badge', 'Done'));
    card.appendChild(head);

    var row = { card: card, newTag: newTag };
    if (o.requirement) {
      var req = el('div', 'req');
      req.appendChild(el('span', 'req-label', 'Squad'));
      req.appendChild(el('span', 'req-text', o.requirement));
      card.appendChild(req);

      var player = el('label', 'player');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'player-cb';
      cb.addEventListener('change', function () { setAdded(g, o, cb.checked); });
      player.appendChild(cb);
      player.appendChild(el('span', null, 'Player added'));
      card.appendChild(player);
      row.cb = cb;
    }

    var pr = el('div', 'progress-row');
    var bar = el('div', 'bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', o.name + ' progress');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(o.target));
    var fill = el('div', 'bar-fill');
    bar.appendChild(fill);
    pr.appendChild(bar);
    var count = el('span', 'count');
    pr.appendChild(count);
    card.appendChild(pr);

    var step = stepFor(o.target);
    var controls = el('div', 'controls');
    var minus = el('button', 'step minus', '−');
    minus.type = 'button';
    minus.setAttribute('aria-label', 'Decrease ' + o.name + (step > 1 ? ' by ' + step : ''));
    var input = document.createElement('input');
    input.type = 'number';
    input.className = 'value-input';
    input.inputMode = 'numeric';
    input.min = '0';
    input.max = String(o.target);
    input.setAttribute('aria-label', o.name + ' progress value');
    var plus = el('button', 'step plus', '+');
    plus.type = 'button';
    plus.setAttribute('aria-label', 'Increase ' + o.name + (step > 1 ? ' by ' + step : ''));
    var complete = el('button', 'complete-btn', 'Complete');
    complete.type = 'button';

    minus.addEventListener('click', function () { setProgress(g, o, value(g, o) - step); });
    plus.addEventListener('click', function () { setProgress(g, o, value(g, o) + step); });
    complete.addEventListener('click', function () { setProgress(g, o, o.target); });
    input.addEventListener('change', function () { setProgress(g, o, input.value); });
    input.addEventListener('focus', function () { input.select(); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') input.blur(); });

    controls.appendChild(minus);
    controls.appendChild(input);
    controls.appendChild(plus);
    controls.appendChild(complete);
    card.appendChild(controls);

    if (o.reward) card.appendChild(el('p', 'reward-line', o.reward));

    row.bar = bar; row.fill = fill; row.count = count; row.input = input; row.minus = minus; row.plus = plus; row.complete = complete;
    return row;
  }

  function buildGroup(g) {
    var root = el('section', 'group');
    root.dataset.id = g.id;

    var top = el('div', 'group-top');
    var head = el('button', 'group-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
    var ring = el('span', 'ring-mini');
    ring.setAttribute('aria-hidden', 'true');
    head.appendChild(ring);
    var title = el('div', 'group-title');
    title.appendChild(el('h2', null, g.name));
    var tags = el('span', 'tags');
    title.appendChild(tags);
    head.appendChild(title);
    var count = el('span', 'group-count');
    head.appendChild(count);
    var bar = el('div', 'bar');
    var fill = el('div', 'bar-fill');
    bar.appendChild(fill);
    head.appendChild(bar);
    var sub = el('p', 'group-sub');
    var subLeft = el('span');
    var subRight = el('span');
    sub.appendChild(subLeft);
    sub.appendChild(subRight);
    head.appendChild(sub);
    top.appendChild(head);

    var star = el('button', 'star', '★');
    star.type = 'button';
    star.setAttribute('aria-label', 'Track ' + g.name);
    star.addEventListener('click', function () {
      if (state.tracked[g.id]) delete state.tracked[g.id]; else state.tracked[g.id] = true;
      save();
      toast(state.tracked[g.id] ? 'Tracking ' + g.name : 'Stopped tracking ' + g.name);
      renderChips();
      refresh();
    });
    top.appendChild(star);
    root.appendChild(top);

    var body = el('div', 'group-body');
    body.hidden = true;
    root.appendChild(body);

    var view = { root: root, head: head, ring: ring, tags: tags, count: count, fill: fill, subLeft: subLeft, subRight: subRight, star: star, body: body, rows: {}, built: false };
    head.addEventListener('click', function () {
      var open = body.hidden;
      setOpen(g, view, open);
      save();
    });
    return view;
  }

  function buildBody(g, view) {
    var body = view.body;
    var meta = el('div', 'group-meta');
    if (g.description) meta.appendChild(el('p', null, g.description));
    meta.appendChild(buildSquad(g, view));
    if (g.modes) meta.appendChild(metaRow('Modes', g.modes));
    if (g.groupRewards) meta.appendChild(metaRow('Reward', g.groupRewards, 'reward'));
    if (g.expires) meta.appendChild(metaRow('Ends', g.expires));
    body.appendChild(meta);

    var sw = el('label', 'group-switch');
    sw.appendChild(el('span', null, 'Mark whole group complete'));
    var swIn = document.createElement('input');
    swIn.type = 'checkbox';
    swIn.className = 'switch';
    swIn.setAttribute('role', 'switch');
    swIn.addEventListener('change', function () { setGroupComplete(g, swIn.checked); });
    sw.appendChild(swIn);
    body.appendChild(sw);
    view.sw = swIn;

    var sk = el('label', 'group-switch');
    sk.appendChild(el('span', null, 'Skip this group'));
    var skIn = document.createElement('input');
    skIn.type = 'checkbox';
    skIn.className = 'switch';
    skIn.setAttribute('role', 'switch');
    skIn.addEventListener('change', function () { setSkipped(g, skIn.checked); });
    sk.appendChild(skIn);
    body.appendChild(sk);
    view.skip = skIn;
    view.skipRow = sk;

    var tpl = document.getElementById('guide-' + g.id);
    if (tpl && tpl.content) body.appendChild(tpl.content.cloneNode(true));

    var list = el('div', 'objectives');
    g.objectives.forEach(function (o, i) {
      var row = buildObjective(g, o, i);
      view.rows[o.id] = row;
      list.appendChild(row.card);
    });
    body.appendChild(list);

    var actions = el('div', 'group-actions');
    if (g.url) {
      var link = el('a', 'mini-btn', 'View on fut.gg ↗');
      link.href = g.url;
      link.target = '_blank';
      link.rel = 'noopener';
      actions.appendChild(link);
    }
    var reset = el('button', 'mini-btn danger', 'Reset this group');
    reset.type = 'button';
    reset.addEventListener('click', function () {
      askConfirm('Reset ' + g.name + '?', 'Clears progress and Player added ticks for this group only. Handy when daily or weekly objectives refresh.', function () {
        g.objectives.forEach(function (o) { delete state.progress[key(g, o)]; });
        delete state.snap[g.id];
        save();
        refresh();
        toast(g.name + ' reset');
      });
    });
    actions.appendChild(reset);
    body.appendChild(actions);
    view.built = true;
  }

  function cleanReq(r) {
    return r.replace(/\s*in (your|the) starting (xi|11)\.?$/i, '').replace(/\.$/, '').trim();
  }

  // One box per group listing every squad requirement, deduplicated, with the objectives it covers.
  function buildSquad(g, view) {
    var live = liveObjectives(g);
    var reqs = [];
    live.forEach(function (o) {
      if (!o.requirement) return;
      var text = cleanReq(o.requirement);
      var hit = reqs.filter(function (r) { return r.text.toLowerCase() === text.toLowerCase(); })[0];
      if (hit) hit.objs.push(o); else reqs.push({ text: text, objs: [o] });
    });
    var box = el('div', 'squad-box');
    box.appendChild(el('h4', null, 'Squad needed'));
    view.squadItems = [];
    if (!reqs.length) {
      box.appendChild(el('p', 'squad-sum', 'No special players needed. Any squad works' + (g.modes ? ', as long as you play in the modes listed below.' : '.')));
      return box;
    }
    var withReq = reqs.reduce(function (n, r) { return n + r.objs.length; }, 0);
    box.appendChild(el('p', 'squad-sum', reqs.length === 1
      ? 'Have this in your starting XI for ' + (withReq === live.length ? 'every objective' : withReq + ' of the ' + live.length + ' objectives') + ':'
      : 'To finish everything, use one starting XI that includes all of these:'));
    var ul = el('ul', 'squad-list');
    reqs.forEach(function (r) {
      var li = el('li');
      li.appendChild(el('b', null, r.text));
      var names = el('span', 'squad-objs', r.objs.map(function (o) { return o.name; }).join(', '));
      li.appendChild(names);
      ul.appendChild(li);
      view.squadItems.push({ li: li, objs: r.objs });
    });
    box.appendChild(ul);
    var free = live.length - withReq;
    if (free > 0 && reqs.length > 1) box.appendChild(el('p', 'squad-note', 'The other ' + free + ' objective' + (free > 1 ? 's need' : ' needs') + ' no special players.'));
    if (reqs.length > 1) box.appendChild(el('p', 'squad-note', 'One player can tick several boxes (e.g. a player who is both the right nation and league).'));
    return box;
  }

  function metaRow(label, text, cls) {
    var r = el('div', 'meta-row' + (cls ? ' ' + cls : ''));
    r.appendChild(el('span', 'req-label', label));
    r.appendChild(el('span', null, text));
    return r;
  }

  function setOpen(g, view, open) {
    if (open && !view.built) { buildBody(g, view); updateGroup(g, view); }
    view.body.hidden = !open;
    view.root.classList.toggle('open', open);
    view.head.setAttribute('aria-expanded', String(open));
    if (open) ui.open[g.id] = true; else delete ui.open[g.id];
  }

  function updateGroup(g, view) {
    var live = liveObjectives(g);
    var done = live.filter(function (o) { return isDone(g, o); }).length;
    var gDone = done === live.length && live.length > 0;
    var skip = skipped(g) && !gDone;
    view.root.classList.toggle('is-complete', gDone);
    view.root.classList.toggle('is-skipped', skip);
    // A group that just got finished or skipped folds itself away; tapping it opens it again.
    var settled = gDone || skip;
    if (settled && !view.settled && !view.body.hidden) { setOpen(g, view, false); if (view.settled !== undefined) save(); }
    view.settled = settled;
    if (view.ring) view.ring.style.setProperty('--p', live.length ? Math.round(done / live.length * 100) : 0);
    view.count.innerHTML = '';
    view.count.appendChild(document.createTextNode(String(done)));
    view.count.appendChild(el('small', null, '/' + live.length));
    view.fill.style.width = (live.length ? done / live.length * 100 : 0) + '%';

    view.tags.innerHTML = '';
    view.tags.appendChild(el('span', 'tag', g.category));
    if (groupNew(g)) view.tags.appendChild(el('span', 'tag new', 'New'));
    else if (isNew(g)) view.tags.appendChild(el('span', 'tag new', 'New objectives'));
    if (endingSoon(g)) view.tags.appendChild(el('span', 'tag soon', 'Ending soon'));
    if (g.active === false) view.tags.appendChild(el('span', 'tag expired', 'Expired'));
    if (gDone) view.tags.appendChild(el('span', 'tag done', 'Done'));
    if (skip) view.tags.appendChild(el('span', 'tag skipped', 'Skipped'));

    var totalTok = 0, earnedTok = 0;
    live.forEach(function (o) { var t = tokensIn(o.reward); totalTok += t; if (isDone(g, o)) earnedTok += t; });
    var bonus = tokensIn(g.groupRewards);
    totalTok += bonus;
    if (gDone) earnedTok += bonus;
    view.subLeft.textContent = totalTok ? 'Tokens ' + earnedTok + '/' + totalTok : (g.groupRewards ? '🎁 ' + g.groupRewards : '');
    var ends = g.active !== false ? endsAt(g) : null;
    view.subRight.textContent = ends ? (g.resets ? 'Resets in ' : 'Ends in ') + countdown(ends)
      : totalTok && bonus ? (gDone ? 'Group bonus earned' : 'Group bonus +' + bonus) : '';

    view.star.setAttribute('aria-pressed', String(!!state.tracked[g.id]));

    if (!view.built) return;
    view.sw.checked = gDone;
    view.skip.checked = skipped(g);
    view.skipRow.hidden = gDone;
    (view.squadItems || []).forEach(function (it) {
      it.li.classList.toggle('done', it.objs.every(function (o) { return isDone(g, o); }));
    });
    view.sw.setAttribute('aria-checked', String(gDone));
    g.objectives.forEach(function (o) {
      var r = view.rows[o.id];
      var p = prog(g, o);
      var v = Math.min(o.target, p.p);
      var d = v >= o.target;
      r.card.classList.toggle('is-complete', d);
      r.newTag.hidden = !objNew(g, o);
      if (r.cb) r.cb.checked = p.added;
      r.fill.style.width = (v / o.target * 100) + '%';
      r.bar.setAttribute('aria-valuenow', String(v));
      r.count.innerHTML = '';
      r.count.appendChild(document.createTextNode(fmt(v)));
      r.count.appendChild(el('small', null, '/' + fmt(o.target)));
      if (document.activeElement !== r.input) r.input.value = String(v);
      r.minus.disabled = v <= 0;
      r.plus.disabled = d;
      r.complete.disabled = d;
      r.complete.textContent = d ? 'Completed' : 'Complete';
    });
  }

  function matches(g, q) {
    if (!q) return true;
    var hay = [g.name, g.category, g.description, g.modes, g.groupRewards].concat(g.objectives.map(function (o) {
      return [o.name, o.task, o.requirement, o.reward].join(' ');
    })).join(' ').toLowerCase();
    return q.split(/\s+/).every(function (w) { return hay.indexOf(w) !== -1; });
  }

  function inFilter(g, f) {
    if (f === 'expired') return g.active === false;
    if (g.active === false) return false;
    if (f === 'skipped') return skipped(g);
    if (f === 'tracking') return !!state.tracked[g.id];
    if (f === 'new') return isNew(g);
    if (f === 'soon') return endingSoon(g) && !skipped(g);
    if (f === 'done') return groupDone(g);
    if (f === 'all') return true;
    return g.category === f;
  }

  function filters() {
    var list = [
      { id: 'tracking', label: '★ Tracking' },
      { id: 'all', label: 'All' }
    ];
    list.push({ id: 'new', label: 'New' });
    list.push({ id: 'soon', label: 'Ending soon' });
    CATEGORIES.forEach(function (c) { if (data.groups.some(function (g) { return g.active !== false && g.category === c; })) list.push({ id: c, label: c }); });
    data.groups.forEach(function (g) {
      if (g.active !== false && CATEGORIES.indexOf(g.category) === -1 && !list.some(function (x) { return x.id === g.category; })) list.push({ id: g.category, label: g.category });
    });
    list.push({ id: 'done', label: 'Completed' });
    if (data.groups.some(function (g) { return g.active !== false && skipped(g); })) list.push({ id: 'skipped', label: 'Skipped' });
    if (data.groups.some(function (g) { return g.active === false; })) list.push({ id: 'expired', label: 'Expired' });
    return list;
  }

  function renderChips() {
    var chips = $('chips');
    chips.innerHTML = '';
    var list = filters();
    if (!ui.filter || !list.some(function (f) { return f.id === ui.filter; })) {
      ui.filter = Object.keys(state.tracked).length ? 'tracking' : 'all';
    }
    list.forEach(function (f) {
      var b = el('button', 'chip', f.label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.filter = f.id;
      b.setAttribute('aria-selected', String(f.id === ui.filter));
      var n = data.groups.filter(function (g) { return inFilter(g, f.id); }).length;
      b.appendChild(el('span', 'n', String(n)));
      b.addEventListener('click', function () {
        ui.filter = f.id;
        save();
        renderChips();
        refresh();
      });
      chips.appendChild(b);
    });
  }

  function renderAll() {
    groupsEl.innerHTML = '';
    views = {};
    groupsById = {};
    data.groups.forEach(function (g) {
      groupsById[g.id] = g;
      var v = buildGroup(g);
      views[g.id] = v;
      groupsEl.appendChild(v.root);
      if (ui.open[g.id]) setOpen(g, v, true);
    });
    var newCount = data.groups.filter(isNew).length;
    $('dataInfo').textContent = 'Ultimate Team · updated ' + niceDate(data.updatedAt);
    applyResets();
    renderChips();
    refresh();
    if (newCount && !sessionStorageGet('seenNew-' + data.updatedAt)) {
      toast(newCount + ' new objective group' + (newCount > 1 ? 's' : '') + ' added');
      sessionStorageSet('seenNew-' + data.updatedAt);
    }
  }

  function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function sessionStorageSet(k) { try { sessionStorage.setItem(k, '1'); } catch (e) { /* ignore */ } }

  function refresh() {
    if (!data) return;
    var q = ui.query.trim().toLowerCase();
    var shown = 0;
    data.groups.forEach(function (g) {
      var v = views[g.id];
      updateGroup(g, v);
      var visible = q ? (g.active !== false && matches(g, q)) : inFilter(g, ui.filter);
      v.root.hidden = !visible;
      v.root.style.order = groupDone(g) || skipped(g) ? 1 : 0; // finished and skipped groups sink to the bottom
      if (visible) shown++;
    });
    var empty = $('emptyMsg');
    empty.hidden = shown > 0;
    if (!shown) {
      empty.textContent = q ? 'No objectives match “' + ui.query.trim() + '”.'
        : ui.filter === 'tracking' ? 'Nothing tracked yet. Tap ★ on any group to pin it here.'
        : ui.filter === 'soon' ? 'Nothing ending soon that you still need to finish.'
        : ui.filter === 'new' ? 'Nothing new in the last 24 hours. New objectives land here after the nightly update (11:45pm IST) and stay for a day.'
        : 'Nothing here yet.';
    }
    updateDashboard();
    renderPlanner();
    renderPlayNext();
    updateBadge();
    mirror();
    $('undoLogBtn').hidden = !state.lastLog;
  }

  function updateDashboard() {
    var tracked = data.groups.filter(function (g) { return inPlay(g) && state.tracked[g.id]; });
    var scope = tracked.length ? tracked : data.groups.filter(inPlay);
    var objDone = 0, objTotal = 0, gDone = 0, players = 0, playersTotal = 0;
    scope.forEach(function (g) {
      liveObjectives(g).forEach(function (o) {
        objTotal++;
        if (isDone(g, o)) objDone++;
        if (o.requirement) { playersTotal++; if (prog(g, o).added) players++; }
      });
      if (groupDone(g)) gDone++;
    });
    var pct = objTotal ? Math.round(objDone / objTotal * 100) : 0;
    $('dashPercent').textContent = pct + '%';
    $('dashScope').textContent = tracked.length ? 'tracked' : 'all';
    $('ring').style.setProperty('--p', pct);
    $('dashObjDone').textContent = objDone;
    $('dashObjTotal').textContent = objTotal;
    $('dashGroupsDone').textContent = gDone;
    $('dashGroupsTotal').textContent = scope.length;
    $('dashPlayers').textContent = players;
    $('dashPlayersTotal').textContent = playersTotal;
    var note = $('dashNote');
    note.innerHTML = '';
    note.appendChild(document.createTextNode(tracked.length
      ? 'Showing totals for your ' + tracked.length + ' tracked group' + (tracked.length > 1 ? 's' : '') + '. '
      : 'Showing totals for all live groups. Tap ★ on a group to focus on it. '));
    var n = data.groups.filter(isNew).length;
    if (n) { note.appendChild(el('b', null, n + ' new')); note.appendChild(document.createTextNode(' in the last 24 hours (see the New tab).')); }
    renderRewards(scope);
  }

  // ---------- Data loading ----------
  function validData(d) {
    return d && Array.isArray(d.groups) && d.groups.every(function (g) {
      return g && typeof g.id === 'string' && Array.isArray(g.objectives) && g.objectives.every(function (o) { return o && typeof o.id === 'string' && o.target > 0; });
    });
  }

  function cachedData() {
    try { var d = JSON.parse(localStorage.getItem(DATA_CACHE_KEY)); return validData(d) ? d : null; } catch (e) { return null; }
  }

  function loadData(manual) {
    return fetch(DATA_URL, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        if (!validData(d)) throw new Error('bad data');
        var changed = !data || JSON.stringify(d) !== JSON.stringify(data);
        try { localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(d)); } catch (e) { /* ignore */ }
        if (changed) { data = d; renderAll(); }
        if (manual) toast(changed ? 'Objectives updated' : 'Already up to date (' + niceDate(d.updatedAt) + ')');
      })
      .catch(function () {
        if (!data) {
          var c = cachedData();
          if (c) { data = c; renderAll(); }
          else { $('loading').textContent = 'Could not load objectives. Connect to the internet once, then reopen the app.'; }
        }
        if (manual) toast('Offline: showing saved objectives');
      });
  }

  // ---------- Toast ----------
  var toastEl = $('toast');
  var toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2400);
  }

  // ---------- Menu, backup & reset ----------
  var sheet = $('sheet');
  var confirmEl = $('confirm');
  var menuBtn = $('menuBtn');
  var onConfirm = null;

  function openSheet(node) { node.hidden = false; }
  function closeSheet(node) { node.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); }
  function askConfirm(title, text, fn, yes) {
    $('confirmYes').textContent = yes || 'Yes, reset';
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    onConfirm = fn;
    openSheet(confirmEl);
    $('confirmNo').focus();
  }

  menuBtn.addEventListener('click', function () { menuBtn.setAttribute('aria-expanded', 'true'); openSheet(sheet); });
  $('sheetClose').addEventListener('click', function () { closeSheet(sheet); });
  [sheet, confirmEl].forEach(function (node) {
    node.addEventListener('click', function (e) { if (e.target === node) closeSheet(node); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { [sheet, confirmEl, $('logSheet'), $('alertsSheet'), $('statsSheet'), $('settingsSheet'), $('scanSheet'), $('endsSheet'), $('squadSheet')].forEach(closeSheet); }
  });
  $('confirmNo').addEventListener('click', function () { closeSheet(confirmEl); });
  $('confirmYes').addEventListener('click', function () {
    closeSheet(confirmEl);
    if (onConfirm) { var fn = onConfirm; onConfirm = null; fn(); }
  });

  $('refreshBtn').addEventListener('click', function () { closeSheet(sheet); loadData(true); });

  function backupJson() {
    return JSON.stringify({
      app: 'fc27-objectives-tracker',
      appVersion: APP_VERSION,
      schema: 2,
      exportedAt: new Date().toISOString(),
      dataUpdatedAt: data && data.updatedAt,
      progress: state.progress,
      tracked: state.tracked,
      snap: state.snap,
      cycles: state.cycles,
      sbc: state.sbc,
      sbcReps: state.sbcReps,
      sbcSkip: state.sbcSkip,
      skip: state.skip,
      evo: state.evo,
      evoSkip: state.evoSkip,
      evoPlayer: state.evoPlayer,
      ends: state.ends,
      fav: state.fav,
      stats: state.stats
    }, null, 2);
  }

  function backupName() {
    return 'fc27-objectives-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  }

  $('exportBtn').addEventListener('click', function () {
    var json = backupJson();
    var name = backupName();
    var file;
    try { file = new File([json], name, { type: 'application/json' }); } catch (e) { file = null; }
    // iOS (especially the Home Screen app) handles the share sheet better than downloads.
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'FC 27 objectives backup' })
        .then(function () { closeSheet(sheet); toast('Backup shared'); })
        .catch(function (err) { if (err && err.name !== 'AbortError') downloadFallback(json, name); });
      return;
    }
    downloadFallback(json, name);
  });

  function downloadFallback(json, name) {
    var url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    closeSheet(sheet);
    toast('Backup downloaded');
  }

  $('copyBtn').addEventListener('click', function () {
    var json = backupJson();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json)
        .then(function () { closeSheet(sheet); toast('Backup copied to clipboard'); })
        .catch(function () { toast('Copy failed. Use Export instead.'); });
    } else {
      toast('Clipboard not available. Use Export instead.');
    }
  });

  var importFile = $('importFile');
  $('importBtn').addEventListener('click', function () { importFile.click(); });
  importFile.addEventListener('change', function () {
    var f = importFile.files && importFile.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var raw = JSON.parse(String(reader.result));
        var next;
        if (raw && raw.progress && typeof raw.progress === 'object') next = normalize(raw);
        else if (raw && raw.objectives && typeof raw.objectives === 'object') next = fromLegacy(raw); // v1 Phantom Playgrounds backup
        else throw new Error('bad');
        next.settings = state.settings; // look & feel belongs to this phone, not the backup
        if (!raw.stats) next.stats = state.stats;
        state = next;
        save(true);
        if (data) { renderChips(); refresh(); }
        closeSheet(sheet);
        toast('Backup restored');
      } catch (e) {
        toast('That file is not a valid backup');
      }
      importFile.value = '';
    };
    reader.readAsText(f);
  });

  $('resetBtn').addEventListener('click', function () {
    closeSheet(sheet);
    askConfirm('Reset all progress?', 'This clears progress and Player added ticks for every objective, every SBC and Evolution tick, and everything you skipped. Your tracked groups and stats stay. Export a backup first if you might want it back.', function () {
      state.progress = {};
      state.snap = {};
      state.sbc = {};
      state.sbcReps = {};
      state.sbcSkip = {};
      state.skip = {};
      state.evo = {};
      state.evoSkip = {};
      save(true);
      renderAll();
      if (sbcData) renderSbcs();
      if (evoData) renderEvos();
      refresh();
      toast('Progress reset');
    });
  });

  // ---------- Daily / weekly resets (EA refreshes at 6pm UK; weekly ones on Thursdays) ----------
  var londonFmt = null;
  function londonParts(t) {
    if (!londonFmt) {
      londonFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false });
    }
    var p = {};
    londonFmt.formatToParts(new Date(t)).forEach(function (x) { p[x.type] = x.value; });
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second, wd: p.weekday };
  }
  // UTC time of 18:00 London on the London calendar day containing t.
  function sixPmLondon(t) {
    var p = londonParts(t);
    var guess = Date.UTC(p.y, p.m - 1, p.d, 18, 0, 0);
    var q = londonParts(guess);
    var offset = Date.UTC(q.y, q.m - 1, q.d, q.h, q.min, q.s) - guess; // 0 in winter, 1h in summer
    return guess - offset;
  }
  function lastReset(kind, now) {
    for (var i = 0; i < 9; i++) {
      var day = now - i * 864e5;
      var at = sixPmLondon(day);
      if (at <= now && (kind === 'daily' || londonParts(day).wd === 'Thu')) return at;
    }
    return now;
  }

  // Clear progress for daily/weekly groups once EA has refreshed them. Player added ticks stay.
  function applyResets() {
    if (!data) return;
    var cleared = [];
    data.groups.forEach(function (g) {
      if (!g.resets || g.active === false) return;
      var cycle = lastReset(g.resets, Date.now());
      var seen = state.cycles[g.id];
      if (seen && seen < cycle) {
        var had = g.objectives.some(function (o) { return prog(g, o).p > 0; });
        g.objectives.forEach(function (o) {
          var cur = state.progress[key(g, o)];
          if (cur) state.progress[key(g, o)] = { p: 0, added: cur.added };
        });
        delete state.snap[g.id];
        if (had) cleared.push(g.name);
      }
      state.cycles[g.id] = cycle;
    });
    save(true);
    if (cleared.length) toast(cleared.join(', ') + (cleared.length > 1 ? ' have' : ' has') + ' refreshed. Progress reset.');
  }

  // ---------- Rewards summary ----------
  var REWARD_KINDS = [
    { id: 'tokens', label: 'Tokens' },
    { id: 'sp', label: 'SP' },
    { id: 'coins', label: 'Coins' },
    { id: 'packs', label: 'Packs' },
    { id: 'picks', label: 'Player picks' },
    { id: 'items', label: 'Players & items' }
  ];

  function parseRewards(text, into) {
    if (!text) return;
    text.split(/\s*(?:,|;|\+|\band\b)\s*/i).forEach(function (part) {
      if (!part) return;
      var mult = /^(\d+)\s*x\b/i.exec(part);
      var n = mult ? +mult[1] : 1;
      var m;
      if ((m = /([\d,]+)\s*SP\b/i.exec(part))) into.sp += toInt(m[1]);
      else if ((m = /([\d,]+)\s*Tokens?\b/i.exec(part))) into.tokens += toInt(m[1]);
      else if ((m = /([\d,]+)\s*Coins?\b/i.exec(part))) into.coins += toInt(m[1]);
      else if (/pick/i.test(part)) into.picks += n;
      else if (/pack/i.test(part)) into.packs += n;
      else if (/points|boost|access|award/i.test(part)) return; // not worth counting
      else into.items += n;
    });
  }

  function renderRewards(scope) {
    var earned = {}, total = {};
    REWARD_KINDS.forEach(function (k) { earned[k.id] = 0; total[k.id] = 0; });
    scope.forEach(function (g) {
      liveObjectives(g).forEach(function (o) {
        parseRewards(o.reward, total);
        if (isDone(g, o)) parseRewards(o.reward, earned);
      });
      parseRewards(g.groupRewards, total);
      if (groupDone(g)) parseRewards(g.groupRewards, earned);
    });
    var box = $('rewards');
    box.innerHTML = '';
    var head = el('div', 'rewards-head');
    head.appendChild(el('span', null, 'Rewards earned'));
    head.appendChild(el('span', 'muted', 'of what’s on offer'));
    box.appendChild(head);
    var grid = el('div', 'rewards-grid');
    REWARD_KINDS.forEach(function (k) {
      if (!total[k.id]) return;
      var tile = el('div', 'reward-tile');
      tile.dataset.kind = k.id;
      var v = el('span', 'reward-val');
      v.appendChild(el('b', null, fmt(earned[k.id])));
      v.appendChild(el('small', null, '/' + fmt(total[k.id])));
      tile.appendChild(v);
      tile.appendChild(el('span', 'reward-label', k.label));
      grid.appendChild(tile);
    });
    box.appendChild(grid);
  }

  // ---------- Combined squad planner ----------
  var LEAGUES = /premier league|ligue 1|serie a|bundesliga|la ?liga|mls|super league|eredivisie|liga portugal|saudi|wsl|liga f|nwsl/i;
  var CLUBS = /\(|\bfc\b|psg|madrid|bayern|barcelona|united|city|juventus|milan|inter\b|arsenal|chelsea|liverpool|dortmund/i;
  var SPECIAL = /scream|future stars|weak foot|first owned|icon|hero|rated|skill|loan|evolution/i;

  function parseReq(text) {
    return cleanReq(text).split(/\s*\+\s*|\s+and\s+(?=\d|min)/i).map(function (part) {
      var t = part.replace(/^(min\.?|at least)\s*/i, '').trim();
      if (/weak foot/i.test(t)) return { n: 1, subject: t.replace(/\s*players?$/i, ''), type: 'special' };
      if (/^first owned starting (xi|11)$/i.test(t)) return { n: 11, subject: 'First Owned', type: 'special', whole: true };
      var m = /^(\d+)?\s*(.+?)\s*(?:player items?|players?)?(?:\s+from\s+(?:any\s+)?(.+?)(?:\s+teams?)?)?$/i.exec(t);
      var n = m && m[1] ? +m[1] : 1;
      var subject = (m && (m[3] || m[2]) || t).replace(/^any\s+/i, '').replace(/\s+teams?$/i, '').trim();
      var type = SPECIAL.test(subject) ? 'special' : LEAGUES.test(subject) && !/\(/.test(subject) ? 'league' : CLUBS.test(subject) ? 'club' : 'nation';
      return { n: n, subject: subject, type: type };
    });
  }

  function renderPlanner() {
    var body = $('plannerBody');
    var tracked = data.groups.filter(function (g) { return inPlay(g) && state.tracked[g.id]; });
    var needs = {};
    tracked.forEach(function (g) {
      liveObjectives(g).forEach(function (o) {
        if (!o.requirement || isDone(g, o)) return;
        parseReq(o.requirement).forEach(function (r) {
          var k = r.subject.toLowerCase();
          var cur = needs[k] || (needs[k] = { subject: r.subject, type: r.type, n: 0, whole: !!r.whole, objs: [] });
          cur.n = Math.max(cur.n, r.n);
          cur.objs.push(g.name + ': ' + o.name);
        });
      });
    });
    var list = Object.keys(needs).map(function (k) { return needs[k]; });
    var order = { special: 0, nation: 1, league: 2, club: 3 };
    list.sort(function (a, b) { return order[a.type] - order[b.type] || b.objs.length - a.objs.length; });
    $('plannerHint').textContent = tracked.length ? list.length + ' requirement' + (list.length === 1 ? '' : 's') : 'Track groups first';
    body.innerHTML = '';
    if (!tracked.length) { body.appendChild(el('p', 'squad-note', 'Tap ★ on the groups you’re playing, and this plans one starting XI that covers all their squad requirements.')); return; }
    if (!list.length) { body.appendChild(el('p', 'squad-note', 'Your tracked groups have no unfinished squad requirements, so any team works.')); return; }

    var slots = list.reduce(function (n, r) { return n + (r.whole ? 0 : r.n); }, 0);
    body.appendChild(el('p', 'squad-sum', 'One starting XI for all your tracked groups needs at most ' + slots + ' of 11 spots for these:'));
    var ul = el('ul', 'squad-list');
    list.forEach(function (r) {
      var li = el('li');
      var b = el('b', null, (r.whole ? 'All 11 ' : r.n + '× ') + r.subject + (r.type === 'nation' ? ' player' : r.type === 'special' ? '' : ' player') + (r.n > 1 && !r.whole && r.type !== 'special' ? 's' : ''));
      li.appendChild(b);
      li.appendChild(el('span', 'tag type-' + r.type, r.type));
      li.appendChild(el('span', 'squad-objs', r.objs.join(' · ')));
      ul.appendChild(li);
    });
    body.appendChild(ul);

    // Where one card can cover two requirements.
    var tips = [];
    var nations = list.filter(function (r) { return r.type === 'nation'; });
    var places = list.filter(function (r) { return r.type === 'league' || r.type === 'club'; });
    var specials = list.filter(function (r) { return r.type === 'special' && !r.whole && !/weak foot/i.test(r.subject); });
    specials.forEach(function (sp) { nations.forEach(function (na) { tips.push('A ' + sp.subject + ' card who is ' + na.subject + ' covers both.'); }); });
    nations.forEach(function (na) { places.forEach(function (pl) { tips.push('A ' + na.subject + ' player at a ' + pl.subject + ' club covers both.'); }); });
    if (list.some(function (r) { return /weak foot/i.test(r.subject); })) tips.push('Check the weak foot of the players you already need. One of them may already be 4★ or better.');
    if (tips.length) {
      body.appendChild(el('h4', 'planner-sub', 'Save spots'));
      var tl = el('ul', 'guide-list plain');
      tips.slice(0, 5).forEach(function (t) { tl.appendChild(el('li', null, t)); });
      body.appendChild(tl);
    }
    if (slots > 11) body.appendChild(el('p', 'squad-warn', 'That’s more than one XI can hold. Overlap where you can, or split your tracked groups across two squads.'));
    if (list.some(function (r) { return r.whole; })) body.appendChild(el('p', 'squad-warn', 'One objective needs an all First Owned XI, so every player above must also be First Owned for it to count.'));
  }

  // ---------- Quick match log ----------
  var MODES = [
    { id: 'rivals', label: 'Rivals' },
    { id: 'champions', label: 'Champions' },
    { id: 'live', label: 'Live Events' },
    { id: 'rush', label: 'Rush' },
    { id: 'sb-semi', label: 'Squad Battles, Semi-Pro to Pro' },
    { id: 'sb-wc', label: 'Squad Battles, World Class+' },
    { id: 'sb-low', label: 'Squad Battles, below Semi-Pro' },
    { id: 'draft', label: 'Draft' },
    { id: 'coop', label: 'Co-Op' }
  ];
  var COUNTERS = [
    { id: 'goals', label: 'Goals' },
    { id: 'headers', label: 'Headers', goal: true },
    { id: 'outside', label: 'Outside the box', goal: true },
    { id: 'chip', label: 'Chip shots', goal: true },
    { id: 'fk', label: 'Direct free kicks', goal: true },
    { id: 'assists', label: 'Assists' },
    { id: 'through', label: 'Through-ball assists', assist: true },
    { id: 'cross', label: 'Assists from crosses', assist: true }
  ];

  // Work out what a match has to contain to move an objective. null = not match-based.
  function classify(o) {
    var t = (o.task || o.name).toLowerCase();
    if (/sbc|squad building|evolution|transfer market|buy now|\blist\b|gallery|chemistry|consumable|formation|club name|moments|earn \d+ stars|rush points|bonuses|completion|complete the|finish every|single round|quarter-final|win the .*(tournament|five times)|level|finesse|with a st\b/.test(t)) return null;
    var m = /through ball/.test(t) ? 'through'
      : /cross/.test(t) ? 'cross'
      : /free kick/.test(t) ? 'fk'
      : /header/.test(t) ? 'headers'
      : /outside the box/.test(t) ? 'outside'
      : /chip/.test(t) ? 'chip'
      : /clean sheet/.test(t) ? 'clean'
      : /assist/.test(t) ? 'assists'
      : /\bscore|\bgoal/.test(t) ? 'goals'
      : /\bwins?\b|\bbeat\b/.test(t) ? 'win'
      : /\bplay\b|\bmatch(es)?\b|lace/.test(t) ? 'played'
      : null;
    if (!m) return null;
    var per = /separate matches|\bin (one|1|a single|a) match\b/.test(t);
    var at = /at least (\d+|one)/.exec(t);
    return { metric: m, per: per, min: at ? (at[1] === 'one' ? 1 : +at[1]) : 1 };
  }

  // Objectives tied to one named event ("... in the FC Heritage Circuit Semi-Pro Event").
  function eventOf(o) {
    var m = /\bin the (.+?\b(?:event|tournament))\b/i.exec(o.task || '');
    return m ? { id: 'ev:' + m[1].toLowerCase().replace(/[^a-z0-9]+/g, '-'), label: m[1].replace(/\bevent\b/, 'Event') } : null;
  }

  function modeOk(allowed, mode) { return !!allowed[mode] || (mode.indexOf('ev:') === 0 && !!allowed.live); }

  function allowedModes(g, o) {
    var ev = eventOf(o);
    if (ev) { var only = {}; only[ev.id] = true; return only; }
    var t = (o.task + ' ' + (o.requirement || '') + ' ' + (g.modes || '')).toLowerCase();
    var all = {};
    MODES.forEach(function (m) { all[m.id] = true; });
    if (/any (fut|football ultimate team) game mode/.test(t)) return all;
    var s = {};
    if (/squad battles/.test(t)) {
      if (/world class/.test(t)) s['sb-wc'] = true;
      else if (/semi-pro/.test(t)) { s['sb-semi'] = true; s['sb-wc'] = true; }
      else { s['sb-low'] = true; s['sb-semi'] = true; s['sb-wc'] = true; }
    }
    if (/rivals/.test(t)) s.rivals = true;
    if (/champions/.test(t)) s.champions = true;
    if (/live events?|\bevent\b|tournament|gauntlet|knockout/.test(t)) s.live = true;
    if (/\brush\b/.test(t)) s.rush = true;
    if (/draft/.test(t)) s.draft = true;
    if (/co-op/.test(t)) s.coop = true;
    return Object.keys(s).length ? s : all;
  }

  var log = null;
  function newLog() {
    var l = { result: null, clean: false };
    COUNTERS.forEach(function (c) { l[c.id] = 0; });
    return l;
  }

  function amountFor(c, l) {
    var v = c.metric === 'played' ? 1
      : c.metric === 'win' ? (l.result === 'W' ? 1 : 0)
      : c.metric === 'clean' ? (l.clean ? 1 : 0)
      : l[c.metric] || 0;
    return c.per ? (v >= c.min ? 1 : 0) : v;
  }

  // Every unfinished objective this match would move, and whether it should by default.
  function logCandidates() {
    var mode = $('logMode').value;
    var out = [];
    data.groups.forEach(function (g) {
      if (g.active === false) return;
      liveObjectives(g).forEach(function (o) {
        if (isDone(g, o)) return;
        var c = classify(o);
        if (!c) return;
        var amt = amountFor(c, log);
        if (!amt) return;
        var why = !modeOk(allowedModes(g, o), mode) ? 'doesn’t count in this mode'
          : o.requirement && !prog(g, o).added ? 'tick Player added first'
          : '';
        out.push({ g: g, o: o, amt: amt, why: why });
      });
    });
    return out;
  }

  var logPicks = {}; // key -> true/false chosen by the user in the preview
  function renderLog() {
    var res = log.result;
    Array.prototype.forEach.call(document.querySelectorAll('.result-btn'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.result === res));
    });
    COUNTERS.forEach(function (c) { $('cnt-' + c.id).textContent = log[c.id]; });
    $('cnt-clean').checked = log.clean;
    var extras = COUNTERS.filter(function (c) { return log[c.id]; }).map(function (c) { return log[c.id] + ' ' + c.label.toLowerCase(); });
    if (log.clean) extras.push('clean sheet');
    $('logMoreSum').textContent = extras.length ? '· ' + extras.join(', ') : '';

    var prev = $('logPreview');
    prev.innerHTML = '';
    if (!res) { $('logSave').disabled = true; $('logSave').textContent = 'Pick a result'; return; }
    var cands = logCandidates();
    var on = cands.filter(function (c) { var k = key(c.g, c.o); return k in logPicks ? logPicks[k] : !c.why; });
    prev.appendChild(el('p', 'log-count', on.length ? 'This match updates ' + on.length + ' objective' + (on.length > 1 ? 's' : '') + ':' : 'Nothing to update for this match.'));
    var list = el('div', 'log-list');
    cands.sort(function (a, b) { return (a.why ? 1 : 0) - (b.why ? 1 : 0); });
    cands.forEach(function (c) {
      var k = key(c.g, c.o);
      var row = el('label', 'log-item' + (c.why ? ' off' : ''));
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = k in logPicks ? logPicks[k] : !c.why;
      cb.addEventListener('change', function () { logPicks[k] = cb.checked; renderLog(); });
      row.appendChild(cb);
      var txt = el('span', 'log-text');
      txt.appendChild(el('b', null, c.o.name));
      txt.appendChild(el('small', null, c.g.name + (c.why ? ' · ' + c.why : '')));
      row.appendChild(txt);
      row.appendChild(el('span', 'log-amt', '+' + c.amt));
      list.appendChild(row);
    });
    prev.appendChild(list);
    $('logSave').disabled = false;
    $('logSave').textContent = on.length ? 'Save match' : 'Save anyway';
  }

  // Generic modes, plus each live event that still has unfinished objectives.
  function fillModes() {
    var sel = $('logMode');
    sel.innerHTML = '';
    MODES.forEach(function (m) { var op = el('option', null, m.label); op.value = m.id; sel.appendChild(op); });
    var events = {};
    data.groups.forEach(function (g) {
      if (g.active === false) return;
      liveObjectives(g).forEach(function (o) {
        var ev = eventOf(o);
        if (ev && !isDone(g, o)) events[ev.id] = ev.label;
      });
    });
    var ids = Object.keys(events);
    if (ids.length) {
      var grp = document.createElement('optgroup');
      grp.label = 'A specific event';
      ids.sort().forEach(function (id) { var op = el('option', null, events[id]); op.value = id; grp.appendChild(op); });
      sel.appendChild(grp);
    }
  }

  function buildLogSheet() {
    var sel = $('logMode');
    sel.addEventListener('change', function () { state.logMode = sel.value; logPicks = {}; save(); renderLog(); });
    var wrap = $('logCounters');
    COUNTERS.forEach(function (c) {
      var row = el('div', 'counter' + (c.goal || c.assist ? ' sub' : ''));
      row.appendChild(el('span', 'counter-label', c.label));
      var minus = el('button', 'step mini minus', '−');
      minus.type = 'button';
      minus.setAttribute('aria-label', 'Fewer ' + c.label);
      var val = el('span', 'counter-val', '0');
      val.id = 'cnt-' + c.id;
      var plus = el('button', 'step mini plus', '+');
      plus.type = 'button';
      plus.setAttribute('aria-label', 'More ' + c.label);
      minus.addEventListener('click', function () { log[c.id] = Math.max(0, log[c.id] - 1); logPicks = {}; renderLog(); });
      plus.addEventListener('click', function () {
        log[c.id]++;
        // A header or chip shot is also a goal, and a through ball is also an assist.
        var parts = function (flag) { return COUNTERS.filter(function (x) { return x[flag]; }).reduce(function (n, x) { return n + log[x.id]; }, 0); };
        if (c.goal) log.goals = Math.max(log.goals, parts('goal'));
        if (c.assist) log.assists = Math.max(log.assists, parts('assist'));
        logPicks = {};
        renderLog();
      });
      row.appendChild(minus);
      row.appendChild(val);
      row.appendChild(plus);
      wrap.appendChild(row);
    });
    var clean = el('label', 'counter clean');
    clean.appendChild(el('span', 'counter-label', 'Clean sheet'));
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'switch';
    cb.id = 'cnt-clean';
    cb.addEventListener('change', function () { log.clean = cb.checked; logPicks = {}; renderLog(); });
    clean.appendChild(cb);
    wrap.appendChild(clean);

    Array.prototype.forEach.call(document.querySelectorAll('.result-btn'), function (b) {
      b.addEventListener('click', function () { log.result = b.dataset.result; logPicks = {}; renderLog(); });
    });
    $('logClose').addEventListener('click', function () { closeSheet($('logSheet')); });
    $('logSheet').addEventListener('click', function (e) { if (e.target === $('logSheet')) closeSheet($('logSheet')); });
    $('logSave').addEventListener('click', saveLog);
  }

  function openLog(mode) {
    if (!data) return;
    log = newLog();
    logPicks = {};
    fillModes();
    if (typeof mode === 'string') state.logMode = mode;
    $('logMode').value = state.logMode;
    if (!$('logMode').value) $('logMode').value = 'rivals';
    $('logMore').open = false;
    renderLog();
    openSheet($('logSheet'));
  }

  function saveLog() {
    var changes = [];
    logCandidates().forEach(function (c) {
      var k = key(c.g, c.o);
      if (!(k in logPicks ? logPicks[k] : !c.why)) return;
      var cur = state.progress[k] || { p: 0, added: false };
      changes.push({ k: k, before: cur.p });
      state.progress[k] = { p: Math.min(c.o.target, cur.p + c.amt), added: cur.added };
    });
    var t = today();
    var r = log.result.toLowerCase();
    t.m++;
    t[r]++;
    t.g += log.goals;
    t.a += log.assists;
    state.lastLog = { at: Date.now(), changes: changes, stat: { day: dayKey(), r: r, g: log.goals, a: log.assists } };
    save();
    closeSheet($('logSheet'));
    refresh();
    var finished = changes.filter(function (ch) {
      var parts = ch.k.split('/');
      var g = groupsById[parts[0]];
      var o = g && g.objectives.filter(function (x) { return x.id === parts[1]; })[0];
      return o && isDone(g, o) && ch.before < o.target;
    }).length;
    toast(changes.length ? 'Updated ' + changes.length + ' objective' + (changes.length > 1 ? 's' : '') + (finished ? ', ' + finished + ' completed 🎉' : '') : 'Match logged, nothing to update');
    if (navigator.vibrate) navigator.vibrate(20);
  }

  function undoLog() {
    if (!state.lastLog) return;
    state.lastLog.changes.forEach(function (ch) {
      var cur = state.progress[ch.k] || { p: 0, added: false };
      state.progress[ch.k] = { p: ch.before, added: cur.added };
    });
    var st = state.lastLog.stat, day = st && state.stats[st.day];
    if (day) {
      day.m = Math.max(0, day.m - 1);
      day[st.r] = Math.max(0, day[st.r] - 1);
      day.g = Math.max(0, day.g - st.g);
      day.a = Math.max(0, day.a - st.a);
    }
    var n = state.lastLog.changes.length;
    var scan = state.lastLog.kind === 'scan';
    state.lastLog = null;
    save();
    refresh();
    toast((scan ? 'Screenshot import undone (' : 'Last match undone (') + n + ' objective' + (n === 1 ? '' : 's') + ')');
  }

  buildLogSheet();
  $('logBtn').addEventListener('click', function () { openLog(); });
  $('undoLogBtn').addEventListener('click', function () { closeSheet(sheet); undoLog(); });

  // ---------- New-objective alerts (Web Push) ----------
  var alertsSheet = $('alertsSheet');
  function standalone() { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
  function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  function b64ToBytes(b64) {
    var pad = '='.repeat((4 - b64.length % 4) % 4);
    var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function showCode(sub) {
    $('alertsCode').value = JSON.stringify(sub);
    $('alertsCode').hidden = false;
    $('alertsCopy').hidden = false;
    $('alertsTest').hidden = false;
    $('alertsOn').hidden = true;
    $('alertsText').textContent = 'Alerts are on for this phone. If you haven’t already, copy the alert code below and send it to Claude in your project thread, so the nightly update knows where to send alerts.';
  }
  function openAlerts() {
    closeSheet(sheet);
    $('alertsOn').hidden = false;
    $('alertsCode').hidden = $('alertsCopy').hidden = $('alertsTest').hidden = true;
    if (!pushSupported() || !standalone()) {
      $('alertsText').textContent = 'On iPhone, alerts only work in the Home Screen app (iOS 16.4 or later). Add this page to your Home Screen with Share → Add to Home Screen, open it from there, then come back here.';
      $('alertsOn').hidden = !pushSupported();
    } else {
      $('alertsText').textContent = 'Get a notification when new objectives or SBCs drop, when something you’re working on is about to end, and a weekly recap on Sunday evening.';
      navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); })
        .then(function (sub) { if (sub) showCode(sub); })
        .catch(function () {});
    }
    openSheet(alertsSheet);
  }
  $('alertsBtn').addEventListener('click', openAlerts);
  $('alertsClose').addEventListener('click', function () { closeSheet(alertsSheet); });
  $('alertsOn').addEventListener('click', function () {
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') { toast('Notifications are blocked. Allow them in Settings → Notifications.'); return null; }
      return navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.getSubscription().then(function (sub) {
          return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY) });
        });
      });
    }).then(function (sub) { if (sub) showCode(sub); })
      .catch(function () { toast('Could not turn on alerts on this device'); });
  });
  $('alertsCopy').addEventListener('click', function () {
    var code = $('alertsCode').value;
    (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(code) : Promise.reject())
      .then(function () { toast('Alert code copied'); })
      .catch(function () { $('alertsCode').select(); toast('Select the code and copy it'); });
  });
  $('alertsTest').addEventListener('click', function () {
    navigator.serviceWorker.ready.then(function (reg) {
      return reg.showNotification('Alerts are working', { body: 'You’ll hear from FC Objectives when new objectives drop.', icon: 'icons/icon-192.png', tag: 'test' });
    }).catch(function () { toast('Could not show a notification'); });
  });

  // ---------- Play next ----------
  // The mode where one match moves the most unfinished objectives in the dashboard's scope.
  function playNext() {
    var tracked = data.groups.filter(function (g) { return inPlay(g) && state.tracked[g.id]; });
    var scope = tracked.length ? tracked : data.groups.filter(inPlay);
    var modes = MODES.map(function (m) { return { id: m.id, label: m.label }; });
    var events = {};
    var items = [];
    scope.forEach(function (g) {
      liveObjectives(g).forEach(function (o) {
        if (isDone(g, o) || !classify(o)) return;
        var ev = eventOf(o);
        if (ev) events[ev.id] = ev.label;
        items.push({ g: g, o: o, allowed: allowedModes(g, o), blocked: !!(o.requirement && !prog(g, o).added) });
      });
    });
    Object.keys(events).sort().forEach(function (id) { modes.push({ id: id, label: events[id] }); });
    modes.forEach(function (m) {
      m.ready = items.filter(function (it) { return !it.blocked && modeOk(it.allowed, m.id); });
      m.blocked = items.filter(function (it) { return it.blocked && modeOk(it.allowed, m.id); });
      // Named events are narrower, so an event only wins when it beats the generic modes outright.
      m.score = m.ready.length + m.blocked.length * 0.5 - (m.id.indexOf('ev:') === 0 ? 0.25 : 0);
    });
    modes.sort(function (a, b) { return b.score - a.score; });
    return { scope: tracked.length ? 'tracked' : 'all', modes: modes.filter(function (m) { return m.score > 0; }) };
  }

  function renderPlayNext() {
    var box = $('playNext');
    box.innerHTML = '';
    var p = playNext();
    if (!p.modes.length) { box.hidden = true; return; }
    box.hidden = false;
    var best = p.modes[0];
    var head = el('div', 'pn-head');
    var txt = el('div', 'pn-text');
    txt.appendChild(el('span', 'pn-kicker', 'Play next'));
    if (!best.ready.length) {
      // Everything left needs a player in the XI first, so that's the next step, not a mode.
      var need = {};
      best.blocked.forEach(function (it) { need[cleanReq(it.o.requirement)] = true; });
      var nl = Object.keys(need);
      txt.appendChild(el('b', 'pn-mode', 'Set up your XI first'));
      head.appendChild(txt);
      var sq0 = el('button', 'pn-go', 'Squad');
      sq0.type = 'button';
      sq0.setAttribute('aria-label', 'Suggest a squad for ' + best.label);
      sq0.addEventListener('click', function () { openSquad(best.id); });
      head.appendChild(sq0);
      box.appendChild(head);
      box.appendChild(el('p', 'pn-line', best.blocked.length + ' objective' + (best.blocked.length === 1 ? '' : 's') + ' wait for: ' + nl.slice(0, 4).join('; ') + (nl.length > 4 ? ' and ' + (nl.length - 4) + ' more' : '') + '. Tick Player added once they’re in.'));
      box.appendChild(el('p', 'pn-line muted', 'Then play: ' + p.modes.slice(0, 3).map(function (m) { return m.label; }).join(' · ')));
      return;
    }
    txt.appendChild(el('b', 'pn-mode', best.label));
    head.appendChild(txt);
    var go = el('button', 'pn-go', 'Log');
    go.type = 'button';
    go.setAttribute('aria-label', 'Log a ' + best.label + ' match');
    go.addEventListener('click', function () { openLog(best.id); });
    var sq = el('button', 'pn-go ghost', 'Squad');
    sq.type = 'button';
    sq.setAttribute('aria-label', 'Suggest a squad for ' + best.label);
    sq.addEventListener('click', function () { openSquad(best.id); });
    var btns = el('div', 'pn-btns');
    btns.appendChild(sq);
    btns.appendChild(go);
    head.appendChild(btns);
    box.appendChild(head);
    var names = best.ready.map(function (it) { return it.o.name; });
    box.appendChild(el('p', 'pn-line', 'Moves ' + best.ready.length + ' ' + (p.scope === 'tracked' ? 'tracked ' : '') + 'objective' + (best.ready.length === 1 ? '' : 's') + ': ' + names.slice(0, 4).join(', ') + (names.length > 4 ? ' and ' + (names.length - 4) + ' more' : '')));
    if (best.blocked.length) {
      var reqs = {};
      best.blocked.forEach(function (it) { reqs[cleanReq(it.o.requirement)] = true; });
      var list = Object.keys(reqs);
      box.appendChild(el('p', 'pn-line muted', '+' + best.blocked.length + ' more once your XI has: ' + list.slice(0, 3).join('; ') + (list.length > 3 ? ' and ' + (list.length - 3) + ' more' : '') + '.'));
    }
    var others = p.modes.slice(1, 3).filter(function (m) { return m.ready.length; });
    if (others.length) {
      box.appendChild(el('p', 'pn-line muted', 'Next best: ' + others.map(function (m) { return m.label + ' (' + m.ready.length + ')'; }).join(' · ')));
    }
  }

  // ---------- Squad suggestion for one mode ----------
  // Packs the squad requirements of unfinished objectives in a mode into one starting XI,
  // favourites first, combining requirements on one player (e.g. a Brazilian Premier League
  // player) only once there are no free spots left.
  var CLUB_LEAGUE = { 'fc bayern munchen': 'bundesliga', 'bayern': 'bundesliga', 'psg': 'ligue 1', 'paris saint-germain': 'ligue 1' };
  function leagueKey(s) { return norm(s).replace(/^la ?liga$/, 'laliga').replace(/ea sports /, ''); }
  function clubLeague(club) {
    var m = /\(([^)]+)\)/.exec(club);
    if (m) return leagueKey(m[1]);
    var k = norm(club);
    return CLUB_LEAGUE[k] || null;
  }
  function squadNeed(r) {
    if (/first owned/i.test(r.subject)) return { kind: 'owned', n: r.whole ? 11 : r.n };
    if (/weak foot/i.test(r.subject)) return { kind: 'wf', n: 1, label: r.subject };
    var kind = r.type === 'special' ? 'promo' : r.type;
    return { kind: kind, n: r.n, label: r.subject.replace(/\s*\([^)]*\)/, ''), full: r.subject, val: kind === 'league' ? leagueKey(r.subject) : norm(r.subject) };
  }
  function slotHas(s, need) { return s[need.kind] && s[need.kind].val === need.val; }
  function slotFits(s, need) {
    if (s[need.kind]) return false;
    if (need.kind === 'league' && s.club) return clubLeague(s.club.full) === need.val;
    if (need.kind === 'club' && s.league) return clubLeague(need.full) === s.league.val;
    return true;
  }
  function slotSize(s) { return ['nation', 'league', 'club', 'promo'].filter(function (k) { return s[k]; }).length; }

  function objFav(g, o) { return !!state.fav[key(g, o)]; }
  function squadItems(mode) {
    var items = [];
    data.groups.forEach(function (g) {
      if (!inPlay(g)) return;
      liveObjectives(g).forEach(function (o) {
        if (isDone(g, o) || !classify(o) || !modeOk(allowedModes(g, o), mode)) return;
        var end = endsAt(g);
        items.push({
          g: g, o: o,
          rank: (objFav(g, o) ? 4 : 0) + (state.tracked[g.id] ? 2 : 0) + (endingSoon(g) ? 1 : 0),
          end: end || Infinity,
          needs: o.requirement ? parseReq(o.requirement).map(squadNeed) : []
        });
      });
    });
    items.sort(function (a, b) {
      return b.rank - a.rank || a.end - b.end ||
        a.needs.reduce(function (n, x) { return n + x.n; }, 0) - b.needs.reduce(function (n, x) { return n + x.n; }, 0);
    });
    return items;
  }

  function suggestSquad(mode) {
    var items = squadItems(mode);
    var slots = [];
    var owned = 0, wf = [];
    var fitted = [], free = [], left = [];
    items.forEach(function (it) {
      if (!it.needs.length) { free.push(it); return; }
      var trial = slots.map(function (s) { var c = {}; Object.keys(s).forEach(function (k) { c[k] = s[k]; }); c.for = s.for.slice(); return c; });
      var ok = it.needs.every(function (need) {
        if (need.kind === 'owned' || need.kind === 'wf') return true;
        var have = trial.filter(function (s) { return slotHas(s, need); });
        have.forEach(function (s) { if (s.for.indexOf(it) === -1) s.for.push(it); });
        for (var i = have.length; i < need.n; i++) {
          var s = null;
          if (trial.length < 11) { s = { for: [] }; trial.push(s); }
          else {
            // No spot left: put it on the simplest player it can share with.
            var fits = trial.filter(function (x) { return slotFits(x, need) && slotSize(x) < 3; });
            fits.sort(function (a, b) { return slotSize(a) - slotSize(b); });
            s = fits[0];
          }
          if (!s) return false;
          s[need.kind] = need;
          s.for.push(it);
        }
        return true;
      });
      if (!ok) { left.push(it); return; }
      slots = trial;
      it.needs.forEach(function (need) {
        if (need.kind === 'owned') owned = Math.max(owned, need.n);
        if (need.kind === 'wf' && wf.indexOf(need.label) === -1) wf.push(need.label);
      });
      fitted.push(it);
    });
    return { slots: slots, owned: owned, wf: wf, fitted: fitted, free: free, left: left };
  }

  function slotLabel(s) {
    var parts = [];
    if (s.nation) parts.push(s.nation.label);
    if (s.club) parts.push(s.club.label);
    else if (s.league) parts.push(s.league.label);
    if (s.promo) parts.push(s.promo.label);
    return parts.join(' · ') + (s.nation || s.club || s.league ? ' player' : '');
  }

  function fillModeSelect(sel) {
    sel.innerHTML = '';
    MODES.forEach(function (m) { var op = el('option', null, m.label); op.value = m.id; sel.appendChild(op); });
    var events = {};
    data.groups.forEach(function (g) {
      if (!inPlay(g)) return;
      liveObjectives(g).forEach(function (o) { var ev = eventOf(o); if (ev && !isDone(g, o)) events[ev.id] = ev.label; });
    });
    var ids = Object.keys(events);
    if (ids.length) {
      var grp = document.createElement('optgroup');
      grp.label = 'A specific event';
      ids.sort().forEach(function (id) { var op = el('option', null, events[id]); op.value = id; grp.appendChild(op); });
      sel.appendChild(grp);
    }
  }

  function objRow(it, note) {
    var row = el('div', 'sq-obj');
    var star = el('button', 'sq-star' + (objFav(it.g, it.o) ? ' on' : ''), objFav(it.g, it.o) ? '★' : '☆');
    star.type = 'button';
    star.setAttribute('aria-label', (objFav(it.g, it.o) ? 'Unfavourite ' : 'Favourite ') + it.o.name);
    star.setAttribute('aria-pressed', String(objFav(it.g, it.o)));
    star.addEventListener('click', function () {
      var k = key(it.g, it.o);
      if (state.fav[k]) delete state.fav[k]; else state.fav[k] = true;
      save();
      renderSquad();
    });
    row.appendChild(star);
    var txt = el('span', 'log-text');
    txt.appendChild(el('b', null, it.o.name));
    txt.appendChild(el('small', null, it.g.name + (state.tracked[it.g.id] ? ' · tracked' : '') + (note ? ' · ' + note : '')));
    row.appendChild(txt);
    row.appendChild(el('span', 'log-amt', value(it.g, it.o) + '/' + it.o.target));
    return row;
  }

  var squadPlan = null;
  function renderSquad() {
    var mode = $('squadMode').value;
    var p = squadPlan = suggestSquad(mode);
    var body = $('squadBody');
    body.innerHTML = '';
    var total = p.fitted.length + p.free.length;
    if (!total && !p.left.length) {
      body.appendChild(el('p', 'squad-note', 'Nothing unfinished can be played in this mode.'));
      $('squadApply').hidden = true;
      return;
    }
    var favs = p.fitted.concat(p.free).filter(function (it) { return it.rank >= 2; }).length;
    body.appendChild(el('p', 'sq-sum', 'This XI can move ' + total + ' objective' + (total === 1 ? '' : 's') + (favs ? ', ' + favs + ' of them favourites or tracked' : '') + '.'));

    if (p.slots.length) {
      body.appendChild(el('h4', 'planner-sub', 'Your XI · ' + p.slots.length + ' of 11 spots set'));
      var ol = el('ol', 'sq-xi');
      p.slots.forEach(function (s) {
        var li = el('li');
        li.appendChild(el('b', null, slotLabel(s)));
        li.appendChild(el('small', null, s.for.map(function (it) { return it.o.name; }).join(' · ')));
        ol.appendChild(li);
      });
      body.appendChild(ol);
    }
    var spare = 11 - p.slots.length;
    var notes = [];
    if (spare) notes.push(spare + ' spot' + (spare === 1 ? '' : 's') + ' free: use your best players.');
    if (p.owned) notes.push(p.owned >= 11 ? 'Every player must be First Owned (not bought on the market).' : 'At least ' + p.owned + ' of the 11 must be First Owned.');
    p.wf.forEach(function (w) { notes.push('One player needs ' + w + '. Check the players above first.'); });
    notes.forEach(function (n) { body.appendChild(el('p', 'squad-note', n)); });

    function section(title, list, note) {
      if (!list.length) return;
      body.appendChild(el('h4', 'planner-sub', title));
      var box = el('div', 'log-list sq-list');
      list.forEach(function (it) { box.appendChild(objRow(it, note && note(it))); });
      body.appendChild(box);
    }
    section('Needs these players (' + p.fitted.length + ')', p.fitted, function (it) { return cleanReq(it.o.requirement); });
    section('Any players will do (' + p.free.length + ')', p.free);
    section('Doesn’t fit this XI (' + p.left.length + ')', p.left, function (it) { return cleanReq(it.o.requirement); });
    body.appendChild(el('p', 'setting-note', 'Tap ☆ to put an objective first. Order: your ☆ objectives, then ★ tracked groups, then whatever ends soonest.'));
    var pending = p.fitted.filter(function (it) { return !prog(it.g, it.o).added; });
    $('squadApply').hidden = !pending.length;
    $('squadApply').textContent = 'I’ve built this XI (tick Player added on ' + pending.length + ')';
  }

  function openSquad(mode) {
    if (!data) return;
    closeSheet(sheet);
    var sel = $('squadMode');
    fillModeSelect(sel);
    sel.value = typeof mode === 'string' ? mode : (playNext().modes[0] || {}).id || 'sb-semi';
    if (!sel.value) sel.value = 'rivals';
    renderSquad();
    openSheet($('squadSheet'));
  }
  $('squadMode').addEventListener('change', renderSquad);
  $('squadClose').addEventListener('click', function () { closeSheet($('squadSheet')); });
  $('squadSheet').addEventListener('click', function (e) { if (e.target === $('squadSheet')) closeSheet($('squadSheet')); });
  $('squadMenuBtn').addEventListener('click', openSquad);
  $('squadApply').addEventListener('click', function () {
    if (!squadPlan) return;
    var n = 0;
    squadPlan.fitted.forEach(function (it) {
      var k = key(it.g, it.o);
      var cur = state.progress[k] || { p: 0, added: false };
      if (!cur.added) { state.progress[k] = { p: cur.p, added: true }; n++; }
    });
    save();
    refresh();
    renderSquad();
    toast('Player added ticked on ' + n + ' objective' + (n === 1 ? '' : 's'));
  });

  // ---------- Stats ----------
  function lastDays(n) {
    var out = [];
    var d = new Date();
    d.setHours(12, 0, 0, 0);
    for (var i = n - 1; i >= 0; i--) {
      var t = new Date(d.getTime() - i * 864e5);
      var k = dayKey(t.getTime());
      var r = state.stats[k] || {};
      var row = { key: k, date: t };
      STAT_KEYS.forEach(function (x) { row[x] = r[x] || 0; });
      out.push(row);
    }
    return out;
  }
  function sumDays(days) {
    var s = {};
    STAT_KEYS.forEach(function (x) { s[x] = days.reduce(function (n, d) { return n + d[x]; }, 0); });
    return s;
  }
  function weekSummary() {
    var w = sumDays(lastDays(7));
    var streak = 0;
    var days = lastDays(60).reverse();
    for (var i = 0; i < days.length; i++) {
      var active = days[i].m || days[i].done || days[i].sbc;
      if (active) streak++;
      else if (i > 0) break; // today without activity yet doesn't break a streak
    }
    w.streak = streak;
    return w;
  }

  // One small single-series bar chart; the title names the series, so no legend is needed.
  function barChart(days, field, title, unit) {
    var W = 320, H = 92, top = 16, bottom = 18;
    var max = Math.max.apply(null, days.map(function (d) { return d[field]; }).concat([1]));
    var slot = W / days.length, bw = Math.max(6, slot - 4);
    var ns = 'http://www.w3.org/2000/svg';
    var wrap = el('figure', 'chart');
    wrap.appendChild(el('figcaption', 'chart-title', title));
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('class', 'chart-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', title + ', last ' + days.length + ' days: ' + days.map(function (d) { return d[field]; }).join(', '));
    var base = document.createElementNS(ns, 'line');
    base.setAttribute('x1', 0); base.setAttribute('x2', W); base.setAttribute('y1', H - bottom); base.setAttribute('y2', H - bottom);
    base.setAttribute('class', 'chart-base');
    svg.appendChild(base);
    var tip = el('p', 'chart-tip', 'Tap a bar for the day’s number.');
    days.forEach(function (d, i) {
      var v = d[field];
      var h = v ? Math.max(4, (H - top - bottom) * v / max) : 0;
      var x = i * slot + (slot - bw) / 2, y = H - bottom - h;
      var g = document.createElementNS(ns, 'g');
      g.setAttribute('class', 'chart-hit');
      var hit = document.createElementNS(ns, 'rect');
      hit.setAttribute('x', i * slot); hit.setAttribute('y', 0); hit.setAttribute('width', slot); hit.setAttribute('height', H);
      hit.setAttribute('fill', 'transparent');
      g.appendChild(hit);
      if (h) {
        // Rounded top, square bottom on the baseline.
        var r = Math.min(4, bw / 2, h);
        var path = document.createElementNS(ns, 'path');
        path.setAttribute('d', 'M' + x + ',' + (H - bottom) + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y + 'H' + (x + bw - r) + 'Q' + (x + bw) + ',' + y + ' ' + (x + bw) + ',' + (y + r) + 'V' + (H - bottom) + 'Z');
        path.setAttribute('class', 'chart-bar');
        g.appendChild(path);
      }
      var label = d.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ': ' + v + ' ' + unit;
      var t = document.createElementNS(ns, 'title');
      t.textContent = label;
      g.appendChild(t);
      g.addEventListener('click', function () {
        tip.textContent = label;
        Array.prototype.forEach.call(svg.querySelectorAll('.chart-hit'), function (n) { n.classList.remove('on'); });
        g.classList.add('on');
      });
      svg.appendChild(g);
      if (i === 0 || i === days.length - 1 || i === Math.floor(days.length / 2)) {
        var tx = document.createElementNS(ns, 'text');
        tx.setAttribute('x', i * slot + slot / 2); tx.setAttribute('y', H - 4);
        tx.setAttribute('class', 'chart-axis');
        tx.setAttribute('text-anchor', i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle');
        if (i === 0) tx.setAttribute('x', 0);
        if (i === days.length - 1) tx.setAttribute('x', W);
        tx.textContent = i === days.length - 1 ? 'Today' : d.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        svg.appendChild(tx);
      }
    });
    var mx = document.createElementNS(ns, 'text');
    mx.setAttribute('x', 0); mx.setAttribute('y', 10);
    mx.setAttribute('class', 'chart-axis');
    mx.textContent = 'max ' + max;
    svg.appendChild(mx);
    wrap.appendChild(svg);
    wrap.appendChild(tip);
    return wrap;
  }

  function openStats() {
    closeSheet(sheet);
    var body = $('statsBody');
    body.innerHTML = '';
    var w = weekSummary();
    var tiles = el('div', 'stat-tiles');
    [
      ['Matches', w.m],
      ['Win rate', w.m ? Math.round(w.w / w.m * 100) + '%' : '–'],
      ['Goals', w.g],
      ['Objectives done', w.done],
      ['SBCs done', w.sbc],
      ['Day streak', w.streak]
    ].forEach(function (t) {
      var d = el('div', 'stat-tile');
      d.appendChild(el('b', null, String(t[1])));
      d.appendChild(el('span', null, t[0]));
      tiles.appendChild(d);
    });
    body.appendChild(el('p', 'stats-sub', 'Last 7 days' + (w.m ? ' · ' + w.w + 'W ' + w.d + 'D ' + w.l + 'L' : '')));
    body.appendChild(tiles);
    var days = lastDays(14);
    body.appendChild(barChart(days, 'done', 'Objectives completed per day', 'objectives'));
    body.appendChild(barChart(days, 'm', 'Matches logged per day', 'matches'));
    if (!sumDays(days).m && !sumDays(days).done) {
      body.appendChild(el('p', 'squad-note', 'Stats fill in as you log matches and finish objectives. They’re kept on this phone and included in backups.'));
    }
    openSheet($('statsSheet'));
  }

  // ---------- Settings: theme and app badge ----------
  var darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function applyTheme() {
    var t = state.settings.theme;
    var resolved = t === 'system' ? (darkQuery && !darkQuery.matches ? 'light' : 'dark') : t;
    document.documentElement.dataset.theme = resolved;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'light' ? '#f4f6f9' : '#07090c');
    var cs = document.querySelector('meta[name="color-scheme"]');
    if (cs) cs.setAttribute('content', resolved);
  }
  if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', applyTheme);

  // Home Screen icon badge: unfinished objectives in tracked groups (iOS 16.4+, needs notification permission).
  function badgeCount() {
    if (!data) return 0;
    var n = 0;
    data.groups.forEach(function (g) {
      if (!inPlay(g) || !state.tracked[g.id]) return;
      liveObjectives(g).forEach(function (o) { if (!isDone(g, o)) n++; });
    });
    return n;
  }
  function updateBadge() {
    if (!('setAppBadge' in navigator)) return;
    var n = state.settings.badge ? badgeCount() : 0;
    (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(function () {});
  }

  function renderSettings() {
    Array.prototype.forEach.call(document.querySelectorAll('.seg-btn[data-theme]'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.theme === state.settings.theme));
    });
    $('badgeToggle').checked = state.settings.badge;
    renderSync();
    $('badgeNote').textContent = !('setAppBadge' in navigator)
      ? 'This browser can’t show icon badges. On iPhone it works in the Home Screen app once alerts are on.'
      : 'Shows how many objectives are left in your tracked groups on the app icon' + (typeof Notification !== 'undefined' && Notification.permission !== 'granted' ? '. Turn on alerts first so iOS allows it.' : '.');
  }
  Array.prototype.forEach.call(document.querySelectorAll('.seg-btn[data-theme]'), function (b) {
    b.addEventListener('click', function () { state.settings.theme = b.dataset.theme; save(); applyTheme(); renderSettings(); });
  });
  $('badgeToggle').addEventListener('change', function () { state.settings.badge = $('badgeToggle').checked; save(); updateBadge(); });
  $('settingsBtn').addEventListener('click', function () { closeSheet(sheet); renderSettings(); openSheet($('settingsSheet')); });
  $('settingsClose').addEventListener('click', function () { closeSheet($('settingsSheet')); });
  $('statsBtn').addEventListener('click', openStats);
  $('statsMenuBtn').addEventListener('click', openStats);
  $('statsClose').addEventListener('click', function () { closeSheet($('statsSheet')); });

  // ---------- Cloud sync (private GitHub gist) ----------
  // The token and gist id live under their own key, never in backups or in the synced file.
  // Each side remembers what it last agreed on: cfg.at (the gist's savedAt) and cfg.localAt
  // (this device's updatedAt). Only one side changed → copy it over; both changed → newer wins,
  // with daily stats merged so matches logged on either device are kept.
  var SYNC_KEY = 'fc27Objectives.sync';
  var GIST_FILE = 'fc27-tracker-progress.json';
  var GIST_DESC = 'FC 27 Objectives Tracker sync (managed by the app)';
  var SYNCED = ['progress', 'tracked', 'snap', 'cycles', 'sbc', 'sbcReps', 'sbcSkip', 'skip', 'evo', 'evoSkip', 'evoPlayer', 'ends', 'fav', 'stats', 'logMode'];
  var syncing = false, applying = false, syncTimer = null, syncErr = null;
  // editedAt moves only when synced content changes (not on view switches or opening a card).
  function syncSig() { return JSON.stringify(SYNCED.map(function (k) { return state[k]; })); }
  var lastSig = syncSig();
  function noteEdit() {
    var sig = syncSig();
    if (sig !== lastSig) { lastSig = sig; if (!applying) state.editedAt = new Date().toISOString(); }
    return sig;
  }

  function syncCfg() { try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || null; } catch (e) { return null; } }
  function setSyncCfg(c) { try { if (c) localStorage.setItem(SYNC_KEY, JSON.stringify(c)); else localStorage.removeItem(SYNC_KEY); } catch (e) { /* ignore */ } }

  function gh(path, opts, token) {
    opts = opts || {};
    return fetch('https://api.github.com' + path, {
      method: opts.method || 'GET',
      cache: 'no-store',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      if (r.status === 401) throw new Error('auth');
      if (r.status === 404) throw new Error('missing');
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  }

  function syncPayload() {
    var out = { app: 'fc27-objectives-tracker', appVersion: APP_VERSION, savedAt: new Date().toISOString(), updatedAt: state.editedAt, state: {} };
    SYNCED.forEach(function (k) { out.state[k] = state[k]; });
    return out;
  }

  function readGist(g) {
    var f = g.files && g.files[GIST_FILE];
    if (!f) return Promise.resolve(null);
    var p = f.truncated ? fetch(f.raw_url, { cache: 'no-store' }).then(function (r) { return r.text(); }) : Promise.resolve(f.content);
    return p.then(function (t) { try { var j = JSON.parse(t); return j && j.state ? j : null; } catch (e) { return null; } });
  }

  function mergeStats(a, b) {
    var out = {};
    [a || {}, b || {}].forEach(function (src) {
      Object.keys(src).forEach(function (day) {
        var d = out[day] || (out[day] = {});
        STAT_KEYS.forEach(function (k) { d[k] = Math.max(d[k] || 0, toInt((src[day] || {})[k] || 0)); });
      });
    });
    return out;
  }

  function applyRemote(remote) {
    var raw = {};
    SYNCED.forEach(function (k) { if (k in remote.state) raw[k] = remote.state[k]; });
    var next = normalize(raw);
    next.stats = mergeStats(state.stats, next.stats);
    next.settings = state.settings;
    next.ui = state.ui;
    next.lastLog = null;
    next.editedAt = remote.updatedAt || remote.savedAt;
    state = next;
    applying = true;
    save(true);
    applying = false;
    if (data) { renderChips(); refresh(); }
    if (sbcData) renderSbcs();
    if (evoData) renderEvos();
    if (ui.view === 'cal') renderCalendar();
  }

  function pushGist(cfg) {
    var body = { files: {} };
    body.files[GIST_FILE] = { content: JSON.stringify(syncPayload()) };
    var savedAt = JSON.parse(body.files[GIST_FILE].content).savedAt;
    return gh('/gists/' + cfg.gistId, { method: 'PATCH', body: body }, cfg.token).then(function () {
      cfg.at = savedAt;
      cfg.localAt = state.editedAt;
    });
  }

  function findOrCreateGist(cfg) {
    return gh('/user', {}, cfg.token).then(function (u) {
      cfg.login = u.login;
      return gh('/gists?per_page=100', {}, cfg.token);
    }).then(function (list) {
      var hit = list.filter(function (g) { return g.description === GIST_DESC || (g.files && g.files[GIST_FILE]); })[0];
      if (hit) { cfg.gistId = hit.id; return; }
      var body = { description: GIST_DESC, public: false, files: {} };
      body.files[GIST_FILE] = { content: JSON.stringify(syncPayload()) };
      return gh('/gists', { method: 'POST', body: body }, cfg.token).then(function (g) {
        cfg.gistId = g.id;
        cfg.at = JSON.parse(body.files[GIST_FILE].content).savedAt;
        cfg.localAt = state.editedAt;
        cfg.created = true;
      });
    });
  }

  function syncNow(manual) {
    var cfg = syncCfg();
    if (!cfg || !cfg.token || syncing) return Promise.resolve();
    if (!navigator.onLine) { syncErr = 'Offline, will sync when you’re back online'; renderSync(); return Promise.resolve(); }
    syncing = true;
    syncErr = null;
    renderSync();
    var result = '';
    var first = !cfg.gistId;
    var step = first ? findOrCreateGist(cfg) : Promise.resolve();
    return step.then(function () {
      if (cfg.created) { delete cfg.created; result = 'Cloud copy created'; return; }
      return gh('/gists/' + cfg.gistId, {}, cfg.token).then(readGist).then(function (remote) {
        var remoteChanged = !!remote && remote.savedAt !== cfg.at;
        var localChanged = !cfg.localAt || state.editedAt !== cfg.localAt;
        if (first && remote) {
          // A device joining an existing sync takes the cloud copy (stats are merged).
          applyRemote(remote);
          cfg.at = remote.savedAt;
          cfg.localAt = state.editedAt;
          result = 'Progress loaded from the cloud';
          return;
        }
        if (!remote || (localChanged && !remoteChanged)) return pushGist(cfg).then(function () { result = 'Saved to the cloud'; });
        if (remoteChanged && !localChanged) {
          applyRemote(remote);
          cfg.at = remote.savedAt;
          cfg.localAt = state.editedAt;
          result = 'Updated from your other device';
          return;
        }
        if (remoteChanged && localChanged) {
          if ((remote.updatedAt || remote.savedAt) > (state.editedAt || '')) {
            applyRemote(remote);
            result = 'Updated from your other device';
          } else {
            state.stats = mergeStats(state.stats, remote.state.stats);
            applying = true; save(true); applying = false;
          }
          return pushGist(cfg);
        }
        result = manual ? 'Already in sync' : '';
      });
    }).then(function () {
      cfg.lastSync = Date.now();
      setSyncCfg(cfg);
      if (result && (manual || /other device|loaded/.test(result))) toast(result);
    }).catch(function (e) {
      if (e.message === 'auth') { syncErr = 'GitHub rejected the token. Paste a new one.'; cfg.bad = true; setSyncCfg(cfg); }
      else if (e.message === 'missing') { delete cfg.gistId; setSyncCfg(cfg); syncErr = 'The cloud copy was deleted. Tap Sync now to make a new one.'; }
      else syncErr = 'Sync failed (' + (e.message || 'network') + '). It will try again.';
      if (manual) toast(syncErr);
    }).then(function () { syncing = false; renderSync(); });
  }

  function scheduleSync() {
    if (applying || !syncCfg()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { syncNow(false); }, 4000);
  }

  function ago(t) {
    var s = Math.round((Date.now() - t) / 1000);
    return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : niceDate(new Date(t).toISOString());
  }

  function renderSync() {
    if (!$('syncStatus')) return;
    var cfg = syncCfg();
    var on = !!(cfg && cfg.token && !cfg.bad);
    $('syncSetup').hidden = on;
    $('syncOn').hidden = !on;
    var st = $('syncStatus');
    st.className = 'sync-status' + (syncErr ? ' err' : '');
    st.textContent = syncErr ? syncErr
      : syncing ? 'Syncing…'
      : on ? 'On' + (cfg.login ? ' as ' + cfg.login : '') + (cfg.lastSync ? ' · last synced ' + ago(cfg.lastSync) : '')
      : 'Off';
  }

  $('syncConnect').addEventListener('click', function () {
    var t = $('syncToken').value.trim();
    if (!/^(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}$/.test(t)) { toast('That doesn’t look like a GitHub token'); return; }
    setSyncCfg({ token: t });
    $('syncToken').value = '';
    syncNow(true);
  });
  $('syncNow').addEventListener('click', function () { syncNow(true); });
  $('syncOff').addEventListener('click', function () {
    closeSheet($('settingsSheet'));
    askConfirm('Turn off sync on this device?', 'Your progress stays on this phone and the cloud copy stays in your gist. Connect again with a token any time.', function () {
      setSyncCfg(null);
      syncErr = null;
      renderSync();
      toast('Sync turned off');
    }, 'Turn off');
  });
  window.addEventListener('online', function () { if (syncCfg()) syncNow(false); });

  // ---------- Summary for the service worker ----------
  // Notifications are built by sw.js, which can't read localStorage, so the bits it needs
  // (unfinished tracked groups, this week's stats) are mirrored into IndexedDB.
  var mirrorTimer;
  function mirror() {
    clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(function () {
      if (!data || !window.indexedDB) return;
      var tracked = data.groups.filter(function (g) { return inPlay(g) && state.tracked[g.id]; });
      var unfinished = (tracked.length ? tracked : data.groups.filter(function (g) {
        return inPlay(g) && g.objectives.some(function (o) { return prog(g, o).p > 0; });
      })).filter(function (g) { return !groupDone(g); }).map(function (g) { return g.id; });
      var sbcOpen = sbcData ? sbcData.sbcs.filter(function (s) { return s.active !== false && !s.repeatable && !sbcSkipped(s) && sbcStarted(s) && !sbcDone(s); }).map(function (s) { return s.id; }) : [];
      var summary = { at: Date.now(), unfinished: unfinished, sbcOpen: sbcOpen, week: weekSummary(), left: badgeCount(), badge: state.settings.badge };
      try {
        var req = indexedDB.open('fc27-tracker', 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
        req.onsuccess = function () {
          try {
            var tx = req.result.transaction('kv', 'readwrite');
            tx.objectStore('kv').put(summary, 'summary');
            tx.oncomplete = function () { req.result.close(); };
          } catch (e) { /* ignore */ }
        };
      } catch (e) { /* private mode */ }
    }, 400);
  }

  // ---------- SBCs ----------
  function sbcKey(s, c) { return s.id + '/' + c.id; }
  function liveChallenges(s) { return s.challenges.filter(function (c) { return !c.retired; }); }
  function sbcDone(s) {
    if (s.repeatable) return false; // repeatables never "finish"; they count how often you did them
    var l = liveChallenges(s);
    return l.length > 0 && l.every(function (c) { return state.sbc[sbcKey(s, c)]; });
  }
  function sbcStarted(s) { return liveChallenges(s).some(function (c) { return state.sbc[sbcKey(s, c)]; }); }
  function sbcNew(s) { return s.active !== false && seenRecently(s.firstSeenAt, null); }
  function sbcSkipped(s) { return !!state.sbcSkip[s.id]; }
  function sbcInFilter(s, f) {
    if (f === 'expired') return s.active === false;
    if (s.active === false) return false;
    if (f === 'skipped') return sbcSkipped(s);
    if (f === 'new') return sbcNew(s);
    if (f === 'soon') return !!s.expiringSoon && !sbcDone(s) && !sbcSkipped(s);
    if (f === 'todo') return !s.repeatable && !sbcDone(s) && !sbcSkipped(s);
    if (f === 'done') return sbcDone(s) || !!state.sbcReps[s.id];
    if (f === 'all') return true;
    return s.category === f;
  }
  function sbcMatches(s, q) {
    if (!q) return true;
    var hay = [s.name, s.category, s.description, s.reward].concat(s.challenges.map(function (c) {
      return [c.name, c.reward].concat(c.requirements).join(' ');
    })).join(' ').toLowerCase();
    return q.split(/\s+/).every(function (w) { return hay.indexOf(w) !== -1; });
  }
  function coinText(n) { return n >= 1e6 ? (Math.round(n / 1e5) / 10) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : fmt(n); }

  function setSbcChallenge(s, c, on) {
    var k = sbcKey(s, c);
    var wasDone = sbcDone(s);
    if (on) state.sbc[k] = true; else delete state.sbc[k];
    if (!wasDone && sbcDone(s)) { today().sbc++; delete state.sbcSkip[s.id]; delete ui.sbcOpen[s.id]; toast(s.name + ' complete! 🎉'); }
    else if (wasDone && !sbcDone(s)) { var t = today(); t.sbc = Math.max(0, t.sbc - 1); }
    save();
    renderSbcs();
  }
  function setSbcComplete(s, on) {
    var wasDone = sbcDone(s);
    liveChallenges(s).forEach(function (c) { if (on) state.sbc[sbcKey(s, c)] = true; else delete state.sbc[sbcKey(s, c)]; });
    if (on) delete state.sbcSkip[s.id];
    var t = today();
    if (!wasDone && on) { t.sbc++; delete ui.sbcOpen[s.id]; toast(s.name + ' marked complete'); }
    else if (wasDone && !on) { t.sbc = Math.max(0, t.sbc - 1); toast(s.name + ' cleared'); }
    save();
    renderSbcs();
  }
  function setSbcSkipped(s, on) {
    if (on) { state.sbcSkip[s.id] = true; delete ui.sbcOpen[s.id]; } else delete state.sbcSkip[s.id];
    toast(on ? s.name + ' skipped' : s.name + ' back on your list');
    save();
    renderSbcs();
  }

  function bumpRepeat(s, delta) {
    var old = state.sbcReps[s.id] || 0;
    var n = Math.max(0, old + delta);
    if (n === old) return;
    if (n) state.sbcReps[s.id] = n; else delete state.sbcReps[s.id];
    var t = today();
    t.sbc = Math.max(0, t.sbc + n - old);
    save();
    renderSbcs();
  }

  function buildSbc(s) {
    var root = el('section', 'group sbc');
    root.dataset.id = s.id;
    var head = el('button', 'group-head');
    head.type = 'button';
    var open = !!ui.sbcOpen[s.id];
    head.setAttribute('aria-expanded', String(open));
    var l0 = liveChallenges(s);
    var ring = el('span', 'ring-mini' + (s.repeatable ? ' rep' : ''));
    ring.setAttribute('aria-hidden', 'true');
    ring.style.setProperty('--p', s.repeatable ? (state.sbcReps[s.id] ? 100 : 0) : l0.length ? Math.round(l0.filter(function (c) { return state.sbc[sbcKey(s, c)]; }).length / l0.length * 100) : 0);
    head.appendChild(ring);
    var title = el('div', 'group-title');
    title.appendChild(el('h2', null, s.name));
    var tags = el('span', 'tags');
    if (sbcNew(s)) tags.appendChild(el('span', 'tag new', 'New'));
    if (s.expiringSoon && s.active !== false) tags.appendChild(el('span', 'tag soon', 'Ending soon'));
    if (s.active === false) tags.appendChild(el('span', 'tag expired', 'Expired'));
    if (sbcDone(s)) tags.appendChild(el('span', 'tag done', 'Done'));
    if (sbcSkipped(s)) tags.appendChild(el('span', 'tag skipped', 'Skipped'));
    title.appendChild(tags);
    head.appendChild(title);
    var l = liveChallenges(s);
    var done = l.filter(function (c) { return state.sbc[sbcKey(s, c)]; }).length;
    head.appendChild(el('span', 'group-count', s.repeatable ? (state.sbcReps[s.id] ? '×' + state.sbcReps[s.id] : '') : done + '/' + l.length));
    var sub = el('p', 'group-sub');
    sub.appendChild(el('span', null, s.reward && s.reward !== s.name ? s.reward : s.category));
    sub.appendChild(el('span', null, [s.cost ? '≈ ' + coinText(s.cost) + ' coins' : '', s.repeatable ? '↻ ' + s.repeatable : ''].filter(Boolean).join(' · ')));
    head.appendChild(sub);
    if (!s.repeatable) {
      var bar = el('div', 'bar');
      var fill = el('div', 'bar-fill');
      fill.style.width = (l.length ? done / l.length * 100 : 0) + '%';
      bar.appendChild(fill);
      head.appendChild(bar);
    }
    root.appendChild(head);
    if (sbcDone(s)) root.classList.add('is-complete');
    if (sbcSkipped(s)) root.classList.add('is-skipped');

    var body = el('div', 'group-body');
    body.hidden = !open;
    head.addEventListener('click', function () {
      ui.sbcOpen[s.id] = body.hidden;
      if (!ui.sbcOpen[s.id]) delete ui.sbcOpen[s.id];
      body.hidden = !body.hidden;
      head.setAttribute('aria-expanded', String(!body.hidden));
      save();
    });
    if (s.description) body.appendChild(el('p', 'sbc-desc', s.description));
    function sbcSwitch(label, checked, fn) {
      var sw = el('label', 'group-switch');
      sw.appendChild(el('span', null, label));
      var inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.className = 'switch';
      inp.setAttribute('role', 'switch');
      inp.checked = checked;
      inp.addEventListener('change', function () { fn(inp.checked); });
      sw.appendChild(inp);
      body.appendChild(sw);
    }
    if (!s.repeatable) sbcSwitch('Mark whole SBC complete', sbcDone(s), function (on) { setSbcComplete(s, on); });
    if (!sbcDone(s)) sbcSwitch('Skip this SBC', sbcSkipped(s), function (on) { setSbcSkipped(s, on); });
    if (s.repeatable) {
      var rep = el('div', 'sbc-rep');
      rep.appendChild(el('span', null, 'Times done'));
      var minus = el('button', 'step mini minus', '−');
      minus.type = 'button';
      minus.setAttribute('aria-label', 'One fewer');
      minus.addEventListener('click', function () { bumpRepeat(s, -1); });
      var plus = el('button', 'step mini plus', '+');
      plus.type = 'button';
      plus.setAttribute('aria-label', 'Did it once more');
      plus.addEventListener('click', function () { bumpRepeat(s, 1); });
      rep.appendChild(minus);
      rep.appendChild(el('b', 'counter-val', String(state.sbcReps[s.id] || 0)));
      rep.appendChild(plus);
      body.appendChild(rep);
    }
    l.forEach(function (c) {
      var card = el('div', 'sbc-ch' + (state.sbc[sbcKey(s, c)] ? ' is-complete' : ''));
      var top = el('label', 'sbc-ch-top');
      if (!s.repeatable) {
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'sbc-check';
        cb.checked = !!state.sbc[sbcKey(s, c)];
        cb.addEventListener('change', function () { setSbcChallenge(s, c, cb.checked); });
        top.appendChild(cb);
      }
      var txt = el('span', 'sbc-ch-text');
      txt.appendChild(el('b', null, c.name));
      if (c.reward && c.reward !== s.reward) txt.appendChild(el('small', null, c.reward));
      top.appendChild(txt);
      card.appendChild(top);
      if (c.requirements.length) {
        var ul = el('ul', 'sbc-reqs');
        c.requirements.forEach(function (r) { ul.appendChild(el('li', null, r)); });
        card.appendChild(ul);
      }
      body.appendChild(card);
    });
    if (s.url) {
      var a = el('a', 'link', 'Solutions on fut.gg ↗');
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noopener';
      body.appendChild(a);
    }
    root.appendChild(body);
    return root;
  }

  function sbcFilters() {
    var list = [{ id: 'all', label: 'All' }, { id: 'todo', label: 'To do' }, { id: 'new', label: 'New' }, { id: 'soon', label: 'Ending soon' }];
    SBC_CATEGORIES.forEach(function (c) { if (sbcData.sbcs.some(function (s) { return s.active !== false && s.category === c; })) list.push({ id: c, label: c }); });
    list.push({ id: 'done', label: 'Done' });
    if (sbcData.sbcs.some(function (s) { return s.active !== false && sbcSkipped(s); })) list.push({ id: 'skipped', label: 'Skipped' });
    if (sbcData.sbcs.some(function (s) { return s.active === false; })) list.push({ id: 'expired', label: 'Expired' });
    return list;
  }

  function renderSbcs() {
    if (!sbcData) return;
    var chips = $('sbcChips');
    chips.innerHTML = '';
    var fl = sbcFilters();
    if (!fl.some(function (f) { return f.id === ui.sbcFilter; })) ui.sbcFilter = 'all';
    fl.forEach(function (f) {
      var b = el('button', 'chip', f.label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(f.id === ui.sbcFilter));
      b.appendChild(el('span', 'n', String(sbcData.sbcs.filter(function (s) { return sbcInFilter(s, f.id); }).length)));
      b.addEventListener('click', function () { ui.sbcFilter = f.id; save(); renderSbcs(); });
      chips.appendChild(b);
    });
    var q = ui.sbcQuery.trim().toLowerCase();
    var listEl = $('sbcList');
    listEl.innerHTML = '';
    var shown = sbcData.sbcs.filter(function (s) { return q ? s.active !== false && sbcMatches(s, q) : sbcInFilter(s, ui.sbcFilter); });
    // Finished and skipped SBCs sink to the bottom.
    shown.sort(function (a, b) { return (sbcDone(a) || sbcSkipped(a) ? 1 : 0) - (sbcDone(b) || sbcSkipped(b) ? 1 : 0); });
    shown.forEach(function (s) { listEl.appendChild(buildSbc(s)); });
    var empty = $('sbcEmpty');
    empty.hidden = shown.length > 0;
    empty.textContent = q ? 'No SBCs match “' + ui.sbcQuery.trim() + '”.'
      : ui.sbcFilter === 'new' ? 'No new SBCs in the last 24 hours.'
      : ui.sbcFilter === 'soon' ? 'Nothing ending soon that you still need.'
      : ui.sbcFilter === 'skipped' ? 'Nothing skipped.'
      : 'Nothing here yet.';

    var live = sbcData.sbcs.filter(function (s) { return s.active !== false; });
    var oneOff = live.filter(function (s) { return !s.repeatable && !sbcSkipped(s); });
    var doneN = oneOff.filter(sbcDone).length;
    var left = oneOff.filter(function (s) { return !sbcDone(s) && s.cost; }).reduce(function (n, s) { return n + s.cost; }, 0);
    var reps = live.reduce(function (n, s) { return n + (state.sbcReps[s.id] || 0); }, 0);
    $('sbcDoneN').textContent = doneN;
    $('sbcTotalN').textContent = oneOff.length;
    $('sbcReps').textContent = reps;
    $('sbcLeftCost').textContent = left ? coinText(left) : '0';
    $('sbcInfo').textContent = 'From fut.gg · updated ' + niceDate(sbcData.updatedAt) + '. Coin costs are fut.gg estimates and move with the market.';
    mirror();
  }

  function sbcValid(d) {
    return d && Array.isArray(d.sbcs) && d.sbcs.every(function (s) { return s && typeof s.id === 'string' && Array.isArray(s.challenges); });
  }
  function loadSbcs() {
    if (!sbcData) {
      try { var c = JSON.parse(localStorage.getItem(SBC_CACHE_KEY)); if (sbcValid(c)) { sbcData = c; renderSbcs(); } } catch (e) { /* ignore */ }
    }
    return fetch(SBC_URL, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        if (!sbcValid(d)) throw new Error('bad data');
        var changed = !sbcData || JSON.stringify(d) !== JSON.stringify(sbcData);
        try { localStorage.setItem(SBC_CACHE_KEY, JSON.stringify(d)); } catch (e) { /* ignore */ }
        if (changed) { sbcData = d; renderSbcs(); }
      })
      .catch(function () {
        if (sbcData) return;
        $('sbcEmpty').hidden = false;
        $('sbcEmpty').textContent = 'Could not load SBCs. Connect to the internet once, then reopen the app.';
      });
  }

  function setView(v) {
    ui.view = VIEWS.indexOf(v) !== -1 ? v : 'obj';
    $('objView').hidden = ui.view !== 'obj';
    $('sbcView').hidden = ui.view !== 'sbc';
    $('evoView').hidden = ui.view !== 'evo';
    $('calView').hidden = ui.view !== 'cal';
    $('logBtn').hidden = ui.view !== 'obj';
    $('viewTitle').textContent = { obj: 'Objectives', sbc: 'SBCs', evo: 'Evolutions', cal: 'Calendar' }[ui.view];
    if (ui.view === 'cal') renderCalendar();
    Array.prototype.forEach.call(document.querySelectorAll('.view-btn'), function (b) {
      b.setAttribute('aria-selected', String(b.dataset.view === ui.view));
    });
    save();
  }
  Array.prototype.forEach.call(document.querySelectorAll('.view-btn'), function (b) {
    b.addEventListener('click', function () { setView(b.dataset.view); window.scrollTo(0, 0); });
  });
  var sbcSearchTimer;
  $('sbcSearch').addEventListener('input', function (e) {
    clearTimeout(sbcSearchTimer);
    sbcSearchTimer = setTimeout(function () { ui.sbcQuery = e.target.value; renderSbcs(); }, 120);
  });

  // ---------- Evolutions ----------
  function evoKey(e, i) { return e.id + '/' + i; }
  function evoLevelsDone(e) { return e.levels.filter(function (lv, i) { return state.evo[evoKey(e, i)]; }).length; }
  function evoDone(e) { return e.levels.length ? evoLevelsDone(e) === e.levels.length : !!state.evo[e.id + '/done']; }
  function evoStarted(e) { return evoLevelsDone(e) > 0 || !!state.evoPlayer[e.id]; }
  function evoSkipped(e) { return !!state.evoSkip[e.id]; }
  function evoNew(e) { return e.active !== false && seenRecently(e.firstSeenAt, null); }
  function evoInFilter(e, f) {
    if (f === 'expired') return e.active === false;
    if (e.active === false) return false;
    if (f === 'skipped') return evoSkipped(e);
    if (f === 'todo') return !evoDone(e) && !evoSkipped(e);
    if (f === 'progress') return evoStarted(e) && !evoDone(e) && !evoSkipped(e);
    if (f === 'new') return evoNew(e);
    if (f === 'soon') return !!e.expiringSoon && !evoDone(e) && !evoSkipped(e);
    if (f === 'done') return evoDone(e);
    if (f === 'free') return !e.cost;
    return true;
  }
  function evoMatches(e, q) {
    if (!q) return true;
    var hay = [e.name, e.cost, state.evoPlayer[e.id]].concat(e.requirements).concat(e.levels.map(function (lv) {
      return lv.objectives.concat(lv.upgrades).join(' ');
    })).join(' ').toLowerCase();
    return q.split(/\s+/).every(function (w) { return hay.indexOf(w) !== -1; });
  }
  function setEvoLevel(e, i, on) {
    var was = evoDone(e);
    if (on) state.evo[evoKey(e, i)] = true; else delete state.evo[evoKey(e, i)];
    if (!was && evoDone(e)) { delete state.evoSkip[e.id]; delete ui.evoOpen[e.id]; toast(e.name + ' complete! 🎉'); }
    save();
    renderEvos();
  }
  function setEvoComplete(e, on) {
    if (e.levels.length) e.levels.forEach(function (lv, i) { if (on) state.evo[evoKey(e, i)] = true; else delete state.evo[evoKey(e, i)]; });
    else if (on) state.evo[e.id + '/done'] = true; else delete state.evo[e.id + '/done'];
    if (on) { delete state.evoSkip[e.id]; delete ui.evoOpen[e.id]; }
    toast(on ? e.name + ' marked complete' : e.name + ' cleared');
    save();
    renderEvos();
  }
  function setEvoSkipped(e, on) {
    if (on) { state.evoSkip[e.id] = true; delete ui.evoOpen[e.id]; } else delete state.evoSkip[e.id];
    toast(on ? e.name + ' skipped' : e.name + ' back on your list');
    save();
    renderEvos();
  }

  // A labelled on/off switch row, shared by SBC and Evolution cards.
  function switchRow(parent, label, checked, fn) {
    var sw = el('label', 'group-switch');
    sw.appendChild(el('span', null, label));
    var inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.className = 'switch';
    inp.setAttribute('role', 'switch');
    inp.checked = checked;
    inp.addEventListener('change', function () { fn(inp.checked); });
    sw.appendChild(inp);
    parent.appendChild(sw);
    return inp;
  }

  var EVO_KIND = { training: 'Training camp', instant: 'Instant' };
  function buildEvo(e) {
    var root = el('section', 'group sbc evo');
    root.dataset.id = e.id;
    var head = el('button', 'group-head');
    head.type = 'button';
    var open = !!ui.evoOpen[e.id];
    head.setAttribute('aria-expanded', String(open));
    var n = e.levels.length, d = evoLevelsDone(e);
    var ring = el('span', 'ring-mini');
    ring.style.setProperty('--p', n ? Math.round(d / n * 100) : evoDone(e) ? 100 : 0);
    head.appendChild(ring);
    var title = el('div', 'group-title');
    title.appendChild(el('h2', null, e.name));
    var tags = el('span', 'tags');
    if (evoNew(e)) tags.appendChild(el('span', 'tag new', 'New'));
    if (e.expiringSoon && e.active !== false && !evoDone(e)) tags.appendChild(el('span', 'tag soon', 'Ending soon'));
    if (EVO_KIND[e.kind]) tags.appendChild(el('span', 'tag', EVO_KIND[e.kind]));
    if (e.repeatable) tags.appendChild(el('span', 'tag', 'Repeatable'));
    if (e.active === false) tags.appendChild(el('span', 'tag expired', 'Expired'));
    if (evoDone(e)) tags.appendChild(el('span', 'tag done', 'Done'));
    if (evoSkipped(e) && !evoDone(e)) tags.appendChild(el('span', 'tag skipped', 'Skipped'));
    title.appendChild(tags);
    head.appendChild(title);
    head.appendChild(el('span', 'group-count', n ? d + '/' + n : ''));
    var sub = el('p', 'group-sub');
    sub.appendChild(el('span', null, state.evoPlayer[e.id] ? '👤 ' + state.evoPlayer[e.id] : e.requirements.slice(0, 2).join(' · ')));
    sub.appendChild(el('span', 'cost' + (e.cost ? '' : ' free'), e.cost || 'Free'));
    head.appendChild(sub);
    root.appendChild(head);
    if (evoDone(e)) root.classList.add('is-complete');
    if (evoSkipped(e) && !evoDone(e)) root.classList.add('is-skipped');

    var body = el('div', 'group-body');
    body.hidden = !open;
    head.addEventListener('click', function () {
      ui.evoOpen[e.id] = body.hidden;
      if (!ui.evoOpen[e.id]) delete ui.evoOpen[e.id];
      body.hidden = !body.hidden;
      head.setAttribute('aria-expanded', String(!body.hidden));
      save();
    });
    switchRow(body, 'Mark whole Evolution complete', evoDone(e), function (on) { setEvoComplete(e, on); });
    if (!evoDone(e)) switchRow(body, 'Skip this Evolution', evoSkipped(e), function (on) { setEvoSkipped(e, on); });

    var pl = el('label', 'evo-player');
    pl.appendChild(el('span', null, 'Player'));
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'Who are you evolving?';
    inp.maxLength = 60;
    inp.value = state.evoPlayer[e.id] || '';
    inp.addEventListener('change', function () {
      var v = inp.value.trim();
      if (v) state.evoPlayer[e.id] = v; else delete state.evoPlayer[e.id];
      save();
      renderEvos();
    });
    pl.appendChild(inp);
    body.appendChild(pl);

    if (e.requirements.length) {
      body.appendChild(el('h4', 'evo-sub', 'Eligible players'));
      var ul = el('ul', 'sbc-reqs');
      e.requirements.forEach(function (r) { ul.appendChild(el('li', null, r)); });
      body.appendChild(ul);
    }
    if (!e.levels.length) body.appendChild(el('p', 'squad-note', 'Level details aren’t on fut.gg yet. Use the switch above once it’s done.'));
    e.levels.forEach(function (lv, i) {
      var on = !!state.evo[evoKey(e, i)];
      var card = el('div', 'sbc-ch evo-level' + (on ? ' is-complete' : ''));
      var top = el('label', 'sbc-ch-top');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'sbc-check';
      cb.checked = on;
      cb.addEventListener('change', function () { setEvoLevel(e, i, cb.checked); });
      top.appendChild(cb);
      var txt = el('span', 'sbc-ch-text');
      txt.appendChild(el('b', null, e.levels.length > 1 ? 'Level ' + (i + 1) : e.kind === 'instant' ? 'Applied' : 'Done'));
      if (lv.objectives.length) txt.appendChild(el('span', 'evo-task', lv.objectives.join(' · ')));
      top.appendChild(txt);
      card.appendChild(top);
      if (lv.upgrades.length) {
        var up = el('ul', 'sbc-reqs upgrades');
        lv.upgrades.forEach(function (u) { up.appendChild(el('li', null, u)); });
        card.appendChild(up);
      }
      body.appendChild(card);
    });
    if (e.url) {
      var a = el('a', 'link', 'Eligible players on fut.gg ↗');
      a.href = e.url + 'eligible-players/';
      a.target = '_blank';
      a.rel = 'noopener';
      body.appendChild(a);
    }
    root.appendChild(body);
    return root;
  }

  function renderEvos() {
    if (!evoData) return;
    var fl = [{ id: 'all', label: 'All' }, { id: 'todo', label: 'To do' }, { id: 'progress', label: 'In progress' }, { id: 'new', label: 'New' }, { id: 'soon', label: 'Ending soon' }, { id: 'free', label: 'Free' }, { id: 'done', label: 'Done' }];
    if (evoData.evos.some(function (e) { return e.active !== false && evoSkipped(e); })) fl.push({ id: 'skipped', label: 'Skipped' });
    if (evoData.evos.some(function (e) { return e.active === false; })) fl.push({ id: 'expired', label: 'Expired' });
    if (!fl.some(function (f) { return f.id === ui.evoFilter; })) ui.evoFilter = 'all';
    var chips = $('evoChips');
    chips.innerHTML = '';
    fl.forEach(function (f) {
      var b = el('button', 'chip', f.label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(f.id === ui.evoFilter));
      b.appendChild(el('span', 'n', String(evoData.evos.filter(function (e) { return evoInFilter(e, f.id); }).length)));
      b.addEventListener('click', function () { ui.evoFilter = f.id; save(); renderEvos(); });
      chips.appendChild(b);
    });
    var q = ui.evoQuery.trim().toLowerCase();
    var shown = evoData.evos.filter(function (e) { return q ? e.active !== false && evoMatches(e, q) : evoInFilter(e, ui.evoFilter); });
    // In progress first, finished and skipped last.
    var rank = function (e) { return evoDone(e) || evoSkipped(e) ? 2 : evoStarted(e) ? 0 : 1; };
    shown.sort(function (a, b) { return rank(a) - rank(b); });
    var list = $('evoList');
    list.innerHTML = '';
    shown.forEach(function (e) { list.appendChild(buildEvo(e)); });
    var empty = $('evoEmpty');
    empty.hidden = shown.length > 0;
    empty.textContent = q ? 'No Evolutions match “' + ui.evoQuery.trim() + '”.'
      : ui.evoFilter === 'progress' ? 'Nothing in progress. Open an Evolution and add the player you’re using.'
      : 'Nothing here yet.';
    var live = evoData.evos.filter(function (e) { return e.active !== false && !evoSkipped(e); });
    $('evoDoneN').textContent = live.filter(evoDone).length;
    $('evoTotalN').textContent = live.length;
    $('evoProgN').textContent = live.filter(function (e) { return evoStarted(e) && !evoDone(e); }).length;
    $('evoFreeN').textContent = live.filter(function (e) { return !e.cost && !evoDone(e); }).length;
    $('evoInfo').textContent = 'From fut.gg · updated ' + niceDate(evoData.updatedAt) + '. Tick each level as you finish it in game.';
  }

  function loadJson(url, cacheKey, valid, apply, emptyId, label) {
    var hadCache = false;
    try { var c = JSON.parse(localStorage.getItem(cacheKey)); if (valid(c)) { hadCache = true; apply(c, true); } } catch (e) { /* ignore */ }
    return fetch(url, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        if (!valid(d)) throw new Error('bad data');
        try { localStorage.setItem(cacheKey, JSON.stringify(d)); } catch (e) { /* ignore */ }
        apply(d, false);
      })
      .catch(function () {
        if (hadCache) return;
        $(emptyId).hidden = false;
        $(emptyId).textContent = 'Could not load ' + label + '. Connect to the internet once, then reopen the app.';
      });
  }
  function loadEvos() {
    return loadJson(EVO_URL, EVO_CACHE_KEY, function (d) {
      return d && Array.isArray(d.evos) && d.evos.every(function (e) { return e && typeof e.id === 'string' && Array.isArray(e.levels); });
    }, function (d) {
      if (evoData && JSON.stringify(d) === JSON.stringify(evoData)) return;
      evoData = d;
      renderEvos();
      if (ui.view === 'cal') renderCalendar();
    }, 'evoEmpty', 'Evolutions');
  }
  var evoSearchTimer;
  $('evoSearch').addEventListener('input', function (ev) {
    clearTimeout(evoSearchTimer);
    evoSearchTimer = setTimeout(function () { ui.evoQuery = ev.target.value; renderEvos(); }, 120);
  });

  // ---------- Calendar ----------
  // fut.gg publishes no end dates, so the calendar combines the exact EA reset times, the
  // "ending soon" lists, end times the player typed in from the in-game timers, and EA's usual weekly rhythm.
  function ukTime(day, hour) {
    // UTC time of <hour>:00 London on the London calendar day containing `day`.
    return sixPmLondon(day) + (hour - 18) * 36e5;
  }
  function calItems() {
    var out = [];
    var add = function (key, name, type, extra) {
      out.push({ key: key, name: name, type: type, at: state.ends[key] || null, soon: extra.soon, view: extra.view, id: extra.id, filter: extra.filter });
    };
    if (data) data.groups.forEach(function (g) {
      if (!inPlay(g) || groupDone(g) || g.resets) return;
      if (g.expiringSoon || state.tracked[g.id] || state.ends['g:' + g.id]) add('g:' + g.id, g.name, 'Objectives', { soon: !!g.expiringSoon, view: 'obj', id: g.id });
    });
    if (sbcData) sbcData.sbcs.forEach(function (sb) {
      if (sb.active === false || sbcDone(sb) || sbcSkipped(sb) || sb.repeatable) return;
      if (sb.expiringSoon || sbcStarted(sb) || state.ends['s:' + sb.id]) add('s:' + sb.id, sb.name, 'SBC', { soon: !!sb.expiringSoon, view: 'sbc', id: sb.id });
    });
    if (evoData) evoData.evos.forEach(function (e) {
      if (e.active === false || evoDone(e) || evoSkipped(e)) return;
      if (e.expiringSoon || evoStarted(e) || state.ends['e:' + e.id]) add('e:' + e.id, e.name, 'Evolution', { soon: !!e.expiringSoon, view: 'evo', id: e.id });
    });
    return out;
  }

  function renderCalendar() {
    var box = $('calBody');
    box.innerHTML = '';
    var now = Date.now();
    var items = calItems();
    var undated = items.filter(function (it) { return !it.at || it.at < now - 864e5; });
    undated.sort(function (a, b) { return (b.soon ? 1 : 0) - (a.soon ? 1 : 0); });
    if (undated.length) {
      var sec = el('section', 'cal-undated');
      sec.appendChild(el('h3', 'cal-h', 'End time not set'));
      sec.appendChild(el('p', 'cal-note', 'fut.gg doesn’t publish end dates. Copy the timer from the game (“Ends in 2d 4h”) to put these on the calendar.'));
      undated.forEach(function (it) { sec.appendChild(calRow(it, null)); });
      box.appendChild(sec);
    }
    // Events for the next 14 days.
    var events = [];
    items.forEach(function (it) { if (it.at && it.at >= now - 864e5) events.push({ at: it.at, item: it }); });
    var dailyLeft = data ? data.groups.filter(function (g) { return inPlay(g) && g.resets === 'daily' && !groupDone(g); }).length : 0;
    var weeklyLeft = data ? data.groups.filter(function (g) { return inPlay(g) && g.resets === 'weekly' && !groupDone(g); }).length : 0;
    for (var i = 0; i < 15; i++) {
      var day = now + i * 864e5;
      var p = londonParts(day);
      var reset = sixPmLondon(day);
      if (reset > now) events.push({ at: reset, label: 'Daily objectives refresh', kind: 'reset', note: dailyLeft ? dailyLeft + ' daily group' + (dailyLeft === 1 ? '' : 's') + ' unfinished' : '' });
      if (p.wd === 'Thu' && reset > now) events.push({ at: reset, label: 'Weekly objectives refresh', kind: 'reset', note: weeklyLeft ? weeklyLeft + ' weekly group' + (weeklyLeft === 1 ? '' : 's') + ' unfinished' : '' });
      if (p.wd === 'Wed' && reset > now) events.push({ at: ukTime(day, 18), label: 'New Team of the Week', kind: 'usual' });
      if (p.wd === 'Fri' && reset > now) events.push({ at: ukTime(day, 18), label: 'New promo content', kind: 'usual' });
    }
    events.sort(function (a, b) { return a.at - b.at; });
    var lastDay = null, list = null;
    events.forEach(function (ev) {
      var d = new Date(ev.at);
      var k = dayKey(ev.at);
      if (k !== lastDay) {
        lastDay = k;
        var diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())) / 864e5);
        var h = el('h3', 'cal-day', diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }));
        box.appendChild(h);
        list = el('div', 'cal-list');
        box.appendChild(list);
      }
      if (ev.item) list.appendChild(calRow(ev.item, ev.at));
      else {
        var row = el('div', 'cal-row ' + ev.kind);
        row.appendChild(el('span', 'cal-time', d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })));
        var t = el('span', 'cal-text');
        t.appendChild(el('b', null, ev.label));
        if (ev.kind === 'usual') t.appendChild(el('small', null, 'Usual EA schedule, not confirmed'));
        else if (ev.note) t.appendChild(el('small', null, ev.note));
        row.appendChild(t);
        row.appendChild(el('span', 'cal-kind', ev.kind === 'reset' ? '↻' : '★'));
        list.appendChild(row);
      }
    });
    $('calInfo').textContent = 'Times in your time zone. EA refreshes content at 6pm UK.';
  }

  function calRow(it, at) {
    var row = el('div', 'cal-row item' + (it.soon ? ' soon' : ''));
    row.appendChild(el('span', 'cal-time', at ? new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—'));
    var t = el('button', 'cal-text link-btn');
    t.type = 'button';
    t.appendChild(el('b', null, it.name));
    t.appendChild(el('small', null, it.type + (at ? (at > Date.now() ? ' · ends in ' + countdown(at) : ' · ended') : it.soon ? ' · ending soon' : '')));
    t.addEventListener('click', function () { jumpTo(it); });
    row.appendChild(t);
    var b = el('button', 'cal-set', at ? 'Edit' : 'Set end');
    b.type = 'button';
    b.addEventListener('click', function () { openEnds(it); });
    row.appendChild(b);
    return row;
  }

  function jumpTo(it) {
    setView(it.view);
    var sel;
    if (it.view === 'obj') { ui.filter = 'all'; ui.open[it.id] = true; renderChips(); refresh(); if (views[it.id]) setOpen(groupsById[it.id], views[it.id], true); sel = '#groups .group[data-id="' + it.id + '"]'; }
    if (it.view === 'sbc') { ui.sbcFilter = 'all'; ui.sbcOpen[it.id] = true; renderSbcs(); sel = '#sbcList .sbc[data-id="' + it.id + '"]'; }
    if (it.view === 'evo') { ui.evoFilter = 'all'; ui.evoOpen[it.id] = true; renderEvos(); sel = '#evoList .evo[data-id="' + it.id + '"]'; }
    save();
    var node = document.querySelector(sel);
    if (node) node.scrollIntoView({ block: 'start' });
  }

  var endsItem = null;
  function pad(n) { return String(n).padStart(2, '0'); }
  function openEnds(it) {
    endsItem = it;
    $('endsTitle').textContent = it.name;
    var t = new Date(state.ends[it.key] || sixPmLondon(Date.now() + 864e5));
    $('endsInput').value = t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) + 'T' + pad(t.getHours()) + ':' + pad(t.getMinutes());
    $('endsDays').value = '';
    $('endsHours').value = '';
    $('endsClear').hidden = !state.ends[it.key];
    openSheet($('endsSheet'));
  }
  function saveEnds() {
    if (!endsItem) return;
    var d = toInt($('endsDays').value || 0), h = toInt($('endsHours').value || 0);
    var at = d || h ? Date.now() + d * 864e5 + h * 36e5 : Date.parse($('endsInput').value);
    if (!isFinite(at)) { toast('Pick a date and time'); return; }
    state.ends[endsItem.key] = Math.round(at / 6e4) * 6e4;
    save();
    closeSheet($('endsSheet'));
    renderCalendar();
    refresh();
    toast(endsItem.name + ' ends ' + new Date(at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }));
  }
  $('endsSave').addEventListener('click', saveEnds);
  $('endsClear').addEventListener('click', function () {
    if (endsItem) delete state.ends[endsItem.key];
    save();
    closeSheet($('endsSheet'));
    renderCalendar();
    refresh();
  });
  $('endsClose').addEventListener('click', function () { closeSheet($('endsSheet')); });
  [$('endsSheet')].forEach(function (node) {
    node.addEventListener('click', function (e) { if (e.target === node) closeSheet(node); });
  });

  // ---------- Screenshot import (reads the in-game Objectives screen on the phone) ----------
  var ocrWorker = null;
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var sc = document.createElement('script');
      sc.src = src;
      sc.onload = resolve;
      sc.onerror = function () { reject(new Error('load ' + src)); };
      document.head.appendChild(sc);
    });
  }
  function getOcr(progress) {
    if (ocrWorker) return Promise.resolve(ocrWorker);
    return (window.Tesseract ? Promise.resolve() : loadScript('vendor/tesseract/tesseract.min.js')).then(function () {
      return window.Tesseract.createWorker('eng', 1, {
        workerPath: 'vendor/tesseract/worker.min.js',
        corePath: 'vendor/tesseract/core',
        langPath: 'vendor/tesseract/lang',
        workerBlobURL: false,
        logger: function (m) { if (m && typeof m.progress === 'number') progress(m.status, m.progress); }
      });
    }).then(function (w) { ocrWorker = w; return w; });
  }
  // Light text on a dark game screen reads better inverted, greyscale and a bit larger.
  function prepImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = img.width < 1400 ? 2 : 1;
        var c = document.createElement('canvas');
        c.width = img.width * scale;
        c.height = img.height * scale;
        var ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, c.width, c.height);
        var px = ctx.getImageData(0, 0, c.width, c.height);
        var d = px.data, sum = 0;
        for (var i = 0; i < d.length; i += 4) { var y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; d[i] = d[i + 1] = d[i + 2] = y; sum += y; }
        var dark = sum / (d.length / 4) < 128;
        for (var j = 0; j < d.length; j += 4) {
          var v = dark ? 255 - d[j] : d[j];
          v = Math.max(0, Math.min(255, (v - 128) * 1.4 + 128));
          d[j] = d[j + 1] = d[j + 2] = v;
        }
        ctx.putImageData(px, 0, 0);
        URL.revokeObjectURL(url);
        resolve(c);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('image')); };
      img.src = url;
    });
  }

  function norm(t) { return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function bigrams(t) { var out = {}; t = t.replace(/ /g, ''); for (var i = 0; i < t.length - 1; i++) out[t.substr(i, 2)] = (out[t.substr(i, 2)] || 0) + 1; return out; }
  function similar(a, b) {
    if (!a || !b) return 0;
    if (b.indexOf(a) !== -1) return 1;
    var x = bigrams(a), y = bigrams(b), inter = 0, na = 0, nb = 0;
    Object.keys(x).forEach(function (k) { na += x[k]; if (y[k]) inter += Math.min(x[k], y[k]); });
    Object.keys(y).forEach(function (k) { nb += y[k]; });
    return na + nb ? 2 * inter / (na + nb) : 0;
  }
  // "3/10", "3 / 10", "3|10" (OCR often reads the slash as a bar).
  var FRACTION = /(\d[\d,.]*)\s*[\/|\\]\s*(\d[\d,.]*)/g;

  // Match OCR lines to objectives: a line naming an objective, then within the next few lines
  // a progress fraction whose total equals that objective's target (or a "completed" mark).
  function parseScan(lines) {
    var cands = [];
    data.groups.forEach(function (g) {
      if (g.active === false) return;
      liveObjectives(g).forEach(function (o) { cands.push({ g: g, o: o, name: norm(o.name), task: norm(o.task) }); });
    });
    var found = {};
    var nl = lines.map(norm);
    nl.forEach(function (line, i) {
      if (line.length < 4) return;
      var scored = cands.map(function (c) {
        var sName = c.name.length >= 4 ? Math.max(similar(c.name, line), line.length >= c.name.length * 0.6 ? similar(line, c.name) : 0) : 0;
        var sTask = c.task.length >= 12 && line.length >= 12 ? similar(line, c.task) * 0.95 : 0;
        return { c: c, s: Math.max(sName, sTask) };
      }).filter(function (x) { return x.s >= 0.8; });
      if (!scored.length) return;
      // Progress from this line or the next few.
      var window_ = nl.slice(i, i + 5).join(' | ');
      var fracs = [], m;
      FRACTION.lastIndex = 0;
      while ((m = FRACTION.exec(window_))) fracs.push({ v: toInt(m[1]), t: toInt(m[2]) });
      var complete = /\bcompleted?\b|\bclaimed?\b/.test(nl.slice(i, i + 4).join(' '));
      scored.forEach(function (x) {
        var f = fracs.filter(function (fr) { return fr.t === x.c.o.target && fr.v <= fr.t; })[0];
        var v = f ? f.v : complete ? x.c.o.target : null;
        if (v === null) return;
        x.v = v;
      });
      scored = scored.filter(function (x) { return x.v !== undefined; });
      if (!scored.length) return;
      // Several groups can share an objective name ("Win 1 Match"): prefer tracked groups,
      // then the best text match; skip it if that still leaves a tie.
      scored.sort(function (a, b) { return (state.tracked[b.c.g.id] ? 1 : 0) - (state.tracked[a.c.g.id] ? 1 : 0) || b.s - a.s; });
      var best = scored[0];
      var tie = scored[1] && scored[1].s === best.s && !!state.tracked[scored[1].c.g.id] === !!state.tracked[best.c.g.id] && scored[1].c.o.target === best.c.o.target;
      var k = key(best.c.g, best.c.o);
      if (found[k] && found[k].s >= best.s) return;
      found[k] = { g: best.c.g, o: best.c.o, v: best.v, s: best.s, tie: tie };
    });
    return Object.keys(found).map(function (k) { return found[k]; });
  }

  var scanPicks = {};
  var scanRows = [];
  function renderScan() {
    var prev = $('scanPreview');
    prev.innerHTML = '';
    var rows = scanRows.map(function (r) {
      var cur = prog(r.g, r.o).p;
      var why = r.v === cur ? 'already saved' : r.v < cur ? 'lower than saved (' + fmt(cur) + ')' : r.tie ? 'name matches more than one group' : '';
      return { r: r, cur: cur, why: why, same: r.v === cur };
    }).filter(function (x) { return !x.same; });
    var on = rows.filter(function (x) { var k = key(x.r.g, x.r.o); return k in scanPicks ? scanPicks[k] : !x.why; });
    prev.appendChild(el('p', 'log-count', !scanRows.length
      ? 'No objectives with progress were found. Use a screenshot of the in-game Objectives screen where names and numbers like 3/10 are visible.'
      : on.length ? 'Update ' + on.length + ' objective' + (on.length === 1 ? '' : 's') + ':' : 'Everything found already matches your saved progress.'));
    var list = el('div', 'log-list');
    rows.forEach(function (x) {
      var k = key(x.r.g, x.r.o);
      var row = el('label', 'log-item' + (x.why ? ' off' : ''));
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = k in scanPicks ? scanPicks[k] : !x.why;
      cb.addEventListener('change', function () { scanPicks[k] = cb.checked; renderScan(); });
      row.appendChild(cb);
      var txt = el('span', 'log-text');
      txt.appendChild(el('b', null, x.r.o.name));
      txt.appendChild(el('small', null, x.r.g.name + (x.why ? ' · ' + x.why : '')));
      row.appendChild(txt);
      row.appendChild(el('span', 'log-amt', fmt(x.cur) + ' → ' + fmt(x.r.v)));
      list.appendChild(row);
    });
    prev.appendChild(list);
    $('scanSave').hidden = !rows.length;
    $('scanSave').disabled = !on.length;
    $('scanSave').textContent = on.length ? 'Update ' + on.length : 'Nothing selected';
  }

  function runScan(files) {
    if (!data || !files.length) return;
    closeSheet(sheet);
    scanPicks = {};
    scanRows = [];
    $('scanPreview').innerHTML = '';
    $('scanSave').hidden = true;
    $('scanStatus').hidden = false;
    $('scanStatus').textContent = 'Getting the text reader ready… (first time takes a few seconds)';
    openSheet($('scanSheet'));
    var lines = [];
    var chain = getOcr(function (status, p) {
      if (/load|initiali/.test(status)) $('scanStatus').textContent = 'Getting the text reader ready… ' + Math.round(p * 100) + '%';
    });
    Array.prototype.forEach.call(files, function (f, i) {
      chain = chain.then(function (w) {
        $('scanStatus').textContent = 'Reading screenshot ' + (i + 1) + ' of ' + files.length + '…';
        return prepImage(f).then(function (canvas) { return w.recognize(canvas); }).then(function (res) {
          lines = lines.concat(String(res.data.text || '').split(/\n+/));
          return w;
        });
      });
    });
    chain.then(function () {
      $('scanStatus').hidden = true;
      scanRows = parseScan(lines);
      window.FCTracker.lastScanText = lines.join('\n');
      renderScan();
    }).catch(function () {
      $('scanStatus').textContent = 'Couldn’t read that image. The text reader needs an internet connection the first time.';
    });
  }

  function saveScan() {
    var changes = [];
    scanRows.forEach(function (r) {
      var k = key(r.g, r.o);
      var cur = prog(r.g, r.o);
      if (r.v === cur.p) return;
      var why = r.v < cur.p || r.tie;
      if (!(k in scanPicks ? scanPicks[k] : !why)) return;
      changes.push({ k: k, before: cur.p });
      state.progress[k] = { p: Math.min(r.o.target, r.v), added: cur.added };
    });
    state.lastLog = { at: Date.now(), kind: 'scan', changes: changes };
    save();
    closeSheet($('scanSheet'));
    refresh();
    toast('Updated ' + changes.length + ' objective' + (changes.length === 1 ? '' : 's') + ' from your screenshot');
  }

  var scanFile = $('scanFile');
  function pickScan() { scanFile.value = ''; scanFile.click(); }
  $('scanBtn').addEventListener('click', pickScan);
  $('scanMenuBtn').addEventListener('click', pickScan);
  scanFile.addEventListener('change', function () { runScan(scanFile.files || []); });
  $('scanSave').addEventListener('click', saveScan);
  $('scanClose').addEventListener('click', function () { closeSheet($('scanSheet')); });
  [$('scanSheet'), $('statsSheet'), $('settingsSheet')].forEach(function (node) {
    node.addEventListener('click', function (e) { if (e.target === node) closeSheet(node); });
  });

  // ---------- Search ----------
  var searchTimer;
  $('search').addEventListener('input', function (e) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { ui.query = e.target.value; refresh(); }, 120);
  });

  // Keep in sync if the app is open in two tabs.
  window.addEventListener('storage', function (e) {
    if (e.key === STORAGE_KEY) { state = load(); if (data) { renderChips(); refresh(); } }
  });

  // Pick up the daily data update when the app comes back to the foreground.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      if (data) { applyResets(); renderChips(); refresh(); } // let day-old items drop out of New
      if (sbcData) renderSbcs();
      if (ui.view === 'cal') renderCalendar();
      loadData(false);
      loadSbcs();
      loadEvos();
      syncNow(false);
    }
  });

  // ---------- Boot ----------
  $('appVersion').textContent = 'v' + APP_VERSION;
  applyTheme();
  // Deep links from notifications: ?filter=new|soon, ?view=sbc|stats, ?sbc=new.
  var startFilter = /[?&]filter=([\w-]+)/.exec(location.search);
  var startView = /[?&]view=(\w+)/.exec(location.search);
  var startSbc = /[?&]sbc=([\w-]+)/.exec(location.search);
  if (startFilter) { ui.filter = startFilter[1]; ui.view = 'obj'; }
  if (startSbc) { ui.sbcFilter = startSbc[1]; ui.view = 'sbc'; }
  if (startView && VIEWS.indexOf(startView[1]) !== -1) ui.view = startView[1];
  setView(ui.view);
  var early = cachedData();
  if (early) { data = early; renderAll(); }
  loadData(false).then(function () { if (startView && startView[1] === 'stats' && data) openStats(); syncNow(false); });
  loadSbcs();
  loadEvos();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    var hadController = !!navigator.serviceWorker.controller;
    var reloaded = false;
    // A new version took over: reload once so the new files are used straight away.
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible') reg.update().catch(function () {});
        });
      }).catch(function () { /* offline support unavailable */ });
    });
  }

  // Exposed for debugging and automated tests.
  window.FCTracker = {
    version: APP_VERSION,
    storageKey: STORAGE_KEY,
    getState: function () { return JSON.parse(JSON.stringify(state)); },
    getData: function () { return data; },
    suggestSquad: function (m) { var p = suggestSquad(m); return { slots: p.slots.map(slotLabel), fitted: p.fitted.map(function (it) { return key(it.g, it.o); }), free: p.free.length, left: p.left.map(function (it) { return key(it.g, it.o); }), owned: p.owned }; },
    syncNow: function () { return syncNow(true); }
  };
})();
