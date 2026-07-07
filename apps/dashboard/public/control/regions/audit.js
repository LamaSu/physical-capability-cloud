/* @harness/control-plane — regions/audit.js  (B3 wave 2)
 *
 * Upgraded Audit region: "receipts, evidence and telemetry — what
 * happened, provably" (all lenses). STRICTLY READ-ONLY: this region
 * displays what the audit spine already records — it writes no logging,
 * no verdict logic, and never POSTs.
 *
 * Three panels:
 *
 *   1. Action-class ladder — the five harness action classes and the
 *      authority rung each maps to. Display-only browser mirror of
 *      lib/genui/verdict.js AUTHORITY_CLASS (§3a five-way map):
 *      read→observe, write→mutate, exec→actuate, network→reach-out,
 *      credential→privileged.
 *
 *   2. Verdict transitions — every trust-phase move the spine records
 *      (pre-auth → verified → settled, UNIFIED-CONTROL-PLANE.md §4.2),
 *      grouped per capability run and per ambient PCC job:
 *        - dispatched runs ride in on the bus ('run:event' — every event
 *          streamRun parses is re-emitted there),
 *        - ambient jobs ride in on this region's own watch attach
 *          (CUSTOM pcc.escrow|attestation|settlement carrying a jobId).
 *          NOTE: deliberately does NOT touch CP.state.watchAttached —
 *          that flag belongs to the Activity/pipe projection.
 *      Phase moves are recorded with timestamps; settlement/receipt
 *      fields (status, txHash, rail, receiptCID, evidenceOk,
 *      assuranceTierMet) render when the stream carries them. Projection
 *      is monotonic (a displayed verdict never regresses), mirroring the
 *      advanceVerdict invariant.
 *
 *   3. Tool calls & telemetry — probes GET {base}/api/audit, falling back
 *      to GET {base}/api/telemetry; honest "no audit feed on this origin"
 *      when neither answers with rows. Rows group by capability / run /
 *      agent where the row carries such a key.
 *
 * Reveal-on-use: expand.js suggests 'audit' on run:finished; this region
 * additionally reveals it when the first receipt lands (a settlement or
 * receiptCID was recorded — there is now something provable to show).
 *
 * Registration: CP.regionBuilders.audit (the B3 shell hook). Loads after
 * shell.js, before boot. Hygiene: textContent only — no innerHTML.
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
  var STYLE_ID = 'cp-audit-styles';
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.aud-ladder-row{display:flex;gap:10px;align-items:center;padding:3px 0;flex-wrap:wrap;}',
      '.aud-ladder-row .auth{font-family:var(--mono);font-size:12px;color:var(--teal);min-width:96px;}',
      '.aud-ladder-row .hint{color:var(--muted);font-size:12px;}',
      '.aud-card{background:var(--panel2);border:1px solid var(--edge);border-radius:10px;',
      ' padding:10px 12px;margin:0 0 10px;}',
      '.aud-phases{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:8px 0 2px;}',
      '.aud-chip{font-size:10.5px;font-family:var(--mono);padding:1px 8px;border-radius:16px;',
      ' border:1px solid var(--edge);color:var(--muted);white-space:nowrap;}',
      '.aud-chip.on{color:var(--ink);border-color:var(--accent);}',
      '.aud-chip.done{color:var(--green);border-color:var(--green);}',
      '.aud-chip.failed{color:var(--red);border-color:var(--red);}',
      '.aud-arrow{color:var(--muted);font-size:10px;}',
      '.aud-trans{margin-top:6px;}',
      '.aud-row{display:flex;gap:10px;align-items:baseline;padding:2px 0;',
      ' font-family:var(--mono);font-size:11.5px;min-width:0;}',
      '.aud-time{color:var(--muted);min-width:62px;flex:none;}',
      '.aud-to{color:var(--ink);white-space:nowrap;}',
      '.aud-via{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.aud-receipt{background:var(--panel);border:1px dashed var(--edge);border-radius:8px;',
      ' padding:6px 10px;margin-top:8px;}',
      '.aud-src{font-size:10.5px;font-family:var(--mono);padding:1px 7px;border-radius:16px;',
      ' border:1px dashed var(--edge);color:var(--muted);white-space:nowrap;}',
      '.aud-group{margin:8px 0 10px;}',
      '.aud-group-h{display:flex;gap:8px;align-items:center;font-size:11.5px;color:var(--muted);',
      ' font-family:var(--mono);border-bottom:1px solid var(--edge);padding-bottom:3px;margin-bottom:4px;}',
      '.aud-refresh{margin-left:auto;min-height:24px;padding:2px 10px;font-size:11px;}',
      '#cp-aud-entries{max-height:420px;overflow:auto;}',
      '#cp-aud-feed{max-height:320px;overflow:auto;}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  }

  // ── the authority ladder (browser mirror of lib/genui/verdict.js §3a) ────
  var AUTHORITY_CLASS = {
    read: 'observe',
    write: 'mutate',
    exec: 'actuate',
    network: 'reach-out',
    credential: 'privileged'
  };
  var LADDER = [
    { t: 'read',       hint: 'runs immediately' },
    { t: 'write',      hint: 'pauses for approval' },
    { t: 'exec',       hint: 'pauses for approval' },
    { t: 'network',    hint: 'pauses for approval' },
    { t: 'credential', hint: 'always explicit approval' }
  ];
  var PHASES = ['pre-auth', 'verified', 'settled'];

  // ── module state (records survive rebuilds; capture starts at load) ─────
  var entries = {};   // key → entry record
  var order = [];     // keys, most-recently-touched first
  var MAX_ENTRIES = 40;
  var revealed = false;
  var watchAttached = false;
  var feed = { source: null, path: null, rows: [], error: null, timer: null, fetching: false };

  function entryFor(key, seed) {
    var e = entries[key];
    if (e) return e;
    e = entries[key] = {
      key: key,
      kind: seed.kind || 'run',
      name: seed.name || key,
      capId: seed.capId || null,
      trustLevel: seed.trustLevel || null,
      authorityClass: seed.trustLevel ? AUTHORITY_CLASS[seed.trustLevel] : null,
      phase: 'pre-auth',
      ok: true,
      failed: false,
      awaiting: false,
      approvedBy: null,
      settlement: null,
      receiptCID: null,
      evidenceOk: undefined,
      assuranceTierMet: undefined,
      transitions: [],   // {to, at, via}
      startedAt: Date.now(),
      lastAt: Date.now()
    };
    order.unshift(key);
    while (order.length > MAX_ENTRIES) {
      var drop = order.pop();
      delete entries[drop];
    }
    return e;
  }

  function findCap(id) {
    if (!id) return null;
    var caps = (CP.state && CP.state.caps) ||
      (CP.catalog && CP.catalog.all && CP.catalog.all()) || [];
    for (var i = 0; i < caps.length; i++) if (caps[i] && caps[i].id === id) return caps[i];
    return null;
  }

  function runSeed(threadId) {
    var runs = (CP.state && CP.state.runs) || [];
    for (var i = 0; i < runs.length; i++) {
      if (runs[i] && runs[i].threadId === threadId) {
        var capId = runs[i].capId;
        var cap = findCap(capId);
        return {
          kind: 'run',
          capId: capId,
          name: (cap && (cap.name || cap.id)) || capId || threadId,
          trustLevel: cap && cap.trustLevel
        };
      }
    }
    return { kind: 'run', name: String(threadId || 'run') };
  }

  // ── projection: record the phase moves the stream carries ───────────────
  // Mirrors the Activity/§4.2 event mapping, but as a RECORDER (transitions
  // with timestamps), and monotonic like advanceVerdict — display never
  // regresses a phase.
  function statusOf(v) {
    return String((v && (v.status || v.state)) || '').toLowerCase();
  }

  function pushTransition(e, to, via) {
    e.transitions.push({ to: to, at: Date.now(), via: via });
    while (e.transitions.length > 12) e.transitions.shift();
  }

  function setPhase(e, phase, via) {
    if (PHASES.indexOf(phase) <= PHASES.indexOf(e.phase) && e.transitions.length) return false;
    e.phase = phase;
    pushTransition(e, phase, via);
    return true;
  }

  function project(e, ev) {
    if (!ev || !ev.type) return false;
    var changed = false;
    var st;
    switch (ev.type) {
      case 'RUN_STARTED':
        if (!e.transitions.length) { pushTransition(e, 'pre-auth', 'RUN_STARTED'); changed = true; }
        break;
      case 'STATE_SNAPSHOT':
        if (ev.snapshot && ev.snapshot.pendingApproval && !e.awaiting) { e.awaiting = true; changed = true; }
        break;
      case 'CUSTOM':
        st = statusOf(ev.value);
        if (ev.name === 'pcc.escrow') {
          if (/funded|locked|escrowed|active/.test(st) && e.approvedBy !== 'escrow-fund') {
            e.approvedBy = 'escrow-fund';
            e.awaiting = false;
            changed = true;
          }
        } else if (ev.name === 'pcc.attestation') {
          if (/verified|attested|passed|ok|accept/.test(st)) {
            if (setPhase(e, 'verified', 'pcc.attestation')) changed = true;
            if (e.evidenceOk !== true) { e.evidenceOk = true; changed = true; }
          }
        } else if (ev.name === 'pcc.settlement') {
          if (setPhase(e, 'settled', 'pcc.settlement')) changed = true;
          e.settlement = {
            status: (ev.value && (ev.value.status || ev.value.state)) || '',
            txHash: ev.value && ev.value.txHash,
            rail: ev.value && ev.value.rail
          };
          if (/slash|dispute|refund|fail/.test(st)) { e.ok = false; e.failed = true; }
          changed = true;
        }
        break;
      case 'RUN_ERROR':
        if (!e.failed) { e.ok = false; e.failed = true; changed = true; }
        break;
      case 'RUN_FINISHED':
        if (ev.result && ev.result.verdict && typeof ev.result.verdict === 'object') {
          var av = ev.result.verdict;
          if (av.phase && PHASES.indexOf(av.phase) !== -1) setPhase(e, av.phase, 'verdict');
          if (av.ok === false) { e.ok = false; e.failed = true; }
          if (av.approvedBy) e.approvedBy = av.approvedBy;
          if (av.authorityClass) e.authorityClass = av.authorityClass;
          if (av.settlement) e.settlement = av.settlement;
          if (av.receiptCID) e.receiptCID = av.receiptCID;
          if (av.evidenceOk !== undefined) e.evidenceOk = av.evidenceOk;
          if (av.assuranceTierMet !== undefined) e.assuranceTierMet = av.assuranceTierMet;
          e.awaiting = false;
          changed = true;
        } else if (ev.outcome && ev.outcome.type === 'interrupt') {
          if (!e.awaiting) { e.awaiting = true; changed = true; }
        } else {
          // Clean finish, no authoritative verdict: record the approver the
          // session actually observed — a recorded interrupt that later
          // finished cleanly was resolved by a human; otherwise policy.
          if (!e.approvedBy) {
            e.approvedBy = e.awaiting ? 'user' : 'policy';
            changed = true;
          }
          if (e.awaiting) { e.awaiting = false; changed = true; }
        }
        break;
      default:
        break;
    }
    if (changed) e.lastAt = Date.now();
    return changed;
  }

  function touched(e) {
    var i = order.indexOf(e.key);
    if (i > 0) { order.splice(i, 1); order.unshift(e.key); }
    maybeReveal(e);
    renderEntries();
  }

  function maybeReveal(e) {
    if (revealed) return;
    if (e.phase === 'settled' || e.receiptCID) {
      revealed = true;
      CP.expand.reveal('audit', { auto: true, toast: 'Audit unlocked — a receipt landed' });
    }
  }

  // ── source a: dispatched runs (bus re-emits every streamed event) ───────
  function isRelevant(ev) {
    if (ev.type === 'RUN_STARTED' || ev.type === 'RUN_ERROR' ||
        ev.type === 'RUN_FINISHED' || ev.type === 'STATE_SNAPSHOT') return true;
    return ev.type === 'CUSTOM' && typeof ev.name === 'string' && ev.name.indexOf('pcc.') === 0;
  }

  bus.on('run:event', function (p) {
    var ev = p && p.event;
    if (!ev || !ev.type || !isRelevant(ev)) return;
    var e = entryFor('run:' + (p.threadId || 'unknown'), runSeed(p.threadId));
    if (project(e, ev)) touched(e);
  });

  // ── source b: ambient PCC jobs on the watch stream (own attach) ─────────
  function attachWatchOnce() {
    if (watchAttached) return;
    watchAttached = true;
    // Own EventSource; CP.state.watchAttached is Activity's flag — untouched.
    CP.api.attachWatch(function (ev) {
      if (!ev || ev.type !== 'CUSTOM' || typeof ev.name !== 'string' ||
          ev.name.indexOf('pcc.') !== 0) return;
      var jobId = ev.value && (ev.value.jobId || ev.value.job_id);
      if (!jobId) return;
      var e = entryFor('job:' + jobId, {
        kind: 'job',
        name: 'job ' + jobId,
        capId: (ev.value && (ev.value.capabilityId || ev.value.capId)) || null
      });
      if (project(e, ev)) touched(e);
    }, function (st) {
      var d = document.getElementById('cp-aud-dot');
      if (d) d.className = 'dot' + (st === 'live' ? ' live' : '');
    });
  }

  // ── the tool-call / telemetry feed (probed; honest when absent) ─────────
  var FEED_PATHS = [
    { path: '/api/audit?limit=80', label: '/api/audit' },
    { path: '/api/telemetry?limit=80', label: '/api/telemetry' }
  ];

  function parseRows(j) {
    if (Array.isArray(j)) return j;
    if (j && Array.isArray(j.events)) return j.events;
    if (j && Array.isArray(j.rows)) return j.rows;
    if (j && Array.isArray(j.entries)) return j.entries;
    if (j && Array.isArray(j.items)) return j.items;
    return null;
  }

  function feedSync() {
    if (feed.fetching || document.hidden) return Promise.resolve();
    feed.fetching = true;
    var cands = feed.path ? [{ path: feed.path, label: feed.source }] : FEED_PATHS;
    var i = 0;
    function next() {
      if (i >= cands.length) {
        feed.path = null;
        feed.source = null;
        feed.rows = [];
        feed.error = 'absent';
        feed.fetching = false;
        renderFeed();
        return Promise.resolve();
      }
      var c = cands[i++];
      return CP.api.getJSON(c.path).then(function (j) {
        var rows = parseRows(j);
        if (!rows) return next();
        feed.path = c.path;
        feed.source = c.label;
        feed.rows = rows.slice(-200);
        feed.error = null;
        feed.fetching = false;
        renderFeed();
      }, function () { return next(); });
    }
    return next();
  }

  function startFeedPolling() {
    if (feed.timer) return;
    feed.timer = setInterval(feedSync, 60000);
  }

  function rowKey(r) {
    return r.capId || r.capabilityId || r.capability ||
      r.threadId || r.thread_id || r.runId || r.run_id ||
      r.jobId || r.job_id ||
      r.agent || r.agent_name || r.agent_role || null;
  }
  function rowLabel(r) {
    return String(r.tool || r.event || r.type || r.action || '·');
  }
  function rowClass(r) {
    var c = r.action_class || r.actionClass || r.trustLevel;
    return (c === 'read' || c === 'write' || c === 'exec' || c === 'network' || c === 'credential') ? c : null;
  }
  function rowTime(r) {
    return String(r.ts || r.timestamp || r.time || r.at || '').slice(0, 19).replace('T', ' ');
  }
  function rowMeta(r) {
    var who = r.agent || r.agent_name || r.agent_role || '';
    var extra = r.phase || r.status || '';
    return [String(who), String(extra), rowTime(r)].filter(Boolean).join(' · ');
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  function fmtTime(ms) {
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function kv(host, k, v) {
    var row = el('div', 'prov-row');
    row.appendChild(el('span', 'k', k));
    row.appendChild(el('span', 'v', String(v)));
    host.appendChild(row);
  }

  function entryCard(e) {
    var card = el('article', 'aud-card');

    var head = el('div', 'run-head');
    head.appendChild(el('span', 'run-name', String(e.name)));
    var badges = el('span', 'cap-badges');
    if (e.trustLevel && CP.render && CP.render.trustBadge) {
      badges.appendChild(CP.render.trustBadge(e.trustLevel));
    }
    if (e.authorityClass) badges.appendChild(el('span', 'aud-src', String(e.authorityClass)));
    badges.appendChild(el('span', 'aud-src', e.kind === 'job' ? 'pcc job' : 'run'));
    if (e.failed) badges.appendChild(el('span', 'pill st-failed', 'failed'));
    head.appendChild(badges);
    card.appendChild(head);

    var strip = el('div', 'aud-phases');
    var reached = PHASES.indexOf(e.phase);
    PHASES.forEach(function (p, i) {
      if (i > 0) strip.appendChild(el('span', 'aud-arrow', '→'));
      var cls = 'aud-chip';
      if (i < reached) cls += ' done';
      else if (i === reached) cls += e.failed ? ' failed' : (e.phase === 'settled' ? ' done' : ' on');
      strip.appendChild(el('span', cls, p));
    });
    if (e.approvedBy) strip.appendChild(el('span', 'aud-chip', 'by ' + e.approvedBy));
    if (e.awaiting) strip.appendChild(el('span', 'aud-chip', 'awaiting approval'));
    card.appendChild(strip);

    if (e.transitions.length) {
      var list = el('div', 'aud-trans');
      e.transitions.forEach(function (t) {
        var row = el('div', 'aud-row');
        row.appendChild(el('span', 'aud-time', fmtTime(t.at)));
        row.appendChild(el('span', 'aud-to', '→ ' + t.to));
        row.appendChild(el('span', 'aud-via', 'via ' + t.via));
        list.appendChild(row);
      });
      card.appendChild(list);
    }

    if (e.settlement || e.receiptCID || e.evidenceOk !== undefined || e.assuranceTierMet !== undefined) {
      var rec = el('div', 'aud-receipt');
      if (e.settlement) {
        kv(rec, 'settlement', String(e.settlement.status || '') +
          (e.settlement.rail ? ' · ' + e.settlement.rail : ''));
        if (e.settlement.txHash) kv(rec, 'tx', e.settlement.txHash);
      }
      if (e.receiptCID) kv(rec, 'receipt', e.receiptCID);
      if (e.evidenceOk !== undefined) kv(rec, 'evidence', e.evidenceOk ? 'ok' : 'not ok');
      if (e.assuranceTierMet !== undefined) kv(rec, 'tier met', e.assuranceTierMet);
      card.appendChild(rec);
    }

    return card;
  }

  function renderEntries() {
    var host = document.getElementById('cp-aud-entries');
    if (!host) return;
    clear(host);
    if (!order.length) {
      host.appendChild(el('p', 'muted',
        'No verdict transitions recorded this session yet. Dispatch a run from the Catalog, or let a PCC job ' +
        'ride the stream — every pre-auth → verified → settled move lands here with a timestamp.'));
      return;
    }
    order.forEach(function (k) {
      var e = entries[k];
      if (e) host.appendChild(entryCard(e));
    });
  }

  function renderFeed() {
    var fb = document.getElementById('cp-aud-feed');
    if (!fb) return;
    clear(fb);
    var status = el('p', 'muted small');
    fb.appendChild(status);
    if (feed.error === 'absent') {
      status.textContent = 'No audit feed on this origin — neither GET /api/audit nor GET /api/telemetry ' +
        'returned rows. Tool-call history appears here when the spine exposes one.';
      return;
    }
    if (!feed.source) {
      status.textContent = 'Probing /api/audit and /api/telemetry…';
      return;
    }
    status.textContent = 'Rows from GET ' + feed.source +
      ' — newest first, grouped where a row names a capability, run or agent.';

    var rows = feed.rows.slice().reverse();
    var groups = [];
    var byKey = {};
    rows.forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      var k = String(rowKey(r) || '(no capability/run key)');
      if (!byKey[k]) { byKey[k] = { key: k, rows: [] }; groups.push(byKey[k]); }
      byKey[k].rows.push(r);
    });
    if (!groups.length) {
      fb.appendChild(el('p', 'muted', 'The feed answered but carried no rows yet.'));
      return;
    }
    groups.slice(0, 8).forEach(function (g) {
      var sec = el('div', 'aud-group');
      var h = el('div', 'aud-group-h');
      h.appendChild(el('span', null, g.key));
      h.appendChild(el('span', null, '×' + g.rows.length));
      sec.appendChild(h);
      g.rows.slice(0, 6).forEach(function (r) {
        var row = el('div', 'ev-row');
        row.appendChild(el('span', 'ev-type', rowLabel(r)));
        var cls = rowClass(r);
        if (cls && CP.render && CP.render.trustBadge) row.appendChild(CP.render.trustBadge(cls));
        row.appendChild(el('span', 'ev-txt', rowMeta(r)));
        sec.appendChild(row);
      });
      if (g.rows.length > 6) sec.appendChild(el('p', 'muted small', '+' + (g.rows.length - 6) + ' more'));
      fb.appendChild(sec);
    });
    if (groups.length > 8) fb.appendChild(el('p', 'muted small', '+' + (groups.length - 8) + ' more groups'));
  }

  // ── the region builder ────────────────────────────────────────────────────
  function buildAudit() {
    var body = CP.regionBody('audit');
    if (!body) return;
    ensureStyles();
    clear(body);

    // 1. the action-class → authority ladder (display of the spine's map)
    var lad = el('div', 'panel');
    lad.appendChild(el('div', 'panel-h', 'Action classes → authority'));
    var lb = el('div', 'pipe-body');
    LADDER.forEach(function (item) {
      var row = el('div', 'aud-ladder-row');
      if (CP.render && CP.render.trustBadge) row.appendChild(CP.render.trustBadge(item.t));
      else row.appendChild(el('span', 'badge trust-' + item.t, item.t));
      row.appendChild(el('span', 'aud-arrow', '→'));
      row.appendChild(el('span', 'auth', AUTHORITY_CLASS[item.t]));
      row.appendChild(el('span', 'hint', item.hint));
      lb.appendChild(row);
    });
    lad.appendChild(lb);
    body.appendChild(lad);

    // 2. verdict transitions, grouped by run / job
    var vt = el('div', 'panel');
    var vh = el('div', 'panel-h', 'Verdict transitions — pre-auth → verified → settled, by run / job');
    var dot = el('span', 'dot');
    dot.id = 'cp-aud-dot';
    vh.appendChild(dot);
    vt.appendChild(vh);
    var vb = el('div', 'pipe-body');
    vb.id = 'cp-aud-entries';
    vt.appendChild(vb);
    body.appendChild(vt);

    // 3. tool calls & telemetry (probed feed)
    var fp = el('div', 'panel');
    var fh = el('div', 'panel-h', 'Tool calls & telemetry');
    var refresh = el('button', 'btn ghost aud-refresh', 'Refresh');
    refresh.type = 'button';
    refresh.onclick = function () {
      feed.path = null;
      feed.source = null;
      feed.error = null;
      feedSync();
    };
    fh.appendChild(refresh);
    fp.appendChild(fh);
    var fb = el('div', 'pipe-body');
    fb.id = 'cp-aud-feed';
    fp.appendChild(fb);
    body.appendChild(fp);

    body.appendChild(el('p', 'muted small',
      'This region displays what the spine already recorded — it never writes, approves or settles anything.'));

    renderEntries();
    renderFeed();
    attachWatchOnce();
    feedSync();
    startFeedPolling();
  }

  (CP.regionBuilders = CP.regionBuilders || {}).audit = buildAudit;

  // Late-load edge: shell booted before this file → rebuild with ours.
  try {
    if (CP.rebuildRegion && CP.expand && CP.expand.isRevealed('audit')) {
      var rb = CP.regionBody && CP.regionBody('audit');
      if (rb && rb.childNodes.length) CP.rebuildRegion('audit');
    }
  } catch (e) { /* boot not far enough — the normal path builds us */ }

  // Exposed for headless tests (read-only surface).
  CP._audit = {
    AUTHORITY_CLASS: AUTHORITY_CLASS,
    PHASES: PHASES,
    parseRows: parseRows,
    rowKey: rowKey,
    entries: function () {
      return order.map(function (k) { return entries[k]; }).filter(Boolean);
    },
    _entryFor: entryFor,
    _project: project
  };
})();
