/* @harness/control-plane — regions/compose.js  (B3 wave 2)
 *
 * Compose — chain capabilities into an ordered plan (the orchestrator
 * lens's workbench). Vanilla only: flexbox chips + arrows for the chain,
 * no external libs, no build.
 *
 *   - pick capabilities out of the catalog (search over CP.catalog.match /
 *     CP.catalog.all) into an ordered step list: add / remove / reorder,
 *   - every step shows its inputs (param names from the JSON schema, * =
 *     required) → outputs (PCC steps return a kind:"job" handle — evidence
 *     → settlement; otherwise the declared ui.hint, or honestly
 *     "undeclared shape"). Outputs are NOT auto-wired into the next step's
 *     inputs — the UI says so instead of pretending,
 *   - per-step args editor (JSON object; empty = {}),
 *   - "Run plan" dispatches the steps ONE AT A TIME through the exact
 *     per-capability AG-UI run path the Catalog uses — CP.api.runCapability
 *     (POST {base}/api/agui/run) + CP.trackRun, so every step surfaces in
 *     Activity as a live run card with its verdict strip. There is no
 *     server-side DAG yet and the region says that in plain text: the
 *     sequencing is client-driven,
 *   - a gated step pauses the WHOLE plan: its interrupts land in Approvals
 *     (CP.addInterrupt, tracker attached so resumed events reach the run
 *     card). Approve → the plan continues when the resumed run finishes;
 *     deny or expiry → the step is marked denied and the remaining steps
 *     are skipped. "Stop plan" halts before the next dispatch (the
 *     in-flight step still settles on its own),
 *   - a plan with priced steps says so ('economic:seen' is emitted when a
 *     priced step is added, so the Ledger reveals itself).
 *
 * Plan state is module-scoped: region rebuilds (lens switches, reveals)
 * keep the steps. Statuses come only from observed run events on the bus
 * ('run:event' / 'interrupt:resolved' scoped by threadId) — never assumed.
 *
 * Registration: CP.regionBuilders.compose (the B3 shell hook — overrides
 * the inline thin-state builder in shell.js). Loads after shell.js, before
 * boot. Hygiene: textContent only — no innerHTML.
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
  function uuid8() {
    var u = CP.uuid ? CP.uuid() : (String(Math.random()).slice(2) + Date.now().toString(36));
    return String(u).replace(/-/g, '').slice(0, 8);
  }

  // ── region-local styles (injected once) ──────────────────────────────────
  var STYLE_ID = 'cp-compose-styles';
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.cmp-chain{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 14px;}',
      '.cmp-chain p.muted{margin:0;}',
      '.cmp-arrow{color:var(--muted);font-size:12px;}',
      '.cmp-chip{font-size:11.5px;}',
      '.pill.st-skipped{opacity:.55;}',
      '.cmp-steps{display:grid;gap:10px;margin-bottom:12px;}',
      '.cmp-step{margin-bottom:0;}',
      '.cmp-idx{background:var(--panel);border:1px solid var(--edge);border-radius:50%;',
      ' width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;',
      ' font-size:11px;color:var(--ink);flex:none;}',
      '.cmp-name{color:var(--ink);text-transform:none;letter-spacing:normal;font-size:13px;',
      ' font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.cmp-tools{margin-left:auto;display:inline-flex;gap:4px;}',
      '.cmp-tool{background:transparent;border:1px solid var(--edge);color:var(--muted);',
      ' border-radius:8px;width:26px;height:24px;font-size:11px;line-height:1;padding:0;}',
      '.cmp-tool:hover{color:var(--ink);border-color:var(--accent);}',
      '.cmp-tool:disabled{opacity:.35;cursor:default;}',
      '.cmp-picker-results{margin-top:10px;display:grid;gap:8px;}',
      '.cmp-pick-row{display:flex;align-items:center;gap:10px;justify-content:space-between;',
      ' background:var(--panel2);border:1px solid var(--edge);border-radius:10px;padding:8px 12px;}',
      '.cmp-pick-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}',
      '.cmp-pick-name{font-weight:600;font-size:13.5px;}',
      '.cmp-add{min-height:32px;padding:5px 14px;}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  }

  // ── ontology (local mirror; files stay independently loadable) ───────────
  function kindOf(cap) {
    if (cap && (cap.kind === 'action' || cap.kind === 'job')) return cap.kind;
    return (cap && cap.source === 'pcc') ? 'job' : 'action';
  }

  /** inputs → outputs summary, from real fields only (no invented schemas). */
  function ioSummary(cap) {
    var params = (cap && cap.params) || {};
    var props = (params.properties && typeof params.properties === 'object') ? params.properties : {};
    var req = Array.isArray(params.required) ? params.required : [];
    var names = Object.keys(props);
    var inputs = names.length
      ? names.map(function (n) { return n + (req.indexOf(n) >= 0 ? '*' : ''); }).join(', ')
      : 'none';
    var outputs;
    if (kindOf(cap) === 'job') outputs = 'job handle (evidence → settlement)';
    else if (cap && cap.ui && cap.ui.hint) outputs = 'result (' + String(cap.ui.hint) + ')';
    else outputs = 'result (undeclared shape)';
    return { inputs: inputs, outputs: outputs };
  }

  function argsPlaceholder(cap) {
    var params = (cap && cap.params) || {};
    var req = Array.isArray(params.required) ? params.required : [];
    var props = (params.properties && typeof params.properties === 'object') ? params.properties : {};
    if (!Object.keys(props).length) return '{ } — this capability takes no parameters';
    return req.length
      ? '{ … } — required: ' + req.join(', ')
      : '{ … } — all parameters optional';
  }

  // ── plan state (module-scoped: survives region rebuilds) ─────────────────
  var steps = [];          // { uid, cap, argsText, status, note, threadId }
  var running = false;
  var stopRequested = false;
  var planNote = '';
  var pickerQuery = '';
  var uidSeq = 0;
  var threadSeq = 0; // guarantees distinct threadIds per step, whatever CP.uuid yields

  var ST_PILL = {
    pending: '',
    running: 'st-running',
    'waiting-approval': 'st-pending',
    done: 'st-done',
    error: 'st-failed',
    denied: 'st-failed',
    skipped: 'st-skipped'
  };

  function findStep(uid) {
    for (var i = 0; i < steps.length; i++) if (steps[i].uid === uid) return i;
    return -1;
  }

  function addStep(cap) {
    if (!cap || !cap.id) return null;
    var step = {
      uid: 's' + (++uidSeq),
      cap: cap,
      argsText: '',
      status: 'pending',
      note: '',
      threadId: null
    };
    steps.push(step);
    if (cap.economic && cap.economic.price) {
      bus.emit('economic:seen', { capId: cap.id, via: 'compose' });
    }
    renderAll();
    return step;
  }

  function removeStep(uid) {
    if (running) return;
    var i = findStep(uid);
    if (i === -1) return;
    steps.splice(i, 1);
    renderAll();
  }

  function moveStep(uid, delta) {
    if (running) return;
    var i = findStep(uid);
    var j = i + (delta < 0 ? -1 : 1);
    if (i === -1 || j < 0 || j >= steps.length) return;
    var tmp = steps[i];
    steps[i] = steps[j];
    steps[j] = tmp;
    renderAll();
  }

  function clearPlan() {
    if (running) return;
    steps = [];
    planNote = '';
    renderAll();
  }

  // ── the sequential runner ─────────────────────────────────────────────────
  function parseArgs(step) {
    var t = String(step.argsText == null ? '' : step.argsText).trim();
    if (!t) return {};
    var v = JSON.parse(t); // syntax errors propagate to the caller
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      throw new Error('args must be a JSON object');
    }
    return v;
  }

  function setStep(step, status, note) {
    step.status = status;
    step.note = note || '';
    renderAll();
  }

  /**
   * Run one step. Resolves 'done' | 'error' | 'denied'. Status transitions
   * come from observed events only:
   *   - bus 'run:event' scoped to this step's threadId (the shell emits one
   *     per parsed AG-UI event — including the resumed stream after an
   *     approval, which reuses the same threadId),
   *   - bus 'interrupt:resolved' for interrupts this step raised.
   */
  function runStep(step) {
    return new Promise(function (resolve) {
      var args;
      try { args = parseArgs(step); }
      catch (e) {
        setStep(step, 'error', 'args: ' + String(e && e.message || e));
        resolve('error');
        return;
      }
      if (!CP.api || typeof CP.api.runCapability !== 'function') {
        setStep(step, 'error', 'run path unavailable (no CP.api.runCapability)');
        resolve('error');
        return;
      }
      if (step.cap.__demo) {
        setStep(step, 'error', 'sample capability — connect to a server to run it');
        resolve('error');
        return;
      }

      var threadId = 't-plan-' + uuid8() + '-' + (++threadSeq);
      step.threadId = threadId;
      var tracker = null;
      if (typeof CP.trackRun === 'function') {
        try { tracker = CP.trackRun(step.cap, threadId); } catch (e) { tracker = null; }
      }

      var settled = false;
      var pendingInterrupts = {};
      var pendingCount = 0;
      var offRun = bus.on('run:event', onRunEvent) || function () {};
      var offRes = bus.on('interrupt:resolved', onResolved) || function () {};

      function settle(outcome) {
        if (settled) return;
        settled = true;
        try { offRun(); } catch (e) { /* off is best-effort */ }
        try { offRes(); } catch (e) { /* off is best-effort */ }
        resolve(outcome);
      }

      function onRunEvent(p) {
        if (!p || p.threadId !== threadId) return;
        var ev = p.event || {};
        if (ev.type === 'RUN_ERROR') {
          setStep(step, 'error', String(ev.message || 'run error'));
          settle('error');
          return;
        }
        if (ev.type !== 'RUN_FINISHED') return;
        if (ev.outcome && ev.outcome.type === 'interrupt') {
          (ev.outcome.interrupts || []).forEach(function (intr) {
            if (!intr) return;
            var id = intr.id;
            if (typeof CP.addInterrupt === 'function') {
              var item = CP.addInterrupt(intr, threadId, step.cap);
              if (item && tracker) item.tracker = tracker;
              if (item && item.id) id = item.id;
            }
            if (id && !pendingInterrupts[id]) {
              pendingInterrupts[id] = true;
              pendingCount++;
            }
          });
          setStep(step, 'waiting-approval', 'paused — approve or deny in Approvals; the plan waits here');
        } else {
          setStep(step, 'done', '');
          settle('done');
        }
      }

      function onResolved(p) {
        if (!p || !p.id || !pendingInterrupts[p.id]) return;
        delete pendingInterrupts[p.id];
        pendingCount--;
        if (p.expired) {
          setStep(step, 'denied', 'approval expired');
          settle('denied');
          return;
        }
        if (!p.approved) {
          setStep(step, 'denied', 'denied in Approvals');
          settle('denied');
          return;
        }
        if (pendingCount <= 0) {
          setStep(step, 'running', 'approved — waiting for the resumed run to finish');
        }
        // The resumed stream re-enters onRunEvent under the same threadId;
        // its RUN_FINISHED (or a follow-up interrupt) decides what happens.
      }

      setStep(step, 'running', '');
      CP.api.runCapability({
        id: step.cap.id,
        args: args,
        threadId: threadId,
        onEvent: function (ev) {
          if (tracker) { try { tracker.event(ev); } catch (e) { /* card render hiccup — runner unaffected */ } }
        }
      }).then(function () {
        // Stream closed. A normal finish already settled via RUN_FINISHED;
        // open interrupts legitimately keep the plan waiting (the resume
        // arrives on a NEW stream). Anything else is a dead stream — say so.
        if (!settled && pendingCount <= 0) {
          setStep(step, 'error', 'stream closed without RUN_FINISHED');
          settle('error');
        }
      }, function (err) {
        if (!settled) {
          setStep(step, 'error', 'dispatch failed: ' + String(err && err.message || err));
          settle('error');
        }
      });
    });
  }

  function markPendingSkipped(fromIdx, why) {
    for (var j = fromIdx; j < steps.length; j++) {
      if (steps[j].status === 'pending') {
        steps[j].status = 'skipped';
        steps[j].note = why;
      }
    }
  }

  function runPlan() {
    if (running || !steps.length) return;
    running = true;
    stopRequested = false;
    planNote = '';
    steps.forEach(function (s) { s.status = 'pending'; s.note = ''; s.threadId = null; });
    renderAll();

    var i = 0;
    function finish(msg) {
      running = false;
      planNote = msg;
      renderAll();
    }
    function next() {
      if (stopRequested) {
        markPendingSkipped(i, 'plan stopped');
        finish('stopped — remaining steps skipped');
        return;
      }
      if (i >= steps.length) {
        finish('plan complete — all ' + steps.length + ' step' + (steps.length === 1 ? '' : 's') + ' finished');
        return;
      }
      var step = steps[i];
      i++;
      runStep(step).then(function (outcome) {
        if (outcome === 'done') { next(); return; }
        markPendingSkipped(i, 'a previous step ' + (outcome === 'denied' ? 'was denied' : 'failed'));
        finish('stopped at step ' + i + ' (' + outcome + ')');
      });
    }
    next();
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  function buildStepCard(s, idx) {
    var card = el('article', 'panel cmp-step');

    var head = el('div', 'panel-h');
    head.appendChild(el('span', 'cmp-idx', String(idx + 1)));
    head.appendChild(el('span', 'cmp-name', s.cap.name || s.cap.id));
    var badges = el('span', 'cap-badges');
    if (CP.render && CP.render.trustBadge) badges.appendChild(CP.render.trustBadge(s.cap.trustLevel));
    if (s.cap.economic && s.cap.economic.price) {
      var p = s.cap.economic.price;
      var ptxt = ((p.base != null ? String(p.base) : '') + (p.currency ? ' ' + p.currency : '')).trim();
      badges.appendChild(el('span', 'badge econ', ptxt || 'priced'));
    }
    head.appendChild(badges);
    head.appendChild(el('span', 'pill ' + (ST_PILL[s.status] || ''), s.status));
    var tools = el('span', 'cmp-tools');
    [
      ['▲', 'Move up', function () { moveStep(s.uid, -1); }, idx === 0],
      ['▼', 'Move down', function () { moveStep(s.uid, 1); }, idx === steps.length - 1],
      ['✕', 'Remove step', function () { removeStep(s.uid); }, false]
    ].forEach(function (t) {
      var b = el('button', 'cmp-tool', t[0]);
      b.type = 'button';
      b.title = t[1];
      b.setAttribute('aria-label', t[1]);
      b.disabled = running || t[3];
      b.onclick = t[2];
      tools.appendChild(b);
    });
    head.appendChild(tools);
    card.appendChild(head);

    var bodyd = el('div', 'pipe-body');
    var io = ioSummary(s.cap);
    var rowIn = el('div', 'pipe-row');
    rowIn.appendChild(el('span', 'k', 'inputs'));
    rowIn.appendChild(el('span', 'v', io.inputs));
    bodyd.appendChild(rowIn);
    var rowOut = el('div', 'pipe-row');
    rowOut.appendChild(el('span', 'k', 'outputs'));
    rowOut.appendChild(el('span', 'v', io.outputs));
    bodyd.appendChild(rowOut);
    if (s.note) {
      bodyd.appendChild(el('p',
        (s.status === 'error' || s.status === 'denied') ? 'err-txt' : 'muted small',
        s.note));
    }

    var edit = el('details', 'intr-edit');
    edit.appendChild(el('summary', null, 'Args (JSON object — empty = {})'));
    var ta = el('textarea', 'intr-args');
    ta.value = s.argsText;
    ta.placeholder = argsPlaceholder(s.cap);
    ta.disabled = running;
    ta.oninput = function () { s.argsText = ta.value; }; // state only — keeps focus
    edit.appendChild(ta);
    bodyd.appendChild(edit);
    card.appendChild(bodyd);
    return card;
  }

  function searchCaps(q) {
    var cat = CP.catalog;
    if (cat && typeof cat.match === 'function') return cat.match(q, 8) || [];
    var all = (cat && typeof cat.all === 'function' && cat.all()) || [];
    var t = String(q || '').toLowerCase();
    if (!t) return [];
    return all.filter(function (c) {
      return String(c.name || '').toLowerCase().indexOf(t) >= 0 ||
        String(c.id || '').toLowerCase().indexOf(t) >= 0 ||
        String(c.description || '').toLowerCase().indexOf(t) >= 0;
    }).slice(0, 8);
  }

  function renderPicker(host) {
    clear(host);
    var query = String(pickerQuery || '').trim();
    if (!query) {
      var total = (CP.catalog && typeof CP.catalog.all === 'function')
        ? (CP.catalog.all() || []).length : 0;
      host.appendChild(el('p', 'muted small', total
        ? 'Type to search ' + total + ' capabilities.'
        : 'No capabilities available yet — the picker needs the catalog (connect a server or wait for it to warm up).'));
      return;
    }
    var hits = searchCaps(query);
    if (!hits.length) {
      host.appendChild(el('p', 'muted small', 'No capability matches "' + query + '".'));
      return;
    }
    hits.forEach(function (cap) {
      var row = el('div', 'cmp-pick-row');
      var meta = el('span', 'cmp-pick-meta');
      meta.appendChild(el('span', 'cmp-pick-name', cap.name || cap.id));
      var badges = el('span', 'cap-badges');
      if (CP.render && CP.render.trustBadge) badges.appendChild(CP.render.trustBadge(cap.trustLevel));
      if (cap.economic && cap.economic.price) badges.appendChild(el('span', 'badge econ', 'priced'));
      if (cap.__demo) badges.appendChild(el('span', 'badge demo-b', 'sample'));
      meta.appendChild(badges);
      row.appendChild(meta);
      var add = el('button', 'btn cmp-add', 'Add');
      add.type = 'button';
      if (cap.__demo) {
        add.disabled = true;
        add.title = 'Sample capability — connect to a server to compose it';
      } else if (running) {
        add.disabled = true;
        add.title = 'Plan is running';
      } else {
        add.onclick = function () { addStep(cap); };
      }
      row.appendChild(add);
      host.appendChild(row);
    });
  }

  function buildPicker() {
    var panel = el('div', 'panel');
    panel.appendChild(el('div', 'panel-h', 'Add a step — search the catalog'));
    var pb = el('div', 'pipe-body');
    var input = el('input', 'cat-search');
    input.type = 'search';
    input.placeholder = 'e.g. "code index", "pizza", "route a task"…';
    input.value = pickerQuery;
    input.setAttribute('aria-label', 'Search capabilities to add');
    var results = el('div', 'cmp-picker-results');
    input.oninput = function () { pickerQuery = input.value; renderPicker(results); };
    pb.appendChild(input);
    pb.appendChild(results);
    renderPicker(results);
    panel.appendChild(pb);
    return panel;
  }

  function renderAll() {
    var body = CP.regionBody ? CP.regionBody('compose') : null;
    if (!body) return;
    ensureStyles();
    clear(body);

    body.appendChild(el('p', 'muted',
      'Chain capabilities into an ordered plan. Steps dispatch one at a time through the same ' +
      'run path single capabilities use — watch them settle in Activity. No server-side DAG yet: ' +
      'sequencing is client-driven, and outputs are not auto-wired into the next step\'s inputs.'));

    // Chain strip — the plan at a glance, status-colored.
    var chainPanel = el('div', 'panel');
    chainPanel.appendChild(el('div', 'panel-h',
      'Plan — ' + steps.length + ' step' + (steps.length === 1 ? '' : 's')));
    var chain = el('div', 'cmp-chain');
    chain.id = 'cp-cmp-chain';
    if (!steps.length) {
      chain.appendChild(el('p', 'muted', 'No steps yet — add capabilities below.'));
    }
    steps.forEach(function (s, idx) {
      if (idx > 0) chain.appendChild(el('span', 'cmp-arrow', '→'));
      var chip = el('span', 'pill cmp-chip ' + (ST_PILL[s.status] || ''),
        (idx + 1) + ' · ' + (s.cap.name || s.cap.id));
      chip.title = s.status + (s.note ? ' — ' + s.note : '');
      chain.appendChild(chip);
    });
    chainPanel.appendChild(chain);
    body.appendChild(chainPanel);

    // Step editor.
    if (steps.length) {
      var list = el('div', 'cmp-steps');
      steps.forEach(function (s, idx) { list.appendChild(buildStepCard(s, idx)); });
      body.appendChild(list);
    }

    // Run controls.
    var acts = el('div', 'actions');
    var run = el('button', 'btn primary', running ? 'Running…' : 'Run plan');
    run.type = 'button';
    run.disabled = running || !steps.length;
    run.onclick = runPlan;
    acts.appendChild(run);
    if (running) {
      var stop = el('button', 'btn deny', 'Stop plan');
      stop.type = 'button';
      stop.disabled = stopRequested;
      stop.onclick = function () {
        stopRequested = true;
        planNote = 'stopping — the in-flight step finishes (or waits in Approvals); nothing further dispatches';
        renderAll();
      };
      acts.appendChild(stop);
    } else if (steps.length) {
      var cl = el('button', 'btn ghost', 'Clear plan');
      cl.type = 'button';
      cl.onclick = clearPlan;
      acts.appendChild(cl);
    }
    body.appendChild(acts);

    if (planNote) body.appendChild(el('p', 'muted small', planNote));
    var priced = steps.filter(function (s) { return s.cap.economic && s.cap.economic.price; }).length;
    if (priced) {
      body.appendChild(el('p', 'muted small',
        priced + ' priced step' + (priced === 1 ? '' : 's') +
        ' — spend approvals pause in Approvals; settlement shows in the Ledger.'));
    }

    // The pipeline visualizer link the thin builder offered — still real.
    if (typeof location !== 'undefined' && location.protocol !== 'file:') {
      var a = el('a', 'ghost-link', 'Open the pipeline visualizer (/viz)');
      a.href = (CP.api && CP.api.base ? CP.api.base() : '') + '/viz';
      a.target = '_blank';
      a.rel = 'noopener';
      body.appendChild(a);
    }

    body.appendChild(buildPicker());
  }

  // ── the region builder ────────────────────────────────────────────────────
  function buildCompose() { renderAll(); }

  (CP.regionBuilders = CP.regionBuilders || {}).compose = buildCompose;

  // The catalog answering (or growing) changes what the picker can offer.
  bus.on('registry:grew', function () { if (!running) renderAll(); });

  // Late-load edge (shell booted before this file): rebuild with ours.
  try {
    if (CP.rebuildRegion && CP.expand && CP.expand.isRevealed && CP.expand.isRevealed('compose')) {
      var rb = CP.regionBody && CP.regionBody('compose');
      if (rb && rb.childNodes.length) CP.rebuildRegion('compose');
    }
  } catch (e) { /* boot not far enough — the normal path builds us */ }

  // Exposed for headless tests (read/drive surface, mirrors CP._approvals).
  CP._compose = {
    steps: function () { return steps.slice(); },
    addStep: addStep,
    removeStep: removeStep,
    moveStep: moveStep,
    clearPlan: clearPlan,
    runPlan: runPlan,
    ioSummary: ioSummary,
    kindOf: kindOf,
    isRunning: function () { return running; },
    planNote: function () { return planNote; }
  };
})();
