/* PCC On-Ramp — pcc-ui.js (the kit)  ·  ui-kit v1
 *
 * ONE renderer for a DashboardManifest, four transports. A person's LLM emits a
 * small declarative manifest (windows + bindings + actions, schema'd by
 * @pcc/spec `DashboardManifestSchema`); this file turns any manifest into the
 * finished dashboard — identically whether it is served by the gateway
 * (`/a/:slug`), opened from `file://`, inlined as a chat artifact, or bridged by
 * an MCP-Apps host. The LLM composes; the kit renders.
 *
 * WHY a shipped kit instead of LLM-authored HTML: shared artifacts are UNTRUSTED
 * content rendered in a context where the viewer's PCC key is in scope. A
 * declarative manifest rendered `textContent`-only is the stored-XSS boundary.
 * That single reason makes SHARE shippable, and it is the most important rule in
 * this file — see the security invariants below.
 *
 * Security invariants (kit-owned; On-Ramp spec §6.2 + §4.2):
 *   1. textContent ONLY. No innerHTML, no eval, no new Function, no outerHTML=.
 *   2. No action fires on load, EVER. Render is passive; execution is a click.
 *   3. Money verbs (fund/release/dispute/commit/approve) go through the kit's
 *      Approval surface; only its Approve button POSTs.
 *   4. `idempotencyKey` on every offer-posting action (a button can be
 *      double-clicked; the pack teaches the fix).
 *   5. The person's key lives in sessionStorage only — stripped from the URL
 *      fragment on boot, never rendered back into the DOM.
 *   6. Live streams use fetch-SSE with `Authorization: Bearer` — NEVER
 *      `EventSource` + `?token=` (sse-auth rejects keys there by design).
 *   7. A snapshot banner (with the data timestamp) shows whenever any binding is
 *      stale or baked. Never claim a dashboard is live when its data is baked.
 *
 * Visual system: the "subtraction" tokens/type/space/motion from the control-
 * plane redesign spec §3, VERBATIM (no purple; hue = meaning only —
 * green settled / amber waiting / red failed / blue running; inverted-neutral
 * primary; hairline in-flow, shadow only floating; tabular numerals on money;
 * dark+light via prefers-color-scheme + data-theme; reduced-motion kills motion).
 *
 * Vanilla classic-script IIFE — no build, no deps, no CDN. Runs from file://
 * with nothing installed. The proven transport (apiBase ladder + fetch-SSE
 * reader) is inlined from the control-plane `api.js`/`bus.js` so the kit ships
 * self-contained (an exported artifact inlines this whole file).
 */
