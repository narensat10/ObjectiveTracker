// Evolution planner logic (window.EvoPlan in the app; module.exports in Node for tests).
// Reads each Evolution's limits ("Overall: max 80", "Position: CM or CDM", "Pace: max 83") and its
// OVR boost with fut.gg's cap ("+10 OVR (max 85)"), then works out who to use and which Evolutions
// can be stacked on one player, one after another, for the highest overall.
(function (root) {
  'use strict';
  var POSITIONS = ['GK', 'CB', 'LB', 'RB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'ST'];

  function model(e) {
    var m = { e: e, ovrMax: 99, ovrMin: 0, pos: null, paceMax: null, rarity: null, psPlusMax: null, bornAfter: null, gain: 0, cap: 0, pace: 0, psPlus: 0, notes: [] };
    e.requirements.forEach(function (r) {
      var x;
      if ((x = /^Overall: exactly (\d+)/i.exec(r))) { m.ovrMin = m.ovrMax = +x[1]; }
      else if ((x = /^Overall: max (\d+)/i.exec(r))) m.ovrMax = +x[1];
      else if ((x = /^Overall: min (\d+)/i.exec(r))) m.ovrMin = +x[1];
      else if ((x = /^Position: (.+)/i.exec(r))) m.pos = x[1].split(/,\s*|\s+or\s+/).map(function (p) { return p.trim().toUpperCase(); });
      else if ((x = /^Pace: max (\d+)/i.exec(r))) m.paceMax = +x[1];
      else if ((x = /^Rarity: (.+)/i.exec(r))) m.rarity = x[1].trim();
      else if ((x = /^Max PlayStyles\+: (\d+)/i.exec(r))) m.psPlusMax = +x[1];
      else if ((x = /^Born after (\d{4}-\d{2}-\d{2})/i.exec(r))) m.bornAfter = x[1];
      else if (/^Max PlayStyles: 7$|^Excluded positions/i.test(r)) { /* nearly every card passes */ }
      else m.notes.push(r);
    });
    var acc = 0, spr = 0, accCap = 0, sprCap = 0;
    e.levels.forEach(function (lv) {
      var opts = lv.upgrades.filter(function (u) { return /^Option /.test(u); });
      // A pick-one level only counts when every option gives the same OVR boost.
      var fixed = lv.upgrades.filter(function (u) { return !/^Option /.test(u); });
      var ovrOpt = opts.map(function (u) { var x = /\+(\d+) OVR \(max (\d+)\)/.exec(u); return x ? x[1] + '/' + x[2] : ''; });
      if (opts.length && ovrOpt[0] && ovrOpt.every(function (v) { return v === ovrOpt[0]; })) fixed = fixed.concat(['+' + ovrOpt[0].replace('/', ' OVR (max ') + ')']);
      fixed.forEach(function (u) {
        var x = /^\+(\d+) (.+?) \(max (\d+)/.exec(u);
        if (/PlayStyle\+/.test(u)) m.psPlus++;
        if (!x) return;
        if (x[2] === 'OVR') { m.gain += +x[1]; m.cap = Math.max(m.cap, +x[3]); }
        if (x[2] === 'Acceleration') { acc += +x[1]; accCap = +x[3]; }
        if (x[2] === 'Sprint Speed') { spr += +x[1]; sprCap = +x[3]; }
      });
    });
    // In-game Pace is roughly 45% Acceleration + 55% Sprint Speed, and each boost stops at its cap.
    m.pace = Math.round(acc * 0.45 + spr * 0.55);
    m.paceCap = m.pace ? Math.round((accCap || sprCap) * 0.45 + (sprCap || accCap) * 0.55) : 0;
    m.grants = /future stars academy/i.test(e.name) ? 'Future Stars Academy' : null;
    return m;
  }

  // p: { ovr, pos: [..], pace (or null), rarity, psPlus }. Returns the player after the Evolution, or null.
  function apply(p, m) {
    if (p.ovr > m.ovrMax || p.ovr < m.ovrMin) return null;
    if (m.pos && !p.pos.some(function (x) { return m.pos.indexOf(x) !== -1; })) return null;
    if (m.paceMax != null && p.pace != null && p.pace > m.paceMax) return null;
    if (m.rarity && p.rarity !== m.rarity) return null;
    if (m.psPlusMax != null && p.psPlus > m.psPlusMax) return null;
    return {
      ovr: m.gain && p.ovr < m.cap ? Math.min(p.ovr + m.gain, m.cap) : p.ovr,
      pos: m.pos ? p.pos.filter(function (x) { return m.pos.indexOf(x) !== -1; }) : p.pos,
      pace: p.pace == null || !m.pace ? p.pace : Math.min(p.pace + m.pace, Math.max(p.pace, m.paceCap)),
      rarity: m.grants || p.rarity,
      psPlus: p.psPlus + m.psPlus
    };
  }

  function paid(path) { return path.filter(function (m) { return m.e.cost; }).length; }

  // Every order of up to maxLen Evolutions this player can go through; best final OVR first.
  function chains(models, start, maxLen) {
    var out = [];
    (function walk(p, path) {
      if (path.length) out.push({ path: path, end: p });
      if (path.length >= (maxLen || 4)) return;
      models.forEach(function (m) {
        // Only steps that raise OVR; Evolutions without an OVR boost fit in anywhere.
        if (!m.gain || path.indexOf(m) !== -1) return;
        var next = apply(p, m);
        if (next && next.ovr > p.ovr) walk(next, path.concat([m]));
      });
    })(start, []);
    out.sort(function (a, b) { return b.end.ovr - a.end.ovr || a.path.length - b.path.length || paid(a.path) - paid(b.path); });
    return out;
  }

  // Ages are counted on `now`; "born after" means strictly after, so the safe age limit rounds down.
  function ageLimit(bornAfter, now) {
    var b = new Date(bornAfter + 'T00:00:00Z'), n = now ? new Date(now) : new Date();
    var age = n.getUTCFullYear() - b.getUTCFullYear() - ((n.getUTCMonth() < b.getUTCMonth() || (n.getUTCMonth() === b.getUTCMonth() && n.getUTCDate() <= b.getUTCDate())) ? 1 : 0);
    return Math.max(15, age - 1);
  }

  // Best single-card start for each chain, over every position, starting OVR and pace.
  function best(models, now) {
    var found = {};
    POSITIONS.forEach(function (pos) {
      for (var s = 60; s <= 90; s++) {
        [55, 65, 70, 75, 80, 85, 90, 95].forEach(function (pace) {
          chains(models, { ovr: s, pos: [pos], pace: pace, rarity: null, psPlus: 0 }, 4).forEach(function (c) {
            if (c.path.length < 2 || c.end.ovr <= s) return;
            var k = c.path.map(function (m) { return m.e.id; }).join('>');
            var f = found[k] || (found[k] = { c: c, pos: {}, lo: s, hi: s, end: c.end.ovr, pace: pace });
            if (c.end.ovr > f.end) { f.end = c.end.ovr; f.lo = f.hi = s; f.pos = {}; f.pace = pace; }
            if (c.end.ovr === f.end) { f.pos[pos] = true; f.lo = Math.min(f.lo, s); f.hi = Math.max(f.hi, s); f.pace = Math.max(f.pace, pace); }
          });
        });
      }
    });
    var list = Object.keys(found).map(function (k) { return found[k]; });
    // Highest finish first; for the same finish, the fewest Evolutions (less to play), then the widest start.
    list.sort(function (a, b) { return b.end - a.end || a.c.path.length - b.c.path.length || (b.hi - b.lo) - (a.hi - a.lo); });
    // A longer chain that contains a listed one with the same finish only earns a place by taking lower-rated cards.
    var shown = [];
    list.forEach(function (f) {
      var ids = f.c.path.map(function (m) { return m.e.id; });
      if (shown.some(function (g) {
        return g.end === f.end && g.lo <= f.lo && g.c.path.every(function (m) { return ids.indexOf(m.e.id) !== -1; });
      })) return;
      f.positions = POSITIONS.filter(function (p) { return f.pos[p]; });
      var born = f.c.path.map(function (m) { return m.bornAfter; }).filter(Boolean);
      f.ageMax = born.length ? Math.min.apply(null, born.map(function (d) { return ageLimit(d, now); })) : null;
      shown.push(f);
    });
    return shown;
  }

  // Players named by guides for the Evolutions in a chain, run through the chain to check they fit
  // and to show where they end up. Picks without a known OVR only count for the first Evolution.
  function chainPicks(f, models) {
    var path = f.c.path, seen = {}, out = [];
    // Guide picks for the chain's own Evolutions first, then any other Evolution's picks that also fit.
    var sources = path.concat((models || []).filter(function (m) { return path.indexOf(m) === -1; }));
    sources.forEach(function (m) {
      (m.e.picks || []).forEach(function (pk) {
        if (seen[pk.name]) return;
        if (pk.ovr == null) {
          if (m !== path[0] || (pk.pos && f.positions && !pk.pos.some(function (x) { return f.positions.indexOf(x) !== -1; }))) return;
          seen[pk.name] = true;
          out.push({ pick: pk, end: null });
          return;
        }
        var p = { ovr: pk.ovr, pos: pk.pos || (m.pos || POSITIONS).slice(), pace: null, rarity: null, psPlus: 0 };
        for (var k = 0; k < path.length && p; k++) p = apply(p, path[k]);
        if (!p) return;
        seen[pk.name] = true;
        out.push({ pick: pk, end: p.ovr });
      });
    });
    out.sort(function (a, b) { return (b.end || 0) - (a.end || 0); });
    return out;
  }

  var api = { POSITIONS: POSITIONS, model: model, apply: apply, chains: chains, best: best, chainPicks: chainPicks, ageLimit: ageLimit };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EvoPlan = api;
})(this);
