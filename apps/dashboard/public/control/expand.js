/* @harness/control-plane — expand.js
 *
 * The self-expansion engine. A tiny event bus where (a) user clicks and
 * (b) agent/API signals drive which regions of the shell are revealed.
 * The shell starts minimal (Ask + Catalog) and grows as the user — or
 * their agent — touches more of the surface. Revealed state persists in
 * localStorage so the plane keeps its shape across visits.
 *
 * Curated, not a firehose: automatic reveals are budgeted (max 2 per
 * 10 seconds); anything past the budget becomes a *suggestion* — a dot
 * in the "More" drawer — instead of a new panel shoving into view.
 *
 * Load order: this file loads FIRST and creates window.CP.
 * No frameworks, no build, no external requests. All DOM text goes
 * through textContent (never innerHTML).
 */
(function () {
  'use strict';

  var CP = window.CP = window.CP || {};

  // ── The nine regions (SYNTHESIS-ontology-actors-ui.md §4.2) ─────────────
  // core:true regions are always visible (the minimal home).
  // lenses lists which actor lenses a region is most relevant to — the
  // More drawer orders by relevance to the active lens.
  CP.REGIONS = [
    { id: 'ask',       title: 'Ask',       icon: '✦', core: true,
      blurb: 'Describe what you want; get routed to a capability.',
      lenses: ['user', 'operator', 'orchestrator'] },
    { id: 'catalog',   title: 'Catalog',   icon: '▦', core: true,
      blurb: 'Browse every capability, local and networked, provenance visible.',
      lenses: ['user', 'operator', 'orchestrator'] },
    { id: 'activity',  title: 'Activity',  icon: '▸',
      blurb: 'Live runs and jobs — watch work happen and settle.',
      lenses: ['user', 'operator', 'orchestrator'] },
    { id: 'approvals', title: 'Approvals', icon: '⏸',
      blurb: 'Everything paused and waiting on your say-so.',
      lenses: ['user', 'operator', 'orchestrator'] },
    { id: 'ledger',    title: 'Ledger',    icon: '◎',
      blurb: 'Costs and settlement — two rails, honestly labeled.',
      lenses: ['user', 'operator', 'orchestrator'] },
    { id: 'compose',   title: 'Compose',   icon: '⎇',
      blurb: 'Chain capabilities into a plan.',
      lenses: ['orchestrator'] },
    { id: 'fleet',     title: 'Fleet',     icon: '⚙',
      blurb: 'Your providers and kernels in one console.',
      lenses: ['operator'] },
    { id: 'publish',   title: 'Publish',   icon: '↑',
      blurb: 'Turn an API or a machine into a listed capability.',
      lenses: ['operator', 'orchestrator'] },
    { id: 'audit',     title: 'Audit',     icon: '≡',
      blurb: 'Receipts, evidence and telemetry — what happened, provably.',
      lenses: ['user', 'operator', 'orchestrator'] }
  ];

  CP.regionById = function (id) {
    for (var i = 0; i < CP.REGIONS.length; i++) {
      if (CP.REGIONS[i].id === id) return CP.REGIONS[i];
    }
    return null;
  };

  // ── Event bus ────────────────────────────────────────────────────────────
  var handlers = {}; // evt -> [fn]

  CP.bus = {
    on: function (evt, fn) {
      (handlers[evt] = handlers[evt] || []).push(fn);
      return function off() {
        var list = handlers[evt] || [];
        var i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
    },
    emit: function (evt, payload) {
      var list = (handlers[evt] || []).slice();
      for (var i = 0; i < list.length; i++) {
        try { list[i](payload || {}); }
        catch (e) { if (window.console) console.warn('[cp bus]', evt, e); }
      }
    }
  };

  // ── Persistence ──────────────────────────────────────────────────────────
  var LS_KEY = 'cp.revealed.v1';

  function loadStore() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return {
            revealed: Array.isArray(parsed.revealed) ? parsed.revealed : [],
            suggested: Array.isArray(parsed.suggested) ? parsed.suggested : []
          };
        }
      }
    } catch (e) { /* corrupt storage → fresh start */ }
    return { revealed: [], suggested: [] };
  }

  var store = loadStore();
  var badges = {};        // regionId -> count (session-only)
  var autoTimes = [];     // timestamps of recent automatic reveals

  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch (e) { /* private mode etc. */ }
  }

  // ── Reveal / suggest / badge ─────────────────────────────────────────────
  function isRevealed(id) {
    var r = CP.regionById(id);
    if (r && r.core) return true;
    return store.revealed.indexOf(id) >= 0;
  }

  function autoBudgetOk() {
    var now = Date.now();
    autoTimes = autoTimes.filter(function (t) { return now - t < 10000; });
    return autoTimes.length < 2;
  }

  /**
   * Reveal a region.
   * opts.auto   — reveal triggered by a signal, not a direct user tap.
   *               Budgeted: over-budget auto reveals degrade to suggestions.
   * opts.toast  — message to toast when the reveal actually happens.
   * opts.quiet  — no toast, no scroll.
   */
  function reveal(id, opts) {
    opts = opts || {};
    var region = CP.regionById(id);
    if (!region) return false;
    if (isRevealed(id)) {
      if (opts.focus) CP.bus.emit('region:focus', { id: id });
      return true;
    }
    if (opts.auto && !autoBudgetOk()) {
      suggest(id);
      return false;
    }
    if (opts.auto) autoTimes.push(Date.now());

    store.revealed.push(id);
    var si = store.suggested.indexOf(id);
    if (si >= 0) store.suggested.splice(si, 1);
    save();

    CP.bus.emit('revealed:changed', { id: id, revealed: store.revealed.slice() });
    if (!opts.quiet) {
      CP.toast(opts.toast || (region.title + ' unlocked'));
      CP.bus.emit('region:focus', { id: id });
    }
    return true;
  }

  /** Mark a region as suggested — a dot in the More drawer, nothing louder. */
  function suggest(id) {
    if (isRevealed(id) || store.suggested.indexOf(id) >= 0) return;
    if (!CP.regionById(id)) return;
    store.suggested.push(id);
    save();
    CP.bus.emit('suggested:changed', { id: id, suggested: store.suggested.slice() });
  }

  function badge(id, delta) {
    badges[id] = Math.max(0, (badges[id] || 0) + delta);
    CP.bus.emit('badge:changed', { id: id, count: badges[id] });
  }

  function reset() {
    store = { revealed: [], suggested: [] };
    badges = {};
    save();
    try { localStorage.removeItem('cp.walkthrough.done'); } catch (e) { /* ignore */ }
    CP.bus.emit('revealed:changed', { id: null, revealed: [] });
  }

  CP.expand = {
    reveal: reveal,
    suggest: suggest,
    isRevealed: isRevealed,
    isSuggested: function (id) { return store.suggested.indexOf(id) >= 0; },
    revealedIds: function () { return store.revealed.slice(); },
    suggestedIds: function () { return store.suggested.slice(); },
    badgeCount: function (id) { return badges[id] || 0; },
    badge: badge,
    reset: reset
  };

  // ── Toasts (quiet, stacking, self-expiring) ──────────────────────────────
  CP.toast = function (msg) {
    var host = document.getElementById('cp-toasts');
    if (!host) return;
    var t = document.createElement('div');
    t.className = 'cp-toast';
    t.textContent = msg;
    host.appendChild(t);
    while (host.childNodes.length > 3) host.removeChild(host.firstChild);
    setTimeout(function () { t.classList.add('show'); }, 20);
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 400);
    }, 3800);
  };

  // ── Default signal wiring: how the plane grows ───────────────────────────
  // (a) USER-driven growth: clicks land here as bus events emitted by the
  //     shell/catalog. (b) AGENT/API-driven growth: run streams, interrupts,
  //     and registry polling land here the same way. One vocabulary.
  function wireDefaultSignals() {

    // A run was dispatched (by the user, or by an agent through this shell):
    // live work now exists → Activity earns its place.
    CP.bus.on('run:dispatched', function () {
      reveal('activity', { auto: true, toast: 'Activity unlocked — your runs live here' });
    });

    // A gated capability paused for a human: Approvals surfaces + badges.
    CP.bus.on('interrupt:new', function () {
      reveal('approvals', { auto: true, toast: 'Approvals unlocked — something needs your say-so' });
      badge('approvals', +1);
    });
    CP.bus.on('interrupt:resolved', function () {
      badge('approvals', -1);
    });

    // Money entered the frame (a priced capability was opened, or an escrow /
    // settlement event rode the stream): the Ledger becomes relevant.
    CP.bus.on('economic:seen', function () {
      reveal('ledger', { auto: true, toast: 'Ledger unlocked — costs & settlement, labeled' });
    });
    CP.bus.on('run:event', function (p) {
      var ev = p && p.event;
      if (ev && ev.type === 'CUSTOM' && typeof ev.name === 'string' && ev.name.indexOf('pcc.') === 0) {
        CP.bus.emit('economic:seen', { via: ev.name });
      }
    });

    // Lens switching reveals the lens's home turf (operator → Fleet;
    // orchestrator → Activity) and *suggests* the rest — never a dump.
    CP.bus.on('lens:changed', function (p) {
      if (p.lens === 'operator') {
        reveal('fleet', { auto: true, toast: 'Fleet unlocked — the operator console' });
        suggest('publish');
        suggest('ledger');
      } else if (p.lens === 'orchestrator') {
        reveal('activity', { auto: true, toast: 'Activity unlocked — runs & jobs, live' });
        suggest('compose');
        suggest('audit');
      }
    });

    // The registry grew mid-session (an agent registered new capabilities):
    // the catalog quietly announces it.
    CP.bus.on('registry:grew', function (p) {
      var n = p && p.added ? p.added : 1;
      badge('catalog', n);
      CP.toast(n === 1 ? 'A new capability just registered' : (n + ' new capabilities just registered'));
    });

    // Deep engagement with results → Audit becomes worth suggesting.
    CP.bus.on('run:finished', function () { suggest('audit'); });
  }

  wireDefaultSignals();
})();
