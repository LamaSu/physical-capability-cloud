/* @harness/genui-render — AG-UI event renderers (+ PCC profile)
 *
 * renderEvent(event [, ctx]) → HTMLElement
 * createEventStream(container [, opts]) → { push, ctx, state, dispose }
 *
 * Written ONCE, reused by every capability (UNIFIED-CONTROL-PLANE.md Part 6:
 * "~15 event renderers"). Covers the AG-UI vocabulary emitted by
 * lib/genui/agui-events.js:
 *
 *   RUN_STARTED · RUN_ERROR
 *   RUN_FINISHED     → success | interrupt (approve/deny card WIRED to the
 *                      resume POST, editedArgs supported) | receipt panel
 *   TOOL_CALL_START/ARGS/END/RESULT
 *   TEXT_MESSAGE_START/CONTENT/END · MESSAGES_SNAPSHOT
 *   STATE_SNAPSHOT   → replace ctx.state, re-render the pinned state panel
 *   STATE_DELTA      → apply RFC-6902 patch (replace/add/remove), re-render
 *   STEP_STARTED/FINISHED · ACTIVITY_SNAPSHOT/DELTA
 *   CUSTOM           → generic name/value card, EXCEPT the PCC profile:
 *     pcc.escrow | pcc.attestation | pcc.settlement → one escrow/settle
 *     progress strip per job:  pre-auth → executing → evidence-in →
 *     verified → settled  (the 3-phase Verdict made visual; slash/dispute
 *     renders the reached stage red)
 *
 * Interrupt resume contract (matches shipped lib/agui-view.html): POST
 *   { threadId, runId, resume:[{ interruptId, status:'resolved'|'cancelled',
 *     payload:{ approved [, editedArgs] } }], state:{}, messages:[], tools:[],
 *     context:[], forwardedProps:{} }
 * to ctx.resume.url (default '/api/agui/run') via ctx.resume.post(url,payload)
 * (default: fetch). editedArgs is a FULL REPLACEMENT of the original args,
 * never a merge (agui-hitl.js contract). PCC milestone approvals arrive as
 * the same interrupt with reason 'pcc:milestone-approval' — same card.
 *
 * ctx (all optional; createEventStream builds one) — { state, statePanel,
 *   strips, tools, msgs, threadId, resume:{url, post}, onResume(detail) }.
 * Custom renderers from registry.js override any event renderer
 * ('event:custom:<name>' > 'event:type:<TYPE>'; null return = decline).
 *
 * Security: textContent/createElement only — no innerHTML (see engine.js).
 * Module format: zero-build universal (see registry.js header).
 */
