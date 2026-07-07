/* @harness/control-plane — regions/fleet.js  (B3 wave 2)
 *
 * Upgraded Fleet region: "Your providers and kernels in one console" — the
 * operator lens. A read-only STATUS DASHBOARD over the registry the shell
 * already exposes; it probes, groups, and counts. It fixes nothing, invents
 * nothing, and never reports a healthy status it did not observe.
 *
 *   - Health strip  — Registry (did GET {base}/api/capabilities answer, how
 *                     fast, when), Local supply, and PCC gateway. PCC status
 *                     is derived honestly: the gateway is "configured" only
 *                     when the registry answered AND networked (pcc/a2a)
 *                     capabilities are present; "PCC gateway not configured —
 *                     offline" when the registry answered with none; and
 *                     "unknown" when the registry itself is unreachable (a
 *                     dead registry says nothing about the gateway).
 *   - Supply        — capabilities grouped by side (local vs PCC) and by
 *                     adapter (sourceDetail.owner, falling back to the source
 *                     type). Per adapter: count, trust-level counts, kind
 *                     counts (only when caps carry a `kind`), sample origin.
 *   - Authority     — per-side authority-class summary derived from trust
 *                     levels via the same map regions/activity.js uses
 *                     (read→observe, write/network→mutate, exec→actuate,
 *                     credential→privileged; anything else → unclassified).
 *
 * Data honesty: offline sample caps (__demo) are excluded — a walkthrough
 * sample is not supply. When the live probe fails but the catalog holds a
 * previously-loaded registry, structure renders from that cache and the
 * health strip says so ("showing last-loaded registry").
 *
 * Registration: assigns CP.regionBuilders.fleet — shell.js consults
 * CP.regionBuilders before its inline builders (the B3 hook), and its
 * catalog-loaded / registry-grew paths call CP.rebuildRegion('fleet'), which
 * lands here too. Loads AFTER shell.js in index.html, before boot.
 *
 * Hygiene: every dynamic string lands via textContent — no innerHTML.
 */
