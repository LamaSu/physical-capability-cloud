/* @harness/genui-render — agent portal (B3 wave 1)
 *
 * "Communicate with the agent that created this UI, from within it."
 *
 * portal.attach(host, view)  → a per-view composer ("Ask about / refine this
 *                              view") that opens/continues an AG-UI thread
 *                              scoped to view.threadId, sends the user's
 *                              message, and streams the agent's reply INTO
 *                              the view (events.js createEventStream).
 * portal.attachGlobal(opts)  → one floating global composer (its own thread).
 * portal.registerViewRenderer / CUSTOM portal.renderer events
 *                            → the agent re-renders a view by registering an
 *                              updated renderer via registry.registerRenderer.
 *                              Renderers arrive as DECLARATIVE templates
 *                              ({hint, summaryKeys, title}) — never code over
 *                              the wire; the template is compiled locally
 *                              against engine.renderResult. mode:"result"
 *                              only; invoke forms stay schema-generated.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HONEST DEPENDENCY — NO CONVERSATIONAL BACKEND IS PROVISIONED YET (2026-07-06)
 *
 * The reply side needs an LLM/chat backend that does not exist on :3457
 * today. VERIFIED ground truth: lib/genui/agui-bridge.js:149-151 rejects any
 * run without forwardedProps.capability.id ("first run requires
 * forwardedProps.capability.id", code invalid_input) — so a message-only
 * chat POST cannot be answered by anything currently running. The CopilotKit
 * runtime at /api/copilotkit has 5 read actions wired but NO LLM key (see
 * rules/library/genui.md: "If no API key is configured, chat will fail").
 *
 * Until a backend is wired, this portal renders fully, PROBES for an agent,
 * and shows "No agent connected — connect an LLM to enable conversation."
 * It never fabricates a reply. The user's text stays in the input.
 *
 * ── THE EXACT BACKEND HOOK NEEDED ───────────────────────────────────────────
 *
 * 1. Probe endpoint (required, tiny):
 *      GET {base}/api/portal/agent
 *      → 200 {"ok":true, "agent":"<label>", "transport":"agui-run"|"portal-chat"}
 *    Anything else (404 today) = degraded mode. The client re-probes on each
 *    send attempt (30s cache), so no restart is needed once it appears.
 *
 * 2. Chat transport — implement ONE of:
 *
 *    B1 (preferred, zero new deps): extend lib/genui/agui-bridge.js handleRun.
 *       When body.forwardedProps.portal && Array.isArray(body.messages) &&
 *       body.messages.length (and no capability id), route to an LLM instead
 *       of rejecting: hand {threadId, messages, view:{capId,lens,rendererKey}}
 *       to @anthropic-ai/sdk (ANTHROPIC_API_KEY) or to the already-mounted
 *       @copilotkit/runtime adapter, and stream back on the SAME SSE framing
 *       /api/agui/run already uses ("data: <json>\n\n" frames):
 *         TEXT_MESSAGE_START {messageId, role:"assistant"}
 *         TEXT_MESSAGE_CONTENT {messageId, delta}          ← streams into the view
 *         TEXT_MESSAGE_END {messageId}
 *         CUSTOM {name:"portal.renderer",
 *                 value:{key:"cap:id:<capId>",             ← re-render the view:
 *                        template:{hint:"card"|"table"|"chart"|"raw",
 *                                  summaryKeys?:[...], title?:"..."}}}
 *         CUSTOM {name:"portal.view", value:{capId, result}}   ← data refresh
 *         RUN_FINISHED {threadId, runId}
 *       Client POST payload (already implemented below, httpTransport):
 *         POST {base}/api/agui/run
 *         { threadId:"<view thread>", runId:"<uuid>", state:{}, tools:[],
 *           context:[], messages:[{id,role:"user",content:"<text>"}],
 *           forwardedProps:{ portal:{ capId, lens, rendererKey } } }
 *
 *    B2 (no key needed): a `claude -p` bridge. Add POST {base}/api/portal/chat
 *       accepting the same payload; spawn
 *         claude -p "<message + serialized view context>" \
 *           --output-format stream-json --include-partial-messages
 *       translate assistant text deltas → TEXT_MESSAGE_CONTENT frames, close
 *       with RUN_FINISHED. Have the probe return transport:"portal-chat" and
 *       the client POSTs there instead of /api/agui/run.
 *
 * Nothing in this file pretends either exists: probe() decides, send() only
 * runs when connected, and every degraded state is labeled in the UI.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Module format: zero-build universal (same as engine.js/events.js — plain
 * script + CommonJS; globalThis.GenUIRender.portal in the browser).
 * Hygiene: textContent/createElement only — no innerHTML, ever.
 */
