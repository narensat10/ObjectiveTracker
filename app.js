(function () {
  'use strict';

  var APP_VERSION = '3.0.0';
  // Storage keys are deliberately not tied to APP_VERSION so app and data updates never wipe progress.
  var STORAGE_KEY = 'fc27Objectives.progress';
  var DATA_CACHE_KEY = 'fc27Objectives.dataCache';
  var LEGACY_KEY = 'phantomPlaygrounds.progress'; // v1 (Phantom Playgrounds only)
  var DATA_URL = 'data/objectives.json';
  var CATEGORIES = ['Campaigns', 'Seasonal', 'Foundations', 'Milestones', 'Mastery'];
  var NEW_MS = 24 * 3600 * 1000; // things stay in the New filter for a day after they appear
  var SOON_MS = 24 * 3600 * 1000; // daily/weekly groups count as "ending soon" in their last day
  // Public half of the Web Push key pair; the private half is the VAPID_PRIVATE_KEY repo secret.
  var VAPID_PUBLIC_KEY = 'BK5UnrgC7Zx2lG2_Wm6W4j4Nq6gkqlcLHtPGMzYywSRC7fBjd_aWaE4XdqEt78SCwtlZXFKdOyFJ8ekrGpCC8W8';

  var data = null;     // { updatedAt, baseline, groups: [...] }
  var groupsById = {};
  var state = load();
  var ui = { filter: state.ui.filter || null, query: '', open: {} };
  if (state.ui.open) ui.open = state.ui.open;

  // ---------- Persistence ----------
  function emptyState() {
    return { schema: 2, progress: {}, snap: {}, cycles: {}, logMode: 'rivals', lastLog: null, tracked: { 'phantom-playgrounds': true }, ui: { open: { 'phantom-playgrounds': true } }, updatedAt: null };
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
    if (typeof raw.logMode === 'string') s.logMode = raw.logMode;
    if (raw.lastLog && Array.isArray(raw.lastLog.changes)) s.lastLog = raw.lastLog;
    if (raw.ui && typeof raw.ui === 'object') {
      s.ui = { filter: typeof raw.ui.filter === 'string' ? raw.ui.filter : null, open: raw.ui.open && typeof raw.ui.open === 'object' ? raw.ui.open : {} };
    }
    s.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
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
  function save() {
    state.updatedAt = new Date().toISOString();
    state.ui = { filter: ui.filter, open: ui.open };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      storageOk = true;
    } catch (e) {
      if (storageOk) toast('Could not save on this device (private browsing?)');
      storageOk = false;
    }
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
    var title = el('div', 'group-title');
    var chev = el('span', 'chev', '›');
    chev.setAttribute('aria-hidden', 'true');
    title.appendChild(chev);
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

    var view = { root: root, head: head, tags: tags, count: count, fill: fill, subLeft: subLeft, subRight: subRight, star: star, body: body, rows: {}, built: false };
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
    view.root.classList.toggle('is-complete', gDone);
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
    if (f === 'tracking') return !!state.tracked[g.id];
    if (f === 'new') return isNew(g);
    if (f === 'soon') return endingSoon(g);
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
      v.root.style.order = groupDone(g) ? 1 : 0; // finished groups sink to the bottom
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
    $('undoLogBtn').hidden = !state.lastLog;
  }

  function updateDashboard() {
    var tracked = data.groups.filter(function (g) { return g.active !== false && state.tracked[g.id]; });
    var scope = tracked.length ? tracked : data.groups.filter(function (g) { return g.active !== false; });
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
  function askConfirm(title, text, fn) {
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
    if (e.key === 'Escape') { [sheet, confirmEl, $('logSheet'), $('alertsSheet')].forEach(closeSheet); }
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
      cycles: state.cycles
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
        state = next;
        save();
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
    askConfirm('Reset all progress?', 'This clears progress and Player added ticks for every objective. Your tracked groups stay. Export a backup first if you might want it back.', function () {
      state.progress = {};
      state.snap = {};
      save();
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
    save();
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
    var tracked = data.groups.filter(function (g) { return g.active !== false && state.tracked[g.id]; });
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

  function openLog() {
    if (!data) return;
    log = newLog();
    logPicks = {};
    fillModes();
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
    state.lastLog = { at: Date.now(), changes: changes };
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
    var n = state.lastLog.changes.length;
    state.lastLog = null;
    save();
    refresh();
    toast('Last match undone (' + n + ' objective' + (n === 1 ? '' : 's') + ')');
  }

  buildLogSheet();
  $('logBtn').addEventListener('click', openLog);
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
    $('alertsText').textContent = 'Alerts are on for this phone. One-time step: copy the alert code below and send it to Claude in your project thread, so the nightly update knows where to send alerts.';
  }
  function openAlerts() {
    closeSheet(sheet);
    $('alertsOn').hidden = false;
    $('alertsCode').hidden = $('alertsCopy').hidden = $('alertsTest').hidden = true;
    if (!pushSupported() || !standalone()) {
      $('alertsText').textContent = 'On iPhone, alerts only work in the Home Screen app (iOS 16.4 or later). Add this page to your Home Screen with Share → Add to Home Screen, open it from there, then come back here.';
      $('alertsOn').hidden = !pushSupported();
    } else {
      $('alertsText').textContent = 'Get a notification when the nightly update finds new objectives.';
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
      loadData(false);
    }
  });

  // ---------- Boot ----------
  $('appVersion').textContent = 'v' + APP_VERSION;
  var startFilter = /[?&]filter=([\w-]+)/.exec(location.search);
  if (startFilter) ui.filter = startFilter[1]; // e.g. opened from a "new objectives" notification
  var early = cachedData();
  if (early) { data = early; renderAll(); }
  loadData(false);

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
    getData: function () { return data; }
  };
})();