(function () {
  'use strict';

  var CP = window.CP = window.CP || {};
  if (!CP.bus || !CP.api) return; // shell absent — nothing to extend
  var bus = CP.bus;
  var el = CP.el || function (tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  };
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ── region-local styles (injected once) ──────────────────────────────────
  var STYLE_ID = 'cp-fleet-styles';
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.flt-health{display:grid;grid-template-columns:1fr;gap:10px;margin:0 0 14px;}',
      '@media (min-width:760px){.flt-health{grid-template-columns:repeat(3,1fr);}}',
      '.flt-health .panel{margin-bottom:0;}',
      '.flt-section{margin:0 0 16px;}',
      '.flt-sec-h{display:flex;align-items:baseline;gap:10px;margin:0 0 6px;}',
      '.flt-sec-h h3{margin:0;font-size:13px;text-transform:uppercase;letter-spacing:.7px;',
      ' color:var(--muted);}',
      '.flt-auth{font-size:12px;color:var(--muted);font-family:var(--mono);margin:0 0 8px;}',
      '.flt-src{font-size:10.5px;font-family:var(--mono);padding:1px 7px;border-radius:16px;',
      ' border:1px dashed var(--edge);color:var(--muted);white-space:nowrap;margin-left:8px;}',
      '.flt-foot{display:flex;align-items:center;gap:10px;margin:6px 0 0;flex-wrap:wrap;}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  }

  // ── classification (mirrors regions/activity.js AUTHORITY) ───────────────
  var AUTHORITY = { read: 'observe', write: 'mutate', network: 'mutate', exec: 'actuate', credential: 'privileged' };

  function isNetworkCap(c) { return !!c && (c.source === 'pcc' || c.source === 'a2a'); }

  /** Group non-demo caps into {local, pcc} sides, each with adapter buckets. */
  function groupSupply(caps) {
    var sides = {
      local: { count: 0, adapters: {} },
      pcc: { count: 0, adapters: {} }
    };
    (caps || []).forEach(function (c) {
      if (!c) return;
      var side = sides[isNetworkCap(c) ? 'pcc' : 'local'];
      side.count++;
      var name = (c.sourceDetail && c.sourceDetail.owner) || c.source || 'unknown';
      var a = side.adapters[name] = side.adapters[name] ||
        { name: name, source: c.source || '', caps: [], trust: {}, kinds: {}, origin: null };
      a.caps.push(c);
      var t = c.trustLevel || 'unknown';
      a.trust[t] = (a.trust[t] || 0) + 1;
      if (c.kind != null) {
        var kk = String(c.kind);
        a.kinds[kk] = (a.kinds[kk] || 0) + 1;
      }
      if (!a.origin && c.sourceDetail && c.sourceDetail.origin) {
        a.origin = String(c.sourceDetail.origin);
      }
    });
    return sides;
  }

  /** Authority-class counts for one side; unknown trust stays unclassified. */
  function authoritySummary(caps) {
    var out = {};
    (caps || []).forEach(function (c) {
      var cls = AUTHORITY[c && c.trustLevel] || 'unclassified';
      out[cls] = (out[cls] || 0) + 1;
    });
    return out;
  }

  // ── module state ──────────────────────────────────────────────────────────
  var probe = { state: 'idle', ok: null, at: null, ms: null, error: null };
  var fleetCaps = [];      // last good non-demo list (live probe, or cache)
  var usedCache = false;   // structure came from the catalog cache, not the probe
  var probing = false;
  var timer = null;

  function catalogCache() {
    var list = (CP.catalog && typeof CP.catalog.all === 'function') ? CP.catalog.all() : [];
    if (!list || !list.length) list = (CP.state && CP.state.caps) || [];
    return (list || []).filter(function (c) { return c && !c.__demo; });
  }

  /** One reachability probe = one real GET /api/capabilities, timed. */
  function runProbe() {
    if (probing) return Promise.resolve();
    probing = true;
    var t0 = Date.now();
    return CP.api.getJSON('/api/capabilities').then(function (list) {
      probing = false;
      probe = { state: 'done', ok: true, at: new Date(), ms: Date.now() - t0, error: null };
      if (Array.isArray(list)) {
        fleetCaps = list.filter(function (c) { return c && !c.__demo; });
        usedCache = false;
      }
      renderAll();
    }, function (err) {
      probing = false;
      probe = {
        state: 'done', ok: false, at: new Date(), ms: Date.now() - t0,
        error: String((err && err.message) || err)
      };
      var cache = catalogCache();
      if (cache.length) { fleetCaps = cache; usedCache = true; }
      renderAll();
    });
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  function row(host, k, v) {
    var r = el('div', 'pipe-row');
    r.appendChild(el('span', 'k', k));
    r.appendChild(el('span', 'v', String(v)));
    host.appendChild(r);
    return r;
  }

  function hCard(title) {
    var c = el('article', 'panel');
    var h = el('div', 'panel-h', title);
    var d = el('span', 'dot');
    h.appendChild(d);
    c.appendChild(h);
    var b = el('div', 'pipe-body');
    c.appendChild(b);
    return { el: c, dot: d, body: b };
  }

  function fmtWhen(d) {
    try { return d ? d.toTimeString().slice(0, 8) : ''; } catch (e) { return ''; }
  }

  function healthCards(host, sides) {
    clear(host);

    // 1. Registry — the one thing this region can actually observe directly.
    var reg = hCard('Registry');
    if (probe.state !== 'done') {
      reg.body.appendChild(el('p', 'muted', 'Probing GET /api/capabilities…'));
    } else if (probe.ok) {
      reg.dot.className = 'dot live';
      row(reg.body, 'status', 'reachable');
      row(reg.body, 'capabilities', String(fleetCaps.length));
      row(reg.body, 'probe', probe.ms + ' ms · ' + fmtWhen(probe.at));
    } else {
      row(reg.body, 'status', 'unreachable');
      var e = String(probe.error || '');
      if (e.length > 60) e = e.slice(0, 57) + '…';
      if (e) row(reg.body, 'error', e);
      reg.body.appendChild(el('p', 'muted small', usedCache
        ? 'Showing the last-loaded registry — counts below may be stale.'
        : 'No providers visible — connect to a control-plane server (⚙ in the header).'));
    }
    host.appendChild(reg.el);

    // 2. Local supply.
    var loc = hCard('Local supply');
    var locAdapters = Object.keys(sides.local.adapters).length;
    if (probe.state !== 'done' && !fleetCaps.length) {
      loc.body.appendChild(el('p', 'muted', 'Waiting on the registry…'));
    } else {
      if (probe.ok && sides.local.count > 0) loc.dot.className = 'dot live';
      row(loc.body, 'capabilities', String(sides.local.count));
      row(loc.body, 'adapters', String(locAdapters));
    }
    host.appendChild(loc.el);

    // 3. PCC gateway — honest three-state: configured / not configured / unknown.
    var pcc = hCard('PCC gateway');
    if (probe.state !== 'done' && !fleetCaps.length) {
      pcc.body.appendChild(el('p', 'muted', 'Waiting on the registry…'));
    } else if (probe.ok === true && sides.pcc.count > 0) {
      pcc.dot.className = 'dot live';
      row(pcc.body, 'status', 'configured');
      row(pcc.body, 'networked caps', String(sides.pcc.count));
    } else if (probe.ok === true) {
      row(pcc.body, 'status', 'not configured — offline');
      pcc.body.appendChild(el('p', 'muted small',
        'No networked (pcc/a2a) capabilities in the registry. They appear here when the gateway registers supply.'));
    } else {
      row(pcc.body, 'status', 'unknown — registry unreachable');
      if (sides.pcc.count > 0) {
        row(pcc.body, 'last seen', String(sides.pcc.count) + ' networked caps (cached)');
      }
    }
    host.appendChild(pcc.el);
  }

  function renderSide(host, side, kind) {
    clear(host);
    var names = Object.keys(side.adapters).sort(function (a, b) {
      return side.adapters[b].caps.length - side.adapters[a].caps.length;
    });
    if (!names.length) {
      var msg;
      if (probe.state !== 'done') {
        msg = 'Probing the registry…';
      } else if (kind === 'pcc') {
        msg = probe.ok === false
          ? 'Registry unreachable — networked supply unknown.'
          : 'PCC gateway not configured — offline. Networked kernels appear here when the gateway registers supply.';
      } else {
        msg = probe.ok === false
          ? 'Registry unreachable — local supply unknown.'
          : 'No local capabilities visible yet.';
      }
      host.appendChild(el('p', 'muted', msg));
      return;
    }

    // Authority-class summary for the whole side.
    var allCaps = [];
    names.forEach(function (n) { allCaps = allCaps.concat(side.adapters[n].caps); });
    var auth = authoritySummary(allCaps);
    var line = Object.keys(auth).map(function (k) { return k + ' × ' + auth[k]; }).join(' · ');
    host.appendChild(el('p', 'flt-auth', 'authority: ' + line));

    var grid = el('div', 'fleet-grid');
    names.slice(0, 24).forEach(function (n) {
      var a = side.adapters[n];
      var card = el('article', 'panel fleet-card');
      var h = el('div', 'panel-h', a.name);
      if (a.source) h.appendChild(el('span', 'flt-src', a.source));
      card.appendChild(h);
      var fb = el('div', 'pipe-body');
      row(fb, 'capabilities', String(a.caps.length));
      var tr = el('div', 'cap-badges');
      Object.keys(a.trust).forEach(function (t) {
        tr.appendChild(el('span', 'badge trust-' + t, t + ' ×' + a.trust[t]));
      });
      fb.appendChild(tr);
      var kk = Object.keys(a.kinds);
      if (kk.length) {
        row(fb, 'kinds', kk.map(function (k) { return k + ' ×' + a.kinds[k]; }).join(' · '));
      }
      if (a.origin) {
        var o = a.origin;
        if (o.length > 44) o = o.slice(0, 41) + '…';
        row(fb, 'origin', o);
      }
      card.appendChild(fb);
      grid.appendChild(card);
    });
    host.appendChild(grid);
    if (names.length > 24) {
      host.appendChild(el('p', 'muted small', '+ ' + (names.length - 24) + ' more providers.'));
    }
  }

  function renderAll() {
    var health = document.getElementById('cp-flt-health');
    if (!health) return; // region not built
    var sides = groupSupply(fleetCaps);
    healthCards(health, sides);
    var lh = document.getElementById('cp-flt-local');
    if (lh) renderSide(lh, sides.local, 'local');
    var ph = document.getElementById('cp-flt-pcc');
    if (ph) renderSide(ph, sides.pcc, 'pcc');
    var when = document.getElementById('cp-flt-when');
    if (when) {
      when.textContent = probe.at
        ? ('last probe ' + fmtWhen(probe.at) + (probe.ok === false ? ' — failed' : '') +
           (usedCache ? ' · structure from cached registry' : ''))
        : '';
    }
  }

  function startTimer() {
    if (timer) return;
    timer = setInterval(function () {
      if (document.hidden) return;
      if (!document.getElementById('cp-flt-health')) return;
      runProbe();
    }, 60000);
  }

  // ── the region builder ────────────────────────────────────────────────────
  function sectionHead(title, blurb) {
    var h = el('div', 'flt-sec-h');
    h.appendChild(el('h3', null, title));
    h.appendChild(el('span', 'muted small', blurb));
    return h;
  }

  function buildFleet() {
    var body = CP.regionBody('fleet');
    if (!body) return;
    ensureStyles();
    clear(body);

    body.appendChild(el('p', 'muted',
      'Your providers and kernels in one console: capability supply grouped by source and ' +
      'adapter, straight from the live registry. Health here means "the registry answered" — ' +
      'nothing is assumed.'));

    var health = el('div', 'flt-health');
    health.id = 'cp-flt-health';
    body.appendChild(health);

    var ls = el('section', 'flt-section');
    ls.appendChild(sectionHead('Local supply', 'broker-gated, on this host'));
    var lh = el('div');
    lh.id = 'cp-flt-local';
    ls.appendChild(lh);
    body.appendChild(ls);

    var ps = el('section', 'flt-section');
    ps.appendChild(sectionHead('PCC supply', 'networked — escrowed, attested, settled'));
    var ph = el('div');
    ph.id = 'cp-flt-pcc';
    ps.appendChild(ph);
    body.appendChild(ps);

    var foot = el('div', 'flt-foot');
    var btn = el('button', 'btn', 'Re-check now');
    btn.type = 'button';
    btn.onclick = function () { runProbe(); };
    foot.appendChild(btn);
    var when = el('span', 'muted small');
    when.id = 'cp-flt-when';
    foot.appendChild(when);
    body.appendChild(foot);

    renderAll();   // paint current state (may be idle) before the probe lands
    runProbe();    // live reachability check
    startTimer();  // re-probe every 60s while visible
  }

  (CP.regionBuilders = CP.regionBuilders || {}).fleet = buildFleet;

  // Registry changed under us (catalog poll saw growth) / server URL changed
  // → re-probe so health and counts stay honest. Guarded on the region being
  // built; renderAll/runProbe both no-op harmlessly otherwise.
  bus.on('registry:grew', function () {
    if (document.getElementById('cp-flt-health')) runProbe();
  });
  bus.on('api:base-changed', function () {
    if (document.getElementById('cp-flt-health')) runProbe();
  });

  // Late-load edge: if the shell already built the region with its inline
  // builder (boot happened before this file executed), rebuild with ours.
  try {
    if (CP.rebuildRegion && CP.expand && CP.expand.isRevealed('fleet')) {
      var rb0 = CP.regionBody && CP.regionBody('fleet');
      if (rb0 && rb0.childNodes.length) CP.rebuildRegion('fleet');
    }
  } catch (e) { /* boot not far enough — the normal path builds us */ }

  // Exposed for headless tests (read-only surface).
  CP._fleet = {
    groupSupply: groupSupply,
    authoritySummary: authoritySummary,
    probeState: function () { return probe; },
    runProbe: runProbe,
    renderAll: renderAll
  };
})();
