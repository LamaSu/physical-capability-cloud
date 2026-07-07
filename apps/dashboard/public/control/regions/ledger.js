/* @harness/control-plane — regions/ledger.js  (B3 wave 2)
 *
 * Upgraded Ledger region: "Costs and settlement — two rails, honestly
 * labeled." A read-only PRESENTATION over data the spine already produces —
 * this file computes no charges, fabricates no receipts, and invents no
 * statuses. If the data is not there, it says so.
 *
 *   - Two rails    — LOCAL capabilities (broker-gated, no economic bundle →
 *                    labeled "no cost / local"; the codeburn advisory panel
 *                    rides here, clearly marked notional) and PCC/networked
 *                    capabilities (carry the optional `economic` bundle →
 *                    price estimates straight from the registry).
 *   - Settlements  — per-job settlement timeline. The spine emits the PCC
 *                    profile as AG-UI CUSTOM events (lib/genui/agui-job.js:
 *                    escrowEvent / attestationEvent / settlementEvent); this
 *                    region only RENDERS them, through the SAME
 *                    GenUIRender.events strip idiom regions/activity.js uses
 *                    (ctx = {strips:{}} keyed by jobId) so the two views
 *                    agree. Per-job money line shows escrowed amount →
 *                    settlement status → txHash — reported values only.
 *   - Receipts     — RUN_FINISHED{result} carrying receipt fields
 *                    (receiptCID / paymentTxHash / evidenceBundleHash /
 *                    dccClass / pccFeeBps, or result.verdict.receiptCID)
 *                    renders a receipt row when present.
 *
 * Event channels (state-keyed updates, so double delivery is harmless):
 *   a. bus 'run:event' — every event from runs dispatched through this shell
 *      (shell.js streamRun emits it; module-scope listener, so settlements
 *      accumulate even before the region is first revealed).
 *   b. its own GET /api/agui/watch EventSource — ambient jobs (attached on
 *      first build only; a region nobody opened costs no connection).
 *
 * Registration: assigns CP.regionBuilders.ledger — shell.js consults
 * CP.regionBuilders before its inline builders (the B3 hook). Loads AFTER
 * shell.js in index.html, before DOMContentLoaded boot. The inline shell
 * listener that wrote into #cp-settle-body no-ops once this builder owns the
 * region (that element id is not recreated here).
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
  var STYLE_ID = 'cp-ledger-styles';
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.led-rails{display:grid;grid-template-columns:1fr;gap:12px;margin:0 0 12px;}',
      '@media (min-width:860px){.led-rails{grid-template-columns:1fr 1fr;}}',
      '.led-rails .panel{margin-bottom:0;}',
      '.led-chip{font-size:10.5px;font-family:var(--mono);padding:1px 8px;border-radius:16px;',
      ' border:1px solid var(--edge);color:var(--muted);white-space:nowrap;margin-left:8px;}',
      '.led-chip.econ{color:var(--amber);border-color:var(--amber);}',
      '.led-sub{font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);',
      ' margin:10px 0 4px;border-top:1px dashed var(--edge);padding-top:8px;}',
      '.led-job{border:1px solid var(--edge);border-radius:10px;padding:8px 10px;margin:0 0 10px;',
      ' background:var(--panel2);}',
      '.led-money{font-family:var(--mono);font-size:12px;color:var(--ink);margin:5px 0 6px;',
      ' overflow-wrap:anywhere;}',
      '#cp-led-jobs{max-height:380px;overflow:auto;}',
      '#cp-led-receipts{max-height:200px;overflow:auto;}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  }

  // ── engine/events mount (classic script injection, fail-open) ────────────
  // Same loader as regions/activity.js: works on file:// and over http; no
  // engine → builtin rows via CP.render.event. The region never breaks.
  function haveEvents() {
    var G = window.GenUIRender;
    return !!(G && G.events && typeof G.events.renderEvent === 'function');
  }
  function haveEngine() {
    var G = window.GenUIRender;
    return !!(G && G.engine && typeof G.engine.ensureStyles === 'function');
  }
  function injectScript(src) {
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = function () { resolve(true); };
      s.onerror = function () { if (s.parentNode) s.parentNode.removeChild(s); resolve(false); };
      (document.head || document.body || document.documentElement).appendChild(s);
    });
  }
  function loadModule(name, check) {
    if (check()) return Promise.resolve(true);
    var candidates = [
      '../genui-render/' + name,
      '/genui-render/' + name,
      './engine/' + name
    ];
    var i = 0;
    function next() {
      if (check()) return Promise.resolve(true);
      if (i >= candidates.length) return Promise.resolve(false);
      return injectScript(candidates[i++]).then(function () { return next(); });
    }
    return next();
  }
  var enginePromise = null;
  function ensureRender() {
    if (!enginePromise) {
      enginePromise = loadModule('engine.js', haveEngine)
        .then(function () { return loadModule('events.js', haveEvents); })
        .then(function () {
          if (haveEngine()) {
            try { window.GenUIRender.engine.ensureStyles(); } catch (e) { /* fine */ }
          }
          return haveEvents();
        });
    }
    return enginePromise;
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  function shortHash(h) {
    h = String(h == null ? '' : h);
    return h.length > 13 ? h.slice(0, 6) + '…' + h.slice(-4) : h;
  }

  // Only the three PCC-profile CUSTOM names drive the timeline (the factory
  // contract in lib/genui/agui-job.js) — same guard as regions/activity.js.
  function isPcc(ev) {
    return ev && ev.type === 'CUSTOM' && typeof ev.name === 'string' &&
      (ev.name === 'pcc.escrow' || ev.name === 'pcc.attestation' || ev.name === 'pcc.settlement');
  }

  // Same key derivation as GenUIRender.events getStrip — cards and strips agree.
  function jobKey(value) {
    return String((value && (value.jobId || value.escrowId || value.runId)) || 'default');
  }

  // ── module state (survives rebuilds; adopted by buildLedger) ─────────────
  var jobs = {};          // key -> {key, node, pill, moneyEl, stripHost, escrow, attest, settlement}
  var jobOrder = [];      // insertion order (oldest first)
  var receipts = {};      // dedupe key -> {data, node}
  var receiptOrder = [];
  var settleCtx = { strips: {} };  // engine ctx — one strip element per jobId
  var watchAttached = false;
  var railsRetryArmed = false;
  var codeburn = { state: 'loading', rows: [], error: null };

  // ── per-job card ──────────────────────────────────────────────────────────
  function newJob(key) {
    ensureStyles();
    var card = el('article', 'led-job');
    card.setAttribute('data-job', key);
    var head = el('div', 'run-head');
    head.appendChild(el('span', 'run-name', key === 'default' ? 'job (unlabeled)' : 'job ' + key));
    var pill = el('span', 'pill st-running', 'open');
    head.appendChild(pill);
    card.appendChild(head);
    var money = el('p', 'led-money', '');
    card.appendChild(money);
    var stripHost = el('div', 'led-strip');
    card.appendChild(stripHost);
    return {
      key: key, node: card, pill: pill, moneyEl: money, stripHost: stripHost,
      escrow: null, attest: null, settlement: null
    };
  }

  // The money line shows REPORTED values only: escrowed amount (from the
  // escrow event), attestation state, settlement status + txHash. It never
  // multiplies, sums, or defaults an amount into existence. The " USDC"
  // fallback when an amount arrives without a currency mirrors the shipped
  // GenUIRender.events pccDetail convention so both surfaces read the same.
  function updateMoney(j) {
    var bits = [];
    var e = j.escrow || {};
    if (e.amount !== undefined && e.amount !== null) {
      bits.push('escrowed ' + String(e.amount) + (e.currency ? ' ' + e.currency : ' USDC'));
    } else if (e.status || e.state) {
      bits.push('escrow: ' + String(e.status || e.state));
    }
    if (j.attest) {
      var a = j.attest;
      var okA = a.satisfied === true ||
        /verified|attested|passed|ok|accept/.test(String(a.status || a.state || '').toLowerCase());
      var atxt = okA ? 'attested' : 'attestation pending';
      if (a.tier !== undefined && a.tier !== null) atxt += ' (tier ' + a.tier + ')';
      bits.push(atxt);
    }
    var s = j.settlement;
    if (s) {
      var st = String(s.status || s.state || 'settled');
      bits.push('settled: ' + st + (s.txHash ? ' · tx ' + shortHash(s.txHash) : ''));
    } else {
      bits.push('not settled yet');
    }
    j.moneyEl.textContent = bits.join(' · ');

    // Status pill — same failure regex as activity's verdict projection.
    if (s) {
      var bad = /slash|dispute|refund|fail/.test(String(s.status || s.state || '').toLowerCase());
      j.pill.textContent = bad ? String(s.status || s.state || 'failed') : 'settled';
      j.pill.className = 'pill ' + (bad ? 'st-failed' : 'st-done');
    } else if (j.attest) {
      j.pill.textContent = 'verified';
      j.pill.className = 'pill st-running';
    } else if (j.escrow) {
      j.pill.textContent = 'escrowed';
      j.pill.className = 'pill st-running';
    }
  }

  function placeJob(j) {
    var host = document.getElementById('cp-led-jobs');
    if (!host) return; // region not built yet — buildLedger adopts everything
    var empty = host.querySelector('p.muted');
    if (empty) host.removeChild(empty);
    host.insertBefore(j.node, host.firstChild);
  }

  function updateJob(ev) {
    var value = ev.value || {};
    var key = jobKey(value);
    var j = jobs[key];
    var isNew = !j;
    if (isNew) { j = jobs[key] = newJob(key); jobOrder.push(key); }
    if (ev.name === 'pcc.escrow') j.escrow = value;
    else if (ev.name === 'pcc.attestation') j.attest = value;
    else if (ev.name === 'pcc.settlement') j.settlement = value;
    updateMoney(j);

    // Settlement timeline — the engine strip updates in place (same element
    // returned per jobId); builtin fallback appends plain event rows.
    var node = null;
    if (haveEvents()) {
      try { node = window.GenUIRender.events.renderEvent(ev, settleCtx); } catch (e) { node = null; }
    }
    if (!node && CP.render && CP.render.event) node = CP.render.event(ev);
    if (node && node.parentNode !== j.stripHost) j.stripHost.appendChild(node);

    if (isNew) placeJob(j);
  }

  // ── receipts (RUN_FINISHED{result} — box 5 as the run result) ────────────
  function receiptFrom(ev) {
    if (!ev || ev.type !== 'RUN_FINISHED') return null;
    var r = ev.result;
    if (!r || typeof r !== 'object') return null;
    var src = null;
    if (r.receiptCID || r.paymentTxHash || r.evidenceBundleHash ||
        r.dccClass != null || r.pccFeeBps != null) {
      src = r;
    } else if (r.verdict && typeof r.verdict === 'object' &&
               (r.verdict.receiptCID || (r.verdict.settlement && r.verdict.settlement.txHash))) {
      src = {
        receiptCID: r.verdict.receiptCID,
        paymentTxHash: r.verdict.settlement && r.verdict.settlement.txHash
      };
    }
    if (!src) return null;
    var out = {
      receiptCID: src.receiptCID,
      paymentTxHash: src.paymentTxHash,
      evidenceBundleHash: src.evidenceBundleHash,
      dccClass: src.dccClass,
      pccFeeBps: src.pccFeeBps,
      threadId: ev.threadId,
      runId: ev.runId
    };
    if (out.receiptCID == null && out.paymentTxHash == null && out.evidenceBundleHash == null &&
        out.dccClass == null && out.pccFeeBps == null) return null;
    return out;
  }

  function addReceipt(r) {
    var key = String(r.receiptCID || r.paymentTxHash ||
      ((r.threadId || '') + '/' + (r.runId || '')));
    if (receipts[key]) return; // resume streams can re-deliver — show once
    var bits = [];
    if (r.receiptCID) bits.push('receipt ' + shortHash(r.receiptCID));
    if (r.dccClass != null) bits.push('class ' + String(r.dccClass));
    if (r.paymentTxHash) bits.push('payment tx ' + shortHash(r.paymentTxHash));
    if (r.pccFeeBps != null) bits.push('fee ' + String(r.pccFeeBps) + ' bps');
    if (r.evidenceBundleHash) bits.push('evidence ' + shortHash(r.evidenceBundleHash));
    if (r.threadId) bits.push('thread ' + String(r.threadId));
    var row = el('div', 'pipe-row');
    row.appendChild(el('span', 'k', 'receipt'));
    row.appendChild(el('span', 'v', bits.join(' · ')));
    receipts[key] = { data: r, node: row };
    receiptOrder.push(key);
    var host = document.getElementById('cp-led-receipts');
    if (host) {
      var empty = host.querySelector('p.muted');
      if (empty) host.removeChild(empty);
      host.insertBefore(row, host.firstChild);
    }
  }

  // ── the single event entry (both channels route here) ────────────────────
  function onEconEvent(ev) {
    if (!ev || !ev.type) return;
    if (isPcc(ev)) { updateJob(ev); return; }
    if (ev.type === 'RUN_FINISHED') {
      var r = receiptFrom(ev);
      if (r) addReceipt(r);
    }
  }

  // Channel a: dispatched-run events (module scope — accumulates pre-reveal).
  bus.on('run:event', function (p) { onEconEvent(p && p.event); });

  // Channel b: ambient watch stream — attached on first build only.
  function attachWatchOnce() {
    if (watchAttached) return;
    watchAttached = true;
    CP.api.attachWatch(function (ev) { onEconEvent(ev); }, function (st) {
      var d = document.getElementById('cp-led-dot');
      if (d) d.className = 'dot' + (st === 'live' ? ' live' : '');
    });
  }

  // ── the two rails (registry-derived; reported values only) ───────────────
  function liveCaps() {
    var list = (CP.catalog && typeof CP.catalog.all === 'function') ? CP.catalog.all() : [];
    if (!list || !list.length) list = (CP.state && CP.state.caps) || [];
    // Offline sample caps are for the walkthrough, not the ledger.
    return (list || []).filter(function (c) { return c && !c.__demo; });
  }

  function row(host, k, v) {
    var r = el('div', 'pipe-row');
    r.appendChild(el('span', 'k', k));
    r.appendChild(el('span', 'v', String(v)));
    host.appendChild(r);
    return r;
  }

  function renderRails() {
    var lb = document.getElementById('cp-led-local');
    var pb = document.getElementById('cp-led-pcc');
    if (!lb || !pb) return; // region not built
    var caps = liveCaps();
    var online = !!(CP.catalog && CP.catalog.isOnline && CP.catalog.isOnline());

    var networked = [], priced = [], localFree = [];
    caps.forEach(function (c) {
      var net = c.source === 'pcc' || c.source === 'a2a';
      var pr = c.economic && c.economic.price;
      if (pr) priced.push(c);
      if (net) networked.push(c);
      if (!net && !pr) localFree.push(c);
    });

    // Local rail — broker-gated, no economic bundle.
    clear(lb);
    if (!caps.length) {
      lb.appendChild(el('p', 'muted', online
        ? 'Registry loaded but empty — no capabilities to price.'
        : 'Registry offline — no live capability data.'));
    } else {
      row(lb, 'capabilities', String(localFree.length));
      row(lb, 'cost', 'none — broker-gated, no economic bundle');
    }
    lb.appendChild(el('div', 'led-sub', 'Advisory compute cost (codeburn)'));
    if (codeburn.state === 'loading') {
      lb.appendChild(el('p', 'muted', 'Loading…'));
    } else if (codeburn.state === 'err') {
      lb.appendChild(el('p', 'muted', codeburn.error || 'Advisory cost endpoint not reachable.'));
    } else if (!codeburn.rows.length) {
      lb.appendChild(el('p', 'muted', 'No advisory cost data yet.'));
    } else {
      codeburn.rows.forEach(function (kv) { row(lb, kv[0], kv[1]); });
    }
    lb.appendChild(el('p', 'muted small',
      'Notional (Max plan) — advisory only; nothing settles on this rail.'));

    // PCC rail — economic bundles from the registry (estimates, not charges).
    clear(pb);
    if (!caps.length) {
      pb.appendChild(el('p', 'muted', online
        ? 'Registry loaded but empty — no networked capabilities.'
        : 'Registry offline — no live capability data.'));
    } else {
      row(pb, 'networked', String(networked.length));
      row(pb, 'priced', String(priced.length));
      priced.slice(0, 6).forEach(function (c) {
        var p = c.economic.price;
        var name = String(c.name || c.id);
        if (name.length > 34) name = name.slice(0, 31) + '…';
        var ptxt = (p.base != null ? p.base : '?') + ' ' + (p.currency || '') +
          (p.unit ? ' / ' + p.unit : '');
        row(pb, name, ptxt);
      });
      if (priced.length > 6) {
        pb.appendChild(el('p', 'muted small',
          '+ ' + (priced.length - 6) + ' more priced capabilities in the catalog.'));
      }
      if (!priced.length && networked.length) {
        pb.appendChild(el('p', 'muted', 'Networked capabilities present, none priced.'));
      }
    }
    pb.appendChild(el('p', 'muted small',
      'Estimates come from each capability’s economic bundle. Settled amounts appear ' +
      'per job below — this view computes no charges.'));
  }

  function loadCodeburn() {
    codeburn = { state: 'loading', rows: [], error: null };
    CP.api.getJSON('/api/codeburn').then(function (d) {
      var rows = [];
      Object.keys(d || {}).forEach(function (k) {
        var v = d[k];
        if ((typeof v === 'number' || typeof v === 'string') && rows.length < 6) {
          rows.push([k, String(v)]);
        }
      });
      codeburn = { state: 'ok', rows: rows, error: null };
      renderRails();
    }, function () {
      codeburn = { state: 'err', rows: [], error: 'Advisory cost endpoint not reachable.' };
      renderRails();
    });
  }

  // The catalog loads async after boot and only rebuilds Fleet on arrival —
  // so the rails re-derive on a short bounded retry plus registry growth.
  function scheduleRailsRetry() {
    if (railsRetryArmed) return;
    railsRetryArmed = true;
    [3000, 8000, 20000].forEach(function (ms) { setTimeout(renderRails, ms); });
  }
  bus.on('registry:grew', function () { renderRails(); });

  // ── the region builder ────────────────────────────────────────────────────
  function buildLedger() {
    var body = CP.regionBody('ledger');
    if (!body) return;
    ensureStyles();
    clear(body);

    body.appendChild(el('p', 'muted',
      'Two rails, honestly labeled: local capabilities are broker-gated and carry no economic ' +
      'bundle — no cost. Networked (PCC) capabilities carry one — escrowed, attested, settled. ' +
      'This view only displays what the spine reports; it never computes a charge.'));

    var rails = el('div', 'led-rails');

    var lp = el('section', 'panel');
    var lh = el('div', 'panel-h', 'Local rail — broker-gated');
    lh.appendChild(el('span', 'led-chip', 'no cost / local'));
    lp.appendChild(lh);
    var lb = el('div', 'pipe-body');
    lb.id = 'cp-led-local';
    lb.appendChild(el('p', 'muted', 'Loading registry…'));
    lp.appendChild(lb);
    rails.appendChild(lp);

    var pp = el('section', 'panel');
    var ph = el('div', 'panel-h', 'PCC rail — escrow & settlement');
    ph.appendChild(el('span', 'led-chip econ', 'priced / networked'));
    pp.appendChild(ph);
    var pb = el('div', 'pipe-body');
    pb.id = 'cp-led-pcc';
    pb.appendChild(el('p', 'muted', 'Loading registry…'));
    pp.appendChild(pb);
    rails.appendChild(pp);

    body.appendChild(rails);

    // Settlements — per-job timelines (escrow → attestation → settlement).
    var sp = el('section', 'panel');
    var sh = el('div', 'panel-h', 'Settlement per job — escrow → attestation → settlement');
    var dot = el('span', 'dot');
    dot.id = 'cp-led-dot';
    sh.appendChild(dot);
    sp.appendChild(sh);
    var sb = el('div', 'pipe-body');
    sb.id = 'cp-led-jobs';
    if (jobOrder.length) {
      // re-adopt existing job cards (rebuild / late-reveal case), newest first
      jobOrder.slice().reverse().forEach(function (k) { sb.appendChild(jobs[k].node); });
    } else {
      sb.appendChild(el('p', 'muted',
        'No settled jobs yet — settlement events stream in live as networked jobs run, ' +
        'stage by stage: escrow → attestation → settlement.'));
    }
    sp.appendChild(sb);
    body.appendChild(sp);

    // Receipts — shown when the spine reports them; never fabricated.
    var rp = el('section', 'panel');
    rp.appendChild(el('div', 'panel-h', 'Receipts'));
    var rb = el('div', 'pipe-body');
    rb.id = 'cp-led-receipts';
    if (receiptOrder.length) {
      receiptOrder.slice().reverse().forEach(function (k) { rb.appendChild(receipts[k].node); });
    } else {
      rb.appendChild(el('p', 'muted',
        'No receipts yet — a job’s final receipt lands here when the spine reports it.'));
    }
    rp.appendChild(rb);
    body.appendChild(rp);

    renderRails();
    loadCodeburn();
    scheduleRailsRetry();
    ensureRender();     // strips render richer once the engine mounts (fail-open)
    attachWatchOnce();  // ambient settlement events
  }

  (CP.regionBuilders = CP.regionBuilders || {}).ledger = buildLedger;

  // Late-load edge: if the shell already built the region with its inline
  // builder (boot happened before this file executed), rebuild with ours.
  try {
    if (CP.rebuildRegion && CP.expand && CP.expand.isRevealed('ledger')) {
      var rb0 = CP.regionBody && CP.regionBody('ledger');
      if (rb0 && rb0.childNodes.length) CP.rebuildRegion('ledger');
    }
  } catch (e) { /* boot not far enough — the normal path builds us */ }

  // Exposed for headless tests (read-only surface).
  CP._ledger = {
    onEconEvent: onEconEvent,
    receiptFrom: receiptFrom,
    jobKey: jobKey,
    jobs: function () { return jobOrder.map(function (k) { return jobs[k]; }); },
    receipts: function () { return receiptOrder.map(function (k) { return receipts[k].data; }); },
    renderRails: renderRails
  };
})();