(function (root, factory) {
  'use strict';
  var isNodeModule = (typeof module === 'object' && module !== null && module.exports);
  var api = factory(root, isNodeModule ? function (n) { return require(n); } : null);
  var g = (root.GenUIRender = root.GenUIRender || {});
  g.events = api;
  if (isNodeModule) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, nodeRequire) {
  'use strict';

  function getEngine() {
    if (nodeRequire) { try { return nodeRequire('./engine.js'); } catch (e) { /* soft */ } }
    var g = root.GenUIRender;
    return (g && g.engine) ? g.engine : null;
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
  function stringify(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'object') { try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); } }
    return String(v);
  }
  function shortHash(h) {
    var s = String(h);
    return s.length > 14 ? s.slice(0, 8) + '…' + s.slice(-4) : s;
  }
  function uuid() {
    var c = root.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return 'r-' + String(Math.random()).slice(2) + '-' + Date.now().toString(36);
  }
  function ensureStyles() {
    var eng = getEngine();
    if (eng && eng.ensureStyles) eng.ensureStyles();
  }

  // Event card scaffold — matches agui-view.html's .ev pattern.
  function card(cls, label, body) {
    var c = el('div', 'gur-ev gur-scope' + (cls ? ' ' + cls : ''));
    c.appendChild(el('div', 'gur-ev-lbl', label));
    if (body !== undefined && body !== null) {
      c.appendChild(el('pre', 'gur-pre', typeof body === 'string' ? body : stringify(body)));
    }
    return c;
  }
  function feedline(txt) { return el('div', 'gur-feedline gur-scope', txt); }

  // ── RFC-6902 apply (replace/add/remove — the subset the harness emits) ────
  function ptr(obj, path) {
    var parts = path.split('/').slice(1).map(function (s) {
      return s.replace(/~1/g, '/').replace(/~0/g, '~');
    });
    var parent = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      var k = parts[i];
      if (Array.isArray(parent)) k = parseInt(k, 10);
      if (parent[k] === null || parent[k] === undefined) parent[k] = {};
      parent = parent[k];
    }
    var last = parts[parts.length - 1];
    if (Array.isArray(parent) && last !== '-') last = parseInt(last, 10);
    return { parent: parent, key: last };
  }
  function applyPatch(state, patch) {
    if (!Array.isArray(patch)) return state;
    for (var i = 0; i < patch.length; i++) {
      var op = patch[i];
      if (!op || typeof op.path !== 'string') continue;
      if (op.path === '') {
        if (op.op === 'replace' || op.op === 'add') state = op.value;
        continue;
      }
      try {
        var t = ptr(state, op.path);
        if (op.op === 'remove') {
          if (Array.isArray(t.parent)) t.parent.splice(t.key, 1);
          else delete t.parent[t.key];
        } else if (op.op === 'add' && Array.isArray(t.parent) && t.key === '-') {
          t.parent.push(op.value);
        } else {
          t.parent[t.key] = op.value;
        }
      } catch (e) { /* skip bad op; next snapshot resyncs */ }
    }
    return state;
  }

  // ── state panel (pinned; snapshot replaces, delta patches) ────────────────
  function renderStatePanel(ctx) {
    var eng = getEngine();
    if (!ctx.statePanel) {
      ctx.statePanel = el('div', 'gur-ev gur-scope gur-state-panel');
      ctx.statePanel.appendChild(el('div', 'gur-ev-lbl', 'state'));
      ctx._stateBody = el('div', 'gur-state-body');
      ctx.statePanel.appendChild(ctx._stateBody);
    }
    var body = ctx._stateBody;
    while (body.firstChild) body.removeChild(body.firstChild);
    var st = ctx.state;
    if (st === null || st === undefined) body.appendChild(el('div', 'gur-muted', 'no state'));
    else if (typeof st === 'object' && !Array.isArray(st) && eng) body.appendChild(eng.helpers.kvGrid(st));
    else body.appendChild(el('pre', 'gur-pre', stringify(st)));
    return ctx.statePanel;
  }

  // ── escrow / settle progress strip (the PCC profile) ──────────────────────
  var STAGES = [
    { id: 'pre-auth', label: 'pre-auth' },
    { id: 'executing', label: 'executing' },
    { id: 'evidence-in', label: 'evidence in' },
    { id: 'verified', label: 'verified' },
    { id: 'settled', label: 'settled' },
  ];
  var STAGE_IDS = STAGES.map(function (s) { return s.id; });

  function buildStrip(jobKey) {
    var block = el('div', 'gur-strip-block gur-scope');
    var lbl = el('div', 'gur-ev-lbl');
    lbl.appendChild(el('span', null, 'escrow / settlement'));
    if (jobKey && jobKey !== 'default') lbl.appendChild(el('span', 'gur-chip', 'job ' + jobKey));
    block.appendChild(lbl);
    var strip = el('div', 'gur-strip');
    var stageEls = {};
    STAGES.forEach(function (s, i) {
      if (i > 0) strip.appendChild(el('div', 'gur-stage-link'));
      var st = el('div', 'gur-stage');
      st.appendChild(el('div', 'gur-stage-dot'));
      st.appendChild(el('div', 'gur-stage-lbl', s.label));
      stageEls[s.id] = st;
      strip.appendChild(st);
    });
    block.appendChild(strip);
    var detail = el('div', 'gur-strip-detail', '');
    block.appendChild(detail);
    return { el: block, stageEls: stageEls, detail: detail, reached: -1, failed: false };
  }

  function setStripStage(stripObj, stageId, opts) {
    opts = opts || {};
    var idx = STAGE_IDS.indexOf(stageId);
    if (idx === -1) return;
    if (idx > stripObj.reached) stripObj.reached = idx;
    STAGES.forEach(function (s, i) {
      var node = stripObj.stageEls[s.id];
      var cls = 'gur-stage';
      if (i < stripObj.reached) cls += ' gur-done';
      else if (i === stripObj.reached) {
        cls += opts.failed ? ' gur-failed'
          : (stripObj.reached === STAGES.length - 1 ? ' gur-done' : ' gur-active');
      }
      node.className = cls;
    });
    if (opts.failed) stripObj.failed = true;
    if (opts.detail) stripObj.detail.textContent = opts.detail;
  }

  function stageForPcc(name, value) {
    value = value || {};
    var status = String(value.status || value.state || '').toLowerCase();
    if (name === 'pcc.escrow') {
      if (/funded|locked|escrowed|active/.test(status)) return { stage: 'executing' };
      return { stage: 'pre-auth' };
    }
    if (name === 'pcc.attestation') {
      if (/verified|attested|passed|ok|accept/.test(status)) return { stage: 'verified' };
      return { stage: 'evidence-in' };
    }
    if (name === 'pcc.settlement') {
      if (/slash|dispute|refund|fail/.test(status)) return { stage: 'settled', failed: true };
      return { stage: 'settled' };
    }
    return null;
  }

  function pccDetail(name, value) {
    value = value || {};
    var bits = [name.replace('pcc.', '')];
    if (value.status || value.state) bits.push(String(value.status || value.state));
    if (value.amount !== undefined) bits.push(String(value.amount) + (value.currency ? ' ' + value.currency : ' USDC'));
    if (value.tier !== undefined) bits.push('tier ' + value.tier);
    if (value.txHash) bits.push('tx ' + shortHash(value.txHash));
    if (value.receiptCID) bits.push('receipt ' + shortHash(value.receiptCID));
    return bits.join(' · ');
  }

  function getStrip(ctx, value) {
    var key = String((value && (value.jobId || value.escrowId || value.runId)) || 'default');
    ctx.strips = ctx.strips || {};
    if (!ctx.strips[key]) ctx.strips[key] = buildStrip(key);
    return ctx.strips[key];
  }

  function renderPccEvent(ev, ctx) {
    var strip = getStrip(ctx, ev.value);
    var m = stageForPcc(ev.name, ev.value);
    if (m) setStripStage(strip, m.stage, { failed: m.failed, detail: pccDetail(ev.name, ev.value) });
    return strip.el; // same element returned each time — caller appends once, it updates in place
  }

  // ── interrupt card — approve/deny wired to the resume POST ────────────────
  function defaultPost(url, payload) {
    if (typeof root.fetch !== 'function') {
      return Promise.reject(new Error('no fetch available — supply ctx.resume.post'));
    }
    return root.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  function renderInterrupt(intr, ev, ctx) {
    intr = intr || {};
    var isMilestone = intr.reason === 'pcc:milestone-approval' ||
      (intr.metadata && intr.metadata.reason === 'pcc:milestone-approval');
    var c = el('div', 'gur-ev gur-scope gur-ev-interrupt');
    var lbl = el('div', 'gur-ev-lbl');
    lbl.appendChild(el('span', null, isMilestone ? 'milestone approval required' : 'approval required'));
    if (intr.reason) lbl.appendChild(el('span', 'gur-chip', intr.reason));
    c.appendChild(lbl);
    if (intr.message) c.appendChild(el('pre', 'gur-pre', String(intr.message)));
    if (intr.metadata && Object.keys(intr.metadata).length) {
      c.appendChild(el('pre', 'gur-pre', stringify(intr.metadata)));
    }

    // editedArgs — FULL REPLACEMENT of the original args (never merged)
    var argsBox = null;
    var origArgs = intr.metadata && intr.metadata.args;
    if (origArgs && typeof origArgs === 'object') {
      var editLbl = el('div', 'gur-label', 'args (edit before approving — full replacement)');
      argsBox = el('textarea', 'gur-argsbox');
      argsBox.value = JSON.stringify(origArgs, null, 2);
      var editWrap = el('div', 'gur-form');
      editWrap.appendChild(editLbl);
      editWrap.appendChild(argsBox);
      c.appendChild(editWrap);
    }

    var errEl = el('div', 'gur-err', '');
    var statusEl = el('div', 'gur-feedline', '');
    var actions = el('div', 'gur-actions');
    var approve = el('button', 'gur-btn', 'Approve');
    approve.type = 'button';
    var deny = el('button', 'gur-btn gur-btn-deny', 'Deny');
    deny.type = 'button';
    actions.appendChild(approve);
    actions.appendChild(deny);
    c.appendChild(actions);
    c.appendChild(errEl);
    c.appendChild(statusEl);

    var resumeCfg = (ctx && ctx.resume) || {};
    var url = resumeCfg.url || '/api/agui/run';
    var post = resumeCfg.post || defaultPost;
    var threadId = (ctx && ctx.threadId) || ev.threadId || ('t-' + uuid().slice(0, 8));

    function resume(approved) {
      errEl.textContent = '';
      var payload = { approved: approved };
      if (approved && argsBox) {
        var raw = String(argsBox.value == null ? '' : argsBox.value).trim();
        if (raw) {
          var edited;
          try { edited = JSON.parse(raw); }
          catch (e) {
            errEl.textContent = 'invalid args JSON: ' + String(e.message || e);
            if (argsBox.classList) argsBox.classList.add('gur-invalid');
            return; // do not send a malformed resume
          }
          if (JSON.stringify(edited) !== JSON.stringify(origArgs)) payload.editedArgs = edited;
        }
      }
      approve.disabled = true;
      deny.disabled = true;
      var body = {
        threadId: threadId,
        runId: uuid(),
        resume: [{
          interruptId: intr.id,
          status: approved ? 'resolved' : 'cancelled',
          payload: payload,
        }],
        state: {}, messages: [], tools: [], context: [], forwardedProps: {},
      };
      statusEl.textContent = 'posting resume (' + (approved ? 'resolved' : 'cancelled') + ')…';
      var detail = { url: url, body: body, approved: approved, interrupt: intr };
      var posted;
      try { posted = post(url, body); } // fires synchronously, like fetch
      catch (err) { posted = Promise.reject(err); }
      Promise.resolve(posted)
        .then(function (res) {
          statusEl.textContent = 'resume posted — ' + (approved ? 'approved' : 'denied');
          if (ctx && typeof ctx.onResume === 'function') ctx.onResume(detail, res);
        })
        .catch(function (err) {
          approve.disabled = false;
          deny.disabled = false;
          statusEl.textContent = '';
          errEl.textContent = 'resume failed: ' + String((err && err.message) || err);
        });
    }
    approve.addEventListener('click', function () { resume(true); });
    deny.addEventListener('click', function () { resume(false); });
    c._gurResume = resume; // exposed for tests
    return c;
  }

  // ── RUN_FINISHED (success | interrupt | receipt) ──────────────────────────
  function looksLikeReceipt(result) {
    if (!result || typeof result !== 'object') return false;
    var r = result.receipt || result;
    return !!(r.receiptCID || r.evidenceBundleHash || r.paymentTxHash || r.dccClass !== undefined);
  }

  function renderRunFinished(ev, ctx) {
    if (ev.outcome && ev.outcome.type === 'interrupt' &&
        Array.isArray(ev.outcome.interrupts) && ev.outcome.interrupts.length) {
      // one card per interrupt (usually exactly one)
      if (ev.outcome.interrupts.length === 1) return renderInterrupt(ev.outcome.interrupts[0], ev, ctx);
      var wrap = el('div', 'gur-scope');
      ev.outcome.interrupts.forEach(function (i) { wrap.appendChild(renderInterrupt(i, ev, ctx)); });
      return wrap;
    }
    if (ev.result && ev.result.cancelled) return card('', 'run finished', 'cancelled');
    if (looksLikeReceipt(ev.result)) {
      var eng = getEngine();
      var c = card('gur-ev-success', 'run finished — settled');
      var receipt = ev.result.receipt || ev.result;
      if (eng) c.appendChild(eng.renderReceipt(receipt));
      else c.appendChild(el('pre', 'gur-pre', stringify(receipt)));
      if (ev.result.verdict && eng) c.appendChild(eng.renderVerdict(ev.result.verdict));
      return c;
    }
    var body = (ev.result !== undefined && ev.result !== null) ? ev.result : 'success';
    return card('gur-ev-success', 'run finished', body);
  }

  // ── tool-call lifecycle (args accumulate into the START card) ─────────────
  function renderToolCallStart(ev, ctx) {
    var c = card('', 'tool call');
    var lbl = c.childNodes[0];
    lbl.appendChild(el('span', 'gur-chip', ev.toolCallName || ev.toolCallId));
    var argsPre = el('pre', 'gur-pre gur-tool-args', '');
    c.appendChild(argsPre);
    if (ctx) {
      ctx.tools = ctx.tools || {};
      ctx.tools[ev.toolCallId] = { el: c, argsPre: argsPre, args: '' };
    }
    return c;
  }
  function renderToolCallArgs(ev, ctx) {
    var t = ctx && ctx.tools && ctx.tools[ev.toolCallId];
    if (t) {
      t.args += String(ev.delta == null ? '' : ev.delta);
      t.argsPre.textContent = t.args;
      return t.el; // updated in place
    }
    return feedline('args… ' + String(ev.delta == null ? '' : ev.delta));
  }
  function renderToolCallEnd(ev, ctx) {
    var t = ctx && ctx.tools && ctx.tools[ev.toolCallId];
    if (t) {
      if (!t.args) { try { t.el.removeChild(t.argsPre); } catch (e) { /* ok */ } }
      return t.el;
    }
    return feedline('tool call end');
  }
  function renderToolCallResult(ev, ctx) {
    var content = ev.content;
    var parsed = null;
    if (typeof content === 'string') {
      try { parsed = JSON.parse(content); } catch (e) { parsed = null; }
    } else if (content && typeof content === 'object') parsed = content;
    var c = card('', 'result');
    var eng = getEngine();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && eng) {
      c.appendChild(eng.helpers.kvGrid(parsed));
    } else {
      c.appendChild(el('pre', 'gur-pre', typeof content === 'string' ? content : stringify(content)));
    }
    return c;
  }

  // ── text messages (deltas merge into one bubble per messageId) ────────────
  function msgBubble(ctx, messageId, role) {
    ctx.msgs = ctx.msgs || {};
    if (!ctx.msgs[messageId]) {
      var c = el('div', 'gur-ev gur-scope gur-msg');
      c.appendChild(el('div', 'gur-ev-lbl', role || 'message'));
      var body = el('pre', 'gur-pre', '');
      c.appendChild(body);
      ctx.msgs[messageId] = { el: c, body: body, text: '' };
    }
    return ctx.msgs[messageId];
  }
  function renderTextStart(ev, ctx) {
    if (ctx) return msgBubble(ctx, ev.messageId, ev.role).el;
    return feedline('message start (' + (ev.role || 'assistant') + ')');
  }
  function renderTextContent(ev, ctx) {
    if (ctx) {
      var m = msgBubble(ctx, ev.messageId);
      m.text += String(ev.delta == null ? '' : ev.delta);
      m.body.textContent = m.text;
      return m.el;
    }
    return card('', 'message', String(ev.delta == null ? '' : ev.delta));
  }
  function renderTextEnd(ev, ctx) {
    if (ctx && ctx.msgs && ctx.msgs[ev.messageId]) return ctx.msgs[ev.messageId].el;
    return feedline('message end');
  }

  // ── the dispatch table ─────────────────────────────────────────────────────
  var RENDERERS = {
    RUN_STARTED: function (ev) {
      return card('', 'run started', 'thread ' + (ev.threadId || '—') + ' · run ' + (ev.runId || '—'));
    },
    RUN_FINISHED: renderRunFinished,
    RUN_ERROR: function (ev) {
      return card('gur-ev-error', 'error' + (ev.code ? ' (' + ev.code + ')' : ''), ev.message || 'unknown error');
    },
    TOOL_CALL_START: renderToolCallStart,
    TOOL_CALL_ARGS: renderToolCallArgs,
    TOOL_CALL_END: renderToolCallEnd,
    TOOL_CALL_RESULT: renderToolCallResult,
    TEXT_MESSAGE_START: renderTextStart,
    TEXT_MESSAGE_CONTENT: renderTextContent,
    TEXT_MESSAGE_END: renderTextEnd,
    MESSAGES_SNAPSHOT: function (ev) {
      var msgs = Array.isArray(ev.messages) ? ev.messages : [];
      return card('', 'messages snapshot', msgs.length + ' message' + (msgs.length === 1 ? '' : 's') +
        (msgs.length ? ' · roles: ' + msgs.map(function (m) { return m && m.role; }).join(', ') : ''));
    },
    STATE_SNAPSHOT: function (ev, ctx) {
      if (ctx) {
        ctx.state = ev.snapshot || {};
        return renderStatePanel(ctx);
      }
      return card('', 'state snapshot', ev.snapshot);
    },
    STATE_DELTA: function (ev, ctx) {
      if (ctx) {
        ctx.state = applyPatch(ctx.state !== undefined ? ctx.state : {}, ev.delta || []);
        return renderStatePanel(ctx);
      }
      return card('', 'state delta', ev.delta);
    },
    STEP_STARTED: function (ev) { return feedline('▶ step: ' + (ev.stepName || '—')); },
    STEP_FINISHED: function (ev) { return feedline('✓ step: ' + (ev.stepName || '—')); },
    ACTIVITY_SNAPSHOT: function (ev) {
      var state = ev.content && (ev.content.state || ev.content.status);
      return feedline('● ' + (ev.messageId || '—') + ' [' + (ev.activityType || 'activity') + '] ' +
        (state !== undefined ? String(state) : stringify(ev.content)));
    },
    ACTIVITY_DELTA: function (ev) {
      var v = ev.patch && ev.patch[0] && ev.patch[0].value;
      return feedline('● ' + (ev.messageId || '—') + ' [' + (ev.activityType || 'activity') + '] → ' +
        (v !== undefined ? String(typeof v === 'object' ? JSON.stringify(v) : v) : 'patched'));
    },
    CUSTOM: function (ev, ctx) {
      if (ev.name === 'pcc.escrow' || ev.name === 'pcc.attestation' || ev.name === 'pcc.settlement') {
        return renderPccEvent(ev, ctx || (ctx = {}));
      }
      return card('', 'custom · ' + (ev.name || '—'), ev.value);
    },
  };

  /**
   * MAIN ENTRY — render one AG-UI event.
   * Stateful events (STATE_*, TOOL_CALL_ARGS, TEXT_MESSAGE_*, pcc.*) update
   * shared elements held on ctx and return the SAME element — append-once,
   * updates land in place. Without a ctx every event renders standalone.
   * @param {object} event   AG-UI event ({type, ...})
   * @param {object} [ctx]   shared stream context (see createEventStream)
   * @returns {HTMLElement}
   */
  function renderEvent(event, ctx) {
    ensureStyles();
    if (!event || typeof event.type !== 'string') {
      return card('gur-ev-error', 'bad event', event);
    }
    // custom renderer override (event:custom:<name> > event:type:<TYPE>)
    var reg = getRegistry();
    if (reg && !(ctx && ctx.skipCustom)) {
      var entries = reg.resolveAll(event);
      for (var i = 0; i < entries.length; i++) {
        var node = null;
        try { node = entries[i].fn(event, ctx, api); }
        catch (e) { node = null; }
        if (node) {
          if (node.setAttribute) node.setAttribute('data-renderer', entries[i].key);
          return node;
        }
      }
    }
    var fn = RENDERERS[event.type];
    if (!fn) return card('', event.type, event);
    return fn(event, ctx);
  }

  /**
   * Stateful stream helper: owns a ctx (state store, tool-call cards, message
   * bubbles, escrow strips), appends each rendered element to `container`
   * exactly once, and lets in-place updaters mutate instead of duplicate.
   * @param {HTMLElement} container
   * @param {{threadId?:string, resume?:{url?:string, post?:Function},
   *          onResume?:Function, maxNodes?:number}} [opts]
   */
  function createEventStream(container, opts) {
    opts = opts || {};
    ensureStyles();
    var ctx = {
      state: undefined,
      statePanel: null,
      strips: {},
      tools: {},
      msgs: {},
      threadId: opts.threadId,
      resume: opts.resume || {},
      onResume: opts.onResume,
    };
    var maxNodes = opts.maxNodes || 400;
    function push(event) {
      var node = renderEvent(event, ctx);
      if (!node) return null;
      // append only if not already in the container (in-place updaters return existing nodes)
      if (node.parentNode !== container) container.appendChild(node);
      try {
        while (container.childNodes.length > maxNodes) container.removeChild(container.firstChild);
        if (typeof container.scrollHeight === 'number') container.scrollTop = container.scrollHeight;
      } catch (e) { /* shim without scroll — fine */ }
      return node;
    }
    return {
      push: push,
      ctx: ctx,
      state: function () { return ctx.state; },
      dispose: function () { ctx.tools = {}; ctx.msgs = {}; ctx.strips = {}; },
    };
  }

  var api = {
    renderEvent: renderEvent,
    createEventStream: createEventStream,
    renderInterrupt: renderInterrupt,
    applyPatch: applyPatch,
    STAGES: STAGES,
    _stageForPcc: stageForPcc, // exposed for tests
  };
  return api;
});