(function () {
  'use strict';

  // A manifest may only be rendered once per document; guard re-entry.
  if (window.__PCC_UI_BOOTED__) return;
  window.__PCC_UI_BOOTED__ = true;

  var API_DEFAULT = 'https://capability.network';
  // sol#1 cross-family security review (2026-08-19): the fixed PCC API origin. EVERY
  // Bearer-authenticated request pins to this origin; untrusted manifest / query / localStorage
  // may never select it. Parsed origin (protocol+host+port), never a string/suffix compare.
  var API_ORIGIN = (function () { try { return new URL(API_DEFAULT).origin; } catch (e) { return API_DEFAULT; } })();
  var POLL_DEFAULT_MS = 30000; // the system_prompt's own recommended cadence
  var MONEY_VERB = /(?:^|[\/_.-])(fund|release|dispute|commit|approve)(?:[\/_.-]|$)/i;

  // ═══════════════════════════════════════════════════════════════════════
  // DOM helpers (verbatim shape from control-plane bus.js) — textContent only
  // ═══════════════════════════════════════════════════════════════════════

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt; // textContent — never innerHTML
    return e;
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function uuid() {
    return (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'x' + String(Math.random()).slice(2) + Date.now().toString(36);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MCP-App host embedding (R4 PR1 lockdown — D10/D14). An embedding host (an
  // MCP-Apps view) announces itself with window.__PCC_HOST__ = true BEFORE the
  // kit boots. In host mode the kit is a READ-ONLY renderer:
  //   • manifest-authored writes NEVER execute — every write control renders
  //     visibly disabled, and the action + transport layers refuse (a manifest
  //     is untrusted content, so it must not be able to author a money/API
  //     write from inside a host that carries ambient authority);
  //   • no PCC key is ever read, written, or prompted — a sibling view sharing
  //     the same host origin can neither drive a write nor read a stored key.
  // Reads keep working; a read that would need a key simply has none and
  // degrades to the honest stale/empty state (never fabricated). PR2 reintroduces
  // writes via a typed, server-authorized operation allowlist.
  // ═══════════════════════════════════════════════════════════════════════

  var HOST_WRITE_NOTE = 'Actions are unavailable in this host view.';
  function isHostEmbed() { return window.__PCC_HOST__ === true; }
  function hostDisableBtn(btn) {
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    if ((' ' + btn.className + ' ').indexOf(' pcc-btn-disabled ') === -1) btn.className += ' pcc-btn-disabled';
    if (!btn.title) btn.title = HOST_WRITE_NOTE;
  }
  // R4 PR2 — the registered typed-operation allowlist injected onto the window by
  // the host boot script (window.__PCC_HOST_OPERATIONS__). An action naming one
  // of these operations may run in host mode via the bridge; every other action
  // stays inert. Client-side default-DENY that mirrors the server registry.
  function hostOperationAllowed(operationId) {
    if (!operationId) return false;
    var ops = window.__PCC_HOST_OPERATIONS__;
    if (!ops || !ops.length) return false;
    for (var i = 0; i < ops.length; i++) { if (ops[i] === operationId) return true; }
    return false;
  }
  // True when an action maps to a REGISTERED typed operation reachable through
  // the host bridge — the only writes a hosted view may perform (PR2). Anything
  // else (no operation_id, an unregistered id, or no bridge) stays inert.
  function hostActionEnabled(action) {
    if (!isHostEmbed() || !action) return false;
    if (!hostOperationAllowed(action.operation_id)) return false;
    var b = window.__PCC_HOST_BRIDGE__;
    return !!(b && typeof b.callOperation === 'function');
  }
  // In host mode, disable every button inside an action container and append one
  // "unavailable" note — EXCEPT buttons wired to a registered typed operation
  // (class pcc-host-op-enabled), which stay live. No-op outside host mode.
  function hostLockActionBar(container) {
    if (!isHostEmbed() || !container) return;
    var btns = container.querySelectorAll ? container.querySelectorAll('button') : [];
    var lockedAny = false;
    for (var i = 0; i < btns.length; i++) {
      if ((' ' + btns[i].className + ' ').indexOf(' pcc-host-op-enabled ') !== -1) continue;
      hostDisableBtn(btns[i]);
      lockedAny = true;
    }
    if (lockedAny) container.appendChild(el('div', 'pcc-host-note pcc-muted', HOST_WRITE_NOTE));
  }
  function markWriteUnavailable(status) {
    if (!status) return;
    status.className = 'pcc-action-status';
    status.textContent = HOST_WRITE_NOTE;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The person's key — fragment → sessionStorage only, never into the DOM
  // ═══════════════════════════════════════════════════════════════════════

  var KEY_STORE = 'pcc.key';

  function bootKey() {
    // Host lockdown (D14): in an MCP-App/host view never read a fragment key or
    // touch storage — a hosted view holds no browser-persisted PCC credential.
    if (isHostEmbed()) return;
    // 1. #pcc_key=… in the URL fragment: how an LLM hands its OWN person a
    // private live link. Fragments never reach servers/logs. Strip immediately
    // so it cannot be read back off `location` and cannot leak into history.
    try {
      var h = location.hash || '';
      var m = h.match(/[#&]pcc_key=([^&]+)/);
      if (m && m[1]) {
        var k = decodeURIComponent(m[1]);
        try { sessionStorage.setItem(KEY_STORE, k); } catch (e) {}
        var cleaned = h.replace(/([#&])pcc_key=[^&]*/, '$1').replace(/[#&]+$/, '');
        try {
          history.replaceState(null, '', location.pathname + location.search + (cleaned && cleaned !== '#' ? cleaned : ''));
        } catch (e2) { try { location.hash = ''; } catch (e3) {} }
      }
    } catch (e) {}
  }
  function getKey() {
    // Host lockdown (D14): never read a (possibly sibling-view) stored key when
    // embedded in a host — a hosted view runs unauthenticated (public reads only).
    if (isHostEmbed()) return null;
    try { return sessionStorage.getItem(KEY_STORE) || null; } catch (e) { return null; }
  }
  function setKey(k) {
    // Host lockdown (D14): never persist a credential from inside a host view.
    if (isHostEmbed()) return;
    try { if (k) sessionStorage.setItem(KEY_STORE, k); else sessionStorage.removeItem(KEY_STORE); } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════════════════
  // apiBase resolution ladder (adapted from api.js; artifact-aware default)
  //   ?api= → localStorage → manifest.api_base → same-origin(http/s) → default
  // ═══════════════════════════════════════════════════════════════════════

  function resolveApiBase(manifest, isHost) {
    // sol#1 cross-family security review (2026-08-19): a shared manifest is UNTRUSTED content, and
    // ?api= / localStorage['pcc.apiBase'] are attacker-supplyable ambient input (a malicious shared
    // link can carry ?api=; a hostile render-origin script can seed localStorage). NONE of them may
    // select the origin for a Bearer-authenticated request — otherwise a shared dashboard redirects
    // the viewer's key to an attacker (credential-transport / confused-deputy). So manifest.api_base,
    // ?api= and localStorage are ALL ignored as transport destinations.
    //   - Host/MCP-App mode: pinned (already was).
    //   - Standalone: use relative (same-origin) URLs ONLY when THIS document is itself served from
    //     the API origin; every other render origin (a Claude artifact, file://, opaque/sandbox,
    //     localhost, a *.capability.network subdomain) pins to the fixed API origin.
    // Compare PARSED origins, never strings or hostname suffixes. Other deployments/dev select the
    // backend via a build-time API_DEFAULT, never a runtime override. (manifest.api_base stays in the
    // schema as ADVISORY metadata but is never a transport destination — ui-artifact.ts.)
    if (isHost) return API_ORIGIN;
    var renderOrigin;
    try { renderOrigin = location.origin; } catch (e) { return API_ORIGIN; }
    return renderOrigin === API_ORIGIN ? '' : API_ORIGIN;
  }

  // Whether apiBase points at the page's own origin (empty, or literal match).
  function isSameOrigin(apiBase) {
    if (apiBase === '') return true;
    try { return apiBase.replace(/\/+$/, '') === location.origin; } catch (e) { return false; }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Request-path safety (directive 10). Every manifest-supplied path is
  // UNTRUSTED. A path is only used against the RESOLVED base (forced to the PCC
  // origin in host mode) after passing here — no absolute/scheme URLs, no
  // protocol-relative //host, no path traversal, no backslash escapes. In host
  // mode it must also be in the PCC "/api" or "/sse" operation namespace — an
  // allowlist of supported operations instead of an arbitrary method+path.
  // ═══════════════════════════════════════════════════════════════════════

  function isAbsoluteOrSchemeUrl(p) {
    // any URL scheme (http, https, data, blob, or a script-URL scheme) or a
    // protocol-relative //host — all refused for a manifest-supplied path.
    return /^[a-z][a-z0-9+.\-]*:/i.test(p) || p.indexOf('//') === 0;
  }

  function safeApiPath(path, isHost) {
    if (typeof path !== 'string' || !path) return null;
    if (isAbsoluteOrSchemeUrl(path)) return null;   // no absolute / scheme / //host
    if (path.charAt(0) !== '/') return null;         // must be root-relative
    if (path.indexOf('\\') !== -1) return null;      // backslash escape
    var pathPart = path.split('?')[0];
    var decoded;
    try { decoded = decodeURIComponent(pathPart); } catch (e) { return null; } // malformed %-escape
    if (decoded.indexOf('\\') !== -1) return null;
    var segs = decoded.split('/');
    for (var i = 0; i < segs.length; i++) {
      if (segs[i] === '..' || segs[i] === '.') return null; // traversal (incl. %2e%2e)
    }
    if (decoded.indexOf('..') !== -1) return null;   // belt-and-suspenders (encoded joins)
    if (isHost && !/^\/(api|sse)(\/|$)/.test(decoded)) return null; // PCC namespace allowlist
    return path; // original path (query preserved) — safe against the fixed base
  }

  // The kit-derived TRUTH about the request an action will actually send —
  // method, resolved destination, amount/asset, and job/escrow ref — computed
  // from the REAL request (never manifest-supplied confirmation text, which can
  // differ from what is sent). `destination === null` means the path was refused.
  function describeRealRequest(apiBase, action, body, isHost) {
    var method = (action && action.kind === 'patch') ? 'PATCH' : 'POST';
    var safe = safeApiPath(action ? action.path : '', isHost);
    var destination = safe === null ? null : ((apiBase || '') + safe);
    var b = body || {};
    var amount = b.amount != null ? b.amount
      : (b.totalAmount != null ? b.totalAmount
      : (b.value != null ? b.value
      : (b.priceUSD != null ? b.priceUSD
      : (b.budgetUSD != null ? b.budgetUSD : null))));
    var asset = b.currency || b.asset || (amount != null ? 'USDC' : null);
    var refId = b.jobId || b.escrowId || b.escrowAddress || b.offerId
      || b.compositionId || b.id || null;
    return { method: method, destination: destination, amount: amount, asset: asset, refId: refId };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Formatting + dot-path pluck (no eval; a manual split/reduce)
  // ═══════════════════════════════════════════════════════════════════════

  function dot(obj, path) {
    if (path == null || path === '') return obj;
    var parts = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      var k = parts[i];
      cur = Array.isArray(cur) && /^\d+$/.test(k) ? cur[parseInt(k, 10)] : cur[k];
    }
    return cur;
  }

  function fmtUsd(v) {
    var n = Number(v);
    if (!isFinite(n)) return String(v == null ? '' : v);
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtTs(v) {
    if (v == null || v === '') return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    try { return d.toLocaleString(); } catch (e) { return d.toISOString(); }
  }
  function fmtVal(v, format) {
    if (v == null) return '—';
    switch (format) {
      case 'usd': return fmtUsd(v);
      case 'int': { var n = Number(v); return isFinite(n) ? Math.round(n).toLocaleString('en-US') : String(v); }
      case 'pct': { var p = Number(v); return isFinite(p) ? (p <= 1 ? (p * 100).toFixed(0) : p.toFixed(0)) + '%' : String(v); }
      case 'ts': return fmtTs(v);
      default: return typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
  }

  // Status → semantic pill class (hue = meaning only).
  function statusClass(s) {
    var t = String(s == null ? '' : s).toLowerCase();
    // A refund means the payer was made whole and the operator was NOT paid — it must NEVER
    // render as settled/green. "funded" matches inside "refunded", so this MUST precede the
    // settled check (money-display honesty; read-route contract rule 1).
    if (/refund/.test(t)) return 'st-failed';
    if (/(settl|releas|complet|done|paid|funded|success|approved|active)/.test(t)) return 'st-settled';
    if (/(fail|error|denied|dispute|cancel|reject)/.test(t)) return 'st-failed';
    if (/(wait|pending|queued|paused|review|created|needs)/.test(t)) return 'st-waiting';
    if (/(run|progress|stream|building|in_progress)/.test(t)) return 'st-running';
    return '';
  }

  // Pull the first array out of a response (for list windows without a select).
  function firstArray(resp) {
    if (Array.isArray(resp)) return resp;
    if (resp && typeof resp === 'object') {
      var keys = Object.keys(resp);
      for (var i = 0; i < keys.length; i++) if (Array.isArray(resp[keys[i]])) return resp[keys[i]];
    }
    return [];
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Snapshot store — baked data inlined at #pcc-snapshot (Tier B/C offline)
  //   shape: { "/api/jobs/x": <response>, ..., "_ts": "ISO-8601" }
  // ═══════════════════════════════════════════════════════════════════════

  function readSnapshot() {
    var node = document.getElementById('pcc-snapshot');
    if (!node) return null;
    try {
      var obj = JSON.parse(node.textContent || 'null');
      return obj && typeof obj === 'object' ? obj : null;
    } catch (e) { return null; }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Transport — Bearer everywhere; capture x-pcc-trace-id; fetch-SSE (no
  // EventSource+?token=). Never fires a write on its own.
  // ═══════════════════════════════════════════════════════════════════════

  function Transport(apiBase, isHost) {
    this.base = apiBase;
    this.isHost = !!isHost;
    this.lastTrace = null;
  }
  Transport.prototype._headers = function (extra) {
    var h = extra || {};
    var k = getKey();
    if (k) h['Authorization'] = 'Bearer ' + k;
    return h;
  };
  // sol#1 defense-in-depth: resolve the final request URL and PIN it to the API origin BEFORE any
  // Bearer is attached, so a future resolveApiBase regression can't leak the viewer's key. Returns
  // the absolute URL string, or null if it resolves outside the fixed PCC API origin (or carries
  // embedded credentials). Parsed-origin compare subsumes the https pin (the shipped API_DEFAULT is
  // https, so only https://capability.network satisfies equality). Callers REFUSE on null (getJSON /
  // streamSSE reject; send returns a structured {ok:false} refusal).
  Transport.prototype._pin = function (safe, query) {
    var u;
    try {
      var base = this.base || location.origin;
      u = new URL(safe + this.qs(query), base);
    } catch (e) { return null; }
    if (u.origin !== API_ORIGIN || u.username || u.password) return null;
    return u.toString();
  };
  Transport.prototype._trace = function (res) {
    try { var t = res.headers.get('x-pcc-trace-id'); if (t) this.lastTrace = t; } catch (e) {}
  };
  Transport.prototype.qs = function (query) {
    if (!query) return '';
    var parts = [];
    var keys = Object.keys(query);
    for (var i = 0; i < keys.length; i++) {
      var v = query[keys[i]];
      if (v == null) continue;
      parts.push(encodeURIComponent(keys[i]) + '=' + encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : String(v)));
    }
    return parts.length ? ('?' + parts.join('&')) : '';
  };
  Transport.prototype.getJSON = function (path, query) {
    var self = this;
    var safe = safeApiPath(path, this.isHost);
    if (safe === null) return Promise.reject(new Error('refused unsafe request path: ' + path));
    var url = this._pin(safe, query);
    if (url === null) return Promise.reject(new Error('refused: request resolves outside the PCC API origin'));
    return fetch(url, { headers: this._headers({ Accept: 'application/json' }), credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' })
      .then(function (r) {
        self._trace(r);
        if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + safe);
        return r.json();
      });
  };
  Transport.prototype.send = function (method, path, body) {
    var self = this;
    var safe = safeApiPath(path, this.isHost);
    if (safe === null) return Promise.resolve({ ok: false, status: 0, body: { message: 'Refused: unsafe or non-PCC request path.' } });
    var url = this._pin(safe);
    if (url === null) return Promise.resolve({ ok: false, status: 0, body: { message: 'Refused: request resolves outside the PCC API origin.' } });
    return fetch(url, {
      method: method,
      headers: this._headers({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: body != null ? JSON.stringify(body) : undefined,
      credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store'
    }).then(function (r) {
      self._trace(r);
      return r.json().catch(function () { return {}; }).then(function (j) {
        return { ok: r.ok, status: r.status, body: j };
      });
    });
  };
  // fetch-SSE reader (GET): Authorization Bearer header, parse `data:`-framed
  // SSE by \n\n split (the proven api.js parser). onEvent(ev) per frame.
  Transport.prototype.streamSSE = function (path, onEvent, opts) {
    opts = opts || {};
    var self = this;
    var safe = safeApiPath(path, this.isHost);
    if (safe === null) return Promise.reject(new Error('refused unsafe sse path: ' + path));
    var url = this._pin(safe);
    if (url === null) return Promise.reject(new Error('refused: sse resolves outside the PCC API origin'));
    var init = { headers: this._headers({ Accept: 'text/event-stream' }), credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' };
    if (opts.signal) init.signal = opts.signal;
    return fetch(url, init).then(function (res) {
      self._trace(res);
      if (!res.ok || !res.body) throw new Error('sse dispatch failed (HTTP ' + res.status + ')');
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
            if (onEvent) onEvent(ev);
          }
          return pump();
        });
      }
      return pump();
    });
  };

  // ═══════════════════════════════════════════════════════════════════════
  // Host transport (Tier D) — mode === 'host'. An embedding host (e.g. an
  // MCP-Apps view) has announced itself via window.__PCC_HOST__ = true.
  // Bindings prefer a host-mediated fetch/proxy channel when the host offers
  // one (window.__PCC_HOST_BRIDGE__.fetch — an optional contract a host may
  // set before the kit boots); otherwise this falls back to the SAME direct
  // fetch-with-Bearer behaviour as every other live transport (the view's
  // CSP explicitly allows connect-src to the PCC API origin, so a direct
  // fetch is a legitimate "live" path here, not a security gap). If neither
  // path is reachable, resolveBinding()'s existing fetch-failure handling
  // already degrades to any baked snapshot, else an honest stale/empty
  // state — never fabricated, exactly like every other mode.
  // ═══════════════════════════════════════════════════════════════════════

  function HostTransport(apiBase) {
    Transport.call(this, apiBase, true); // host mode: forced-origin + /api allowlist
  }
  HostTransport.prototype = Object.create(Transport.prototype);
  HostTransport.prototype.constructor = HostTransport;
  HostTransport.prototype._bridge = function () {
    var b = window.__PCC_HOST_BRIDGE__;
    return (b && typeof b.fetch === 'function') ? b : null;
  };
  HostTransport.prototype.getJSON = function (path, query) {
    var safe = safeApiPath(path, true);
    if (safe === null) return Promise.reject(new Error('refused unsafe request path: ' + path));
    var bridge = this._bridge();
    if (!bridge) return Transport.prototype.getJSON.call(this, safe, query);
    return bridge.fetch(safe, { method: 'GET', query: query }).then(function (r) {
      if (!r || r.ok === false) throw new Error('host bridge fetch failed on ' + safe);
      return r.json;
    });
  };
  HostTransport.prototype.send = function (method, path, body) {
    // R4 PR1 lockdown (D10): manifest-authored writes are DISABLED in MCP-App/
    // host mode. No mutating request is ever issued from a hosted view — write
    // controls render disabled and the action layer refuses; this transport-level
    // backstop holds even if a caller reaches send() directly (e.g. a compose
    // POST from renderChain). PR2 reintroduces writes via a typed, server-
    // authorized operation allowlist. (method/path/body intentionally unused.)
    void method; void path; void body;
    return Promise.resolve({ ok: false, status: 0, body: { message: 'Actions are unavailable in this host view.' } });
  };
  // No defined host-bridge equivalent for streaming yet; always use the
  // direct fetch-SSE reader (same Bearer-header contract as every live mode).
  HostTransport.prototype.streamSSE = Transport.prototype.streamSSE;

  // ═══════════════════════════════════════════════════════════════════════
  // Kit context — mode, transport, snapshot, root; shared by every renderer
  // ═══════════════════════════════════════════════════════════════════════

  function detectMode(ctx) {
    if (ctx.snapshot) return 'snapshot';
    // Tier D host bridge: only if an embedding host explicitly announces itself.
    if (window.__PCC_HOST__ === true) return 'host';
    if (isSameOrigin(ctx.apiBase)) return 'live-same-origin';
    return 'live-cors'; // file:// or cross-host — needs a key + the wave-4 CORS lane
  }

  // Mode-appropriate transport: 'host' gets the host-bridge-aware
  // HostTransport (falls back to the same direct fetch as every other live
  // mode); every other mode keeps the existing plain Transport.
  function createTransport(ctx) {
    return ctx.mode === 'host' ? new HostTransport(ctx.apiBase) : new Transport(ctx.apiBase, false);
  }

  // Resolve a binding to data. In snapshot mode, look the path up in the baked
  // store (stale). In live modes, fetch. Returns {data, stale, error}.
  function resolveBinding(ctx, binding) {
    if (!binding || !binding.path) return Promise.resolve({ data: undefined, stale: true, error: null });
    if (ctx.mode === 'snapshot') {
      var d = ctx.snapshot[binding.path];
      var picked = binding.select != null ? dot(d, binding.select) : d;
      return Promise.resolve({ data: picked, stale: true, error: d === undefined ? 'no snapshot for ' + binding.path : null });
    }
    return ctx.tx.getJSON(binding.path, binding.query).then(
      function (d) { return { data: binding.select != null ? dot(d, binding.select) : d, raw: d, stale: false, error: null }; },
      function (err) {
        // Live fetch failed → fall back to any baked snapshot, else stale-empty.
        if (ctx.snapshot && ctx.snapshot[binding.path] !== undefined) {
          var s = ctx.snapshot[binding.path];
          ctx.degraded = true;
          return { data: binding.select != null ? dot(s, binding.select) : s, stale: true, error: null };
        }
        ctx.degraded = true;
        return { data: undefined, stale: true, error: String(err && err.message || err) };
      }
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Shared window chrome
  // ═══════════════════════════════════════════════════════════════════════

  function winShell(title, statusText, statusCls) {
    var wrap = el('article', 'pcc-win');
    var head = el('div', 'pcc-win-head');
    head.appendChild(el('span', 'pcc-win-title', title));
    if (statusText != null) head.appendChild(el('span', 'pcc-pill ' + (statusCls || ''), statusText));
    wrap.appendChild(head);
    var body = el('div', 'pcc-win-body');
    wrap.appendChild(body);
    wrap._body = body;
    wrap._setFoot = function (traceId, stale) {
      var old = wrap.querySelector('.pcc-win-foot');
      if (old) old.parentNode.removeChild(old);
      if (!traceId && !stale) return;
      var foot = el('div', 'pcc-win-foot');
      if (stale) foot.appendChild(el('span', 'pcc-foot-stale', 'snapshot'));
      if (traceId) foot.appendChild(el('span', 'pcc-mono pcc-foot-trace', 'trace ' + traceId));
      wrap.appendChild(foot);
    };
    return wrap;
  }
  function loadingLine() { return el('p', 'pcc-muted', 'Loading…'); }
  function errorLine(msg) {
    var p = el('p', 'pcc-err');
    p.appendChild(el('span', 'pcc-err-msg', msg || 'Could not load this data.'));
    p.appendChild(el('span', 'pcc-err-honest', ' Nothing was fabricated.'));
    return p;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Window renderers — one per manifest window kind (schema-closed set)
  // ═══════════════════════════════════════════════════════════════════════

  // note — prose; split on double newline into <p>, textContent only.
  function renderNote(ctx, w) {
    var wrap = el('article', 'pcc-win pcc-win-note');
    var text = String(w.text == null ? '' : w.text);
    var paras = text.split(/\n\n+/);
    for (var i = 0; i < paras.length; i++) {
      if (paras[i] === '') continue;
      wrap.appendChild(el('p', 'pcc-note-p', paras[i]));
    }
    return wrap;
  }

  // metric — single scalar, formatted, tabular.
  function renderMetric(ctx, w) {
    var wrap = winShell(w.label || 'Metric', null, null);
    var val = el('div', 'pcc-metric-amount pcc-tnum', '—');
    wrap._body.appendChild(val);
    var sel = w.select != null ? w.select : (w.binding && w.binding.select);
    resolveBinding(ctx, w.binding).then(function (r) {
      var raw = sel != null ? dot(r.data, sel) : r.data;
      if (r.error) { clear(wrap._body); wrap._body.appendChild(errorLine(r.error)); }
      else val.textContent = fmtVal(raw, w.format);
      wrap._setFoot(ctx.tx && ctx.tx.lastTrace, r.stale);
    });
    return wrap;
  }

  // capability — one catalog row: name + provider + price + trust + assurance.
  function renderCapability(ctx, w) {
    var wrap = winShell('Capability', null, null);
    wrap._body.appendChild(loadingLine());
    resolveBinding(ctx, w.binding).then(function (r) {
      clear(wrap._body);
      var c = r.data;
      if (r.error || !c) { wrap._body.appendChild(errorLine(r.error || 'No capability data.')); wrap._setFoot(ctx.tx && ctx.tx.lastTrace, r.stale); return; }
      // Follow the API shape (CapabilityDTO) — render what it actually emits.
      var titleRow = el('div', 'pcc-cap-title');
      titleRow.appendChild(el('span', 'pcc-cap-name', String(c.name || c.id || 'Capability')));
      var price = c.pricing && (c.pricing.baseCost != null ? c.pricing.baseCost : c.pricing.minimum);
      var currency = (c.pricing && c.pricing.currency) || 'USDC';
      if (price != null) titleRow.appendChild(el('span', 'pcc-price-chip pcc-tnum', fmtUsd(price) + ' ' + currency));
      wrap._body.appendChild(titleRow);
      var meta = el('div', 'pcc-cap-meta');
      if (c.kernelName || c.kernelId) meta.appendChild(el('span', 'pcc-mono', String(c.kernelName || c.kernelId)));
      if (c.type) meta.appendChild(el('span', 'pcc-tag', String(c.type)));
      if (typeof c.reputation === 'number') meta.appendChild(el('span', 'pcc-badge', 'rep ' + c.reputation));
      wrap._body.appendChild(meta);
      if (c.description) wrap._body.appendChild(el('p', 'pcc-cap-desc', String(c.description)));
      var tiers = Array.isArray(c.assuranceTiers) ? c.assuranceTiers : null;
      if (tiers && tiers.length) {
        wrap._body.appendChild(el('p', 'pcc-cap-assurance', 'assurance tier ' + tiers.join('/') +
          (c.available === false ? ' · unavailable' : (typeof c.queueDepth === 'number' ? ' · queue ' + c.queueDepth : ''))));
      }
      wrap._setFoot(ctx.tx && ctx.tx.lastTrace, r.stale);
    });
    return wrap;
  }

  // list — a collection of light rows (title · meta · status pill).
  function renderList(ctx, w) {
    var wrap = winShell('List', null, null);
    wrap._body.appendChild(loadingLine());
    resolveBinding(ctx, w.binding).then(function (r) {
      clear(wrap._body);
      if (r.error) { wrap._body.appendChild(errorLine(r.error)); wrap._setFoot(ctx.tx && ctx.tx.lastTrace, r.stale); return; }
      var rows = w.binding && w.binding.select != null ? (Array.isArray(r.data) ? r.data : firstArray(r.data)) : firstArray(r.raw != null ? r.raw : r.data);
      if (!rows.length) { wrap._body.appendChild(el('p', 'pcc-muted', 'Nothing here yet.')); wrap._setFoot(ctx.tx && ctx.tx.lastTrace, r.stale); return; }
      var limit = w.limit || rows.length;
      var listNode = el('ul', 'pcc-list');
      for (var i = 0; i < rows.length && i < limit; i++) {
        var row = rows[i];
        var li = el('li', 'pcc-list-row');
        var main = el('div', 'pcc-list-main');
        main.appendChild(el('span', 'pcc-list-title', String(dot(row, w.item.title) != null ? dot(row, w.item.title) : (w.item.title || ''))));
        var metaVals = [];
        var metaKeys = (w.item.meta || []);
        for (var j = 0; j < metaKeys.length; j++) {
          var mv = dot(row, metaKeys[j]);
          if (mv != null && mv !== '') metaVals.push(String(mv));
        }
        if (metaVals.length) main.appendChild(el('span', 'pcc-list-meta', metaVals.join(' · ')));
        li.appendChild(main);
        if (w.item.statusFrom) {
          var st = dot(row, w.item.statusFrom);
          if (st != null) li.appendChild(el('span', 'pcc-pill ' + statusClass(st), String(st)));
        }
        listNode.appendChild(li);
      }
      wrap._body.appendChild(listNode);
      wrap._setFoot(ctx.tx && ctx.tx.lastTrace, r.stale);
    });
    return wrap;
  }

  // ── form: buildForm/collectForm (JSON-Schema → fields; fresh per redesign
  // spec field-map). string/enum→input/select, number/integer→number,
  // boolean→checkbox, object/array→JSON textarea; required *; inline errors.
  function buildForm(schema) {
    var props = (schema && schema.properties) || {};
    var required = (schema && schema.required) || [];
    var fields = [];
    var frag = document.createElement('div');
    frag.className = 'pcc-form-fields';
    var names = Object.keys(props);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var spec = props[name] || {};
      var isReq = required.indexOf(name) >= 0;
      var row = el('div', 'pcc-field');
      var lab = el('label', 'pcc-field-label', (spec.title || name) + (isReq ? ' *' : ''));
      var fieldId = 'pf-' + name + '-' + Math.random().toString(36).slice(2, 7);
      lab.setAttribute('for', fieldId);
      row.appendChild(lab);
      var input, kind = spec.type;
      if (kind === 'string' && Array.isArray(spec.enum)) {
        input = el('select', 'pcc-input');
        for (var e = 0; e < spec.enum.length; e++) input.appendChild(el('option', null, String(spec.enum[e])));
        kind = 'enum';
      } else if (kind === 'number' || kind === 'integer') {
        input = el('input', 'pcc-input'); input.type = 'number';
        if (spec.minimum != null) input.min = spec.minimum;
        if (spec.maximum != null) input.max = spec.maximum;
        if (kind === 'integer') input.step = '1';
      } else if (kind === 'boolean') {
        input = el('input', 'pcc-checkbox'); input.type = 'checkbox';
      } else if (kind === 'object' || kind === 'array') {
        input = el('textarea', 'pcc-input pcc-mono'); input.rows = 3;
        input.placeholder = kind === 'array' ? '[ ]' : '{ }';
        kind = 'json';
      } else {
        input = el('input', 'pcc-input'); input.type = 'text';
        kind = 'string';
      }
      input.id = fieldId;
      if (spec['default'] != null && kind !== 'boolean') input.value = String(spec['default']);
      if (spec['default'] === true && kind === 'boolean') input.checked = true;
      row.appendChild(input);
      var errLine = el('div', 'pcc-field-err'); errLine.hidden = true;
      row.appendChild(errLine);
      frag.appendChild(row);
      fields.push({ name: name, kind: kind, required: isReq, input: input, errLine: errLine });
    }
    return { node: frag, fields: fields };
  }

  // Read + coerce field values; throw an inline-marked Error on invalid input.
  function collectForm(form) {
    var out = {};
    var firstBad = null;
    for (var i = 0; i < form.fields.length; i++) {
      var f = form.fields[i];
      f.errLine.hidden = true; f.input.classList.remove('bad');
      var raw = f.kind === 'boolean' ? f.input.checked : f.input.value;
      var empty = f.kind === 'boolean' ? false : (raw == null || String(raw).trim() === '');
      if (f.required && empty) { markBad(f, 'Required.'); firstBad = firstBad || f; continue; }
      if (empty) continue;
      if (f.kind === 'number' || f.kind === 'integer') {
        var n = Number(raw);
        if (!isFinite(n)) { markBad(f, 'Enter a number.'); firstBad = firstBad || f; continue; }
        out[f.name] = n;
      } else if (f.kind === 'json') {
        try { out[f.name] = JSON.parse(raw); }
        catch (e) { markBad(f, 'Enter valid JSON.'); firstBad = firstBad || f; continue; }
      } else if (f.kind === 'boolean') {
        out[f.name] = !!raw;
      } else {
        out[f.name] = String(raw);
      }
    }
    if (firstBad) { var err = new Error('Please fix the highlighted fields.'); err._inline = true; throw err; }
    return out;
  }
  function markBad(f, msg) { f.input.classList.add('bad'); f.errLine.textContent = msg; f.errLine.hidden = false; }

  function renderForm(ctx, w) {
    var wrap = winShell('Set up', null, null);
    var form = buildForm(w.schema || {});
    wrap._body.appendChild(form.node);
    var foot = el('div', 'pcc-win-foot pcc-actionbar');
    var submit = el('button', 'pcc-btn pcc-btn-primary', (w.submit && w.submit.label) || 'Submit');
    submit.type = 'button';
    var status = el('span', 'pcc-action-status');
    submit.onclick = function () {
      var values;
      try { values = collectForm(form); }
      catch (e) { status.className = 'pcc-action-status st-failed'; status.textContent = e.message; return; }
      dispatchAction(ctx, w.submit, { formValues: values, status: status, rebind: null });
    };
    foot.appendChild(submit);
    foot.appendChild(status);
    hostLockActionBar(foot); // host lockdown: disable the submit + show the note
    wrap.appendChild(foot);
    return wrap;
  }

  // run — live status + prominent latest line + collapsed event feed.
  function renderRun(ctx, w) {
    var wrap = winShell('Run', 'connecting', 'st-running');
    var pill = wrap.querySelector('.pcc-pill');
    var latest = el('div', 'pcc-run-latest', 'Waiting for the first update…');
    wrap._body.appendChild(latest);
    var started = Date.now();
    var elapsed = el('div', 'pcc-run-elapsed pcc-mono', '');
    wrap._body.appendChild(elapsed);
    var toggle = el('button', 'pcc-link', 'Show all');
    toggle.type = 'button';
    var feed = el('div', 'pcc-run-feed'); feed.hidden = true;
    toggle.onclick = function () { feed.hidden = !feed.hidden; toggle.textContent = feed.hidden ? 'Show all' : 'Hide'; };
    wrap._body.appendChild(toggle);
    wrap._body.appendChild(feed);

    var tick = setInterval(function () {
      elapsed.textContent = Math.floor((Date.now() - started) / 1000) + 's elapsed';
    }, 1000);

    function apply(statusVal, latestVal) {
      if (statusVal != null) { pill.textContent = String(statusVal); pill.className = 'pcc-pill ' + statusClass(statusVal); }
      if (latestVal != null && latestVal !== '') latest.textContent = String(latestVal);
    }
    function feedLine(txt) {
      var line = el('div', 'pcc-mono pcc-feed-line', txt);
      feed.appendChild(line);
      while (feed.childNodes.length > 40) feed.removeChild(feed.firstChild); // 40-row cap
    }

    if (ctx.mode === 'snapshot') {
      var snap = ctx.snapshot[w.binding.path];
      apply(dot(snap, w.statusFrom), dot(snap, w.latestFrom));
      var stat = dot(snap, w.statusFrom);
      pill.textContent = String(stat != null ? stat : 'snapshot');
      var tl = dot(snap, 'job.timeline') || dot(snap, 'timeline');
      if (Array.isArray(tl) && tl.length) {
        for (var ti = 0; ti < tl.length; ti++) feedLine((tl[ti].timestamp ? fmtTs(tl[ti].timestamp) + ' · ' : '') + (tl[ti].type || ''));
        latest.textContent = String(tl[tl.length - 1].type || latest.textContent); // last event = latest truth
      }
      wrap._setFoot(null, true);
      clearInterval(tick); elapsed.textContent = '';
      return wrap;
    }

    // Live: prefer fetch-SSE (Bearer), fall back to polling with backoff.
    var stopped = false;
    function poll(delay) {
      if (stopped) return;
      ctx.tx.getJSON(w.binding.path, w.binding.query).then(function (d) {
        apply(dot(d, w.statusFrom), dot(d, w.latestFrom));
        // timeline feed if the response carries one
        var tl = dot(d, 'timeline') || dot(d, 'job.timeline');
        if (Array.isArray(tl)) { clear(feed); for (var i = 0; i < tl.length; i++) feedLine((tl[i].timestamp ? fmtTs(tl[i].timestamp) + ' · ' : '') + (tl[i].type || JSON.stringify(tl[i]))); }
        wrap._setFoot(ctx.tx.lastTrace, false);
        setTimeout(function () { poll(w.binding.pollMs || POLL_DEFAULT_MS); }, w.binding.pollMs || POLL_DEFAULT_MS);
      }, function () {
        var next = Math.min((delay || POLL_DEFAULT_MS) * 2, 120000); // backoff
        wrap._setFoot(ctx.tx.lastTrace, true);
        setTimeout(function () { poll(next); }, next);
      });
    }

    if (w.binding.sse) {
      ctx.tx.streamSSE(w.binding.sse, function (ev) {
        apply(dot(ev, w.statusFrom) != null ? dot(ev, w.statusFrom) : ev.status,
              dot(ev, w.latestFrom) != null ? dot(ev, w.latestFrom) : (ev.message || ev.type));
        feedLine((ev.timestamp ? fmtTs(ev.timestamp) + ' · ' : '') + (ev.type || ev.status || JSON.stringify(ev)));
        wrap._setFoot(ctx.tx.lastTrace, false);
      }).catch(function () { poll(w.binding.pollMs || POLL_DEFAULT_MS); }); // stream dropped → poll
    } else {
      poll(w.binding.pollMs || POLL_DEFAULT_MS);
    }
    return wrap;
  }

  // approval — the what/who/cost block; only Approve fires the POST.
  function renderApproval(ctx, w) {
    var wrap = winShell('Approval', 'needs you', 'st-waiting');
    wrap._body.appendChild(loadingLine());
    resolveBinding(ctx, w.binding).then(function (r) {
      clear(wrap._body);
      var info = r.data || {};
      wrap._body.appendChild(approvalDetails(info));
      // Kit-derived TRUTH about the request the Approve button actually sends
      // (directive 10) — computed from w.approve, never manifest confirmation text.
      var realBody = Object.assign({}, (w.approve && w.approve.body) || {});
      var desc = describeRealRequest(ctx.apiBase, w.approve, realBody, ctx.mode === 'host');
      wrap._body.appendChild(realRequestNode(desc));
      var foot = el('div', 'pcc-win-foot pcc-actionbar');
      var status = el('span', 'pcc-action-status');
      var approve = el('button', 'pcc-btn pcc-btn-primary', (w.approve && w.approve.label) || 'Approve');
      approve.type = 'button';
      approve.onclick = function () {
        if (desc.destination === null) {
          status.className = 'pcc-action-status st-failed';
          status.textContent = 'Refused: unsafe or non-PCC destination.';
          return;
        }
        // The approval WINDOW is itself the confirmation surface: fire directly.
        dispatchAction(ctx, w.approve, { status: status, viaApproval: true, rebind: function () { rebindApproval(ctx, w, wrap); } });
      };
      foot.appendChild(approve);
      if (w.deny) {
        var deny = el('button', 'pcc-btn pcc-btn-quiet', w.deny.label || 'Deny');
        deny.type = 'button';
        deny.onclick = function () { dispatchAction(ctx, w.deny, { status: status, viaApproval: true }); };
        foot.appendChild(deny);
      }
      foot.appendChild(status);
      hostLockActionBar(foot); // host lockdown: disable Approve/Deny + show the note
      wrap.appendChild(foot);
      wrap._setFoot(ctx.tx && ctx.tx.lastTrace, r.stale);
    });
    return wrap;
  }
  function rebindApproval(ctx, w, wrap) {
    var pill = wrap.querySelector('.pcc-pill');
    if (pill) { pill.textContent = 'resolved'; pill.className = 'pcc-pill st-settled'; }
  }
  function approvalDetails(info) {
    var box = el('div', 'pcc-approval');
    // what
    var summary = info.summary || info.name || info.description;
    if (summary) box.appendChild(el('div', 'pcc-approval-what', String(summary)));
    // who + cost
    var line = el('div', 'pcc-approval-line');
    var payee = info.payee || (info.provider && (info.provider.id || info.provider.name)) || info.operatorAddress;
    if (payee) line.appendChild(el('span', 'pcc-mono', 'to ' + payee));
    var amount = info.amount || info.totalAmount || (info.price && (info.price.base || info.price.amount));
    var currency = info.currency || (info.price && info.price.currency) || 'USDC';
    if (amount != null) line.appendChild(el('span', 'pcc-approval-cost pcc-tnum', fmtUsd(amount) + ' ' + currency));
    if (line.childNodes.length) box.appendChild(line);
    if (info.rationale) box.appendChild(el('p', 'pcc-approval-rationale', String(info.rationale)));
    // args table (ui.summaryKeys when present)
    var args = info.args || info.params;
    if (args && typeof args === 'object') {
      var keys = (info.ui && Array.isArray(info.ui.summaryKeys)) ? info.ui.summaryKeys : Object.keys(args);
      var tbl = el('div', 'pcc-args');
      for (var i = 0; i < keys.length; i++) {
        var v = args[keys[i]];
        if (v == null) continue;
        var kv = el('div', 'pcc-args-row');
        kv.appendChild(el('span', 'pcc-args-k', keys[i]));
        kv.appendChild(el('span', 'pcc-args-v pcc-mono', typeof v === 'object' ? JSON.stringify(v) : String(v)));
        tbl.appendChild(kv);
      }
      if (tbl.childNodes.length) box.appendChild(tbl);
    }
    return box;
  }

  // receipt — amount large + payer→payee + rail + event timeline + tx ids.
  function renderReceipt(ctx, w) {
    var wrap = winShell('Receipt', null, null);
    wrap._body.appendChild(loadingLine());
    resolveBinding(ctx, w.binding).then(function (r) {
      clear(wrap._body);
      var e = r.data;
      if (r.error || !e) { wrap._body.appendChild(errorLine(r.error || 'No settlement data.')); wrap._setFoot(ctx.tx && ctx.tx.lastTrace, r.stale); return; }
      var amount = e.totalAmount != null ? e.totalAmount : e.amount;
      var currency = e.currency || 'USDC';
      var amtRow = el('div', 'pcc-receipt-amount pcc-tnum');
      amtRow.appendChild(el('span', 'pcc-receipt-num', fmtUsd(amount)));
      amtRow.appendChild(el('span', 'pcc-receipt-cur', ' ' + currency));
      wrap._body.appendChild(amtRow);
      var status = e.status || (e.releasedCount ? 'settled' : 'pending');
      var pay = el('div', 'pcc-receipt-parties');
      pay.appendChild(el('span', 'pcc-mono', String(e.payer || e.funder || 'payer')));
      pay.appendChild(el('span', 'pcc-arrow', '→'));
      pay.appendChild(el('span', 'pcc-mono', String(e.payee || e.provider || 'payee')));
      wrap._body.appendChild(pay);
      var railRow = el('div', 'pcc-receipt-rail');
      railRow.appendChild(el('span', 'pcc-pill ' + statusClass(status), String(status)));
      railRow.appendChild(el('span', 'pcc-muted', ' · ' + (e.rail || 'escrow-milestone')));
      wrap._body.appendChild(railRow);
      // timeline of pcc.* / escrow events
      var events = e.events || e.timeline || (e.milestones);
      if (Array.isArray(events) && events.length) {
        var tl = el('ol', 'pcc-timeline');
        for (var i = 0; i < events.length; i++) {
          var ev = events[i];
          var li = el('li', 'pcc-timeline-row');
          li.appendChild(el('span', 'pcc-timeline-type', String(ev.type || ev.name || ev.status || 'event')));
          if (ev.timestamp) li.appendChild(el('span', 'pcc-mono pcc-timeline-ts', fmtTs(ev.timestamp)));
          tl.appendChild(li);
        }
        wrap._body.appendChild(tl);
      }
      var tx = e.txHash || e.tx || e.escrowAddress || e.address;
      if (tx) wrap._body.appendChild(el('div', 'pcc-mono pcc-receipt-tx', String(tx)));
      wrap._setFoot(ctx.tx && ctx.tx.lastTrace, r.stale);
    });
    return wrap;
  }

  // chain — the pinned re-plannable ComposeRequest; Plan re-POSTs it.
  function renderChain(ctx, w) {
    var wrap = winShell('Value chain', null, null);
    var cr = w.composeRef || {};
    var head = el('div', 'pcc-chain-head');
    head.appendChild(el('span', 'pcc-chain-outcome', String(cr.outcomeType || 'outcome')));
    if (cr.budgetUSD != null) head.appendChild(el('span', 'pcc-chain-budget pcc-tnum', 'budget ' + fmtUsd(cr.budgetUSD) + ' USDC'));
    wrap._body.appendChild(head);
    var seq = (cr.outcomeChain && cr.outcomeChain.length) ? cr.outcomeChain : (cr.steps || [cr.outcomeType]);
    var stepsRow = el('div', 'pcc-chain-steps');
    for (var i = 0; i < seq.length; i++) {
      if (i > 0) stepsRow.appendChild(el('span', 'pcc-arrow', '→'));
      stepsRow.appendChild(el('span', 'pcc-chain-step', String(seq[i])));
    }
    wrap._body.appendChild(stepsRow);
    wrap._body.appendChild(el('p', 'pcc-muted', 'tier ' + (cr.minAssuranceTier != null ? cr.minAssuranceTier : 0) + ' · optimize for ' + (cr.optimizeFor || 'price')));
    var result = el('div', 'pcc-chain-result');
    wrap._body.appendChild(result);

    var foot = el('div', 'pcc-win-foot pcc-actionbar');
    var status = el('span', 'pcc-action-status');
    var plan = el('button', 'pcc-btn pcc-btn-primary', 'Plan');
    plan.type = 'button';
    plan.onclick = function () {
      if (ctx.mode === 'snapshot') { intentChip(status, 'pcc: plan ' + (cr.outcomeType || 'chain')); return; }
      status.className = 'pcc-action-status'; status.textContent = 'Planning…';
      ctx.tx.send('POST', '/api/compose', cr).then(function (res) {
        clear(result);
        if (!res.ok) { status.className = 'pcc-action-status st-failed'; status.textContent = 'Plan failed (HTTP ' + res.status + ')'; return; }
        status.textContent = '';
        var steps = res.body.steps || [];
        var box = el('ol', 'pcc-plan');
        for (var i = 0; i < steps.length; i++) {
          var s = steps[i];
          var li = el('li', 'pcc-plan-row');
          li.appendChild(el('span', 'pcc-plan-type', String(s.capabilityType || s.outcomeType || ('step ' + (i + 1)))));
          if (s.estimatedPriceUSD != null) li.appendChild(el('span', 'pcc-mono pcc-tnum', fmtUsd(s.estimatedPriceUSD) + ' USDC'));
          box.appendChild(li);
        }
        result.appendChild(box);
        if (res.body.totalPriceUSD != null) result.appendChild(el('div', 'pcc-plan-total pcc-tnum', 'total ' + fmtUsd(res.body.totalPriceUSD) + ' USDC'));
        if (w.execute) {
          var execBtn = el('button', 'pcc-btn pcc-btn-primary', w.execute.label || 'Execute');
          execBtn.type = 'button';
          execBtn.onclick = function () { dispatchAction(ctx, w.execute, { status: status }); };
          result.appendChild(execBtn);
        }
      }, function (err) { status.className = 'pcc-action-status st-failed'; status.textContent = String(err && err.message || 'Plan failed'); });
    };
    foot.appendChild(plan);
    foot.appendChild(status);
    hostLockActionBar(foot); // host lockdown: disable Plan (its POST is refused) + note
    wrap.appendChild(foot);
    return wrap;
  }

  // actions — a bare bar of buttons.
  function renderActions(ctx, w) {
    var wrap = winShell('Actions', null, null);
    var bar = el('div', 'pcc-actionbar');
    var status = el('span', 'pcc-action-status');
    (w.actions || []).forEach(function (a) {
      // NOTE: an MCP-App projected action carries no `path` (raw-HTTP fields are
      // stripped; it acts only via operation_id) — read money intent from the
      // fields the projection keeps (label/id), coercing a missing path to ''.
      var isMoney = a.confirm === 'approval' || MONEY_VERB.test(String(a.path || '') + ' ' + String(a.label || '') + ' ' + String(a.id || ''));
      var btn = el('button', 'pcc-btn ' + (isMoney ? 'pcc-btn-primary' : 'pcc-btn-quiet'), a.label);
      btn.type = 'button';
      // PR2: a button wired to a registered typed operation stays live under the
      // host lockdown (hostLockActionBar skips the pcc-host-op-enabled class).
      if (hostActionEnabled(a)) btn.className += ' pcc-host-op-enabled';
      btn.onclick = function () { dispatchAction(ctx, a, { status: status }); };
      bar.appendChild(btn);
    });
    hostLockActionBar(bar); // host lockdown: disable non-typed action buttons + note
    wrap._body.appendChild(bar);
    wrap._body.appendChild(status);
    return wrap;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Action layer — NOTHING fires on load; execution is a click. Money verbs go
  // through the Approval surface; snapshot mode emits copyable intent chips.
  // ═══════════════════════════════════════════════════════════════════════

  function isMoneyAction(action) {
    // Tolerate a projected action with no `path` (MCP-App host mode): a missing
    // path coerces to '' rather than the literal 'undefined'.
    return action.confirm === 'approval' || MONEY_VERB.test(String(action.path || '') + ' ' + String(action.label || '') + ' ' + String(action.id || ''));
  }

  // Pull the first text line out of an MCP tool-error result (server-authored,
  // never containing a credential) for display.
  function hostOpErrorText(result) {
    try {
      var c = result && result.content;
      if (c && c.length) {
        for (var i = 0; i < c.length; i++) {
          if (c[i] && c[i].type === 'text' && c[i].text) return c[i].text;
        }
      }
    } catch (e) {}
    return null;
  }

  // R4 PR2 — run a REGISTERED typed operation from a hosted view. The manifest
  // action carries { operation_id, arguments }; the bridge sends a tools/call for
  // the mapped pcc.op.<id> tool and the SERVER derives the principal (from the
  // host connection's key) and authorizes. A raw HTTP write is never issued.
  // Unregistered/unknown ops (or no bridge) stay inert (the PR1 read-only state).
  function dispatchHostOperation(ctx, action, status) {
    if (!hostActionEnabled(action)) { markWriteUnavailable(status); return; }
    status.className = 'pcc-action-status'; status.textContent = 'Working…';
    window.__PCC_HOST_BRIDGE__.callOperation(action.operation_id, action.arguments || {}).then(function (result) {
      if (result && result.isError) {
        status.className = 'pcc-action-status st-failed';
        status.textContent = hostOpErrorText(result) || 'Operation failed';
      } else {
        status.className = 'pcc-action-status st-settled';
        status.textContent = 'Done' + (ctx && ctx.tx && ctx.tx.lastTrace ? ' · trace ' + ctx.tx.lastTrace : '');
      }
    }, function (err) {
      status.className = 'pcc-action-status st-failed';
      status.textContent = String((err && err.message) || 'Operation failed');
    });
  }

  function dispatchAction(ctx, action, opts) {
    opts = opts || {};
    var status = opts.status || el('span', 'pcc-action-status');
    if (!action) return;

    // Snapshot: never POST. Hand the LLM a copyable intent chip.
    if (ctx.mode === 'snapshot') { intentChip(status, action.intentText || ('pcc: ' + action.label)); return; }

    // R4 PR2: in MCP-App/host mode a manifest still cannot author a RAW write,
    // but it MAY name a REGISTERED typed operation, executed via the host bridge
    // (a server-authorized tools/call). An unregistered/unknown operation, or no
    // bridge, stays inert exactly as PR1 shipped.
    if (ctx.mode === 'host') { dispatchHostOperation(ctx, action, status); return; }

    // Money verbs MUST pass through the Approval gate (unless we ARE that gate).
    if (isMoneyAction(action) && !opts.viaApproval) {
      openApprovalGate(ctx, action, opts);
      return;
    }

    // Ordinary write with inline confirm: two-step, in place. (Not for money.)
    if (action.confirm === 'inline' && !opts.viaApproval && !opts.confirmed) {
      inlineConfirm(status, action, function () {
        dispatchAction(ctx, action, Object.assign({}, opts, { confirmed: true }));
      });
      return;
    }

    doPost(ctx, action, opts, status);
  }

  function doPost(ctx, action, opts, status) {
    var body = Object.assign({}, action.body || {}, opts.formValues || {});
    // idempotencyKey on every offer-posting action (a button can be double-clicked).
    if (action.kind === 'post') {
      var idem = action.idempotencyFrom && opts.formValues ? opts.formValues[action.idempotencyFrom] : null;
      if (!idem) idem = 'idem-' + uuid();
      body.idempotencyKey = idem;
    }
    status.className = 'pcc-action-status'; status.textContent = 'Working…';
    var method = (action.kind === 'patch') ? 'PATCH' : 'POST';
    var idemHeader = body.idempotencyKey;
    ctx.tx.send(method, action.path, body, idemHeader).then(function (res) {
      if (res.ok) {
        status.className = 'pcc-action-status st-settled';
        status.textContent = 'Done' + (ctx.tx.lastTrace ? ' · trace ' + ctx.tx.lastTrace : '');
        if (typeof opts.rebind === 'function') opts.rebind();
      } else {
        status.className = 'pcc-action-status st-failed';
        status.textContent = (res.body && (res.body.message || res.body.error)) || ('Failed (HTTP ' + res.status + ')');
      }
    }, function (err) {
      status.className = 'pcc-action-status st-failed';
      status.textContent = String(err && err.message || 'Request failed');
    });
  }

  function inlineConfirm(status, action, onConfirm) {
    clear(status); status.className = 'pcc-action-status';
    var yes = el('button', 'pcc-btn pcc-btn-primary pcc-btn-sm', 'Confirm');
    yes.type = 'button';
    var no = el('button', 'pcc-btn pcc-btn-quiet pcc-btn-sm', 'Cancel');
    no.type = 'button';
    yes.onclick = function () { clear(status); onConfirm(); };
    no.onclick = function () { clear(status); };
    status.appendChild(el('span', 'pcc-confirm-q', 'Confirm “' + action.label + '”?'));
    status.appendChild(yes);
    status.appendChild(no);
  }

  // Kit-derived, textContent-only "This will send" block — the honest summary of
  // the REAL request (method + resolved destination + amount/asset + job/escrow
  // ref) that the money action fires. Rendered ALONGSIDE the manifest label so a
  // misleading label can never hide the true destination/amount (directive 10).
  function realRequestNode(desc) {
    var box = el('div', 'pcc-realreq');
    box.appendChild(el('div', 'pcc-realreq-title', 'This will send'));
    var line = el('div', 'pcc-realreq-line');
    if (desc.destination === null) {
      line.appendChild(el('span', 'pcc-realreq-blocked', 'BLOCKED — unsafe or non-PCC destination'));
    } else {
      line.appendChild(el('span', 'pcc-realreq-method', desc.method));
      line.appendChild(el('span', 'pcc-realreq-dest pcc-mono', desc.destination));
    }
    box.appendChild(line);
    if (desc.amount != null) {
      box.appendChild(el('div', 'pcc-realreq-amt pcc-tnum', 'Amount ' + fmtUsd(desc.amount) + (desc.asset ? ' ' + desc.asset : '')));
    }
    if (desc.refId != null) {
      box.appendChild(el('div', 'pcc-realreq-ref pcc-mono', 'ref ' + String(desc.refId)));
    }
    return box;
  }

  // The kit's Approval window as a floating modal — only Approve POSTs.
  function openApprovalGate(ctx, action, opts) {
    // Host lockdown: writes are disabled in a hosted view — never open the gate.
    // (dispatchAction already returns before here in host mode; belt-and-suspenders.)
    if (isHostEmbed()) { markWriteUnavailable(opts && opts.status); return; }
    var overlay = el('div', 'pcc-overlay');
    var card = el('div', 'pcc-modal');
    var head = el('div', 'pcc-win-head');
    head.appendChild(el('span', 'pcc-win-title', 'Approve'));
    head.appendChild(el('span', 'pcc-pill st-waiting', 'confirm'));
    card.appendChild(head);
    // Manifest-supplied label (may mislead) — shown, but NOT authoritative.
    card.appendChild(el('p', 'pcc-approval-what', action.label));
    // Kit-derived TRUTH about the request that will actually be sent.
    var realBody = Object.assign({}, action.body || {}, opts.formValues || {});
    var desc = describeRealRequest(ctx.apiBase, action, realBody, ctx.mode === 'host');
    card.appendChild(realRequestNode(desc));
    var info = { args: realBody };
    card.appendChild(approvalDetails(info));
    var foot = el('div', 'pcc-actionbar');
    var status = el('span', 'pcc-action-status');
    var approve = el('button', 'pcc-btn pcc-btn-primary', 'Approve');
    approve.type = 'button';
    var cancel = el('button', 'pcc-btn pcc-btn-quiet', 'Cancel');
    cancel.type = 'button';
    function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    approve.onclick = function () {
      if (desc.destination === null) {
        status.className = 'pcc-action-status st-failed';
        status.textContent = 'Refused: unsafe or non-PCC destination.';
        if (opts.status) { opts.status.className = status.className; opts.status.textContent = status.textContent; }
        return;
      }
      doPost(ctx, action, Object.assign({}, opts, { viaApproval: true }), status);
      setTimeout(close, 1200);
      if (opts.status) { opts.status.className = status.className; opts.status.textContent = status.textContent; }
    };
    cancel.onclick = close;
    overlay.onclick = function (e) { if (e.target === overlay) close(); };
    foot.appendChild(approve); foot.appendChild(cancel); foot.appendChild(status);
    card.appendChild(foot);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  // Snapshot action-intent chip — copyable text the person hands to their LLM.
  function intentChip(status, text) {
    clear(status); status.className = 'pcc-action-status';
    var chip = el('button', 'pcc-chip', text);
    chip.type = 'button';
    chip.title = 'Copy — paste to your assistant to run this';
    chip.onclick = function () {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
      } catch (e) {}
      chip.textContent = 'copied ✓';
      setTimeout(function () { chip.textContent = text; }, 1400);
    };
    status.appendChild(el('span', 'pcc-chip-label', 'snapshot — run via your assistant: '));
    status.appendChild(chip);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Renderer dispatch table
  // ═══════════════════════════════════════════════════════════════════════

  var RENDERERS = {
    note: renderNote, metric: renderMetric, capability: renderCapability,
    list: renderList, form: renderForm, run: renderRun, approval: renderApproval,
    receipt: renderReceipt, chain: renderChain, actions: renderActions
  };

  function renderWindow(ctx, w) {
    var fn = RENDERERS[w.kind];
    if (!fn) { // unknown kind (a newer manifest against an older kit): honest, never throws.
      var stub = winShell(w.kind || 'window', 'unsupported', 'st-waiting');
      stub._body.appendChild(el('p', 'pcc-muted', 'This dashboard uses a window type this kit version does not render.'));
      return stub;
    }
    try { return fn(ctx, w); }
    catch (e) {
      var errw = winShell(w.kind || 'window', 'error', 'st-failed');
      errw._body.appendChild(errorLine(String(e && e.message || e)));
      return errw;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Chrome — theme, connect bar, snapshot banner
  // ═══════════════════════════════════════════════════════════════════════

  function applyTheme(manifest) {
    var t = manifest && manifest.theme;
    var root = document.documentElement;
    if (t === 'dark' || t === 'light') root.setAttribute('data-theme', t);
    // 'auto' or unset → rely on prefers-color-scheme (+ any shell data-pcc-theme).
  }

  function connectBar(ctx, onConnect) {
    var bar = el('div', 'pcc-connect');
    bar.appendChild(el('span', 'pcc-connect-label', 'Connect your PCC key to go live:'));
    var input = el('input', 'pcc-input pcc-connect-input');
    input.type = 'password';
    input.placeholder = 'pcc_live_…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    var btn = el('button', 'pcc-btn pcc-btn-primary pcc-btn-sm', 'Connect');
    btn.type = 'button';
    btn.onclick = function () {
      var v = input.value.trim();
      if (!v) return;
      setKey(v);
      input.value = ''; // never keep the key in the DOM
      onConnect();
    };
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') btn.click(); });
    bar.appendChild(input);
    bar.appendChild(btn);
    return bar;
  }

  function snapshotBanner(ctx) {
    var ts = ctx.snapshot && ctx.snapshot._ts;
    var banner = el('div', 'pcc-banner');
    banner.appendChild(el('span', 'pcc-banner-dot', ''));
    banner.appendChild(el('span', null, ctx.degraded
      ? 'Snapshot — live data is unreachable; showing the last known values.'
      : ('Snapshot' + (ts ? ' — data as of ' + fmtTs(ts) : '') + ' · not live.')));
    return banner;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Boot
  // ═══════════════════════════════════════════════════════════════════════

  function readManifest() {
    var node = document.getElementById('pcc-manifest');
    if (!node) return null;
    try { return JSON.parse(node.textContent || 'null'); } catch (e) { return null; }
  }

  function mount() {
    injectStyles();
    bootKey();

    var manifest = readManifest();
    var root = document.getElementById('pcc-root') || document.body;
    var status = document.getElementById('pcc-kit-status');
    if (status && status.parentNode) status.parentNode.removeChild(status);

    if (!manifest || !Array.isArray(manifest.sections)) {
      root.appendChild(el('p', 'pcc-err', 'No dashboard manifest found.'));
      return;
    }

    applyTheme(manifest);

    var snapshot = readSnapshot();
    var isHost = (window.__PCC_HOST__ === true);
    var apiBase = resolveApiBase(manifest, isHost);
    var ctx = { manifest: manifest, apiBase: apiBase, snapshot: snapshot, tx: null, degraded: false };
    ctx.mode = detectMode(ctx);
    ctx.tx = createTransport(ctx);

    var wrap = el('div', 'pcc-wrap');
    wrap.setAttribute('data-mode', ctx.mode);

    // Snapshot banner whenever data is baked/stale.
    if (ctx.mode === 'snapshot') wrap.appendChild(snapshotBanner(ctx));

    // Connect bar when a live mode needs a key and none is set.
    if ((ctx.mode === 'live-same-origin' || ctx.mode === 'live-cors') && !getKey()) {
      wrap.appendChild(connectBar(ctx, function () { window.location.reload(); }));
    }

    // Sections → windows.
    for (var s = 0; s < manifest.sections.length; s++) {
      var section = manifest.sections[s];
      var secNode = el('section', 'pcc-section');
      if (section.heading) secNode.appendChild(el('h2', 'pcc-section-heading', section.heading));
      var wins = section.windows || [];
      for (var wi = 0; wi < wins.length; wi++) {
        secNode.appendChild(renderWindow(ctx, wins[wi]));
      }
      wrap.appendChild(secNode);
    }

    // Foot attribution.
    var foot = el('div', 'pcc-kit-foot pcc-muted');
    foot.appendChild(el('span', null, 'PCC · ' + ctx.mode + (ctx.apiBase ? ' · ' + ctx.apiBase : ' · same-origin')));
    wrap.appendChild(foot);

    root.appendChild(wrap);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Styles — the redesign spec §3 "subtraction" system, VERBATIM tokens.
  // Set via a <style> element's textContent (CSS text, not HTML injection).
  // ═══════════════════════════════════════════════════════════════════════

  function injectStyles() {
    if (document.getElementById('pcc-ui-styles')) return;
    var css = [
      /* tokens — dark (default) */
      ':root{',
      '--bg:#0A0B0D;--surface:#121316;--surface-2:#191B1F;--surface-3:#212327;',
      '--hairline:rgba(255,255,255,.07);--hairline-strong:rgba(255,255,255,.13);',
      '--ink:#F2F3F5;--ink-2:#B4B7BE;--ink-3:#7D8188;',
      '--act:#F2F3F5;--act-ink:#0A0B0D;',
      '--signal:#3ECF8E;--wait:#E7B75F;--deny:#F0655A;--info:#6CA5F2;',
      '--signal-dim:rgba(62,207,142,.14);--wait-dim:rgba(231,183,95,.14);',
      '--deny-dim:rgba(240,101,90,.14);--info-dim:rgba(108,165,242,.14);',
      '--mono:ui-monospace,"Cascadia Code",SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;',
      '--shadow-float:0 16px 48px rgba(0,0,0,.42),0 2px 8px rgba(0,0,0,.28);',
      '--font:system-ui,-apple-system,"Segoe UI Variable Text","Segoe UI",Roboto,"Helvetica Neue",sans-serif;',
      '}',
      /* light — media query AND explicit data-theme/data-pcc-theme */
      '@media (prefers-color-scheme: light){:root:not([data-theme="dark"]):not([data-pcc-theme="dark"]){',
      '--bg:#FAFAF8;--surface:#FFFFFF;--surface-2:#F2F2EF;--surface-3:#E9E9E5;',
      '--hairline:rgba(17,18,20,.09);--hairline-strong:rgba(17,18,20,.16);',
      '--ink:#17181A;--ink-2:#55585E;--ink-3:#8A8D94;--act:#17181A;--act-ink:#FAFAF8;',
      '--signal:#1FA467;--wait:#B4842D;--deny:#CC4437;--info:#3B72D9;',
      '--shadow-float:0 16px 48px rgba(23,24,26,.14),0 2px 8px rgba(23,24,26,.08);}}',
      ':root[data-theme="light"],:root[data-pcc-theme="light"]{',
      '--bg:#FAFAF8;--surface:#FFFFFF;--surface-2:#F2F2EF;--surface-3:#E9E9E5;',
      '--hairline:rgba(17,18,20,.09);--hairline-strong:rgba(17,18,20,.16);',
      '--ink:#17181A;--ink-2:#55585E;--ink-3:#8A8D94;--act:#17181A;--act-ink:#FAFAF8;',
      '--signal:#1FA467;--wait:#B4842D;--deny:#CC4437;--info:#3B72D9;',
      '--shadow-float:0 16px 48px rgba(23,24,26,.14),0 2px 8px rgba(23,24,26,.08);}',
      /* base */
      'html{color-scheme:dark light;}',
      'body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font);',
      '-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}',
      '#pcc-root{background:var(--bg);color:var(--ink);}',
      '#pcc-root header h1{font:650 30px/38px var(--font);letter-spacing:-.01em;margin:0 0 4px;padding:24px 16px 0;max-width:720px;margin-left:auto;margin-right:auto;}',
      '#pcc-root header p{color:var(--ink-2);font:400 15px/24px var(--font);margin:0;padding:0 16px;max-width:720px;margin-left:auto;margin-right:auto;}',
      '.pcc-wrap{max-width:720px;margin:0 auto;padding:16px;display:flex;flex-direction:column;gap:20px;box-sizing:border-box;}',
      '@media (min-width:760px){.pcc-wrap{padding:24px;}}',
      '.pcc-section{display:flex;flex-direction:column;gap:12px;}',
      '.pcc-section-heading{font:650 16px/22px var(--font);color:var(--ink);margin:8px 0 0;}',
      /* window: in-flow = hairline, NO shadow */
      '.pcc-win{background:var(--surface);border:1px solid var(--hairline);border-radius:14px;padding:16px 16px 14px;',
      'animation:pcc-rise 180ms cubic-bezier(.2,.7,.2,1);}',
      '@keyframes pcc-rise{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}',
      '.pcc-win-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;}',
      '.pcc-win-title{font:650 16px/22px var(--font);}',
      '.pcc-win-body{display:flex;flex-direction:column;gap:8px;}',
      '.pcc-win-foot{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px;padding-top:10px;border-top:1px solid var(--hairline);}',
      '.pcc-foot-trace{color:var(--ink-3);font-size:11px;}',
      '.pcc-foot-stale{color:var(--wait);font-size:11px;}',
      /* pills — dim fill only, saturated hue on text/dot */
      '.pcc-pill{font:450 12px/16px var(--font);padding:2px 8px;border-radius:999px;background:var(--surface-3);color:var(--ink-2);white-space:nowrap;transition:background 150ms,color 150ms;}',
      '.pcc-pill.st-settled{background:var(--signal-dim);color:var(--signal);}',
      '.pcc-pill.st-waiting{background:var(--wait-dim);color:var(--wait);}',
      '.pcc-pill.st-failed{background:var(--deny-dim);color:var(--deny);}',
      '.pcc-pill.st-running{background:var(--info-dim);color:var(--info);}',
      /* type helpers */
      '.pcc-muted{color:var(--ink-3);font:400 13px/18px var(--font);}',
      '.pcc-mono{font-family:var(--mono);font-size:12px;color:var(--ink-3);}',
      '.pcc-tnum{font-variant-numeric:tabular-nums;}',
      '.pcc-tag{font:450 12px/16px var(--font);color:var(--ink-2);background:var(--surface-3);padding:1px 7px;border-radius:6px;}',
      '.pcc-badge{font:450 12px/16px var(--font);color:var(--ink-2);}',
      /* note */
      '.pcc-win-note{background:transparent;border:none;padding:0;}',
      '.pcc-note-p{font:400 15px/24px var(--font);color:var(--ink-2);margin:0 0 8px;}',
      /* metric */
      '.pcc-metric-amount{font:650 22px/28px var(--font);color:var(--ink);}',
      /* capability */
      '.pcc-cap-title{display:flex;align-items:baseline;justify-content:space-between;gap:10px;}',
      '.pcc-cap-name{font:650 16px/22px var(--font);}',
      '.pcc-price-chip{font:450 13px/18px var(--font);color:var(--ink);background:var(--surface-3);padding:2px 8px;border-radius:8px;}',
      '.pcc-cap-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
      '.pcc-cap-desc{font:400 14px/21px var(--font);color:var(--ink-2);margin:2px 0 0;}',
      '.pcc-cap-assurance{font:400 13px/18px var(--font);color:var(--ink-3);margin:0;}',
      /* list */
      '.pcc-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;}',
      '.pcc-list-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--hairline);}',
      '.pcc-list-row:last-child{border-bottom:none;}',
      '.pcc-list-main{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.pcc-list-title{font:450 14px/20px var(--font);color:var(--ink);}',
      '.pcc-list-meta{font:400 12px/16px var(--font);color:var(--ink-3);}',
      /* form */
      '.pcc-form-fields{display:flex;flex-direction:column;gap:12px;}',
      '.pcc-field{display:flex;flex-direction:column;gap:4px;}',
      '.pcc-field-label{font:450 13px/18px var(--font);color:var(--ink-2);}',
      '.pcc-input{font:400 14px/20px var(--font);color:var(--ink);background:var(--surface-2);border:1px solid var(--hairline);border-radius:10px;padding:8px 10px;outline:none;box-sizing:border-box;width:100%;}',
      '.pcc-input:focus{border-color:var(--hairline-strong);}',
      '.pcc-input.bad{border-color:var(--deny);}',
      'textarea.pcc-input{resize:vertical;min-height:56px;}',
      '.pcc-checkbox{width:18px;height:18px;accent-color:var(--act);}',
      '.pcc-field-err{font:400 12px/16px var(--font);color:var(--deny);}',
      /* buttons */
      '.pcc-btn{font:500 14px/20px var(--font);border-radius:10px;padding:8px 14px;border:1px solid var(--hairline-strong);',
      'background:var(--surface-2);color:var(--ink);cursor:pointer;transition:background 150ms,transform 150ms;}',
      '.pcc-btn:hover{background:var(--surface-3);}',
      '.pcc-btn:active{transform:translateY(1px);}',
      /* host lockdown — disabled write controls + the "unavailable" note */
      '.pcc-btn:disabled,.pcc-btn-disabled{opacity:.45;cursor:not-allowed;}',
      '.pcc-btn:disabled:hover,.pcc-btn-disabled:hover{background:var(--surface-2);}',
      '.pcc-host-note{margin-top:6px;}',
      '.pcc-btn-primary{background:var(--act);color:var(--act-ink);border-color:var(--act);}',
      '.pcc-btn-primary:hover{opacity:.92;background:var(--act);}',
      '.pcc-btn-quiet{background:transparent;}',
      '.pcc-btn-sm{padding:4px 10px;font-size:13px;}',
      '.pcc-link{background:none;border:none;color:var(--info);font:450 13px/18px var(--font);cursor:pointer;padding:0;text-align:left;}',
      '.pcc-actionbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
      '.pcc-action-status{font:400 13px/18px var(--font);color:var(--ink-2);display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap;}',
      '.pcc-action-status.st-settled{color:var(--signal);}',
      '.pcc-action-status.st-failed{color:var(--deny);}',
      '.pcc-confirm-q{color:var(--ink-2);}',
      /* run */
      '.pcc-run-latest{font:450 15px/22px var(--font);color:var(--ink);}',
      '.pcc-run-elapsed{color:var(--ink-3);}',
      '.pcc-run-feed{max-height:220px;overflow:auto;background:var(--surface-2);border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:2px;}',
      '.pcc-feed-line{color:var(--ink-3);}',
      /* approval */
      '.pcc-approval{display:flex;flex-direction:column;gap:8px;}',
      '.pcc-approval-what{font:450 15px/22px var(--font);color:var(--ink);}',
      '.pcc-approval-line{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;}',
      '.pcc-approval-cost{font:650 16px/22px var(--font);color:var(--ink);}',
      '.pcc-approval-rationale{font:400 13px/19px var(--font);color:var(--ink-2);margin:0;}',
      '.pcc-args{display:flex;flex-direction:column;gap:2px;background:var(--surface-2);border-radius:10px;padding:8px;}',
      '.pcc-args-row{display:flex;justify-content:space-between;gap:10px;}',
      '.pcc-args-k{font:400 12px/18px var(--font);color:var(--ink-3);}',
      '.pcc-args-v{color:var(--ink-2);word-break:break-all;text-align:right;}',
      /* honest "this will send" block (directive 10) */
      '.pcc-realreq{display:flex;flex-direction:column;gap:3px;background:var(--surface-2);border:1px solid var(--hairline-strong);border-radius:10px;padding:8px 10px;}',
      '.pcc-realreq-title{font:450 11px/16px var(--font);color:var(--ink-3);text-transform:uppercase;letter-spacing:.04em;}',
      '.pcc-realreq-line{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;}',
      '.pcc-realreq-method{font:650 12px/18px var(--font);color:var(--ink);}',
      '.pcc-realreq-dest{color:var(--ink-2);word-break:break-all;}',
      '.pcc-realreq-amt{font:650 14px/20px var(--font);color:var(--ink);}',
      '.pcc-realreq-ref{color:var(--ink-3);}',
      '.pcc-realreq-blocked{color:var(--deny);font:650 12px/18px var(--font);}',
      /* receipt */
      '.pcc-receipt-amount{display:flex;align-items:baseline;gap:2px;}',
      '.pcc-receipt-num{font:650 22px/28px var(--font);color:var(--ink);}',
      '.pcc-receipt-cur{font:450 14px/20px var(--font);color:var(--ink-2);}',
      '.pcc-receipt-parties{display:flex;gap:8px;align-items:center;}',
      '.pcc-arrow{color:var(--ink-3);}',
      '.pcc-receipt-rail{display:flex;gap:2px;align-items:center;}',
      '.pcc-timeline{list-style:none;margin:6px 0 0;padding:0 0 0 12px;border-left:1px solid var(--hairline);display:flex;flex-direction:column;gap:6px;}',
      '.pcc-timeline-row{display:flex;justify-content:space-between;gap:10px;}',
      '.pcc-timeline-type{font:450 13px/18px var(--font);color:var(--ink);}',
      '.pcc-timeline-ts{color:var(--ink-3);}',
      '.pcc-receipt-tx{word-break:break-all;margin-top:6px;}',
      /* chain */
      '.pcc-chain-head{display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap;}',
      '.pcc-chain-outcome{font:650 16px/22px var(--font);}',
      '.pcc-chain-budget{font:450 13px/18px var(--font);color:var(--ink-2);}',
      '.pcc-chain-steps{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}',
      '.pcc-chain-step{font:450 13px/18px var(--font);color:var(--ink);background:var(--surface-2);padding:2px 8px;border-radius:8px;}',
      '.pcc-plan{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:4px;}',
      '.pcc-plan-row{display:flex;justify-content:space-between;gap:10px;}',
      '.pcc-plan-type{font:450 14px/20px var(--font);}',
      '.pcc-plan-total{margin-top:6px;color:var(--ink);font:650 14px/20px var(--font);}',
      /* connect + banner */
      '.pcc-connect{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:var(--surface);border:1px solid var(--hairline);border-radius:12px;padding:12px;}',
      '.pcc-connect-label{font:450 13px/18px var(--font);color:var(--ink-2);}',
      '.pcc-connect-input{max-width:240px;}',
      '.pcc-banner{display:flex;gap:8px;align-items:center;background:var(--wait-dim);color:var(--wait);border-radius:10px;padding:8px 12px;font:450 13px/18px var(--font);}',
      '.pcc-banner-dot{width:8px;height:8px;border-radius:999px;background:var(--wait);flex:none;}',
      /* chip (snapshot intent) */
      '.pcc-chip{font-family:var(--mono);font-size:12px;color:var(--ink);background:var(--surface-3);border:1px solid var(--hairline-strong);border-radius:8px;padding:3px 8px;cursor:pointer;}',
      '.pcc-chip-label{color:var(--ink-3);font:400 12px/16px var(--font);}',
      /* errors */
      '.pcc-err{color:var(--deny);font:400 14px/20px var(--font);}',
      '.pcc-err-honest{color:var(--ink-3);}',
      /* modal (floating = shadow) */
      '.pcc-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px;z-index:9999;}',
      '.pcc-modal{background:var(--surface);border:1px solid var(--hairline-strong);border-radius:14px;box-shadow:var(--shadow-float);padding:16px;max-width:440px;width:100%;display:flex;flex-direction:column;gap:12px;}',
      /* foot */
      '.pcc-kit-foot{padding-top:8px;border-top:1px solid var(--hairline);}',
      /* reduced motion kills all motion */
      '@media (prefers-reduced-motion: reduce){*{animation:none !important;transition:none !important;}}'
    ].join('');
    var style = el('style');
    style.id = 'pcc-ui-styles';
    style.textContent = css; // CSS text on a <style> node — not HTML injection
    document.head.appendChild(style);
  }

  // Object.assign shim (older webviews) — no external deps.
  if (typeof Object.assign !== 'function') {
    Object.assign = function (t) {
      for (var i = 1; i < arguments.length; i++) {
        var s = arguments[i]; if (!s) continue;
        for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k];
      }
      return t;
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
