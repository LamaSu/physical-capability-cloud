/* @harness/control-plane — shell.js
 *
 * The shell runtime: API client over the spine (:3457), the render bridge
 * that MOUNTS the B1.engine modules (../genui-render/engine.js) with a
 * built-in fallback, the lens manager, the nine region shells, and boot.
 *
 * Load order: expand.js → catalog.js → walkthrough.js → shell.js (this file
 * boots on DOMContentLoaded).
 *
 * Vanilla, no build, no CDN. Works over http(s) (dashboard-server /
 * Capacitor webview) and file:// (engine import degrades to builtins).
 * All text through textContent — never innerHTML.
 */
(function () {
  'use strict';

  var CP = window.CP = window.CP || {};
  var bus = CP.bus;

  // ── tiny DOM helpers ─────────────────────────────────────────────────────
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function uuid() {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : 'x' + String(Math.random()).slice(2) + Date.now().toString(36);
  }
  CP.el = el;
  CP.uuid = uuid;

  // ── CP.api — the spine client ────────────────────────────────────────────
  // Base resolution: ?api= param → localStorage cp.apiBase → same-origin
  // (when served over http/https) → http://localhost:3457 (file:// preview,
  // Android webview pointed at a LAN host, agent-package offline).
  var apiBase = (function () {
    try {
      var q = new URLSearchParams(location.search).get('api');
      if (q) { try { localStorage.setItem('cp.apiBase', q); } catch (e) {} return q.replace(/\/+$/, ''); }
      var ls = localStorage.getItem('cp.apiBase');
      if (ls) return ls.replace(/\/+$/, '');
    } catch (e) { /* no storage */ }
    if (location.protocol === 'http:' || location.protocol === 'https:') return '';
    return 'http://localhost:3457';
  })();

  CP.api = {
    base: function () { return apiBase; },
    setBase: function (u) {
      apiBase = String(u || '').replace(/\/+$/, '');
      try { localStorage.setItem('cp.apiBase', apiBase); } catch (e) {}
      bus.emit('api:base-changed', { base: apiBase });
    },

    getJSON: function (path) {
      return fetch(apiBase + path, { headers: { 'Accept': 'application/json' } })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + path);
          return r.json();
        });
    },

    ping: function () {
      return CP.api.getJSON('/api/health').then(function () { return true; }, function () { return false; });
    },

    /**
     * Dispatch a capability run over AG-UI (POST /api/agui/run, SSE-framed
     * stream read via fetch — the shipped agui-view.html contract).
     * onEvent(ev) fires per parsed event. Returns a promise that resolves
     * when the stream closes.
     */
    runCapability: function (opts) {
      var threadId = opts.threadId || ('t-' + uuid().slice(0, 8));
      var payload = {
        threadId: threadId,
        runId: uuid(),
        state: {}, messages: [], tools: [], context: [],
        forwardedProps: { capability: { id: opts.id, args: opts.args || {} } }
      };
      if (opts.resume) { payload.resume = opts.resume; delete payload.forwardedProps; }
      return streamRun(payload, opts.onEvent, threadId);
    },

    /** Resume a paused interrupt (approve / deny / edit-args). */
    resume: function (opts) {
      var payload = {
        threadId: opts.threadId,
        runId: uuid(),
        resume: [{
          interruptId: opts.interruptId,
          status: opts.approved ? 'resolved' : 'cancelled',
          payload: opts.payload || { approved: !!opts.approved }
        }],
        state: {}, messages: [], tools: [], context: [], forwardedProps: {}
      };
      return streamRun(payload, opts.onEvent, opts.threadId);
    },

    /** Ambient pipeline stream (GET /api/agui/watch via EventSource). */
    attachWatch: function (onEvent, onState) {
      var es;
      try { es = new EventSource(apiBase + '/api/agui/watch'); }
      catch (e) { if (onState) onState('unavailable'); return null; }
      es.onopen = function () { if (onState) onState('live'); };
      es.onerror = function () { if (onState) onState('reconnecting'); };
      es.onmessage = function (e) {
        var ev; try { ev = JSON.parse(e.data); } catch (x) { return; }
        onEvent(ev);
      };
      return es;
    }
  };

  function streamRun(payload, onEvent, threadId) {
    return fetch(apiBase + '/api/agui/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok || !res.body) throw new Error('run dispatch failed (HTTP ' + res.status + ')');
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) return;
          buf += dec.decode(chunk.value, { stream: true });
          var frames = buf.split('\n\n');
          buf = frames.pop();
          for (var i = 0; i < frames.length; i++) {
            var line = frames[i].split('\n')
              .filter(function (l) { return l.indexOf('data:') === 0; })
              .map(function (l) { return l.slice(5).trim(); })
              .join('');
            if (!line) continue;
            var ev; try { ev = JSON.parse(line); } catch (x) { continue; }
            if (onEvent) onEvent(ev, threadId);
            bus.emit('run:event', { event: ev, threadId: threadId });
          }
          return pump();
        });
      }
      return pump();
    });
  }

  // ── RFC-6902 apply (replace/add/remove) for STATE_DELTA — from agui-view ─
  function ptr(obj, path) {
    var parts = path.split('/').slice(1).map(function (s) { return s.replace(/~1/g, '/').replace(/~0/g, '~'); });
    var parent = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      var k = parts[i];
      if (Array.isArray(parent)) k = parseInt(k, 10);
      if (parent[k] == null) parent[k] = {};
      parent = parent[k];
    }
    var last = parts[parts.length - 1];
    if (Array.isArray(parent) && last !== '-') last = parseInt(last, 10);
    return { parent: parent, key: last };
  }
  CP.applyPatch = function (state, patch) {
    for (var i = 0; i < (patch || []).length; i++) {
      var op = patch[i];
      if (op.path === '') { if (op.op === 'replace' || op.op === 'add') state = op.value; continue; }
      try {
        var t = ptr(state, op.path);
        if (op.op === 'remove') { if (Array.isArray(t.parent)) t.parent.splice(t.key, 1); else delete t.parent[t.key]; }
        else if (op.op === 'add' && Array.isArray(t.parent) && t.key === '-') t.parent.push(op.value);
        else t.parent[t.key] = op.value;
      } catch (e) { /* snapshot resync corrects */ }
    }
    return state;
  };

  // ── CP.render — the engine mount + builtin fallbacks ────────────────────
  // The B1.engine (C:\Users\globa\.claude\lib\genui-render\) is mounted via
  // dynamic import(). Candidates cover: served-alongside (/genui-render/*),
  // disk-relative (../genui-render/*), and bundled-copy (./engine/*) layouts.
  // Anything failing → builtins. The shell never depends on the engine
  // existing; it only gets better when it does.
  var engine = null;

  function mountEngine() {
    var candidates = [
      '../genui-render/engine.js',
      '/genui-render/engine.js',
      './engine/engine.js'
    ];
    var i = 0;
    function tryNext() {
      if (i >= candidates.length) {
        bus.emit('engine:fallback', {});
        return Promise.resolve(null);
      }
      var spec = candidates[i++];
      // Indirect eval keeps this file valid as a classic script while still
      // using native dynamic import at runtime.
      var dynImport;
      try { dynImport = new Function('s', 'return import(s)'); }
      catch (e) { bus.emit('engine:fallback', {}); return Promise.resolve(null); }
      return dynImport(spec).then(function (mod) {
        var m = (mod && mod.default && typeof mod.default === 'object') ? mod.default : mod;
        if (m && (typeof m.renderCapability === 'function' || typeof m.renderEvent === 'function')) {
          engine = m;
          engine.__origin = spec;
          bus.emit('engine:mounted', { origin: spec });
          return m;
        }
        return tryNext();
      }, function () { return tryNext(); });
    }
    return tryNext();
  }

  function asNode(out) {
    if (!out) return null;
    if (out.nodeType === 1 || out.nodeType === 11) return out;
    if (typeof out === 'string') { var d = el('div'); d.textContent = out; return d; }
    return null;
  }

  CP.render = {
    mountEngine: mountEngine,
    engine: function () { return engine; },

    /** One capability card. Engine first; builtin fallback always works. */
    capabilityCard: function (cap, opts) {
      if (engine && typeof engine.renderCapability === 'function') {
        try {
          var n = asNode(engine.renderCapability(cap, opts || {}));
          if (n) return n;
        } catch (e) { /* engine hiccup → builtin */ }
      }
      return builtinCapabilityCard(cap, opts || {});
    },

    /** One AG-UI event row. Engine first; builtin fallback. */
    event: function (ev, opts) {
      if (engine && typeof engine.renderEvent === 'function') {
        try {
          var n = asNode(engine.renderEvent(ev, opts || {}));
          if (n) return n;
        } catch (e) { /* fall through */ }
      }
      return builtinEventRow(ev);
    },

    trustBadge: trustBadge
  };

  var TRUST_LABEL = {
    read: 'read', write: 'write', exec: 'exec', network: 'network', credential: 'credential'
  };

  function trustBadge(level) {
    var b = el('span', 'badge trust-' + (level || 'read'), TRUST_LABEL[level] || level || 'read');
    b.title = ({
      read: 'Observe only — runs immediately.',
      write: 'Changes state — pauses for your approval.',
      exec: 'Executes on the host — pauses for your approval.',
      network: 'Reaches out over the network — pauses for your approval.',
      credential: 'Touches credentials — always pauses for your approval.'
    })[level] || '';
    return b;
  }

  function builtinCapabilityCard(cap, opts) {
    var card = el('article', 'cap-card' + (cap.__demo ? ' demo' : ''));
    card.setAttribute('data-cap-id', cap.id);
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    var top = el('div', 'cap-top');
    top.appendChild(el('span', 'cap-name', cap.name || cap.id));
    var badges = el('span', 'cap-badges');
    badges.appendChild(trustBadge(cap.trustLevel));
    var src = (cap.source === 'pcc' || cap.source === 'a2a') ? 'network' : 'local';
    badges.appendChild(el('span', 'badge src-' + src, cap.source || 'local'));
    if (cap.economic && cap.economic.price) {
      var pr = cap.economic.price;
      var ptxt = (pr.base != null ? pr.base : '') + (pr.currency ? ' ' + pr.currency : '');
      badges.appendChild(el('span', 'badge econ', ptxt || 'priced'));
    }
    if (cap.assurance && cap.assurance.offeredTiers && cap.assurance.offeredTiers.length) {
      badges.appendChild(el('span', 'badge tier', 'tier ' + Math.max.apply(null, cap.assurance.offeredTiers)));
    }
    if (cap.__demo) badges.appendChild(el('span', 'badge demo-b', 'sample'));
    top.appendChild(badges);
    card.appendChild(top);

    var desc = String(cap.description || '');
    if (desc.length > 140) desc = desc.slice(0, 137) + '…';
    card.appendChild(el('p', 'cap-desc', desc));

    var lens = (opts && opts.lens) || (CP.lens && CP.lens.get()) || 'user';
    var foot = el('div', 'cap-foot');
    if (lens === 'orchestrator') {
      foot.appendChild(el('span', 'cap-meta', cap.id));
      if (cap.sideEffects) foot.appendChild(el('span', 'cap-meta warn', 'side-effects'));
    } else if (lens === 'operator') {
      var owner = cap.sourceDetail && cap.sourceDetail.owner;
      foot.appendChild(el('span', 'cap-meta', owner ? ('provider: ' + owner) : ''));
    } else {
      foot.appendChild(el('span', 'cap-meta',
        cap.trustLevel === 'read' ? 'runs instantly' : 'asks first'));
    }
    card.appendChild(foot);
    return card;
  }

  function builtinEventRow(ev) {
    var row = el('div', 'ev-row');
    var t = ev && ev.type || '?';
    var lbl = el('span', 'ev-type', t);
    var txt = '';
    switch (t) {
      case 'RUN_STARTED': txt = 'run ' + (ev.runId || ''); break;
      case 'TOOL_CALL_START': txt = String(ev.toolCallName || ''); break;
      case 'TOOL_CALL_RESULT': txt = String(ev.content == null ? '' : ev.content); break;
      case 'TEXT_MESSAGE_CONTENT': txt = String(ev.delta || ''); break;
      case 'STEP_STARTED': txt = String(ev.stepName || ''); break;
      case 'STEP_FINISHED': txt = String(ev.stepName || ''); break;
      case 'RUN_ERROR': row.classList.add('err'); txt = String(ev.message || 'error'); break;
      case 'CUSTOM': txt = String(ev.name || ''); break;
      case 'RUN_FINISHED':
        txt = (ev.outcome && ev.outcome.type === 'interrupt') ? 'paused — approval required' : 'finished';
        break;
      default: txt = '';
    }
    if (txt.length > 400) txt = txt.slice(0, 397) + '…';
    row.appendChild(lbl);
    row.appendChild(el('span', 'ev-txt', txt));
    return row;
  }

  // ── CP.lens — the actor lens (User / Operator / Orchestrator) ───────────
  // Three projections of one spine (SYNTHESIS §3): a view-mode switch, not
  // an account type. Persisted client-side.
  var LENSES = [
    { id: 'user',         label: 'User',         hint: 'Get an outcome' },
    { id: 'operator',     label: 'Operator',     hint: 'Run my capacity' },
    { id: 'orchestrator', label: 'Orchestrator', hint: 'Compose & control' }
  ];
  var currentLens = (function () {
    try { var l = localStorage.getItem('cp.lens'); if (l) return l; } catch (e) {}
    return 'user';
  })();

  CP.lens = {
    LENSES: LENSES,
    get: function () { return currentLens; },
    set: function (l, opts) {
      if (!l || l === currentLens) return;
      currentLens = l;
      try { localStorage.setItem('cp.lens', l); } catch (e) {}
      document.body.setAttribute('data-lens', l);
      renderLensSwitch();
      bus.emit('lens:changed', { lens: l, silent: !!(opts && opts.silent) });
    }
  };

  function renderLensSwitch() {
    var host = document.getElementById('cp-lens');
    if (!host) return;
    clear(host);
    LENSES.forEach(function (L) {
      var b = el('button', 'lens-chip' + (L.id === currentLens ? ' active' : ''), L.label);
      b.type = 'button';
      b.title = L.hint;
      b.setAttribute('aria-pressed', L.id === currentLens ? 'true' : 'false');
      b.onclick = function () { CP.lens.set(L.id); };
      host.appendChild(b);
    });
  }

  // ── Region shells + nav + More drawer ────────────────────────────────────
  var state = CP.state = { runs: [], interrupts: [], caps: [], watchAttached: false };

  function buildRegions() {
    var main = document.getElementById('cp-main');
    clear(main);
    CP.REGIONS.forEach(function (r) {
      var sec = el('section', 'region');
      sec.id = 'region-' + r.id;
      sec.setAttribute('data-region', r.id);
      var head = el('div', 'region-head');
      var h = el('h2', null, r.title);
      var bdg = el('span', 'region-badge');
      bdg.hidden = true;
      h.appendChild(bdg);
      head.appendChild(h);
      head.appendChild(el('span', 'region-blurb', r.blurb));
      sec.appendChild(head);
      sec.appendChild(el('div', 'region-body'));
      sec.hidden = !CP.expand.isRevealed(r.id);
      main.appendChild(sec);
    });
  }

  function regionBody(id) {
    var sec = document.getElementById('region-' + id);
    return sec ? sec.querySelector('.region-body') : null;
  }
  CP.regionBody = regionBody;

  function syncRegions() {
    CP.REGIONS.forEach(function (r) {
      var sec = document.getElementById('region-' + r.id);
      if (sec) sec.hidden = !CP.expand.isRevealed(r.id);
    });
    renderNav();
    renderMoreDrawer();
  }

  function renderNav() {
    var nav = document.getElementById('cp-nav');
    if (!nav) return;
    clear(nav);
    CP.REGIONS.forEach(function (r) {
      if (!CP.expand.isRevealed(r.id)) return;
      var chip = el('button', 'nav-chip', '');
      chip.type = 'button';
      chip.appendChild(el('span', 'nav-ic', r.icon));
      chip.appendChild(el('span', 'nav-lb', r.title));
      var n = CP.expand.badgeCount(r.id);
      if (n > 0) chip.appendChild(el('span', 'nav-badge', String(n)));
      chip.onclick = function () { focusRegion(r.id); };
      nav.appendChild(chip);
    });
    // The More button — user-driven expansion lives here.
    var hidden = CP.REGIONS.filter(function (r) { return !CP.expand.isRevealed(r.id); });
    if (hidden.length) {
      var more = el('button', 'nav-chip more', '');
      more.type = 'button';
      more.id = 'cp-more-btn';
      more.appendChild(el('span', 'nav-ic', '＋'));
      more.appendChild(el('span', 'nav-lb', 'More'));
      var dots = hidden.filter(function (r) { return CP.expand.isSuggested(r.id); }).length;
      if (dots > 0) more.appendChild(el('span', 'nav-badge dot', ''));
      more.onclick = toggleMoreDrawer;
      nav.appendChild(more);
    }
  }

  function focusRegion(id) {
    var sec = document.getElementById('region-' + id);
    if (!sec || sec.hidden) return;
    sec.scrollIntoView({ behavior: prefersReduced() ? 'auto' : 'smooth', block: 'start' });
    sec.classList.add('flash');
    setTimeout(function () { sec.classList.remove('flash'); }, 1200);
  }

  function prefersReduced() {
    return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function renderMoreDrawer() {
    var drawer = document.getElementById('cp-more');
    if (!drawer) return;
    var list = drawer.querySelector('.more-list');
    clear(list);
    var lens = CP.lens.get();
    var hidden = CP.REGIONS.filter(function (r) { return !CP.expand.isRevealed(r.id); });
    // Order: suggested first, then lens-relevant, then the rest.
    hidden.sort(function (a, b) {
      var sa = (CP.expand.isSuggested(a.id) ? 0 : 1) + (a.lenses.indexOf(lens) >= 0 ? 0 : 2);
      var sb = (CP.expand.isSuggested(b.id) ? 0 : 1) + (b.lenses.indexOf(lens) >= 0 ? 0 : 2);
      return sa - sb;
    });
    if (!hidden.length) {
      list.appendChild(el('p', 'more-empty', 'Everything is open. This is the whole plane.'));
      return;
    }
    hidden.forEach(function (r) {
      var row = el('button', 'more-row', '');
      row.type = 'button';
      var head = el('span', 'more-head', '');
      head.appendChild(el('span', 'nav-ic', r.icon));
      head.appendChild(el('span', 'more-title', r.title));
      if (CP.expand.isSuggested(r.id)) head.appendChild(el('span', 'nav-badge dot', ''));
      row.appendChild(head);
      row.appendChild(el('span', 'more-blurb', r.blurb));
      row.onclick = function () {
        CP.expand.reveal(r.id, { toast: r.title + ' opened' });
        toggleMoreDrawer(false);
      };
      list.appendChild(row);
    });
  }

  function toggleMoreDrawer(force) {
    var drawer = document.getElementById('cp-more');
    if (!drawer) return;
    var show = (typeof force === 'boolean') ? force : drawer.hidden;
    drawer.hidden = !show;
    if (show) renderMoreDrawer();
  }
  CP.toggleMoreDrawer = toggleMoreDrawer;

  // ── Region: Ask (0) ──────────────────────────────────────────────────────
  // Honest local routing: token match over the loaded registry. Deeper NL
  // routing (mcp:harness:route via /api/control) is the W3 spine step; this
  // box upgrades in place when that lands.
  function buildAsk() {
    var body = regionBody('ask');
    if (!body) return;
    clear(body);
    var form = el('form', 'ask-form');
    var input = el('input', 'ask-input');
    input.type = 'search';
    input.id = 'cp-ask-input';
    input.placeholder = 'What do you want done? e.g. "check code index" or "order a pizza"';
    input.setAttribute('autocomplete', 'off');
    var go = el('button', 'btn primary', 'Ask');
    go.type = 'submit';
    form.appendChild(input);
    form.appendChild(go);
    body.appendChild(form);
    var out = el('div', 'ask-results');
    out.id = 'cp-ask-results';
    body.appendChild(out);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = input.value.trim();
      if (!q) return;
      bus.emit('ask:query', { q: q });
      var matches = CP.catalog.match(q, 5);
      clear(out);
      if (!matches.length) {
        out.appendChild(el('p', 'muted', 'No capability matched. Browse the catalog below, or refine the ask.'));
        return;
      }
      out.appendChild(el('p', 'muted', 'Closest capabilities:'));
      matches.forEach(function (cap) {
        var card = CP.render.capabilityCard(cap, { lens: CP.lens.get() });
        card.addEventListener('click', function () { CP.catalog.openDetail(cap); });
        card.addEventListener('keydown', function (ke) { if (ke.key === 'Enter' || ke.key === ' ') { ke.preventDefault(); CP.catalog.openDetail(cap); } });
        out.appendChild(card);
      });
    });
  }

  // ── Region: Activity (3) ─────────────────────────────────────────────────
  function buildActivity() {
    var body = regionBody('activity');
    if (!body) return;
    clear(body);

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

    var runsHost = el('div', 'runs');
    runsHost.id = 'cp-runs';
    body.appendChild(runsHost);
    if (!state.runs.length) {
      runsHost.appendChild(el('p', 'muted', 'Runs you dispatch appear here, live.'));
    } else {
      state.runs.forEach(function (r) { runsHost.appendChild(r.node); });
    }
    attachWatchOnce();
  }

  var pipeState = {};
  function attachWatchOnce() {
    if (state.watchAttached) return;
    state.watchAttached = true;
    CP.api.attachWatch(function (ev) {
      switch (ev.type) {
        case 'STATE_SNAPSHOT': pipeState = ev.snapshot || {}; renderPipe(); break;
        case 'STATE_DELTA': pipeState = CP.applyPatch(pipeState, ev.delta || []); renderPipe(); break;
        default: break;
      }
    }, function (st) {
      var d = document.getElementById('cp-pipe-dot');
      if (d) d.className = 'dot' + (st === 'live' ? ' live' : '');
    });
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
    var pct = pipeState.progress_pct;
    var bar = el('div', 'bar');
    var fill = el('span');
    fill.style.width = (pct || 0) + '%';
    bar.appendChild(fill);
    pb.appendChild(bar);
    (pipeState.agents || []).slice(0, 8).forEach(function (a) {
      var ar = el('div', 'pipe-row');
      ar.appendChild(el('span', 'pill st-' + (a.status || ''), a.status || '—'));
      ar.appendChild(el('span', 'v grow', a.name || ''));
      pb.appendChild(ar);
    });
  }

  /** Register a dispatched run into Activity; returns appenders. */
  CP.trackRun = function (cap, threadId) {
    var node = el('article', 'run-card');
    var head = el('div', 'run-head');
    head.appendChild(el('span', 'run-name', cap.name || cap.id));
    var st = el('span', 'pill st-running', 'running');
    head.appendChild(st);
    node.appendChild(head);
    var feed = el('div', 'run-feed');
    node.appendChild(feed);

    var run = { threadId: threadId, capId: cap.id, node: node, status: 'running' };
    state.runs.unshift(run);
    var host = document.getElementById('cp-runs');
    if (host) {
      var empty = host.querySelector('p.muted');
      if (empty) host.removeChild(empty);
      host.insertBefore(node, host.firstChild);
    }
    bus.emit('run:dispatched', { capId: cap.id, threadId: threadId });

    return {
      event: function (ev) {
        feed.appendChild(CP.render.event(ev));
        while (feed.childNodes.length > 40) feed.removeChild(feed.firstChild);
        feed.scrollTop = feed.scrollHeight;
        if (ev.type === 'RUN_ERROR') { st.textContent = 'error'; st.className = 'pill st-failed'; run.status = 'error'; }
        if (ev.type === 'RUN_FINISHED') {
          if (ev.outcome && ev.outcome.type === 'interrupt') {
            st.textContent = 'paused'; st.className = 'pill st-pending'; run.status = 'paused';
          } else {
            st.textContent = 'done'; st.className = 'pill st-done'; run.status = 'done';
            bus.emit('run:finished', { capId: cap.id });
          }
        }
      },
      setStatus: function (s, cls) { st.textContent = s; st.className = 'pill ' + (cls || ''); }
    };
  };

  // ── Region: Approvals (4) ────────────────────────────────────────────────
  function buildApprovals() {
    var body = regionBody('approvals');
    if (!body) return;
    clear(body);
    var host = el('div', 'approvals');
    host.id = 'cp-approvals';
    body.appendChild(host);
    if (!state.interrupts.length) {
      host.appendChild(el('p', 'muted', 'Nothing waiting. Gated capabilities (write / exec / network / credential — and priced jobs) pause here for your approval.'));
    } else {
      state.interrupts.forEach(function (it) { if (it.node) host.appendChild(it.node); });
    }
  }

  /** Called by catalog when a run pauses with an interrupt. */
  CP.addInterrupt = function (intr, threadId, cap) {
    var item = { id: intr.id, threadId: threadId, cap: cap, resolved: false };
    var card = el('article', 'intr-card');
    var head = el('div', 'run-head');
    head.appendChild(el('span', 'run-name', (cap && cap.name) || 'Approval required'));
    head.appendChild(trustBadge(cap ? cap.trustLevel : 'exec'));
    card.appendChild(head);
    card.appendChild(el('p', 'intr-msg', String(intr.message || 'This action is gated and needs your approval.')));
    if (intr.metadata) {
      var pre = el('pre', 'intr-meta');
      try { pre.textContent = JSON.stringify(intr.metadata, null, 2); } catch (e) { pre.textContent = ''; }
      card.appendChild(pre);
    }
    var edit = el('details', 'intr-edit');
    var sum = el('summary', null, 'Edit args before approving (optional)');
    edit.appendChild(sum);
    var ta = el('textarea', 'intr-args');
    ta.placeholder = '{ } — full replacement, not a merge';
    edit.appendChild(ta);
    card.appendChild(edit);

    var acts = el('div', 'actions');
    var ok = el('button', 'btn primary', 'Approve');
    var no = el('button', 'btn deny', 'Deny');
    ok.type = no.type = 'button';
    acts.appendChild(ok); acts.appendChild(no);
    card.appendChild(acts);

    function resolve(approved) {
      if (item.resolved) return;
      item.resolved = true;
      ok.disabled = no.disabled = true;
      var payload = { approved: approved };
      var t = ta.value.trim();
      if (approved && t) {
        try { payload.editedArgs = JSON.parse(t); }
        catch (e) { item.resolved = false; ok.disabled = no.disabled = false; CP.toast('Edited args are not valid JSON'); return; }
      }
      var tracker = item.tracker;
      CP.api.resume({
        threadId: threadId, interruptId: intr.id, approved: approved, payload: payload,
        onEvent: function (ev) { if (tracker) tracker.event(ev); routeRunEvent(ev, threadId, cap); }
      }).then(function () {
        card.classList.add('resolved');
        acts.appendChild(el('span', 'muted', approved ? ' approved' : ' denied'));
        bus.emit('interrupt:resolved', { id: intr.id, approved: approved });
      }, function (err) {
        item.resolved = false; ok.disabled = no.disabled = false;
        CP.toast('Resume failed: ' + err.message);
      });
    }
    ok.onclick = function () { resolve(true); };
    no.onclick = function () { resolve(false); };

    item.node = card;
    state.interrupts.unshift(item);
    var host = document.getElementById('cp-approvals');
    if (host) {
      var empty = host.querySelector('p.muted');
      if (empty) host.removeChild(empty);
      host.insertBefore(card, host.firstChild);
    }
    bus.emit('interrupt:new', { id: intr.id, capId: cap && cap.id });
    return item;
  };

  // Route resumed-run events back into the owning run card, and catch
  // follow-up interrupts (an approval can pause again downstream).
  function routeRunEvent(ev, threadId, cap) {
    if (ev.type === 'RUN_FINISHED' && ev.outcome && ev.outcome.type === 'interrupt') {
      var list = ev.outcome.interrupts || [];
      for (var i = 0; i < list.length; i++) CP.addInterrupt(list[i], threadId, cap);
    }
  }
  CP.routeRunEvent = routeRunEvent;

  // ── Region: Ledger (5) — two rails, honestly labeled ────────────────────
  function buildLedger() {
    var body = regionBody('ledger');
    if (!body) return;
    clear(body);

    var advisory = el('div', 'panel');
    advisory.appendChild(el('div', 'panel-h', 'Advisory cost — local rail (codeburn)'));
    var ab = el('div', 'pipe-body');
    ab.appendChild(el('p', 'muted', 'Loading…'));
    advisory.appendChild(ab);
    body.appendChild(advisory);

    CP.api.getJSON('/api/codeburn').then(function (d) {
      clear(ab);
      var keys = ['today', 'session', 'total', 'burn', 'cost', 'usd'];
      var shown = 0;
      Object.keys(d || {}).forEach(function (k) {
        var v = d[k];
        if ((typeof v === 'number' || typeof v === 'string') && shown < 6) {
          var row = el('div', 'pipe-row');
          row.appendChild(el('span', 'k', k));
          row.appendChild(el('span', 'v', String(v)));
          ab.appendChild(row);
          shown++;
        }
      });
      if (!shown) ab.appendChild(el('p', 'muted', 'No advisory cost data yet.'));
      ab.appendChild(el('p', 'muted small', 'Notional (Max plan) — advisory only, nothing settles on this rail.'));
    }, function () {
      clear(ab);
      ab.appendChild(el('p', 'muted', 'Advisory cost endpoint not reachable.'));
    });

    var settle = el('div', 'panel');
    settle.appendChild(el('div', 'panel-h', 'Settlement — network rail (PCC escrow / x402)'));
    var sb = el('div', 'pipe-body');
    sb.id = 'cp-settle-body';
    sb.appendChild(el('p', 'muted', 'Escrow, milestone releases and x402 receipts appear here when networked (PCC) capabilities run. Nothing has settled in this session.'));
    settle.appendChild(sb);
    body.appendChild(settle);
  }

  // Economic CUSTOM events ride into the settlement panel.
  bus.on('run:event', function (p) {
    var ev = p && p.event;
    if (!ev || ev.type !== 'CUSTOM' || typeof ev.name !== 'string' || ev.name.indexOf('pcc.') !== 0) return;
    var sb = document.getElementById('cp-settle-body');
    if (!sb) return;
    var empty = sb.querySelector('p.muted');
    if (empty) sb.removeChild(empty);
    var row = el('div', 'pipe-row');
    row.appendChild(el('span', 'k', ev.name));
    var val = '';
    try { val = ev.value != null ? JSON.stringify(ev.value) : ''; } catch (e) {}
    if (val.length > 120) val = val.slice(0, 117) + '…';
    row.appendChild(el('span', 'v', val));
    sb.appendChild(row);
  });

  // ── Region: Fleet (6) — providers derived from the live registry ────────
  function buildFleet() {
    var body = regionBody('fleet');
    if (!body) return;
    clear(body);
    var caps = state.caps || [];
    var byOwner = {};
    caps.forEach(function (c) {
      var owner = (c.sourceDetail && c.sourceDetail.owner) || c.source || 'unknown';
      (byOwner[owner] = byOwner[owner] || []).push(c);
    });
    var owners = Object.keys(byOwner).sort(function (a, b) { return byOwner[b].length - byOwner[a].length; });
    if (!owners.length) {
      body.appendChild(el('p', 'muted', 'No providers visible — connect to a control-plane server.'));
      return;
    }
    body.appendChild(el('p', 'muted', 'Providers hosting the capabilities in this registry. Networked kernel fleets (health, queues, bonds) attach here when the PCC adapter lands.'));
    var grid = el('div', 'fleet-grid');
    owners.slice(0, 24).forEach(function (o) {
      var caps2 = byOwner[o];
      var card = el('article', 'panel fleet-card');
      card.appendChild(el('div', 'panel-h', o));
      var fb = el('div', 'pipe-body');
      var row = el('div', 'pipe-row');
      row.appendChild(el('span', 'k', 'capabilities'));
      row.appendChild(el('span', 'v', String(caps2.length)));
      fb.appendChild(row);
      var trusts = {};
      caps2.forEach(function (c) { trusts[c.trustLevel] = (trusts[c.trustLevel] || 0) + 1; });
      var tr = el('div', 'cap-badges');
      Object.keys(trusts).forEach(function (t) { tr.appendChild(el('span', 'badge trust-' + t, t + ' ×' + trusts[t])); });
      fb.appendChild(tr);
      card.appendChild(fb);
      grid.appendChild(card);
    });
    body.appendChild(grid);
  }

  // ── Region: Compose (2) / Publish (7) — honest thin states ──────────────
  function buildCompose() {
    var body = regionBody('compose');
    if (!body) return;
    clear(body);
    body.appendChild(el('p', 'muted',
      'The DAG workbench: chain capabilities into one plan that can span local and networked steps. ' +
      'The compose engine is live on the PCC side (Dijkstra planning, budget gate); this workbench wires to it in Wave W2. ' +
      'Until then, dispatch single capabilities from the Catalog, and watch pipeline waves in Activity.'));
    if (location.protocol !== 'file:') {
      var a = el('a', 'btn ghost-link', 'Open the pipeline visualizer (/viz)');
      a.href = CP.api.base() + '/viz';
      a.target = '_blank';
      a.rel = 'noopener';
      body.appendChild(a);
    }
  }

  function buildPublish() {
    var body = regionBody('publish');
    if (!body) return;
    clear(body);
    body.appendChild(el('p', 'muted', 'One flow to make something offerable. For a digital capability, generate and vet it from your orchestrator:'));
    var pre = el('pre', 'pub-cmd');
    pre.textContent = '/forge <tool-name> <api-docs-url>   # generate an MCP server\n/vet   <path>                        # security-scan it (Gate A)\n# it registers into the catalog on approval';
    body.appendChild(pre);
    var copy = el('button', 'btn', 'Copy commands');
    copy.type = 'button';
    copy.onclick = function () {
      try { navigator.clipboard.writeText(pre.textContent); CP.toast('Copied'); }
      catch (e) { CP.toast('Select and copy manually'); }
    };
    body.appendChild(copy);
    body.appendChild(el('p', 'muted small', 'Machine and human onboarding lanes (kernels, operators) consolidate here as the PCC publish flow lands.'));
  }

  // ── Region: Audit (8) — recent telemetry, real endpoint ──────────────────
  function buildAudit() {
    var body = regionBody('audit');
    if (!body) return;
    clear(body);
    var host = el('div', 'panel');
    host.appendChild(el('div', 'panel-h', 'Recent telemetry'));
    var fb = el('div', 'pipe-body');
    fb.appendChild(el('p', 'muted', 'Loading…'));
    host.appendChild(fb);
    body.appendChild(host);
    CP.api.getJSON('/api/telemetry?limit=30').then(function (d) {
      clear(fb);
      var rows = Array.isArray(d) ? d : (d && d.events) || [];
      if (!rows.length) { fb.appendChild(el('p', 'muted', 'No telemetry yet.')); return; }
      rows.slice(-30).reverse().forEach(function (r) {
        var row = el('div', 'ev-row');
        row.appendChild(el('span', 'ev-type', String(r.event || r.type || '·')));
        var who = r.agent || r.agent_name || '';
        var ts = r.ts || r.timestamp || '';
        row.appendChild(el('span', 'ev-txt', (who ? who + ' · ' : '') + String(ts).slice(0, 19)));
        fb.appendChild(row);
      });
    }, function () {
      clear(fb);
      fb.appendChild(el('p', 'muted', 'Telemetry endpoint not reachable.'));
    });
    body.appendChild(el('p', 'muted small', 'Receipts, evidence bundles and attestations join this view as networked capabilities settle.'));
  }

  // Region builders, invoked on reveal + on boot for already-revealed ones.
  var BUILDERS = {
    ask: buildAsk, activity: buildActivity, approvals: buildApprovals,
    ledger: buildLedger, fleet: buildFleet, compose: buildCompose,
    publish: buildPublish, audit: buildAudit
    // catalog builds itself via CP.catalog.init()
  };
  var built = {};
  function buildIfNeeded(id) {
    if (built[id] || !CP.expand.isRevealed(id)) return;
    var fn = BUILDERS[id];
    if (fn) { fn(); built[id] = true; }
  }
  CP.rebuildRegion = function (id) { if (BUILDERS[id]) { BUILDERS[id](); built[id] = true; } };

  // ── Header wiring ────────────────────────────────────────────────────────
  function wireHeader() {
    renderLensSwitch();
    var help = document.getElementById('cp-help');
    if (help) help.onclick = function () { CP.walkthrough.start(true); };
    var gear = document.getElementById('cp-gear');
    if (gear) gear.onclick = function () {
      var cur = CP.api.base() || location.origin;
      var next = prompt('Control-plane server URL (the spine on :3457):', cur);
      if (next != null && next.trim()) {
        CP.api.setBase(next.trim());
        location.reload();
      }
    };
    var closeMore = document.getElementById('cp-more-close');
    if (closeMore) closeMore.onclick = function () { toggleMoreDrawer(false); };
    var backdrop = document.getElementById('cp-more');
    if (backdrop) backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) toggleMoreDrawer(false);
    });
  }

  function setConn(ok, demo) {
    var d = document.getElementById('cp-conn');
    var s = document.getElementById('cp-conn-sub');
    if (d) d.className = 'dot' + (ok ? ' live' : '');
    if (s) s.textContent = ok ? 'connected' : (demo ? 'offline — sample data' : 'offline');
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function boot() {
    document.body.setAttribute('data-lens', currentLens);
    buildRegions();
    wireHeader();
    syncRegions();

    // Build everything already revealed (persisted growth).
    CP.REGIONS.forEach(function (r) { buildIfNeeded(r.id); });

    // Engine mount (async, non-blocking — builtins carry until then).
    CP.render.mountEngine().then(function (m) {
      var tag = document.getElementById('cp-engine-tag');
      if (tag) tag.textContent = m ? 'engine: mounted' : 'engine: builtin';
    });

    // Catalog: fetch registry (or demo pack) then render.
    CP.catalog.init().then(function (res) {
      state.caps = res.caps;
      setConn(res.online, !res.online);
      if (built.fleet) CP.rebuildRegion('fleet');
    });

    // Reveal changes → sync + lazily build the newly opened region.
    bus.on('revealed:changed', function (p) {
      syncRegions();
      if (p && p.id) buildIfNeeded(p.id);
    });
    bus.on('suggested:changed', function () { renderNav(); renderMoreDrawer(); });
    bus.on('badge:changed', function () { renderNav(); });
    bus.on('region:focus', function (p) { if (p && p.id) focusRegion(p.id); });
    bus.on('registry:grew', function () {
      CP.catalog.refresh().then(function (caps) {
        state.caps = caps;
        if (built.fleet) CP.rebuildRegion('fleet');
      });
    });

    // Periodic health ping keeps the conn dot honest.
    setInterval(function () {
      if (document.hidden) return;
      CP.api.ping().then(function (ok) { setConn(ok, !CP.catalog.isOnline()); });
    }, 60000);

    // First run → the walkthrough IS the entry point.
    CP.walkthrough.maybeAutoStart();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
