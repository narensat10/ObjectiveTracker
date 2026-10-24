(function () {
  'use strict';

  var APP_VERSION = '2.1.0';
  // Storage keys are deliberately not tied to APP_VERSION so app and data updates never wipe progress.
  var STORAGE_KEY = 'fc27Objectives.progress';
  var DATA_CACHE_KEY = 'fc27Objectives.dataCache';
  var LEGACY_KEY = 'phantomPlaygrounds.progress'; // v1 (Phantom Playgrounds only)
  var DATA_URL = 'data/objectives.json';
  var CATEGORIES = ['Campaigns', 'Seasonal', 'Foundations', 'Milestones', 'Mastery'];
  var NEW_DAYS = 3;

  var data = null;     // { updatedAt, baseline, groups: [...] }
  var groupsById = {};
  var state = load();
  var ui = { filter: state.ui.filter || null, query: '', open: {} };
  if (state.ui.open) ui.open = state.ui.open;

  // ---------- Persistence ----------
  function emptyState() {
    return { schema: 2, progress: {}, snap: {}, tracked: { 'phantom-playgrounds': true }, ui: { open: { 'phantom-playgrounds': true } }, updatedAt: null };
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
  function isNew(g) {
    if (!data || !g.firstSeen || g.active === false || g.firstSeen <= (data.baseline || '')) return false;
    return (Date.parse(data.updatedAt) - Date.parse(g.firstSeen)) / 864e5 < NEW_DAYS;
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
    head.appendChild(el('span', 'badge', 'Done'));
    card.appendChild(head);

    var row = { card: card };
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
    if (isNew(g)) view.tags.appendChild(el('span', 'tag new', 'New'));
    if (g.active === false) view.tags.appendChild(el('span', 'tag expired', 'Expired'));
    if (gDone) view.tags.appendChild(el('span', 'tag done', 'Done'));

    var totalTok = 0, earnedTok = 0;
    live.forEach(function (o) { var t = tokensIn(o.reward); totalTok += t; if (isDone(g, o)) earnedTok += t; });
    var bonus = tokensIn(g.groupRewards);
    totalTok += bonus;
    if (gDone) earnedTok += bonus;
    view.subLeft.textContent = totalTok ? 'Tokens ' + earnedTok + '/' + totalTok : (g.groupRewards ? '🎁 ' + g.groupRewards : '');
    view.subRight.textContent = totalTok && bonus ? (gDone ? 'Group bonus earned' : 'Group bonus +' + bonus) : '';

    view.star.setAttribute('aria-pressed', String(!!state.tracked[g.id]));

    if (!view.built) return;
    view.sw.checked = gDone;
    view.sw.setAttribute('aria-checked', String(gDone));
    g.objectives.forEach(function (o) {
      var r = view.rows[o.id];
      var p = prog(g, o);
      var v = Math.min(o.target, p.p);
      var d = v >= o.target;
      r.card.classList.toggle('is-complete', d);
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
    if (f === 'done') return groupDone(g);
    if (f === 'all') return true;
    return g.category === f;
  }

  function filters() {
    var list = [
      { id: 'tracking', label: '★ Tracking' },
      { id: 'all', label: 'All' }
    ];
    if (data.groups.some(isNew)) list.push({ id: 'new', label: 'New' });
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
        : 'Nothing here yet.';
    }
    updateDashboard();
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
    if (n) { note.appendChild(el('b', null, n + ' new')); note.appendChild(document.createTextNode(' since the last update.')); }
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
    if (e.key === 'Escape') { closeSheet(sheet); closeSheet(confirmEl); }
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
      snap: state.snap
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
    if (document.visibilityState === 'visible') loadData(false);
  });

  // ---------- Boot ----------
  $('appVersion').textContent = 'v' + APP_VERSION;
  var early = cachedData();
  if (early) { data = early; renderAll(); }
  loadData(false);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline support unavailable */ });
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