(function (root, factory) {
  'use strict';
  var isNodeModule = (typeof module === 'object' && module !== null && module.exports);
  var api = factory(root, isNodeModule ? function (n) { return require(n); } : null);
  var g = (root.GenUIRender = root.GenUIRender || {});
  g.portal = api;
  if (isNodeModule) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, nodeRequire) {
  'use strict';

  function getEngine() {
    if (nodeRequire) { try { return nodeRequire('./engine.js'); } catch (e) { /* soft */ } }
    var g = root.GenUIRender;
    return (g && g.engine) ? g.engine : null;
  }
  function getEvents() {
    if (nodeRequire) { try { return nodeRequire('./events.js'); } catch (e) { /* soft */ } }
    var g = root.GenUIRender;
    return (g && g.events) ? g.events : null;
  }
  function getRegistry() {
    if (nodeRequire) { try { return nodeRequire('./registry.js'); } catch (e) { /* soft */ } }
    var g = root.GenUIRender;
    return (g && g.registry) ? g.registry : null;
  }
  function doc() { return root.document; }
  function el(tag, cls, txt) {
    var e = doc().createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined && txt !== null) e.textContent = String(txt);
    return e;
  }
  function uuid() {
    var c = root.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return 'p-' + String(Math.random()).slice(2) + '-' + Date.now().toString(36);
  }

  // ── styles (own block; gur vars with fallbacks so it stands alone) ────────
  var STYLE_ID = 'gur-portal-styles';
  var CSS = [
    '.gur-portal{border:1px solid var(--gur-edge,#2a2e3f);border-radius:12px;padding:10px 12px;',
    ' margin:10px 0;background:var(--gur-panel,#171923);font:13px/1.5 system-ui,sans-serif;}',
    '.gur-portal-replies{display:none;max-height:260px;overflow:auto;margin-bottom:8px;}',
    '.gur-portal-replies.has-content{display:block;}',
    '.gur-portal-form{display:flex;gap:8px;}',
    '.gur-portal-input{flex:1;min-width:0;background:var(--gur-panel2,#1e2130);',
    ' border:1px solid var(--gur-edge,#2a2e3f);color:var(--gur-ink,#e6e8ef);',
    ' border-radius:8px;padding:9px 10px;font:inherit;}',
    '.gur-portal-send{background:var(--gur-accent,#8b5cf6);color:#fff;border:none;border-radius:8px;',
    ' padding:9px 14px;font-weight:650;cursor:pointer;min-height:38px;}',
    '.gur-portal-send:disabled{opacity:.5;cursor:default;}',
    '.gur-portal-status{margin-top:6px;font-size:12px;color:var(--gur-muted,#9aa0b4);}',
    '.gur-portal-status.gur-portal-off{color:var(--gur-amber,#f1be64);}',
    '.gur-portal-status.gur-portal-err{color:var(--gur-red,#ef4444);}',
    '.gur-portal-status.gur-portal-live{color:var(--gur-green,#22c55e);}',
    '.gur-portal-hook{margin-top:6px;font-size:12px;color:var(--gur-muted,#9aa0b4);}',
    '.gur-portal-hook summary{cursor:pointer;}',
    '.gur-portal-hook pre{background:var(--gur-panel2,#1e2130);border-radius:6px;padding:8px 10px;',
    ' font:11.5px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word;margin:6px 0 0;}',
    '.gur-portal-you{border:1px solid var(--gur-edge,#2a2e3f);border-radius:10px;padding:8px 10px;',
    ' margin:6px 0;color:var(--gur-ink,#e6e8ef);}',
    '.gur-portal-you .gur-portal-role{font-size:10px;text-transform:uppercase;letter-spacing:.6px;',
    ' color:var(--gur-muted,#9aa0b4);margin-bottom:2px;}',
    '.gur-portal-hist{opacity:.75;}',
    '.gur-portal-global{position:fixed;right:16px;bottom:calc(64px + env(safe-area-inset-bottom,0px));',
    ' z-index:75;display:flex;flex-direction:column;align-items:flex-end;gap:8px;}',
    '.gur-portal-fab{width:46px;height:46px;border-radius:50%;border:1px solid var(--gur-edge,#2a2e3f);',
    ' background:var(--gur-accent,#8b5cf6);color:#fff;font-size:19px;cursor:pointer;',
    ' box-shadow:0 8px 24px rgba(0,0,0,.4);}',
    '.gur-portal-panel{width:min(380px,92vw);background:var(--gur-bg,#0f1117);border:1px solid var(--gur-edge,#2a2e3f);',
    ' border-radius:14px;padding:12px;box-shadow:0 12px 32px rgba(0,0,0,.5);}',
    '.gur-portal-panel-h{display:flex;justify-content:space-between;align-items:center;gap:8px;',
    ' font-size:12px;color:var(--gur-muted,#9aa0b4);text-transform:uppercase;letter-spacing:.7px;margin-bottom:6px;}',
    '.gur-portal-close{background:transparent;border:none;color:var(--gur-muted,#9aa0b4);',
    ' font-size:15px;cursor:pointer;}'
  ].join('\n');

  function ensureStyles() {
    var d = doc();
    if (!d || !d.createElement || (d.getElementById && d.getElementById(STYLE_ID))) return;
    var s = d.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    (d.head || d.documentElement || d.body).appendChild(s);
  }

  // ── transport ─────────────────────────────────────────────────────────────
  // A transport = { probe() → Promise<{connected, agent?, transport?, hint?}>,
  //                 send({threadId, runId, messages, view, onEvent}) → Promise }
  var transport = null;

  /**
   * The default HTTP transport implementing the documented wire contract.
   * probe: GET {base}/api/portal/agent (the hook's tiny required endpoint).
   *        Secondary HINT probe of GET {base}/api/copilotkit — runtime present
   *        without a portal bridge is reported, not treated as connected.
   * send:  POST /api/agui/run (transport "agui-run", default) or
   *        POST /api/portal/chat (transport "portal-chat"), SSE-framed reply.
   */
  function httpTransport(base, fetchImpl) {
    base = String(base || '').replace(/\/+$/, '');
    var f = fetchImpl || (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    var mode = 'agui-run';
    return {
      probe: function () {
        if (!f) return Promise.resolve({ connected: false, hint: 'no fetch available' });
        return f(base + '/api/portal/agent', { headers: { Accept: 'application/json' } })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then(function (j) {
            if (j && j.ok) {
              mode = (j.transport === 'portal-chat') ? 'portal-chat' : 'agui-run';
              return { connected: true, agent: j.agent || 'agent', transport: mode };
            }
            return { connected: false };
          })
          .catch(function () {
            // hint probe: is the CopilotKit runtime at least mounted?
            return f(base + '/api/copilotkit', { headers: { Accept: 'application/json' } })
              .then(function (r) { return r.ok ? r.json() : null; })
              .then(function (j) {
                if (j && (j.status === 'ok' || j.actions_wired)) {
                  return {
                    connected: false,
                    hint: 'CopilotKit runtime detected at /api/copilotkit (actions wired) — an LLM key + the portal bridge are still needed.'
                  };
                }
                return { connected: false };
              })
              .catch(function () { return { connected: false }; });
          });
      },
      send: function (opts) {
        if (!f) return Promise.reject(new Error('no fetch available'));
        var url = base + (mode === 'portal-chat' ? '/api/portal/chat' : '/api/agui/run');
        var payload = {
          threadId: opts.threadId,
          runId: opts.runId || uuid(),
          state: {}, tools: [], context: [],
          messages: opts.messages,
          forwardedProps: { portal: opts.view || {} }
        };
        return f(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(function (res) {
          if (!res.ok || !res.body) throw new Error('portal send failed (HTTP ' + res.status + ')');
          var reader = res.body.getReader();
          var dec = new TextDecoder();
          var buf = '';
          var count = 0;
          function pump() {
            return reader.read().then(function (chunk) {
              if (chunk.done) return count;
              buf += dec.decode(chunk.value, { stream: true });
              var frames = buf.split('\n\n');
              buf = frames.pop();
              for (var i = 0; i < frames.length; i++) {
                var line = frames[i].split('\n')
                  .filter(function (l) { return l.indexOf('data:') === 0; })
                  .map(function (l) { return l.slice(5).trim(); })
                  .join('');
                if (!line) continue;
                var ev;
                try { ev = JSON.parse(line); } catch (x) { continue; }
                count++;
                if (opts.onEvent) opts.onEvent(ev);
              }
              return pump();
            });
          }
          return pump();
        });
      }
    };
  }

  function setTransport(t) { transport = t; probeCache = null; }
  function getTransport() { return transport; }

  // ── probe (cached 30s; every send re-checks when stale) ──────────────────
  var probeCache = null; // {at, result}
  function probe(force) {
    if (!transport) return Promise.resolve({ connected: false, hint: 'no transport configured' });
    if (!force && probeCache && (Date.now() - probeCache.at) < 30000) {
      return Promise.resolve(probeCache.result);
    }
    return Promise.resolve()
      .then(function () { return transport.probe(); })
      .then(function (r) {
        probeCache = { at: Date.now(), result: r || { connected: false } };
        return probeCache.result;
      }, function (e) {
        probeCache = { at: Date.now(), result: { connected: false, hint: String(e && e.message || e) } };
        return probeCache.result;
      });
  }

  // ── thread history (localStorage, last 20 turns per thread) ──────────────
  function histKey(threadId) { return 'gur.portal.thread.' + threadId; }
  function history(threadId) {
    try {
      var raw = root.localStorage && root.localStorage.getItem(histKey(threadId));
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function pushHistory(threadId, role, text) {
    try {
      if (!root.localStorage) return;
      var arr = history(threadId);
      arr.push({ role: role, text: String(text).slice(0, 2000), at: new Date().toISOString() });
      while (arr.length > 20) arr.shift();
      root.localStorage.setItem(histKey(threadId), JSON.stringify(arr));
    } catch (e) { /* private mode etc. */ }
  }

  // ── declarative template → renderer (code never crosses the wire) ────────
  var TEMPLATE_HINTS = ['card', 'table', 'chart', 'raw', 'form'];

  /**
   * Compile {hint, summaryKeys?, title?} into a capability renderer that takes
   * over mode:"result" ONLY (returns null otherwise so schema-generated
   * invoke forms are never displaced).
   */
  function templateRenderer(template) {
    template = template || {};
    var hint = TEMPLATE_HINTS.indexOf(template.hint) !== -1 ? template.hint : 'card';
    return function (cap, opts) {
      if (!opts || opts.mode !== 'result') return null; // decline: template governs results only
      var eng = getEngine();
      if (!eng) return null;
      var shaped = {
        id: cap && cap.id,
        ui: { hint: hint, summaryKeys: Array.isArray(template.summaryKeys) ? template.summaryKeys : [] }
      };
      var wrap = el('div', 'gur-scope');
      if (template.title) wrap.appendChild(el('div', 'gur-panel-h', String(template.title)));
      wrap.appendChild(eng.renderResult(shaped, opts.result !== undefined ? opts.result : opts.data));
      return wrap;
    };
  }

  // Track live registrations so a newer portal.renderer for the same key
  // replaces (not stacks under) the previous one.
  var viewRenderers = {}; // key → unregister()

  /**
   * Register (or replace) a view renderer. fnOrTemplate: a function (advanced,
   * local code) or a declarative template object (the wire-safe path).
   * @returns {Function|null} unregister
   */
  function registerViewRenderer(key, fnOrTemplate, opts) {
    var reg = getRegistry();
    if (!reg || typeof key !== 'string' || key.indexOf('cap:') !== 0) return null;
    var fn = (typeof fnOrTemplate === 'function') ? fnOrTemplate : templateRenderer(fnOrTemplate);
    if (viewRenderers[key]) { try { viewRenderers[key](); } catch (e) { /* gone */ } }
    var un = reg.registerRenderer(key, fn, Object.assign({ name: 'portal:' + key, priority: 5 }, opts || {}));
    viewRenderers[key] = un;
    return un;
  }

  /**
   * Handle a portal.* CUSTOM event from the agent's reply stream.
   * @returns {boolean} true when it was a portal event (handled).
   */
  function handlePortalEvent(ev, view) {
    if (!ev || ev.type !== 'CUSTOM' || typeof ev.name !== 'string') return false;
    if (ev.name === 'portal.renderer') {
      var v = ev.value || {};
      if (typeof v.key === 'string' && v.key.indexOf('cap:') === 0 && v.template && typeof v.template === 'object') {
        registerViewRenderer(v.key, v.template);
        if (view && typeof view.onRerender === 'function') {
          try { view.onRerender(v.key, v.template); } catch (e) { /* view's problem */ }
        }
      }
      return true;
    }
    if (ev.name === 'portal.view') {
      var val = ev.value || {};
      if (view && typeof view.onViewData === 'function') {
        try { view.onViewData(val); } catch (e) { /* view's problem */ }
      }
      return true;
    }
    return false;
  }

  // ── composer (the per-view affordance) ────────────────────────────────────
  var HOOK_SHORT = [
    'The portal is wired; the agent is not (nothing conversational runs on this server yet).',
    'Required hook — see the header of genui-render/portal.js for the full contract:',
    '  GET  /api/portal/agent            → {"ok":true,"agent":"...","transport":"agui-run"}',
    '  POST /api/agui/run                → accept {messages, forwardedProps.portal},',
    '       stream TEXT_MESSAGE_* (+ optional CUSTOM portal.renderer / portal.view)',
    '       back as SSE frames. Wire it to an LLM key (ANTHROPIC_API_KEY / the',
    '       /api/copilotkit runtime) or a `claude -p --output-format stream-json` bridge.'
  ].join('\n');

  /**
   * Mount a composer into `host` for one view.
   * @param {HTMLElement} host
   * @param {{threadId:string, capId?:string, lens?:string, title?:string,
   *          rendererKey?:string, streamHost?:HTMLElement,
   *          onRerender?:Function, onViewData?:Function, placeholder?:string}} view
   * @returns {{el:HTMLElement, send:Function, dispose:Function}}
   */
  function attach(host, view) {
    view = view || {};
    if (!view.threadId) view.threadId = 't-view-' + uuid().slice(0, 8);
    ensureStyles();

    var box = el('div', 'gur-portal gur-scope');
    box.setAttribute('data-portal-thread', view.threadId);

    var replies = view.streamHost || el('div', 'gur-portal-replies');
    if (!view.streamHost) box.appendChild(replies);

    // prior turns on this thread (continuity across reopen)
    var past = history(view.threadId);
    if (past.length && !view.streamHost) {
      replies.classList.add('has-content');
      past.slice(-6).forEach(function (h) {
        var b = el('div', 'gur-portal-you gur-portal-hist');
        b.appendChild(el('div', 'gur-portal-role', h.role === 'user' ? 'you (earlier)' : 'agent (earlier)'));
        b.appendChild(el('div', null, h.text));
        replies.appendChild(b);
      });
    }

    var form = el('form', 'gur-portal-form');
    var input = el('input', 'gur-portal-input');
    input.type = 'text';
    input.placeholder = view.placeholder ||
      ('Ask about / refine this view' + (view.title ? (' — ' + view.title) : '') + '…');
    input.setAttribute('aria-label', 'Message the agent behind this view');
    var send = el('button', 'gur-portal-send', 'Ask');
    send.type = 'submit';
    form.appendChild(input);
    form.appendChild(send);
    box.appendChild(form);

    var status = el('div', 'gur-portal-status', 'checking for a connected agent…');
    box.appendChild(status);

    var hook = el('details', 'gur-portal-hook');
    hook.appendChild(el('summary', null, 'How to connect an agent'));
    hook.appendChild(el('pre', null, HOOK_SHORT));
    hook.hidden = true;
    box.appendChild(hook);

    var stream = null;
    function ensureStream() {
      if (stream) return stream;
      var evs = getEvents();
      if (evs && typeof evs.createEventStream === 'function') {
        stream = evs.createEventStream(replies, { threadId: view.threadId, maxNodes: 120 });
      }
      return stream;
    }

    function setStatus(text, cls) {
      status.textContent = text;
      status.className = 'gur-portal-status' + (cls ? ' ' + cls : '');
    }

    function showProbe(r) {
      if (r.connected) {
        setStatus('agent: ' + (r.agent || 'connected') + (r.transport ? ' · ' + r.transport : ''), 'gur-portal-live');
        hook.hidden = true;
      } else {
        setStatus('No agent connected — connect an LLM to enable conversation.'
          + (r.hint ? ' (' + r.hint + ')' : ''), 'gur-portal-off');
        hook.hidden = false;
      }
      return r;
    }

    probe().then(showProbe);

    function doSend(text) {
      var youCard = el('div', 'gur-portal-you');
      youCard.appendChild(el('div', 'gur-portal-role', 'you'));
      youCard.appendChild(el('div', null, text));
      replies.appendChild(youCard);
      replies.classList.add('has-content');
      try { replies.scrollTop = replies.scrollHeight; } catch (e) { /* shim */ }
      pushHistory(view.threadId, 'user', text);

      send.disabled = true;
      setStatus('sending…');
      var assistantText = '';
      var sawEvent = false;
      var s = ensureStream();

      return transport.send({
        threadId: view.threadId,
        runId: uuid(),
        messages: [{ id: 'm-' + uuid().slice(0, 8), role: 'user', content: text }],
        view: { capId: view.capId, lens: view.lens, rendererKey: view.rendererKey || null },
        onEvent: function (ev) {
          sawEvent = true;
          if (ev && ev.type === 'TEXT_MESSAGE_CONTENT') assistantText += String(ev.delta == null ? '' : ev.delta);
          var handled = handlePortalEvent(ev, view);
          if (s) s.push(ev);
          else if (!handled) {
            // minimal fallback rendering without events.js
            var line = el('div', 'gur-portal-you');
            line.appendChild(el('div', 'gur-portal-role', String(ev && ev.type || 'event')));
            var body = '';
            if (ev && ev.type === 'TEXT_MESSAGE_CONTENT') body = String(ev.delta || '');
            else if (ev && ev.type === 'RUN_ERROR') body = String(ev.message || 'error');
            else { try { body = JSON.stringify(ev); } catch (e) { body = ''; } }
            line.appendChild(el('div', null, body.slice(0, 400)));
            replies.appendChild(line);
          }
        }
      }).then(function () {
        send.disabled = false;
        input.value = '';
        if (assistantText) pushHistory(view.threadId, 'assistant', assistantText);
        if (!sawEvent) setStatus('agent returned no events — check the portal bridge.', 'gur-portal-err');
        else setStatus('agent replied on thread ' + view.threadId, 'gur-portal-live');
      }, function (err) {
        send.disabled = false; // text stays in the input — nothing is faked or lost
        setStatus('send failed: ' + String(err && err.message || err), 'gur-portal-err');
        probeCache = null; // force a fresh probe next time
      });
    }

    function onSubmit(e) {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      var text = String(input.value == null ? '' : input.value).trim();
      if (!text || send.disabled) return;
      if (!transport) { showProbe({ connected: false, hint: 'no transport configured' }); return; }
      probe().then(function (r) {
        showProbe(r);
        if (!r.connected) return; // degraded: banner shown, input kept, nothing faked
        doSend(text);
      });
    }
    form.addEventListener('submit', onSubmit);
    send.addEventListener('click', onSubmit);

    if (host && host.appendChild) host.appendChild(box);
    return {
      el: box,
      send: function (text) { input.value = text; onSubmit(); },
      probe: function () { return probe(true).then(showProbe); },
      dispose: function () { if (box.parentNode) box.parentNode.removeChild(box); }
    };
  }

  // ── the global affordance (floating, its own thread) ─────────────────────
  var globalMount = null;
  function attachGlobal(opts) {
    opts = opts || {};
    var d = doc();
    if (!d || !d.body) return null;
    if (globalMount) return globalMount;
    ensureStyles();

    var wrap = el('div', 'gur-portal-global');
    var panel = el('div', 'gur-portal-panel');
    panel.hidden = true;
    var ph = el('div', 'gur-portal-panel-h');
    ph.appendChild(el('span', null, 'Agent portal'));
    var close = el('button', 'gur-portal-close', '✕');
    close.type = 'button';
    ph.appendChild(close);
    panel.appendChild(ph);

    var composer = attach(panel, {
      threadId: opts.threadId || 't-portal-global',
      lens: opts.lens,
      title: 'this control plane',
      placeholder: 'Ask the agent behind this control plane…'
    });

    var fab = el('button', 'gur-portal-fab', '✦');
    fab.type = 'button';
    fab.title = 'Talk to the agent behind this UI';
    fab.setAttribute('aria-label', 'Open the agent portal');
    fab.onclick = function () {
      panel.hidden = !panel.hidden;
      if (!panel.hidden && composer.probe) composer.probe();
    };
    close.onclick = function () { panel.hidden = true; };

    wrap.appendChild(panel);
    wrap.appendChild(fab);
    d.body.appendChild(wrap);
    globalMount = { el: wrap, composer: composer, dispose: function () {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      globalMount = null;
    } };
    return globalMount;
  }

  var api = {
    attach: attach,
    attachGlobal: attachGlobal,
    setTransport: setTransport,
    getTransport: getTransport,
    httpTransport: httpTransport,
    probe: probe,
    handlePortalEvent: handlePortalEvent,
    templateRenderer: templateRenderer,
    registerViewRenderer: registerViewRenderer,
    history: history,
    ensureStyles: ensureStyles,
    HOOK_SHORT: HOOK_SHORT,
    _resetProbeCache: function () { probeCache = null; } // tests
  };
  return api;
});
