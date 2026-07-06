/* @harness/control-plane — catalog.js
 *
 * The federated capability browser over GET /api/capabilities (harness +
 * PCC sources through one registry, provenance visible). Rendered through
 * the B1.engine when mounted (CP.render.capabilityCard), builtin otherwise.
 *
 * Progressive disclosure: starts with a curated handful of starter
 * capabilities; "Show all N" reveals the rest. Filter by text / source /
 * trust. Lens-aware card emphasis. Polls the registry for growth so an
 * agent registering a new capability visibly grows the catalog
 * (bus: 'registry:grew').
 *
 * Offline (agent-package on first download, file:// preview): falls back
 * to clearly-labeled sample capabilities so the walkthrough still works;
 * Run is disabled until a server is connected.
 */
(function () {
  'use strict';

  var CP = window.CP = window.CP || {};
  var bus = CP.bus;

  var caps = [];          // full registry (serialized Capability objects)
  var online = false;
  var showAll = false;
  var filterText = '';
  var filterSource = '';  // '' | 'local' | 'network'
  var pollTimer = null;

  // Preferred starter set — safe, read-trust, demonstrative. Falls back to
  // "first few read-trust caps from diverse sources" when these ids are
  // absent (the registry is live and can change under us).
  var STARTER_IDS = [
    'cli:codesight-status',
    'cli:spark-check',
    'cli:coord-peers',
    'mcp:harness:route',
    'cli:codesight-search'
  ];
  var STARTER_COUNT = 5;

  // Sample pack for offline/demo mode — honestly labeled, never runnable.
  var DEMO_CAPS = [
    {
      id: 'cli:codesight-status', source: 'cli',
      sourceDetail: { owner: 'codesight', origin: '~/.local/bin/codesight' },
      name: 'CodeSight Status', description: 'Show indexed repositories and symbol counts from the local code-intelligence index.',
      params: { type: 'object', properties: {} },
      ui: { hint: 'card' }, trustLevel: 'read', sideEffects: false, __demo: true
    },
    {
      id: 'mcp:harness:route', source: 'mcp',
      sourceDetail: { owner: 'harness', origin: 'harness serve' },
      name: 'Route a Task', description: 'Given a task in plain language, return the best capability or skill to handle it.',
      params: { type: 'object', properties: { task: { type: 'string', description: 'What you want done' } }, required: ['task'] },
      ui: { hint: 'card' }, trustLevel: 'read', sideEffects: false, __demo: true
    },
    {
      id: 'cli:coord-peers', source: 'cli',
      sourceDetail: { owner: 'coord', origin: '~/.local/bin/coord' },
      name: 'Peer Sessions', description: 'List other active orchestrator sessions on this machine and what they are working on.',
      params: { type: 'object', properties: {} },
      ui: { hint: 'table' }, trustLevel: 'read', sideEffects: false, __demo: true
    },
    {
      id: 'pcc:dominos:pizza.order', source: 'pcc',
      sourceDetail: { owner: 'dominos-kernel', origin: 'https://capability.network' },
      name: 'Order a Pizza', description: 'A networked physical capability: priced, escrowed, and settled with a delivery receipt.',
      params: {
        type: 'object',
        properties: {
          size: { type: 'string', enum: ['small', 'medium', 'large'], description: 'Pizza size' },
          toppings: { type: 'array', description: 'Topping list (JSON array)' }
        },
        required: ['size']
      },
      ui: { hint: 'form' }, trustLevel: 'write', sideEffects: true,
      economic: { price: { model: 'flat', base: 18.99, currency: 'USD' }, provider: { id: 'store-7764' } },
      assurance: { offeredTiers: [0, 1], evidence: 'delivery photo' },
      __demo: true
    }
  ];

  // ── data ────────────────────────────────────────────────────────────────
  function fetchCaps() {
    return CP.api.getJSON('/api/capabilities').then(function (list) {
      if (!Array.isArray(list)) throw new Error('bad registry payload');
      online = true;
      return list;
    });
  }

  function init() {
    return fetchCaps().then(function (list) {
      caps = list;
      render();
      startPolling();
      return { caps: caps, online: true };
    }, function () {
      online = false;
      caps = DEMO_CAPS.slice();
      render();
      return { caps: caps, online: false };
    });
  }

  function refresh() {
    return fetchCaps().then(function (list) {
      caps = list;
      render();
      return caps;
    }, function () { return caps; });
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (document.hidden || !online) return;
      CP.api.getJSON('/api/capabilities').then(function (list) {
        if (Array.isArray(list) && list.length > caps.length) {
          var added = list.length - caps.length;
          caps = list;
          render();
          bus.emit('registry:grew', { added: added, total: list.length });
        } else if (Array.isArray(list)) {
          caps = list; // shrink/replace silently
        }
      }, function () { /* transient — keep last good list */ });
    }, 45000);
  }

  // ── matching (used by the Ask region too) ───────────────────────────────
  function score(cap, tokens) {
    var hay = {
      name: String(cap.name || '').toLowerCase(),
      id: String(cap.id || '').toLowerCase(),
      desc: String(cap.description || '').toLowerCase(),
      trig: (cap.triggers || []).join(' ').toLowerCase()
    };
    var s = 0;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (!t) continue;
      if (hay.name.indexOf(t) >= 0) s += 3;
      if (hay.id.indexOf(t) >= 0) s += 2;
      if (hay.trig.indexOf(t) >= 0) s += 2;
      if (hay.desc.indexOf(t) >= 0) s += 1;
    }
    return s;
  }

  function match(query, limit) {
    var tokens = String(query || '').toLowerCase().split(/[^a-z0-9.]+/).filter(function (t) { return t.length > 1; });
    if (!tokens.length) return [];
    var scored = caps.map(function (c) { return { c: c, s: score(c, tokens) }; })
      .filter(function (x) { return x.s > 0; })
      .sort(function (a, b) { return b.s - a.s; });
    return scored.slice(0, limit || 5).map(function (x) { return x.c; });
  }

  // ── curation ────────────────────────────────────────────────────────────
  function starters() {
    var picked = [];
    var seen = {};
    STARTER_IDS.forEach(function (id) {
      for (var i = 0; i < caps.length; i++) {
        if (caps[i].id === id && !seen[id]) { picked.push(caps[i]); seen[id] = 1; break; }
      }
    });
    if (picked.length < STARTER_COUNT) {
      // Diverse fill: read-trust first, rotate across sources.
      var bySource = {};
      caps.forEach(function (c) {
        if (seen[c.id]) return;
        (bySource[c.source] = bySource[c.source] || []).push(c);
      });
      Object.keys(bySource).forEach(function (s) {
        bySource[s].sort(function (a, b) {
          return (a.trustLevel === 'read' ? 0 : 1) - (b.trustLevel === 'read' ? 0 : 1);
        });
      });
      var sources = Object.keys(bySource);
      var si = 0;
      while (picked.length < STARTER_COUNT && sources.length) {
        var s2 = sources[si % sources.length];
        var c2 = bySource[s2].shift();
        if (c2) { picked.push(c2); seen[c2.id] = 1; }
        if (!bySource[s2].length) { sources.splice(si % sources.length, 1); } else { si++; }
      }
    }
    return picked;
  }

  function visibleCaps() {
    var base = showAll ? caps.slice() : starters();
    var t = filterText.toLowerCase();
    return base.filter(function (c) {
      if (filterSource === 'local' && (c.source === 'pcc' || c.source === 'a2a')) return false;
      if (filterSource === 'network' && !(c.source === 'pcc' || c.source === 'a2a')) return false;
      if (!t) return true;
      return score(c, t.split(/[^a-z0-9.]+/)) > 0;
    });
  }

  // ── rendering ───────────────────────────────────────────────────────────
  function render() {
    var body = CP.regionBody ? CP.regionBody('catalog') : null;
    if (!body) return;
    var elh = CP.el;
    while (body.firstChild) body.removeChild(body.firstChild);

    if (!online) {
      var note = elh('div', 'offline-note');
      note.appendChild(elh('strong', null, 'Offline — sample catalog. '));
      note.appendChild(elh('span', null, 'Connect to a control-plane server (⚙ in the header) to load the live registry and run things.'));
      body.appendChild(note);
    }

    // Controls: search + source filter + show-all toggle.
    var controls = elh('div', 'cat-controls');
    var search = elh('input', 'cat-search');
    search.type = 'search';
    search.placeholder = 'Filter…';
    search.value = filterText;
    search.setAttribute('aria-label', 'Filter capabilities');
    search.oninput = function () { filterText = search.value; renderGrid(); };
    controls.appendChild(search);

    [['', 'All'], ['local', 'Local'], ['network', 'Network']].forEach(function (pair) {
      var b = elh('button', 'seg' + (filterSource === pair[0] ? ' active' : ''), pair[1]);
      b.type = 'button';
      b.onclick = function () { filterSource = pair[0]; render(); };
      controls.appendChild(b);
    });
    body.appendChild(controls);

    var grid = elh('div', 'cat-grid');
    grid.id = 'cp-cat-grid';
    body.appendChild(grid);

    var footer = elh('div', 'cat-footer');
    footer.id = 'cp-cat-footer';
    body.appendChild(footer);

    renderGrid();
  }

  function renderGrid() {
    var grid = document.getElementById('cp-cat-grid');
    var footer = document.getElementById('cp-cat-footer');
    if (!grid || !footer) return;
    var elh = CP.el;
    while (grid.firstChild) grid.removeChild(grid.firstChild);
    while (footer.firstChild) footer.removeChild(footer.firstChild);

    var list = visibleCaps();
    if (!list.length) {
      grid.appendChild(elh('p', 'muted', 'Nothing matches that filter.'));
    }
    list.forEach(function (cap) {
      var card = CP.render.capabilityCard(cap, { lens: CP.lens.get() });
      card.addEventListener('click', function () { openDetail(cap); });
      card.addEventListener('keydown', function (ke) {
        if (ke.key === 'Enter' || ke.key === ' ') { ke.preventDefault(); openDetail(cap); }
      });
      grid.appendChild(card);
    });

    if (!showAll && caps.length > list.length) {
      var moreBtn = elh('button', 'btn ghost wide', 'Show all ' + caps.length + ' capabilities');
      moreBtn.type = 'button';
      moreBtn.onclick = function () {
        showAll = true;
        bus.emit('catalog:show-all', { total: caps.length });
        render();
      };
      footer.appendChild(moreBtn);
    } else if (showAll) {
      var lessBtn = elh('button', 'btn ghost wide', 'Show starters only');
      lessBtn.type = 'button';
      lessBtn.onclick = function () { showAll = false; render(); };
      footer.appendChild(lessBtn);
    }
  }

  // ── detail panel: generated view (schema → form → run → stream) ────────
  var detailHost = null;

  function closeDetail() {
    if (detailHost && detailHost.parentNode) detailHost.parentNode.removeChild(detailHost);
    detailHost = null;
    document.body.classList.remove('detail-open');
  }

  function openDetail(cap) {
    closeDetail();
    var elh = CP.el;
    document.body.classList.add('detail-open');

    var wrap = detailHost = elh('div', 'detail-wrap');
    var panel = elh('aside', 'detail');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', cap.name || cap.id);

    var head = elh('div', 'detail-head');
    var back = elh('button', 'btn ghost', '‹ Back');
    back.type = 'button';
    back.onclick = closeDetail;
    head.appendChild(back);
    var badges = elh('span', 'cap-badges');
    badges.appendChild(CP.render.trustBadge(cap.trustLevel));
    badges.appendChild(elh('span', 'badge src-' + ((cap.source === 'pcc' || cap.source === 'a2a') ? 'network' : 'local'), cap.source || 'local'));
    head.appendChild(badges);
    panel.appendChild(head);

    panel.appendChild(elh('h3', 'detail-title', cap.name || cap.id));
    panel.appendChild(elh('p', 'detail-desc', String(cap.description || '')));

    // Provenance — always visible (the federated-catalog rule).
    var prov = elh('div', 'prov');
    provRow(prov, 'id', cap.id);
    if (cap.sourceDetail) {
      provRow(prov, 'provider', cap.sourceDetail.owner || '');
      provRow(prov, 'origin', cap.sourceDetail.origin || '');
    }
    panel.appendChild(prov);

    // Economic / assurance bundles when present (the PCC face).
    if (cap.economic && cap.economic.price) {
      var eco = elh('div', 'prov econ-p');
      var p = cap.economic.price;
      provRow(eco, 'price', (p.base != null ? p.base : '?') + ' ' + (p.currency || '') + (p.unit ? ' / ' + p.unit : ''));
      if (cap.economic.provider) provRow(eco, 'paid to', cap.economic.provider.id || '');
      panel.appendChild(eco);
      bus.emit('economic:seen', { capId: cap.id });
    }
    if (cap.assurance) {
      var asr = elh('div', 'prov');
      if (cap.assurance.offeredTiers) provRow(asr, 'assurance', 'tier ' + cap.assurance.offeredTiers.join(', '));
      if (cap.assurance.evidence) provRow(asr, 'evidence', String(cap.assurance.evidence));
      panel.appendChild(asr);
    }

    // Params form, generated from the JSON schema.
    var form = elh('form', 'detail-form');
    var fields = buildForm(form, cap.params);
    panel.appendChild(form);

    var gated = cap.trustLevel && cap.trustLevel !== 'read';
    var runBtn = elh('button', 'btn primary wide', gated ? 'Run — will pause for approval' : 'Run');
    runBtn.type = 'submit';
    form.appendChild(runBtn);
    if (cap.__demo) {
      runBtn.disabled = true;
      form.appendChild(elh('p', 'muted small', 'Sample capability — connect to a server to run for real.'));
    }

    var result = elh('div', 'detail-result');
    panel.appendChild(result);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (cap.__demo) return;
      var args;
      try { args = collectForm(fields); }
      catch (err) {
        while (result.firstChild) result.removeChild(result.firstChild);
        result.appendChild(elh('p', 'err-txt', err.message));
        return;
      }
      runBtn.disabled = true;
      dispatch(cap, args, result, function () { runBtn.disabled = false; });
    });

    wrap.appendChild(panel);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) closeDetail(); });
    document.addEventListener('keydown', escClose);
    document.body.appendChild(wrap);
    bus.emit('cap:opened', { capId: cap.id, trust: cap.trustLevel });

    function escClose(e) {
      if (e.key === 'Escape') { closeDetail(); document.removeEventListener('keydown', escClose); }
    }
  }

  function provRow(host, k, v) {
    var elh = CP.el;
    var row = elh('div', 'prov-row');
    row.appendChild(elh('span', 'k', k));
    row.appendChild(elh('span', 'v', String(v)));
    host.appendChild(row);
  }

  /**
   * JSON-schema → form fields. string/enum → input/select, number/integer →
   * number input, boolean → checkbox, object/array → JSON textarea.
   * Returns descriptors for collectForm().
   */
  function buildForm(form, schema) {
    var elh = CP.el;
    var fields = [];
    var props = (schema && schema.properties) || {};
    var required = (schema && schema.required) || [];
    var names = Object.keys(props);
    if (!names.length) {
      form.appendChild(elh('p', 'muted small', 'No parameters.'));
      return fields;
    }
    names.forEach(function (name) {
      var spec = props[name] || {};
      var row = elh('label', 'field');
      var lbl = elh('span', 'field-lbl', name + (required.indexOf(name) >= 0 ? ' *' : ''));
      row.appendChild(lbl);
      if (spec.description) row.appendChild(elh('span', 'field-hint', spec.description));
      var input;
      if (Array.isArray(spec.enum) && spec.enum.length) {
        input = elh('select');
        if (required.indexOf(name) < 0) input.appendChild(elh('option', null, ''));
        spec.enum.forEach(function (v) {
          var o = elh('option', null, String(v));
          o.value = String(v);
          input.appendChild(o);
        });
      } else if (spec.type === 'boolean') {
        input = elh('input');
        input.type = 'checkbox';
        row.classList.add('field-check');
      } else if (spec.type === 'number' || spec.type === 'integer') {
        input = elh('input');
        input.type = 'number';
        if (spec.type === 'number') input.step = 'any';
      } else if (spec.type === 'object' || spec.type === 'array') {
        input = elh('textarea');
        input.placeholder = spec.type === 'array' ? '[ ]' : '{ }';
        input.rows = 3;
      } else {
        input = elh('input');
        input.type = 'text';
      }
      if (spec.default != null && input.type !== 'checkbox') input.value = String(spec.default);
      row.appendChild(input);
      form.appendChild(row);
      fields.push({ name: name, spec: spec, input: input, required: required.indexOf(name) >= 0 });
    });
    return fields;
  }

  function collectForm(fields) {
    var args = {};
    fields.forEach(function (f) {
      var v;
      var t = f.spec.type;
      if (t === 'boolean') {
        v = !!f.input.checked;
      } else if (t === 'number' || t === 'integer') {
        var raw = f.input.value.trim();
        if (raw === '') { if (f.required) throw new Error(f.name + ' is required'); return; }
        v = Number(raw);
        if (isNaN(v)) throw new Error(f.name + ' must be a number');
        if (t === 'integer') v = Math.round(v);
      } else if (t === 'object' || t === 'array') {
        var raw2 = f.input.value.trim();
        if (raw2 === '') { if (f.required) throw new Error(f.name + ' is required'); return; }
        try { v = JSON.parse(raw2); }
        catch (e) { throw new Error(f.name + ': invalid JSON'); }
      } else {
        v = f.input.value;
        if (v === '') { if (f.required) throw new Error(f.name + ' is required'); return; }
      }
      args[f.name] = v;
    });
    return args;
  }

  // ── dispatch: run the capability over AG-UI, mirror into Activity, and
  //    surface interrupts into Approvals ────────────────────────────────────
  function dispatch(cap, args, resultHost, done) {
    var elh = CP.el;
    while (resultHost.firstChild) resultHost.removeChild(resultHost.firstChild);
    var feed = elh('div', 'run-feed in-detail');
    resultHost.appendChild(feed);

    var threadId = 't-' + CP.uuid().slice(0, 8);
    var tracker = CP.trackRun(cap, threadId);

    CP.api.runCapability({
      id: cap.id,
      args: args,
      threadId: threadId,
      onEvent: function (ev) {
        tracker.event(ev);
        feed.appendChild(CP.render.event(ev));
        while (feed.childNodes.length > 30) feed.removeChild(feed.firstChild);
        feed.scrollTop = feed.scrollHeight;
        if (ev.type === 'RUN_FINISHED' && ev.outcome && ev.outcome.type === 'interrupt') {
          (ev.outcome.interrupts || []).forEach(function (intr) {
            var item = CP.addInterrupt(intr, threadId, cap);
            if (item) item.tracker = tracker;
          });
          feed.appendChild(elh('p', 'muted small', 'Paused — approve or deny in Approvals.'));
        }
      }
    }).then(function () {
      done();
    }, function (err) {
      tracker.setStatus('error', 'st-failed');
      feed.appendChild(elh('p', 'err-txt', 'Dispatch failed: ' + err.message));
      done();
    });
  }

  CP.catalog = {
    init: init,
    refresh: refresh,
    match: match,
    openDetail: openDetail,
    closeDetail: closeDetail,
    isOnline: function () { return online; },
    all: function () { return caps.slice(); },
    starters: starters
  };
})();
