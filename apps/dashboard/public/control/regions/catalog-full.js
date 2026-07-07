/* @harness/control-plane — regions/catalog-full.js  (B3 wave 2)
 *
 * The full capability browser — upgrades the core Catalog region from the
 * lighter starter grid to a complete, filterable browser. catalog.js stays
 * the DATA engine (registry fetch, offline sample pack, growth polling, the
 * detail sheet); this file replaces only the VIEW:
 *
 *   - lists EVERY capability from CP.catalog.all() (which is fed by
 *     GET {base}/api/capabilities) — no starter gating,
 *   - filters: free text, source (local / network(pcc)), kind (action /
 *     job), authority class (observe / mutate / actuate / reach-out /
 *     privileged), assurance tier (tier options derived from the data
 *     actually loaded — never a made-up tier),
 *   - bundle badges ONLY when a cap actually carries the optional bundles
 *     (economic / assurance / receipt / definition). Local caps without
 *     them show nothing — never a fake badge,
 *   - provenance on every card: source · adapter (sourceDetail.owner), the
 *     capability id, and side-effects when declared,
 *   - orders by relevance to the active lens (CP.lens.get(): user /
 *     operator / orchestrator — the lenses expand.js declares for this
 *     region), re-sorting on 'lens:changed'. Deterministic scoring over
 *     real fields only; the count line says which lens ordered the grid,
 *   - opening a cap goes through CP.catalog.openDetail — the existing
 *     detail sheet, which emits 'cap:opened' {capId} on the bus (the agent
 *     portal composer mounts on that event). If the detail sheet is absent
 *     the event is emitted directly, so listeners still hear it,
 *   - honest states: "Connecting…" before the registry has answered,
 *     offline note + clearly-labeled sample pack when unreachable, and
 *     "Catalog warming up — no capabilities yet" when a live registry
 *     really has zero capabilities.
 *
 * Ontology sources (kept aligned, not invented):
 *   - authority class: explicit cap.authorityClass wins; else derived from
 *     trustLevel exactly as lib/genui/verdict.js#authorityClassFor
 *     (read→observe, write→mutate, exec→actuate, network→reach-out,
 *     credential→privileged).
 *   - kind: explicit cap.kind ('action'|'job') wins; else source 'pcc' →
 *     'job' (the PCC adapter's invoke returns a kind:"job" handle —
 *     lib/genui/adapters/pcc.js), everything else 'action'.
 *
 * Registration: CP.regionBuilders.catalog (the B3 shell hook) — overrides
 * the inline path while catalog.js keeps owning data + the detail sheet.
 * catalog.js's own render() writes are always followed, inside the same
 * task/microtask chain, by this view's render (init/refresh wrappers +
 * the 'registry:grew' listener), so the old grid never reaches paint.
 *
 * Loads after shell.js, before boot. Vanilla ES5, no build, no innerHTML —
 * every dynamic string lands via textContent.
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

  var prev = CP.catalog || null; // catalog.js — the data engine under this view

  // ── region-local styles (injected once) ──────────────────────────────────
  var STYLE_ID = 'cp-catalog-full-styles';
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.catf-onto{margin-top:6px;}',
      '.badge.auth-observe{color:var(--green);border-color:var(--green);}',
      '.badge.auth-mutate{color:var(--amber);border-color:var(--amber);}',
      '.badge.auth-actuate{color:#fb923c;border-color:#fb923c;}',
      '.badge.auth-reach-out{color:var(--blue);border-color:var(--blue);}',
      '.badge.auth-privileged{color:var(--red);border-color:var(--red);}',
      '.badge.catf-kind{color:var(--teal);border-color:var(--teal);}',
      '.badge.catf-bundle{color:var(--accent);border-color:var(--accent);}',
      '.catf-select{background:var(--panel);border:1px solid var(--edge);color:var(--ink);',
      ' border-radius:10px;padding:8px 10px;font-size:13px;min-height:34px;}',
      '.catf-count{margin:0 0 10px;}',
      '.catf-card .cap-foot{margin-top:2px;min-width:0;}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  }

  // ── ontology helpers ──────────────────────────────────────────────────────
  var AUTH_RUNGS = ['observe', 'mutate', 'actuate', 'reach-out', 'privileged'];
  var TRUST_TO_AUTH = {
    read: 'observe', write: 'mutate', exec: 'actuate',
    network: 'reach-out', credential: 'privileged'
  };
  var BUNDLES = ['economic', 'assurance', 'receipt', 'definition'];

  function authorityOf(cap) {
    if (cap && AUTH_RUNGS.indexOf(cap.authorityClass) !== -1) return cap.authorityClass;
    return TRUST_TO_AUTH[(cap && cap.trustLevel) || 'read'] || 'observe';
  }

  function kindOf(cap) {
    if (cap && (cap.kind === 'action' || cap.kind === 'job')) return cap.kind;
    return (cap && cap.source === 'pcc') ? 'job' : 'action';
  }

  function isNetwork(cap) {
    return !!cap && (cap.source === 'pcc' || cap.source === 'a2a');
  }

  /** Names of the optional bundles this cap ACTUALLY carries (objects only). */
  function bundlesOf(cap) {
    var out = [];
    for (var i = 0; i < BUNDLES.length; i++) {
      var b = cap ? cap[BUNDLES[i]] : null;
      if (b && typeof b === 'object') out.push(BUNDLES[i]);
    }
    return out;
  }

  // ── data facade over catalog.js (this file never fetches on its own) ─────
  function allCaps() {
    return (prev && typeof prev.all === 'function') ? (prev.all() || []) : [];
  }
  function isOnline() {
    return !!(prev && typeof prev.isOnline === 'function' && prev.isOnline());
  }

  // Has the data engine answered at least once? Before that, "offline" is
  // not yet a fact — show "connecting", not a premature offline note.
  var registrySettled = !(prev && typeof prev.init === 'function');

  if (prev && typeof prev.init === 'function') {
    var prevInit = prev.init;
    prev.init = function () {
      return prevInit.apply(prev, arguments).then(function (res) {
        registrySettled = true;
        render();
        return res;
      });
    };
  }
  if (prev && typeof prev.refresh === 'function') {
    var prevRefresh = prev.refresh;
    prev.refresh = function () {
      return prevRefresh.apply(prev, arguments).then(function (res) {
        registrySettled = true;
        render();
        return res;
      });
    };
  }

  // ── filters ───────────────────────────────────────────────────────────────
  var f = { text: '', src: '', kind: '', auth: '', tier: '' };
  function resetFilters() { f.text = ''; f.src = ''; f.kind = ''; f.auth = ''; f.tier = ''; }

  // Text scoring — same weights as catalog.js#score so Ask and the browser
  // agree on what "matches".
  function textScore(cap, tokens) {
    var name = String(cap.name || '').toLowerCase();
    var id = String(cap.id || '').toLowerCase();
    var desc = String(cap.description || '').toLowerCase();
    var trig = (cap.triggers || []).join(' ').toLowerCase();
    var s = 0;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (!t) continue;
      if (name.indexOf(t) >= 0) s += 3;
      if (id.indexOf(t) >= 0) s += 2;
      if (trig.indexOf(t) >= 0) s += 2;
      if (desc.indexOf(t) >= 0) s += 1;
    }
    return s;
  }

  function matchesFilters(cap) {
    if (f.src === 'local' && isNetwork(cap)) return false;
    if (f.src === 'network' && !isNetwork(cap)) return false;
    if (f.kind && kindOf(cap) !== f.kind) return false;
    if (f.auth && authorityOf(cap) !== f.auth) return false;
    if (f.tier === 'none' && cap.assurance) return false;
    if (f.tier !== '' && f.tier !== 'none') {
      var want = parseInt(f.tier, 10);
      var tiers = (cap.assurance && Array.isArray(cap.assurance.offeredTiers))
        ? cap.assurance.offeredTiers : [];
      if (tiers.indexOf(want) === -1) return false;
    }
    var t = f.text.toLowerCase();
    if (!t) return true;
    return textScore(cap, t.split(/[^a-z0-9.]+/)) > 0;
  }

  /**
   * Lens relevance — presentation ORDERING only (nothing is hidden by it).
   * Every rule reads a real field; scores are deterministic:
   *   user         — outcomes first: priced caps, instantly-runnable
   *                  (observe) caps, settled jobs; host plumbing demoted.
   *   operator     — their capacity: assurance contracts, priced offers,
   *                  networked caps, attributable providers.
   *   orchestrator — composable tooling: mcp/cli/skill/command sources,
   *                  parameterizable caps, formal definitions, jobs.
   */
  function lensScore(cap, lens) {
    var s = 0;
    var auth = authorityOf(cap);
    if (lens === 'operator') {
      if (cap.assurance) s += 3;
      if (cap.economic) s += 2;
      if (isNetwork(cap)) s += 2;
      if (cap.sourceDetail && cap.sourceDetail.owner) s += 1;
    } else if (lens === 'orchestrator') {
      if (cap.source === 'mcp' || cap.source === 'cli' ||
          cap.source === 'skill' || cap.source === 'command') s += 2;
      if (cap.params && cap.params.properties &&
          typeof cap.params.properties === 'object' &&
          Object.keys(cap.params.properties).length) s += 1;
      if (cap.definition) s += 1;
      if (kindOf(cap) === 'job') s += 1;
    } else { // user
      if (cap.economic) s += 3;
      if (auth === 'observe') s += 2;
      if (kindOf(cap) === 'job') s += 1;
      if (auth === 'privileged' || auth === 'actuate') s -= 2;
    }
    return s;
  }

  function visibleCaps() {
    var lens = (CP.lens && CP.lens.get()) || 'user';
    return allCaps().filter(matchesFilters).sort(function (a, b) {
      var d = lensScore(b, lens) - lensScore(a, lens);
      if (d) return d;
      var an = String(a.name || a.id || '');
      var bn = String(b.name || b.id || '');
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
  }

  /** Distinct assurance tiers present in the loaded data (never invented). */
  function tierOptions() {
    var seen = {};
    allCaps().forEach(function (c) {
      var tiers = (c.assurance && Array.isArray(c.assurance.offeredTiers))
        ? c.assurance.offeredTiers : [];
      tiers.forEach(function (t) { if (typeof t === 'number') seen[t] = true; });
    });
    return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
  }

  // ── one capability card ───────────────────────────────────────────────────
  function buildCard(cap) {
    var card = el('article', 'cap-card catf-card' + (cap.__demo ? ' demo' : ''));
    card.setAttribute('data-cap-id', cap.id);
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    var top = el('div', 'cap-top');
    top.appendChild(el('span', 'cap-name', cap.name || cap.id));
    var badges = el('span', 'cap-badges');
    if (CP.render && CP.render.trustBadge) badges.appendChild(CP.render.trustBadge(cap.trustLevel));
    badges.appendChild(el('span', 'badge src-' + (isNetwork(cap) ? 'network' : 'local'), cap.source || 'local'));
    top.appendChild(badges);
    card.appendChild(top);

    // Ontology + bundle row. Authority always (derivable for every cap);
    // kind badged only when 'job' (action is the unmarked default); bundle
    // badges strictly from what the cap carries.
    var onto = el('div', 'cap-badges catf-onto');
    var auth = authorityOf(cap);
    onto.appendChild(el('span', 'badge auth-' + auth, auth));
    if (kindOf(cap) === 'job') onto.appendChild(el('span', 'badge catf-kind', 'job'));
    bundlesOf(cap).forEach(function (b) {
      if (b === 'economic') {
        var p = cap.economic.price || {};
        var ptxt = ((p.base != null ? String(p.base) : '') + (p.currency ? ' ' + p.currency : '')).trim();
        onto.appendChild(el('span', 'badge econ', ptxt || 'economic'));
      } else if (b === 'assurance') {
        var tiers = Array.isArray(cap.assurance.offeredTiers) ? cap.assurance.offeredTiers : [];
        onto.appendChild(el('span', 'badge tier', tiers.length ? 'tier ' + tiers.join(',') : 'assurance'));
      } else {
        onto.appendChild(el('span', 'badge catf-bundle', b)); // receipt / definition
      }
    });
    if (cap.__demo) onto.appendChild(el('span', 'badge demo-b', 'sample'));
    card.appendChild(onto);

    var desc = String(cap.description || '');
    if (desc.length > 140) desc = desc.slice(0, 137) + '…';
    card.appendChild(el('p', 'cap-desc', desc));

    // Provenance — source · adapter/owner, then the id (the federated rule:
    // where a capability comes from is always visible).
    var provTop = el('div', 'cap-foot');
    var owner = cap.sourceDetail && cap.sourceDetail.owner;
    provTop.appendChild(el('span', 'cap-meta', (cap.source || 'local') + (owner ? ' · ' + owner : '')));
    if (cap.sideEffects) provTop.appendChild(el('span', 'cap-meta warn', 'side-effects'));
    card.appendChild(provTop);
    var provId = el('div', 'cap-foot');
    provId.appendChild(el('span', 'cap-meta', String(cap.id || '')));
    card.appendChild(provId);

    function open() {
      if (prev && typeof prev.openDetail === 'function') {
        prev.openDetail(cap); // the detail sheet emits 'cap:opened' {capId}
      } else {
        bus.emit('cap:opened', { capId: cap.id, trust: cap.trustLevel });
      }
    }
    card.addEventListener('click', open);
    card.addEventListener('keydown', function (ke) {
      if (ke.key === 'Enter' || ke.key === ' ') { ke.preventDefault(); open(); }
    });
    return card;
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  function render() {
    var body = CP.regionBody ? CP.regionBody('catalog') : null;
    if (!body) return;
    ensureStyles();
    clear(body);

    var caps = allCaps();
    var online = isOnline();

    if (registrySettled && !online) {
      var note = el('div', 'offline-note');
      note.appendChild(el('strong', null, 'Offline — sample catalog. '));
      note.appendChild(el('span', null,
        'Connect to a control-plane server (⚙ in the header) to load the live registry and run things.'));
      body.appendChild(note);
    }

    if (!caps.length) {
      if (!registrySettled) {
        body.appendChild(el('p', 'muted', 'Connecting to the capability registry…'));
      } else if (online) {
        body.appendChild(el('p', 'muted', 'Catalog warming up — no capabilities yet.'));
      } else {
        body.appendChild(el('p', 'muted', 'No registry reachable and no sample pack loaded.'));
      }
      return;
    }

    // Controls row 1: text + source.
    var controls = el('div', 'cat-controls');
    var search = el('input', 'cat-search');
    search.type = 'search';
    search.placeholder = 'Filter capabilities…';
    search.value = f.text;
    search.setAttribute('aria-label', 'Filter capabilities');
    search.oninput = function () { f.text = search.value; renderGrid(); };
    controls.appendChild(search);
    [['', 'All'], ['local', 'Local'], ['network', 'Network (PCC)']].forEach(function (pair) {
      var b = el('button', 'seg' + (f.src === pair[0] ? ' active' : ''), pair[1]);
      b.type = 'button';
      b.onclick = function () { f.src = pair[0]; render(); };
      controls.appendChild(b);
    });
    body.appendChild(controls);

    // Controls row 2: kind + authority class + assurance tier.
    var controls2 = el('div', 'cat-controls');
    [['', 'Any kind'], ['action', 'Action'], ['job', 'Job (settled)']].forEach(function (pair) {
      var b = el('button', 'seg' + (f.kind === pair[0] ? ' active' : ''), pair[1]);
      b.type = 'button';
      b.onclick = function () { f.kind = pair[0]; render(); };
      controls2.appendChild(b);
    });

    var authSel = el('select', 'catf-select');
    authSel.setAttribute('aria-label', 'Filter by authority class');
    [['', 'any authority']].concat(AUTH_RUNGS.map(function (r) { return [r, r]; }))
      .forEach(function (pair) {
        var o = el('option', null, pair[1]);
        o.value = pair[0];
        authSel.appendChild(o);
      });
    authSel.value = f.auth;
    authSel.onchange = function () { f.auth = authSel.value; renderGrid(); };
    controls2.appendChild(authSel);

    var tierSel = el('select', 'catf-select');
    tierSel.setAttribute('aria-label', 'Filter by assurance tier');
    var tierPairs = [['', 'any assurance']]
      .concat(tierOptions().map(function (t) { return [String(t), 'tier ' + t]; }))
      .concat([['none', 'no assurance']]);
    tierPairs.forEach(function (pair) {
      var o = el('option', null, pair[1]);
      o.value = pair[0];
      tierSel.appendChild(o);
    });
    tierSel.value = f.tier;
    tierSel.onchange = function () { f.tier = tierSel.value; renderGrid(); };
    controls2.appendChild(tierSel);
    body.appendChild(controls2);

    var count = el('p', 'muted small catf-count');
    count.id = 'cp-catf-count';
    body.appendChild(count);

    var grid = el('div', 'cat-grid');
    grid.id = 'cp-catf-grid';
    body.appendChild(grid);

    renderGrid();
  }

  function renderGrid() {
    var grid = document.getElementById('cp-catf-grid');
    var count = document.getElementById('cp-catf-count');
    if (!grid || !count) return;
    clear(grid);

    var total = allCaps().length;
    var list = visibleCaps();
    var lens = (CP.lens && CP.lens.get()) || 'user';
    count.textContent = (list.length === total
      ? (total + ' capabilities')
      : (list.length + ' of ' + total + ' capabilities'))
      + ' · ordered for the ' + lens + ' lens';

    if (!list.length) {
      grid.appendChild(el('p', 'muted', 'Nothing matches these filters.'));
      var reset = el('button', 'btn ghost', 'Clear filters');
      reset.type = 'button';
      reset.onclick = function () { resetFilters(); render(); };
      grid.appendChild(reset);
      return;
    }
    list.forEach(function (cap) { grid.appendChild(buildCard(cap)); });
  }

  // ── the region builder ────────────────────────────────────────────────────
  function buildCatalogFull() { render(); }

  (CP.regionBuilders = CP.regionBuilders || {}).catalog = buildCatalogFull;

  // The registry grew mid-session (catalog.js's poll re-painted its own grid
  // in the same task before emitting) — repaint ours before the browser gets
  // to paint, then again after the shell-triggered refresh completes.
  bus.on('registry:grew', function () { render(); });

  // Lens switch → re-order the grid (controls untouched).
  bus.on('lens:changed', function () { renderGrid(); });

  // Late-load edge: shell already booted (region DOM exists) — rebuild with
  // this view. If data already arrived through the unwrapped init, treat the
  // registry as settled so the states render honestly.
  try {
    if (CP.rebuildRegion && CP.regionBody && CP.regionBody('catalog')) {
      if (allCaps().length) registrySettled = true;
      CP.rebuildRegion('catalog');
    }
  } catch (e) { /* boot not far enough — the normal path builds us */ }

  // Exposed for headless tests (read/drive surface, mirrors CP._approvals).
  CP._catalogFull = {
    authorityOf: authorityOf,
    kindOf: kindOf,
    bundlesOf: bundlesOf,
    lensScore: lensScore,
    visible: visibleCaps,
    filters: function () {
      return { text: f.text, src: f.src, kind: f.kind, auth: f.auth, tier: f.tier };
    },
    setFilters: function (patch) {
      patch = patch || {};
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k) &&
            Object.prototype.hasOwnProperty.call(f, k)) {
          f[k] = patch[k];
        }
      }
      render();
    },
    rebuild: render
  };
})();
