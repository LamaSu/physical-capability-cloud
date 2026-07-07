/* @harness/control-plane — regions/activity.js  (B3 wave 1)
 *
 * Upgraded Activity region: the live observability chain.
 *
 *   - Pipeline panel  — STATE_SNAPSHOT / STATE_DELTA off GET /api/agui/watch
 *                       (same projection the inline shell builder had).
 *   - Jobs panel      — every PCC job seen on the watch stream renders the
 *                       evidence → verdict → attestation → settlement timeline
 *                       (the events.js escrow strip: pre-auth → executing →
 *                       evidence-in → verified → settled), grouped per jobId.
 *   - Watch feed      — STEP_* / ACTIVITY_* / other ambient events, rendered
 *                       through the B1 engine (GenUIRender.events.renderEvent)
 *                       when mounted, builtin rows otherwise.
 *   - Run cards       — CP.trackRun is upgraded: each dispatched run gets a
 *                       Verdict progress row (pre-auth → verified → settled,
 *                       UNIFIED-CONTROL-PLANE.md §4.2) projected from
 *                       RUN_* / STATE_* / CUSTOM pcc.escrow|attestation|
 *                       settlement events, plus an engine-backed event feed
 *                       (createEventStream: in-place tool/message/strip
 *                       updates, interrupt cards wired to the resume POST).
 *
 * Registration: assigns CP.regionBuilders.activity — shell.js consults
 * CP.regionBuilders before its inline builders (the B3 hook). Loads AFTER
 * shell.js in index.html, before DOMContentLoaded boot.
 *
 * Reveal-on-use: expand.js already reveals 'activity' on the first
 * 'run:dispatched'; this region additionally reveals it when a PCC job
 * appears on the ambient watch stream (live work now exists).
 *
 * Engine mount: classic <script> tag injection with path candidates —
 * works on file:// (where dynamic import() of file:// URLs is refused)
 * and over http when /genui-render/* is served. Fail-open: no engine →
 * builtin rows via CP.render.event; the region never breaks.
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
  var STYLE_ID = 'cp-activity-styles';
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.run-verdict{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:7px 0 2px;}',
      '.run-verdict .k{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.6px;}',
      '.vp-chip{font-size:10.5px;font-family:var(--mono);padding:1px 8px;border-radius:16px;',
      ' border:1px solid var(--edge);color:var(--muted);white-space:nowrap;}',
      '.vp-chip.vp-on{color:var(--ink);border-color:var(--accent);}',
      '.vp-chip.vp-done{color:var(--green);border-color:var(--green);}',
      '.vp-chip.vp-failed{color:var(--red);border-color:var(--red);}',
      '.vp-arrow{color:var(--muted);font-size:10px;}',
      '#cp-watch-feed .pipe-body,#cp-jobs .pipe-body{max-height:260px;overflow:auto;}',
      '.intr-inline-resolved{opacity:.6;}',
      '.intr-inline-resolved button{pointer-events:none;opacity:.5;}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  }

  // ── engine/events mount (classic script injection, fail-open) ────────────
  function haveEvents() {
    var G = window.GenUIRender;
    return !!(G && G.events && typeof G.events.createEventStream === 'function');
  }
  function haveEngine() {
    var G = window.GenUIRender;
    return !!(G && G.engine && typeof G.engine.renderVerdict === 'function');
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
          if (haveEngine() && window.GenUIRender.engine.ensureStyles) {
            try { window.GenUIRender.engine.ensureStyles(); } catch (e) { /* fine */ }
          }
          return haveEvents();
        });
    }
    return enginePromise;
  }

  // ── watch stream (ambient pipeline + jobs) ───────────────────────────────
  var watchAttached = false;
  var pipeState = {};
  var jobsCtx = { strips: {} };       // shared ctx: pcc strips keyed by jobId — survives rebuilds
  var feedCtx = { strips: {} };       // ctx for the ambient feed (kept separate from jobs)
  var jobCount = 0;

  function isPcc(ev) {
    return ev && ev.type === 'CUSTOM' && typeof ev.name === 'string' &&
      (ev.name === 'pcc.escrow' || ev.name === 'pcc.attestation' || ev.name === 'pcc.settlement');
  }

  function attachWatchOnce() {
    if (watchAttached) return;
    watchAttached = true;
    if (CP.state) CP.state.watchAttached = true; // keep the shell's inline builder from double-attaching
    CP.api.attachWatch(onWatchEvent, function (st) {
      var d = document.getElementById('cp-pipe-dot');
      if (d) d.className = 'dot' + (st === 'live' ? ' live' : '');
    });
  }

  function onWatchEvent(ev) {
    if (!ev || !ev.type) return;
    switch (ev.type) {
      case 'STATE_SNAPSHOT':
        pipeState = ev.snapshot || {};
        renderPipe();
        return;
      case 'STATE_DELTA':
        pipeState = CP.applyPatch(pipeState, ev.delta || []);
        renderPipe();
        return;
      case 'CUSTOM':
        if (isPcc(ev)) { onJobEvent(ev); return; }
        feedPush(ev);
        return;
      default:
        feedPush(ev);
    }
  }

  function renderPipe() {
    var pb = document.getElementById('cp-pipe-body');
    if (!pb) return;
    clear(pb);
    var row = el('div', 'pipe-row');
    row.appendChild(el('span', 'k', 'status'));
    row.appendChild(el('span', 'v', String(pipeState.status || '—')));
    pb.appendChild(row);
    var row2 = el('div', 'pipe-row');
    row2.appendChild(el('span', 'k', 'phase'));
    row2.appendChild(el('span', 'v', String(pipeState.current_phase || '—')));
    pb.appendChild(row2);
    var bar = el('div', 'bar');
    var fill = el('span');
    fill.style.width = (pipeState.progress_pct || 0) + '%';
    bar.appendChild(fill);
    pb.appendChild(bar);
    (pipeState.agents || []).slice(0, 8).forEach(function (a) {
      var ar = el('div', 'pipe-row');
      ar.appendChild(el('span', 'pill st-' + (a.status || ''), a.status || '—'));
      ar.appendChild(el('span', 'v grow', a.name || ''));
      pb.appendChild(ar);
    });
  }

  function feedPush(ev) {
    var fb = document.getElementById('cp-watch-body');
    if (!fb) return;
    var empty = fb.querySelector('p.muted');
    if (empty) fb.removeChild(empty);
    var node = null;
    if (haveEvents()) {
      try { node = window.GenUIRender.events.renderEvent(ev, feedCtx); } catch (e) { node = null; }
    }
    if (!node) node = CP.render.event(ev);
    if (node.parentNode !== fb) fb.appendChild(node);
    while (fb.childNodes.length > 60) fb.removeChild(fb.firstChild);
    fb.scrollTop = fb.scrollHeight;
  }

  function onJobEvent(ev) {
    var panel = document.getElementById('cp-jobs');
    var jb = document.getElementById('cp-jobs-body');
    if (!jb) return;
    if (panel) panel.hidden = false;
    var empty = jb.querySelector('p.muted');
    if (empty) jb.removeChild(empty);
    var node = null;
    if (haveEvents()) {
      try { node = window.GenUIRender.events.renderEvent(ev, jobsCtx); } catch (e) { node = null; }
    }
    if (!node) node = CP.render.event(ev);
    if (node.parentNode !== jb) { jb.appendChild(node); jobCount++; }
    // Live settling work exists → the region has earned its place.
    CP.expand.reveal('activity', { auto: true, toast: 'Activity unlocked — a job is settling' });
    bus.emit('economic:seen', { via: ev.name });
  }

  // ── Verdict projection (UNIFIED-CONTROL-PLANE.md §4.2) ───────────────────
  // One verdict type, three reachable phases. Local caps honestly stop at
  // pre-auth (approvedBy policy/user); PCC jobs advance via pcc.* events;
  // an authoritative verdict inside RUN_FINISHED.result wins outright.
  var PHASES = ['pre-auth', 'verified', 'settled'];
  var AUTHORITY = { read: 'observe', write: 'mutate', network: 'mutate', exec: 'actuate', credential: 'privileged' };

  function newVerdict(cap) {
    return {
      ok: true,
      phase: 'pre-auth',
      approvedBy: undefined,
      authorityClass: AUTHORITY[cap && cap.trustLevel] || undefined,
      settled: false,
      awaiting: false,
      failed: false
    };
  }

  function projectVerdict(v, ev) {
    if (!ev || !ev.type) return false;
    var value, status;
    switch (ev.type) {
      case 'RUN_STARTED':
        v.phase = 'pre-auth';
        return true;
      case 'STATE_SNAPSHOT':
        if (ev.snapshot && ev.snapshot.pendingApproval) { v.awaiting = true; return true; }
        return false;
      case 'CUSTOM':
        if (!isPcc(ev)) return false;
        value = ev.value || {};
        status = String(value.status || value.state || '').toLowerCase();
        if (ev.name === 'pcc.escrow') {
          if (/funded|locked|escrowed|active/.test(status)) { v.approvedBy = 'escrow-fund'; v.awaiting = false; }
          return true;
        }
        if (ev.name === 'pcc.attestation') {
          if (/verified|attested|passed|ok|accept/.test(status)) { v.phase = 'verified'; v.evidenceOk = true; }
          return true;
        }
        if (ev.name === 'pcc.settlement') {
          v.phase = 'settled';
          v.settled = true;
          v.settlement = { status: value.status || value.state, txHash: value.txHash };
          if (/slash|dispute|refund|fail/.test(status)) { v.ok = false; v.failed = true; }
          return true;
        }
        return false;
      case 'RUN_ERROR':
        v.ok = false; v.failed = true;
        return true;
      case 'RUN_FINISHED':
        if (ev.outcome && ev.outcome.type === 'interrupt') { v.awaiting = true; return true; }
        if (ev.result && ev.result.verdict && typeof ev.result.verdict === 'object') {
          var av = ev.result.verdict;
          v.ok = av.ok !== false;
          if (PHASES.indexOf(av.phase) !== -1) v.phase = av.phase;
          if (av.approvedBy) v.approvedBy = av.approvedBy;
          if (av.authorityClass) v.authorityClass = av.authorityClass;
          if (av.settlement) v.settlement = av.settlement;
          if (av.receiptCID) v.receiptCID = av.receiptCID;
          if (av.assuranceTierMet !== undefined) v.assuranceTierMet = av.assuranceTierMet;
          v.settled = v.phase === 'settled';
          v.awaiting = false;
          return true;
        }
        // local run finished: verdict honestly stops where it reached
        if (!v.approvedBy) v.approvedBy = 'policy';
        v.awaiting = false;
        return true;
      default:
        return false;
    }
  }

  function renderVerdictInto(host, v) {
    clear(host);
    host.appendChild(el('span', 'k', 'verdict'));
    if (haveEngine()) {
      try {
        var node = window.GenUIRender.engine.renderVerdict(v);
        if (node) { host.appendChild(node); return; }
      } catch (e) { /* fall through to builtin chips */ }
    }
    var reached = PHASES.indexOf(v.phase);
    PHASES.forEach(function (p, i) {
      if (i > 0) host.appendChild(el('span', 'vp-arrow', '→'));
      var cls = 'vp-chip';
      if (i < reached) cls += ' vp-done';
      else if (i === reached) cls += v.failed ? ' vp-failed' : (v.settled ? ' vp-done' : ' vp-on');
      host.appendChild(el('span', cls, p));
    });
    if (v.approvedBy) host.appendChild(el('span', 'vp-chip', 'by ' + v.approvedBy));
    if (v.awaiting) host.appendChild(el('span', 'vp-chip', 'awaiting approval'));
  }

  // ── CP.trackRun — upgraded run card ──────────────────────────────────────
  var inlineInterrupts = {}; // interrupt id → inline card node (cross-surface resolution marking)

  bus.on('interrupt:resolved', function (p) {
    var id = p && p.id;
    if (!id || !inlineInterrupts[id]) return;
    var card = inlineInterrupts[id];
    if (card.classList) card.classList.add('intr-inline-resolved');
    delete inlineInterrupts[id];
  });

  CP.trackRun = function (cap, threadId) {
    ensureStyles();
    var node = el('article', 'run-card');
    node.setAttribute('data-thread', threadId || '');
    var head = el('div', 'run-head');
    head.appendChild(el('span', 'run-name', cap.name || cap.id));
    var st = el('span', 'pill st-running', 'running');
    head.appendChild(st);
    node.appendChild(head);

    var vhost = el('div', 'run-verdict');
    node.appendChild(vhost);
    var verdict = newVerdict(cap);
    renderVerdictInto(vhost, verdict);

    var feed = el('div', 'run-feed');
    node.appendChild(feed);

    var stream = null;
    if (haveEvents()) {
      try {
        stream = window.GenUIRender.events.createEventStream(feed, {
          threadId: threadId,
          resume: { url: CP.api.base() + '/api/agui/run' },
          onResume: function (detail) {
            bus.emit('interrupt:resolved', {
              id: detail && detail.interrupt && detail.interrupt.id,
              approved: !!(detail && detail.approved),
              via: 'activity-inline'
            });
          },
          maxNodes: 80
        });
      } catch (e) { stream = null; }
    }

    var run = { threadId: threadId, capId: cap.id, node: node, status: 'running' };
    CP.state.runs.unshift(run);
    var host = document.getElementById('cp-runs');
    if (host) {
      var empty = host.querySelector('p.muted');
      if (empty) host.removeChild(empty);
      host.insertBefore(node, host.firstChild);
    }
    bus.emit('run:dispatched', { capId: cap.id, threadId: threadId });

    function fallbackPush(ev) {
      var n = CP.render.event(ev);
      feed.appendChild(n);
      while (feed.childNodes.length > 40) feed.removeChild(feed.firstChild);
      feed.scrollTop = feed.scrollHeight;
      return n;
    }

    return {
      event: function (ev) {
        var rendered = null;
        if (stream) { try { rendered = stream.push(ev); } catch (e) { rendered = fallbackPush(ev); } }
        else rendered = fallbackPush(ev);

        if (projectVerdict(verdict, ev)) renderVerdictInto(vhost, verdict);

        if (ev.type === 'RUN_ERROR') { st.textContent = 'error'; st.className = 'pill st-failed'; run.status = 'error'; }
        if (ev.type === 'RUN_FINISHED') {
          if (ev.outcome && ev.outcome.type === 'interrupt') {
            st.textContent = 'paused'; st.className = 'pill st-pending'; run.status = 'paused';
            (ev.outcome.interrupts || []).forEach(function (intr) {
              if (intr && intr.id && rendered) inlineInterrupts[intr.id] = rendered;
            });
          } else {
            st.textContent = 'done'; st.className = 'pill st-done'; run.status = 'done';
            bus.emit('run:finished', { capId: cap.id });
          }
        }
      },
      setStatus: function (s, cls) { st.textContent = s; st.className = 'pill ' + (cls || ''); }
    };
  };

  // ── the region builder ────────────────────────────────────────────────────
  function buildActivity() {
    var body = CP.regionBody('activity');
    if (!body) return;
    ensureStyles();
    clear(body);

    // 1. pipeline panel (same DOM contract as the inline builder)
    var pipe = el('div', 'panel pipe');
    pipe.id = 'cp-pipe';
    var ph = el('div', 'panel-h', 'Pipeline');
    var pdot = el('span', 'dot'); pdot.id = 'cp-pipe-dot';
    ph.appendChild(pdot);
    pipe.appendChild(ph);
    var pb = el('div', 'pipe-body');
    pb.id = 'cp-pipe-body';
    pb.appendChild(el('p', 'muted', 'No pipeline stream yet.'));
    pipe.appendChild(pb);
    body.appendChild(pipe);

    // 2. jobs panel — the settle-observability chain (hidden until a job appears)
    var jobs = el('div', 'panel');
    jobs.id = 'cp-jobs';
    jobs.appendChild(el('div', 'panel-h', 'Jobs — evidence → verdict → attestation → settlement'));
    var jb = el('div', 'pipe-body');
    jb.id = 'cp-jobs-body';
    jobs.appendChild(jb);
    // re-adopt strips that already exist (rebuild case)
    var stripKeys = Object.keys(jobsCtx.strips || {});
    if (stripKeys.length) {
      stripKeys.forEach(function (k) { jb.appendChild(jobsCtx.strips[k].el); });
      jobs.hidden = false;
    } else {
      jb.appendChild(el('p', 'muted', 'PCC jobs seen on the stream settle here, stage by stage.'));
      jobs.hidden = true;
    }
    body.appendChild(jobs);

    // 3. ambient watch feed
    var wf = el('div', 'panel');
    wf.id = 'cp-watch-feed';
    wf.appendChild(el('div', 'panel-h', 'Pipeline events'));
    var wb = el('div', 'pipe-body');
    wb.id = 'cp-watch-body';
    wb.appendChild(el('p', 'muted', 'Steps and agent activity stream here live.'));
    wf.appendChild(wb);
    body.appendChild(wf);

    // 4. dispatched runs
    var runsHost = el('div', 'runs');
    runsHost.id = 'cp-runs';
    body.appendChild(runsHost);
    if (!CP.state.runs.length) {
      runsHost.appendChild(el('p', 'muted', 'Runs you dispatch appear here, live — each with its verdict progress.'));
    } else {
      CP.state.runs.forEach(function (r) { runsHost.appendChild(r.node); });
    }

    ensureRender();     // kick the engine/events mount (fail-open)
    attachWatchOnce();  // live observability chain
  }

  (CP.regionBuilders = CP.regionBuilders || {}).activity = buildActivity;

  // Late-load edge: if the shell already built the region with its inline
  // builder (boot happened before this file executed), rebuild with ours.
  try {
    if (CP.rebuildRegion && CP.expand && CP.expand.isRevealed('activity')) {
      var rb = CP.regionBody && CP.regionBody('activity');
      if (rb && rb.childNodes.length) CP.rebuildRegion('activity');
    }
  } catch (e) { /* boot not far enough — the normal path builds us */ }

  // Kick the render mount early so run cards dispatched soon after load get
  // the full engine (non-blocking; builtin fallback carries until then).
  ensureRender();
})();
