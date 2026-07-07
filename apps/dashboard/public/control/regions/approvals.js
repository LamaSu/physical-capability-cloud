/* @harness/control-plane — regions/approvals.js  (B3 wave 1)
 *
 * Upgraded Approvals region: the persona-routed interrupt inbox — ONE union
 * view over two sources (UI-COORDINATION.md §9.1 contract #1):
 *
 *   a. AG-UI interrupts raised by runs through this shell
 *      (RUN_FINISHED{outcome:interrupt} → CP.addInterrupt, overridden here).
 *   b. Durable backend queue items from the autonomous-org backend, polled
 *      from GET {base}/api/org/approvals (fallback GET {base}/org/approvals)
 *      and mapped through queueItemToInterrupt — a browser mirror of
 *      lib/genui/contracts.js#queueItemToInterrupt (that file is CommonJS
 *      and cannot load in the browser; the mirror is verified byte-identical
 *      by regions/tests/run-tests.js against the real module). Resolving one
 *      POSTs {base}{orgPath}/:id/resolve {approved[, editedArgs]}.
 *
 * Persona routing (UNIFIED-CONTROL-PLANE.md Part 5 — interrupts become
 * addressable): spend / milestone approvals → User; evidence / dispute →
 * Operator; exec / credential / pipeline gates → Orchestrator. Org queue
 * items carry an explicit `lens` (via metadata.lens) which wins outright.
 * One person can wear all three lenses — groups reorder to put the active
 * lens first; nothing is hidden.
 *
 * Approve / deny / edit-args:
 *   - AG-UI items → CP.api.resume (editedArgs = FULL REPLACEMENT, never a
 *     merge — agui-hitl.js contract), resumed-run events route back into the
 *     owning run card + follow-up interrupts via CP.routeRunEvent.
 *   - Org items  → POST resolve on the backend queue; failure is reported,
 *     never faked.
 *
 * Reveal-on-use: expand.js reveals 'approvals' + badges on 'interrupt:new';
 * this region emits that for BOTH sources. 'interrupt:resolved' decrements
 * (also emitted with {expired:true} when a TTL lapses).
 *
 * Registration: CP.regionBuilders.approvals (the B3 shell hook). Loads after
 * shell.js, before boot. Hygiene: textContent only — no innerHTML.
 */
(function () {
  'use strict';

  var CP = window.CP = window.CP || {};
  if (!CP.bus || !CP.api) return;
  var bus = CP.bus;
  var el = CP.el || function (tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  };
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ── region-local styles ───────────────────────────────────────────────────
  var STYLE_ID = 'cp-approvals-styles';
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.appr-group{margin:0 0 16px;}',
      '.appr-group-h{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);',
      ' text-transform:uppercase;letter-spacing:.7px;margin:0 0 8px;}',
      '.appr-group.lens-active .appr-group-h{color:var(--accent);}',
      '.appr-group-h .nav-badge{background:var(--amber);color:#1a1305;}',
      '.appr-list{display:grid;gap:10px;}',
      '.appr-empty{color:var(--muted);font-size:12.5px;margin:0;}',
      '.intr-card.expired{border-color:var(--edge);opacity:.6;}',
      '.intr-ttl{font-size:11.5px;font-family:var(--mono);color:var(--amber);margin:4px 0 0;}',
      '.intr-ttl.gone{color:var(--red);}',
      '.appr-src{font-size:10.5px;font-family:var(--mono);padding:1px 7px;border-radius:16px;',
      ' border:1px dashed var(--edge);color:var(--muted);white-space:nowrap;}',
      '.appr-conn{margin:0 0 12px;font-size:12px;color:var(--muted);}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  }

  // ── contracts.js#queueItemToInterrupt — browser mirror (parity-tested) ────
  var DEFAULT_APPROVE_SCHEMA = {
    type: 'object',
    properties: { approved: { type: 'boolean' }, editedArgs: { type: 'object' } },
    required: ['approved']
  };
  function queueItemToInterrupt(item) {
    return {
      id: item.id,
      reason: item.kind === 'approval' ? 'org:approval' : ('org:' + item.kind),
      message: item.title || item.reason || 'Approval required',
      responseSchema: item.responseSchema || DEFAULT_APPROVE_SCHEMA,
      expiresAt: item.expiresAt,
      metadata: {
        capabilityId: item.capabilityId,
        args: item.args,
        lens: item.lens,
        authorityClass: item.authorityClass,
        origin: item.origin,
        source: 'org-queue'
      }
    };
  }

  // ── persona routing (Part 5) ──────────────────────────────────────────────
  var PERSONAS = [
    { id: 'user',         title: 'User — spend & orders' },
    { id: 'operator',     title: 'Operator — evidence & disputes' },
    { id: 'orchestrator', title: 'Orchestrator — exec, credential & pipeline gates' }
  ];

  function routePersona(intr, cap) {
    var m = (intr && intr.metadata) || {};
    if (m.lens === 'user' || m.lens === 'operator' || m.lens === 'orchestrator') return m.lens;
    var reason = String((intr && intr.reason) || '');
    if (/evidence|dispute/i.test(reason) || /evidence|dispute/i.test(String(m.reason || ''))) return 'operator';
    if (reason === 'pcc:milestone-approval') return 'user';               // milestone release = spend
    if (cap && cap.economic && cap.economic.price) return 'user';         // priced capability = spend approval
    if (m.authorityClass === 'observe') return 'user';
    var trust = m.trustLevel || (cap && cap.trustLevel) || '';
    if (trust === 'exec' || trust === 'credential') return 'orchestrator';
    if (m.authorityClass === 'privileged' || m.authorityClass === 'actuate') return 'orchestrator';
    return 'orchestrator';                                                // approval authority = catch-all
  }

  // ── module state ──────────────────────────────────────────────────────────
  var items = [];      // {id, persona, kind:'agui'|'org', intr, threadId?, cap?, resolved, expired, node, tracker?}
  var byId = {};
  var org = { path: null, connected: false, pending: 0, lastError: null, timer: null };
  var ttlTimer = null;

  function findItem(id) { return byId[id] || null; }

  // ── TTL countdown (one shared ticker, runs only while needed) ────────────
  function fmtLeft(ms) {
    if (ms <= 0) return 'expired';
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    if (m >= 60) return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
    return m + ':' + String(s % 60).replace(/^(\d)$/, '0$1');
  }
  function tickTTL() {
    var live = false;
    items.forEach(function (it) {
      if (it.resolved || it.expired || !it.ttlEl || !it.expiresAt) return;
      var left = new Date(it.expiresAt).getTime() - Date.now();
      if (isNaN(left)) { it.ttlEl.textContent = ''; return; }
      if (left <= 0) {
        it.expired = true;
        it.ttlEl.textContent = 'expired';
        it.ttlEl.classList.add('gone');
        if (it.node) it.node.classList.add('expired');
        setButtons(it, true);
        bus.emit('interrupt:resolved', { id: it.id, approved: false, expired: true });
        return;
      }
      live = true;
      it.ttlEl.textContent = 'expires in ' + fmtLeft(left);
    });
    if (!live && ttlTimer) { clearInterval(ttlTimer); ttlTimer = null; }
  }
  function armTTL() {
    if (ttlTimer) return;
    ttlTimer = setInterval(tickTTL, 1000);
    tickTTL();
  }

  function setButtons(it, disabled) {
    if (it.okBtn) it.okBtn.disabled = disabled;
    if (it.noBtn) it.noBtn.disabled = disabled;
  }

  // ── card ──────────────────────────────────────────────────────────────────
  function buildCard(it) {
    var intr = it.intr;
    var cap = it.cap;
    var card = el('article', 'intr-card');
    card.setAttribute('data-intr-id', it.id);

    var head = el('div', 'run-head');
    var title = (cap && (cap.name || cap.id)) ||
      (intr.metadata && intr.metadata.capabilityId) || 'Approval required';
    head.appendChild(el('span', 'run-name', String(title)));
    var badges = el('span', 'cap-badges');
    if (CP.render && CP.render.trustBadge) {
      var trust = (intr.metadata && intr.metadata.trustLevel) || (cap && cap.trustLevel);
      if (trust) badges.appendChild(CP.render.trustBadge(trust));
    }
    badges.appendChild(el('span', 'appr-src', it.kind === 'org' ? 'org queue' : 'run'));
    if (intr.reason) badges.appendChild(el('span', 'appr-src', String(intr.reason)));
    head.appendChild(badges);
    card.appendChild(head);

    card.appendChild(el('p', 'intr-msg', String(intr.message || 'This action is gated and needs your approval.')));

    if (intr.metadata && Object.keys(intr.metadata).length) {
      var pre = el('pre', 'intr-meta');
      try { pre.textContent = JSON.stringify(intr.metadata, null, 2); } catch (e) { pre.textContent = ''; }
      card.appendChild(pre);
    }

    if (intr.expiresAt) {
      it.expiresAt = intr.expiresAt;
      it.ttlEl = el('p', 'intr-ttl', '');
      card.appendChild(it.ttlEl);
      armTTL();
    }

    var edit = el('details', 'intr-edit');
    edit.appendChild(el('summary', null, 'Edit args before approving (full replacement, optional)'));
    var ta = el('textarea', 'intr-args');
    var origArgs = intr.metadata && intr.metadata.args;
    if (origArgs && typeof origArgs === 'object') {
      try { ta.value = JSON.stringify(origArgs, null, 2); } catch (e) { /* leave blank */ }
    }
    ta.placeholder = '{ } — full replacement, not a merge';
    edit.appendChild(ta);
    card.appendChild(edit);

    var errEl = el('p', 'err-txt', '');
    var acts = el('div', 'actions');
    var ok = el('button', 'btn primary', 'Approve');
    var no = el('button', 'btn deny', 'Deny');
    ok.type = no.type = 'button';
    acts.appendChild(ok); acts.appendChild(no);
    card.appendChild(acts);
    card.appendChild(errEl);
    it.okBtn = ok; it.noBtn = no; it.errEl = errEl; it.argsEl = ta; it.actsEl = acts;

    ok.onclick = function () { resolveItem(it, true); };
    no.onclick = function () { resolveItem(it, false); };

    it.node = card;
    return card;
  }

  function collectEdited(it, approved) {
    if (!approved || !it.argsEl) return { payload: { approved: approved } };
    var t = String(it.argsEl.value == null ? '' : it.argsEl.value).trim();
    if (!t) return { payload: { approved: approved } };
    var parsed;
    try { parsed = JSON.parse(t); }
    catch (e) { return { error: 'Edited args are not valid JSON: ' + String(e.message || e) }; }
    var orig = it.intr.metadata && it.intr.metadata.args;
    var payload = { approved: approved };
    try {
      if (!orig || JSON.stringify(parsed) !== JSON.stringify(orig)) payload.editedArgs = parsed;
    } catch (e) { payload.editedArgs = parsed; }
    return { payload: payload };
  }

  function markResolved(it, approved, note) {
    if (it.resolved) return;
    it.resolved = true;
    setButtons(it, true);
    if (it.node) it.node.classList.add('resolved');
    if (it.actsEl) it.actsEl.appendChild(el('span', 'muted', note || (approved ? ' approved' : ' denied')));
  }

  function resolveItem(it, approved) {
    if (it.resolved || it.expired) return;
    if (it.errEl) it.errEl.textContent = '';
    var got = collectEdited(it, approved);
    if (got.error) { it.errEl.textContent = got.error; return; }
    setButtons(it, true);

    if (it.kind === 'org') {
      var url = CP.api.base() + org.path + '/' + encodeURIComponent(it.id) + '/resolve';
      var body = { approved: approved };
      if (got.payload.editedArgs) body.editedArgs = got.payload.editedArgs;
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        markResolved(it, approved);
        bus.emit('interrupt:resolved', { id: it.id, approved: approved, source: 'org-queue' });
      }).catch(function (err) {
        setButtons(it, false);
        if (it.errEl) it.errEl.textContent = 'Backend resolve failed: ' + String(err && err.message || err);
      });
      return;
    }

    // AG-UI interrupt → resume run (editedArgs = full replacement)
    var tracker = it.tracker;
    CP.api.resume({
      threadId: it.threadId,
      interruptId: it.intr.id,
      approved: approved,
      payload: got.payload,
      onEvent: function (ev) {
        if (tracker) tracker.event(ev);
        if (CP.routeRunEvent) CP.routeRunEvent(ev, it.threadId, it.cap);
      }
    }).then(function () {
      markResolved(it, approved);
      bus.emit('interrupt:resolved', { id: it.id, approved: approved });
    }, function (err) {
      setButtons(it, false);
      if (it.errEl) it.errEl.textContent = 'Resume failed: ' + String(err && err.message || err);
    });
  }

  // ── placement into persona groups ─────────────────────────────────────────
  function groupList(persona) {
    var sec = document.querySelector('.appr-group[data-persona="' + persona + '"]');
    return sec ? sec.querySelector('.appr-list') : null;
  }

  function placeItem(it) {
    var list = groupList(it.persona);
    if (!list) return; // region not built yet — buildApprovals adopts everything
    var empty = list.querySelector('p.appr-empty');
    if (empty) list.removeChild(empty);
    list.insertBefore(it.node, list.firstChild);
    refreshGroupCounts();
  }

  function refreshGroupCounts() {
    PERSONAS.forEach(function (p) {
      var sec = document.querySelector('.appr-group[data-persona="' + p.id + '"]');
      if (!sec) return;
      var n = items.filter(function (it) { return it.persona === p.id && !it.resolved && !it.expired; }).length;
      var b = sec.querySelector('.nav-badge');
      if (b) { b.textContent = String(n); b.hidden = n === 0; }
      var list = sec.querySelector('.appr-list');
      if (list && !list.childNodes.length) {
        list.appendChild(el('p', 'appr-empty', 'Nothing waiting for this persona.'));
      }
    });
  }

  function addItem(it) {
    items.unshift(it);
    byId[it.id] = it;
    if (CP.state && CP.state.interrupts) CP.state.interrupts.unshift(it); // shell-state compat
    buildCard(it);
    placeItem(it);
    bus.emit('interrupt:new', { id: it.id, capId: it.cap && it.cap.id, persona: it.persona, source: it.kind });
    return it;
  }

  // ── CP.addInterrupt override (the shell/catalog entry point) ─────────────
  CP.addInterrupt = function (intr, threadId, cap) {
    if (!intr) return null;
    var id = intr.id || ('intr-' + (CP.uuid ? CP.uuid().slice(0, 8) : Math.random().toString(36).slice(2, 10)));
    if (byId[id] && !byId[id].resolved) return byId[id]; // dedupe re-raised interrupts
    ensureStyles();
    var it = {
      id: id,
      persona: routePersona(intr, cap),
      kind: 'agui',
      intr: intr,
      threadId: threadId,
      cap: cap,
      resolved: false,
      expired: false
    };
    return addItem(it);
  };

  // Cross-surface resolution (e.g. the inline interrupt card in an Activity
  // run feed posted the resume): reflect it here instead of double-resolving.
  bus.on('interrupt:resolved', function (p) {
    if (!p || !p.id) return;
    var it = findItem(p.id);
    if (!it || it.resolved) return;
    if (p.expired) { /* card already marked by tickTTL */ return; }
    markResolved(it, !!p.approved, p.via === 'activity-inline' ? ' resolved from the run card' : undefined);
  });

  // ── org durable queue (contract #1) ───────────────────────────────────────
  var ORG_LIST_PATHS = ['/api/org/approvals', '/org/approvals'];

  function parseQueuePayload(j) {
    if (Array.isArray(j)) return j;
    if (j && Array.isArray(j.items)) return j.items;
    if (j && Array.isArray(j.approvals)) return j.approvals;
    return null;
  }

  function orgFetch(path) {
    return fetch(CP.api.base() + path, { headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        var list = parseQueuePayload(j);
        if (!list) throw new Error('bad payload');
        return list;
      });
  }

  function orgSync() {
    if (document.hidden) return Promise.resolve();
    var paths = org.path ? [org.path] : ORG_LIST_PATHS;
    var i = 0;
    function tryNext() {
      if (i >= paths.length) {
        org.connected = false;
        renderConn();
        return Promise.resolve();
      }
      var p = paths[i++];
      return orgFetch(p).then(function (list) {
        org.path = p;
        org.connected = true;
        ingestQueue(list);
        renderConn();
      }, function () { return tryNext(); });
    }
    return tryNext();
  }

  function ingestQueue(list) {
    var seen = {};
    var pending = 0;
    list.forEach(function (q) {
      if (!q || !q.id) return;
      seen[q.id] = q.status || 'pending';
      if (q.status && q.status !== 'pending') return;
      pending++;
      var existing = findItem(q.id);
      if (existing) return;
      ensureStyles();
      var intr = queueItemToInterrupt(q);
      addItem({
        id: q.id,
        persona: routePersona(intr, null),
        kind: 'org',
        intr: intr,
        resolved: false,
        expired: false
      });
    });
    // items the backend resolved/cancelled elsewhere → reflect, fix badges
    items.forEach(function (it) {
      if (it.kind !== 'org' || it.resolved || it.expired) return;
      var st = seen[it.id];
      if (st && st !== 'pending') {
        markResolved(it, st === 'resolved', ' ' + st + ' (backend)');
        bus.emit('interrupt:resolved', { id: it.id, approved: st === 'resolved', source: 'org-queue' });
      }
    });
    org.pending = pending;
  }

  function renderConn() {
    var line = document.getElementById('cp-appr-conn');
    if (!line) return;
    line.textContent = org.connected
      ? ('Durable backend queue: connected (' + org.path + ')')
      : 'Durable backend queue: not connected — org-queue approvals appear here when the backend is up.';
  }

  function startOrgPolling() {
    if (org.timer) return;
    orgSync();
    org.timer = setInterval(orgSync, 45000);
  }

  // ── the region builder ────────────────────────────────────────────────────
  function personaOrder() {
    var active = (CP.lens && CP.lens.get()) || 'user';
    return PERSONAS.slice().sort(function (a, b) {
      return (a.id === active ? 0 : 1) - (b.id === active ? 0 : 1);
    });
  }

  function buildApprovals() {
    var body = CP.regionBody('approvals');
    if (!body) return;
    ensureStyles();
    clear(body);

    body.appendChild(el('p', 'muted',
      'Everything paused for a say-so, in one inbox: run interrupts from this shell and durable approvals ' +
      'from the org backend, routed to the persona they belong to.'));
    var conn = el('p', 'appr-conn', '');
    conn.id = 'cp-appr-conn';
    body.appendChild(conn);

    var groups = el('div', 'appr-groups');
    groups.id = 'cp-approvals';
    personaOrder().forEach(function (p) {
      var sec = el('section', 'appr-group' + (CP.lens && CP.lens.get() === p.id ? ' lens-active' : ''));
      sec.setAttribute('data-persona', p.id);
      var h = el('h3', 'appr-group-h', p.title);
      var badge = el('span', 'nav-badge', '0');
      badge.hidden = true;
      h.appendChild(badge);
      sec.appendChild(h);
      sec.appendChild(el('div', 'appr-list'));
      groups.appendChild(sec);
    });
    body.appendChild(groups);

    // adopt existing items (rebuild / late-load case)
    items.slice().reverse().forEach(function (it) {
      if (it.node) placeItem(it);
    });
    refreshGroupCounts();
    renderConn();
    startOrgPolling();
  }

  (CP.regionBuilders = CP.regionBuilders || {}).approvals = buildApprovals;

  // active-lens group floats to the top when the lens switches
  bus.on('lens:changed', function () {
    var groups = document.getElementById('cp-approvals');
    if (!groups) return;
    personaOrder().forEach(function (p) {
      var sec = groups.querySelector('.appr-group[data-persona="' + p.id + '"]');
      if (!sec) return;
      sec.classList.toggle('lens-active', (CP.lens && CP.lens.get()) === p.id);
      groups.appendChild(sec); // re-append in order
    });
  });

  // Late-load edge (shell booted before this file): rebuild with ours.
  try {
    if (CP.rebuildRegion && CP.expand && CP.expand.isRevealed('approvals')) {
      var rb = CP.regionBody && CP.regionBody('approvals');
      if (rb && rb.childNodes.length) CP.rebuildRegion('approvals');
    }
  } catch (e) { /* normal path builds us */ }

  // Exposed for headless tests (read-only surface).
  CP._approvals = {
    queueItemToInterrupt: queueItemToInterrupt,
    routePersona: routePersona,
    items: function () { return items.slice(); },
    _ingestQueue: ingestQueue
  };
})();
