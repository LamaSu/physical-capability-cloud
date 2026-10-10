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
 *   3. Every write passes the kit's Approval surface unless it is on the kit-owned
 *      NON_MONEY_WRITES allowlist (fail closed). One validated request descriptor
 *      drives the gate, the "This will send" display and the transport; only a
 *      kit-labelled Approve sends it, exactly as displayed.
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
  // Money detection is FAIL-CLOSED BY CONSTRUCTION: every manifest-authored WRITE is money (the
  // Approval gate; "submitted", never "done") unless it is one of the few writes KNOWN to move no
  // money. A new or unrecognised route therefore cannot slip through as "not money": being unlisted
  // already gates it (a new non-money route is merely over-gated until listed). Entries are exact
  // route templates (":" = one id segment) matched against the path the wire carries (canonicalPath).
  // The paid x402 routes (capabilities quote/simulate/route) are money and stay OFF this list. So do
  // artifact create/fork: they PUBLISH under the viewer's identity (visibility comes from the body),
  // so they pass the Approval gate, which shows exactly what would be published.
  var NON_MONEY_WRITES = [
    'POST /api/csd/validate',          // validate a CSD document
    'POST /api/csd/resolve',           // resolve a CSD by canonical URL
    'POST /api/feedback',              // product feedback
    'POST /api/feedback/agent-report', // an agent's feedback report
    // chain Plan (astra r5 F3 on #342). Effect review: routes/compose.ts POST /api/compose validates the
    // request, plans it (planComposition) and stores the proposal row (status "proposed"); it moves no
    // money and is not payment-gated. Only POST /api/compose/:id/execute acts, and that stays money.
    'POST /api/compose'
  ];
  // Kit-owned per-action EXECUTION state (ruling 5). It lives in a WeakMap keyed by the action
  // object, never ON the action: an action is untrusted manifest JSON, and a manifest must not be
  // able to pre-seed a key, strip the header, mark itself done, or make an action inert.
  //   posting a request (or hosted typed operation) for this action is in flight
  //   done    a MONEY write for this action was accepted (2xx): one-shot for this render
  //   gate    the identity of the ONE open Approval gate for this action (null when none)
  var ACTION_STATE = new WeakMap();
  function actionState(action) {
    var st = ACTION_STATE.get(action);
    if (!st) {
      st = { posting: false, done: false, gate: null };
      ACTION_STATE.set(action, st);
    }
    return st;
  }
  // Kit-owned per-REQUEST-INTENT state (astra r2 on #342, F1). An intent is the exact request the
  // wire would carry: method, pinned URL (query included) and body. Every action object describing
  // that request -- a cloned manifest entry, an approval window, a button -- shares ONE open gate, ONE
  // unresolved Idempotency-Key and ONE money one-shot, so a manifest cannot duplicate a money action
  // into independent approvals with different keys. The per-object state above still applies; the
  // stricter of the two wins.
  //   key     the Idempotency-Key while this intent's outcome is UNRESOLVED (A/B/A reuses A's key)
  //   posting / done / gate: as above, for the intent
  var INTENT_STATE = Object.create(null);
  // What the kit can and cannot know (astra r4 F1 on #342): a request's SPELLING is never its business
  // effect. Two differently spelled requests -- /release/0 vs /release/00, /api/settlement/release vs
  // /api/escrow/chain/:addr/release/:n, a method change -- can move the exact same money, and the kit
  // has no general way to tell. So the kit stops pretending endpoint identity IS effect identity: EVERY
  // money request, to ANY endpoint, shares ONE intent per view (per render):
  //   - accepted (2xx): the intent is done. Every further money request this render is refused --
  //     reload to make another. (A NON-money write is unaffected: a 2xx only consumes THAT write's own
  //     key, exactly as before.)
  //   - sent but not accepted (any other status, a throw, a network error): every further money request
  //     is refused, INCLUDING an identical retry, until a reload (astra r5 F1, F2 on #342). No status
  //     code proves "no effect": a route can mutate state and still answer 400. And no money route is
  //     durably idempotent today: the gateway's Idempotency-Key middleware is not registered in
  //     production, is in-memory, and re-runs a 5xx.
  // So one view sends at most ONE money request. Effect-level identity and idempotency are the SERVER's
  // to enforce; the kit cannot see past the wire, only guard it. A reload is the user's checkpoint:
  // check the earlier request's outcome, then decide.
  // A NON-money write (the allowlist) keeps the exact canonical request as its intent, UNCHANGED: object
  // keys sorted at every depth; the decoded pathname the gateway routes (desc.canonical) plus the
  // decoded query parameters, sorted by NAME only, so repeated values keep their order (?r=A&r=B is not
  // ?r=B&r=A; astra r3 F2).
  function canonicalJson(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    var i, out = [];
    if (Array.isArray(v)) {
      for (i = 0; i < v.length; i++) out.push(dataAt(v, i) === undefined ? 'null' : canonicalJson(dataAt(v, i)));
      return '[' + out.join(',') + ']';
    }
    var ks = Object.keys(v).sort();
    for (i = 0; i < ks.length; i++) { if (dataAt(v, dataAt(ks, i)) !== undefined) out.push(JSON.stringify(dataAt(ks, i)) + ':' + canonicalJson(dataAt(v, dataAt(ks, i)))); }
    return '{' + out.join(',') + '}';
  }
  function canonicalTarget(desc) {
    var q = [];
    try { new URL(desc.url).searchParams.forEach(function (val, key) { q.push([key, val]); }); } catch (e) { q = []; }
    q.sort(function (x, y) { return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0; }); // stable: equal names keep their order
    var qs = q.map(function (p) { return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]); }).join('&');
    return desc.canonical + (qs ? '?' + qs : '');
  }
  function requestFingerprint(desc) { return desc.method + ' ' + canonicalTarget(desc) + '\n' + canonicalJson(desc.body); }
  // One shared intent for EVERY money request this render, regardless of endpoint (astra r4 F1 on
  // #342): the kit cannot tell a genuinely new payment from an aliased retry of the same one, so it
  // fails closed over the whole view instead of trusting endpoint spelling. A NON-money write keeps
  // its own per-canonical-request intent in INTENT_STATE, exactly as before.
  var MONEY_INTENT = { key: null, request: null, posting: false, done: false, gate: null };
  function intentState(desc) {
    if (desc.money) return MONEY_INTENT;
    var k = requestFingerprint(desc);
    var it = dataAt(INTENT_STATE, k);
    // request: the fingerprint of the request that holds the unresolved key (only it may retry with it)
    if (!it) { it = { key: null, request: null, posting: false, done: false, gate: null }; INTENT_STATE[k] = it; }
    return it;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DOM helpers (verbatim shape from control-plane bus.js) — textContent only
  // ═══════════════════════════════════════════════════════════════════════

  // Runtime brands cannot be forged or copied: only these module-private mints register them.
  var TEXT_BRANDS = new WeakSet();
  window.__PCC_UI_TEXT_VIOLATIONS__ = 0;
  function mintText(t) {
    if (typeof t !== 'string') { window.__PCC_UI_TEXT_VIOLATIONS__++; t = '—'; }
    var text = Object.freeze({ t: t });
    TEXT_BRANDS.add(text);
    return text;
  }
  function kitText(t) { return mintText(t); }
  function isKitText(text) { return !!text && typeof text === 'object' && TEXT_BRANDS.has(text); }
  function readText(text) {
    if (isKitText(text)) return text.t;
    window.__PCC_UI_TEXT_VIOLATIONS__++;
    return '—';
  }
  function joinText() {
    var out = '';
    for (var i = 0; i < arguments.length; i++) {
      if (!isKitText(dataAt(arguments, i))) {
        window.__PCC_UI_TEXT_VIOLATIONS__++;
        return mintText('—');
      }
      out += dataAt(arguments, i).t;
    }
    return mintText(out);
  }
  function setText(node, text) { node.textContent = readText(text); }
  function setAttrText(node, name, text) {
    if (name !== 'title' && name !== 'placeholder') { window.__PCC_UI_TEXT_VIOLATIONS__++; return; }
    node.setAttribute(name, readText(text));
  }
  function setValue(input, text) { input.value = readText(text); }
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = readText(txt); // textContent — never innerHTML
    return e;
  }

  // Manifest prose has its own private tier; it never becomes kit-authored text.
  var AGENT_TEXT_BRANDS = new WeakSet();
  var WITHHELD_PROSE = kitText('Agent text withheld: it stated an amount or a payment or verification status. Money facts appear only in PCC cards.');
  var WITHHELD_FIELD = kitText('withheld: stated money or verification');
  function agentText(raw, prose) {
    var t = String(raw);
    if (isProseClaim(t)) return prose ? WITHHELD_PROSE : WITHHELD_FIELD;
    var text = Object.freeze({ t: t });
    AGENT_TEXT_BRANDS.add(text);
    return text;
  }
  // The sole agent sink marks the agent's words; PCC notices retain PCC authorship.
  function agentEl(tag, cls, text) {
    if (text === WITHHELD_PROSE || text === WITHHELD_FIELD) return el(tag, (cls || '') + ' pcc-withheld', text);
    var e = document.createElement(tag);
    e.className = (cls || '') + ' pcc-agent pcc-untrusted';
    if (text && typeof text === 'object' && AGENT_TEXT_BRANDS.has(text)) e.textContent = text.t;
    else { window.__PCC_UI_TEXT_VIOLATIONS__++; e.textContent = '—'; }
    return e;
  }
  function enumValueText(raw) { return mintText(String(raw)); }
  // The descriptor is the exact request the user is approving, never a settlement claim.
  function requestValueText(raw) { return mintText(wireText(raw)); }
  function requestMethodText(desc) { return kitText(desc.method === 'PATCH' ? 'PATCH' : 'POST'); }
  function requestDestinationText(desc) { return mintText(desc.destination); }
  function requestReasonText(desc, blocked) { return mintText((desc && desc.reason) || (blocked ? 'unsafe or non-PCC destination' : 'no valid request')); }
  function apiBaseText(raw) { return raw === API_ORIGIN ? mintText(raw) : kitText('—'); }
  function modeText(raw) {
    if (raw === 'snapshot') return kitText('snapshot');
    if (raw === 'host') return kitText('host');
    return kitText(raw === 'live-cors' ? 'live-cors' : 'live-same-origin');
  }
  function numberText(raw) { return typeof raw === 'number' && isFinite(raw) ? mintText(String(raw)) : kitText('—'); }
  function currencyText(raw) {
    if (raw === 'USDC') return kitText('USDC');
    if (raw === 'ETH') return kitText('ETH');
    return kitText(raw === 'DAI' ? 'DAI' : 'currency not reported');
  }
  function settlementCaptionText(row, bindingPath, live) {
    // Captions are chosen by the closed settlement classifiers, never from server prose.
    return mintText(settlementReadClass(row, bindingPath, live)[1] || '');
  }
  function traceSuffixText(raw) {
    var trace = traceText(raw);
    return trace.t ? joinText(kitText(' · '), trace) : kitText('');
  }
  function joinWithText(separator, parts) {
    var joined = kitText('');
    for (var i = 0; i < parts.length; i++) joined = joinText(joined, i ? separator : kitText(''), dataAt(parts, i));
    return joined;
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

  var HOST_WRITE_NOTE = kitText('Actions are unavailable in this host view.');
  function isHostEmbed() { return window.__PCC_HOST__ === true; }
  function hostDisableBtn(btn) {
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    if ((' ' + btn.className + ' ').indexOf(' pcc-btn-disabled ') === -1) btn.className += ' pcc-btn-disabled';
    if (!btn.title) setAttrText(btn, 'title', HOST_WRITE_NOTE);
  }
  // R4 PR2 — the registered typed-operation allowlist injected onto the window by
  // the host boot script (window.__PCC_HOST_OPERATIONS__). An action naming one
  // of these operations may run in host mode via the bridge; every other action
  // stays inert. Client-side default-DENY that mirrors the server registry.
  function hostOperationAllowed(operationId) {
    if (!operationId) return false;
    var ops = window.__PCC_HOST_OPERATIONS__;
    if (!ops || !ops.length) return false;
    for (var i = 0; i < ops.length; i++) { if (dataAt(ops, i) === operationId) return true; }
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
      if ((' ' + dataAt(btns, i).className + ' ').indexOf(' pcc-host-op-enabled ') !== -1) continue;
      hostDisableBtn(dataAt(btns, i));
      lockedAny = true;
    }
    if (lockedAny) container.appendChild(el('div', 'pcc-host-note pcc-muted', HOST_WRITE_NOTE));
  }
  function markWriteUnavailable(status) {
    if (!status) return;
    status.className = 'pcc-action-status';
    setText(status, HOST_WRITE_NOTE);
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
        var cleaned = String(String(h).replace(/([#&])pcc_key=[^&]*/, '$1')).replace(/[#&]+$/, '');
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
    try { return String(apiBase).replace(/\/+$/, '') === location.origin; } catch (e) { return false; }
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
    // The URL parser silently strips TAB/LF/CR anywhere, trims edge spaces and control characters,
    // and drops a '#fragment', so "/api/comp\tose" would be SENT as /api/compose. Refuse them (and
    // the C1 controls): the path we classify must be the path we send.
    if (/[\s#\u0000-\u001f\u007f-\u009f]/.test(path)) return null;
    if (isAbsoluteOrSchemeUrl(path)) return null;   // no absolute / scheme / //host
    if (path.charAt(0) !== '/') return null;         // must be root-relative
    if (path.indexOf('\\') !== -1) return null;      // backslash escape
    var pathPart = path.split('?')[0];
    // Ambiguous encodings have no single meaning, so they are refused outright (fail closed, no
    // request): %25 decodes to ANOTHER escape (double encoding: %252F -> %2F -> '/'), and an encoded
    // / \ ? # splits the path differently at each layer (URL parser, edge, gateway router).
    if (/%(25|2f|5c|3f|23)/i.test(pathPart)) return null;
    var decoded;
    try { decoded = decodeURIComponent(pathPart); } catch (e) { return null; } // malformed %-escape
    if (decoded.indexOf('\\') !== -1) return null;
    var segs = decoded.split('/');
    for (var i = 0; i < segs.length; i++) {
      if (dataAt(segs, i) === '..' || dataAt(segs, i) === '.') return null; // traversal (incl. %2e%2e)
    }
    if (decoded.indexOf('..') !== -1) return null;   // belt-and-suspenders (encoded joins)
    if (isHost && !/^\/(api|sse)(\/|$)/.test(decoded)) return null; // PCC namespace allowlist
    return path; // original path (query preserved) — safe against the fixed base
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The ONE canonical request descriptor (ruling 3). A write is validated ONCE,
  // here, into the exact request the wire will carry, and that same object
  // drives everything downstream: the money decision (the Approval gate), button
  // styling, the "This will send" display, rebindApproval, the idempotency
  // intent, and the transport (Transport.send fetches desc.url with desc.method
  // and re-derives neither). A refusal fails closed: ok:false, nothing can be
  // sent, money stays true, and `reason` says why.
  // ═══════════════════════════════════════════════════════════════════════

  // Only the two write kinds the schema defines, matched EXACTLY: "post" -> POST, "patch" -> PATCH.
  // Anything else ("PATCH", "put", "delete", "get", missing) is refused; it never becomes a POST.
  function actionMethod(action) {
    var k = action ? action.kind : null;
    return k === 'post' ? 'POST' : (k === 'patch' ? 'PATCH' : null);
  }
  // The canonical form of the pathname the wire carries, %-decoded the way the gateway routes it.
  // An ambiguous escape has no single canonical form: null (fail closed; safeApiPath refuses them
  // first, this keeps the classifier closed on its own).
  function canonicalPath(pathname) {
    var p = String(pathname == null ? '' : pathname);
    if (/%(25|2f|5c|3f|23)/i.test(p)) return null;
    try { return decodeURIComponent(p); } catch (e) { return null; }
  }
  function matchesWriteTemplate(template, method, path) {
    var sp = template.indexOf(' ');
    if (template.slice(0, sp) !== method) return false;
    var t = template.slice(sp + 1).split('/'), p = path.split('/');
    if (t.length !== p.length) return false;
    for (var i = 0; i < t.length; i++) {
      if (dataAt(t, i) === ':') { if (!/^[A-Za-z0-9_.~-]+$/.test(dataAt(p, i))) return false; }
      else if (dataAt(t, i) !== dataAt(p, i)) return false;
    }
    return true;
  }
  // True only for an EXACT allowlisted (method, route) carrying no query string; every other write
  // is money (the Approval gate) until the kit's allowlist says otherwise.
  function isNonMoneyWrite(method, canonical, search) {
    if (search) return false;
    for (var i = 0; i < NON_MONEY_WRITES.length; i++) {
      if (matchesWriteTemplate(dataAt(NON_MONEY_WRITES, i), method, canonical)) return true;
    }
    return false;
  }
  // The request body exactly as the kit displays AND sends it: a plain copy of the sources' OWN
  // enumerable keys (overrides win). A "__proto__" key cannot be copied as data -- assigning it
  // re-parents the copy instead -- so an inherited amount or ref would be DISPLAYED while the wire
  // carries only the own keys. Such a body has no single meaning: null (the descriptor refuses it).
  function plainBody(base, overrides) {
    var out = {};
    var srcs = [base, overrides];
    for (var s = 0; s < srcs.length; s++) {
      var src = dataAt(srcs, s);
      if (!src || typeof src !== 'object') continue;
      var ks = Object.keys(src);
      for (var i = 0; i < ks.length; i++) {
        if (dataAt(ks, i) === '__proto__') return null;
        out[dataAt(ks, i)] = dataAt(src, dataAt(ks, i));
      }
    }
    return out;
  }
  // [name, value] for each named field the body carries as its OWN key, in the given order.
  function ownFields(b, names, truthy) {
    var out = [];
    for (var i = 0; i < names.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(b, dataAt(names, i))) continue;
      var v = dataAt(b, dataAt(names, i));
      if (truthy ? v : v != null) out.push([dataAt(names, i), v]);
    }
    return out;
  }
  // -> { ok, method, path (the request-target the wire carries), canonical (decoded pathname),
  //      url (the pinned absolute URL string fetch receives), money, destination (display === url),
  //      reason (why refused), body (the kit's copy of the request body), amounts / refs (EVERY
  //      amount- / reference-like field the body carries, as [name, value]), amount / asset / refId
  //      (the first of each; assetField names the body field the asset came from, if any) }
  function requestDescriptor(action, body, isHost, base, overrides) {
    var b = plainBody(body, overrides);
    // A POST's idempotencyKey is kit-owned (the kit sets it on send): a manifest value never reaches the
    // intent, the display or the wire (astra r3 F1 on #342). A PATCH body's idempotencyKey stays plain
    // data, shown and sent as is (review charlie F4: the kit keys a PATCH by header only).
    if (b && actionMethod(action) === 'POST') delete b.idempotencyKey;
    var own = b || {};
    var amounts = ownFields(own, ['amount', 'totalAmount', 'value', 'priceUSD', 'budgetUSD'], false);
    var refs = ownFields(own, ['jobId', 'escrowId', 'escrowAddress', 'offerId', 'compositionId', 'id'], true);
    var assets = ownFields(own, ['currency', 'asset'], true);
    var d = {
      ok: false, method: actionMethod(action), path: null, canonical: null, url: null,
      money: true, destination: null, reason: null, body: own, amounts: amounts, refs: refs,
      amount: amounts.length ? amounts[0][1] : null,
      asset: assets.length ? assets[0][1] : null,
      assetField: assets.length ? assets[0][0] : null,
      refId: refs.length ? refs[0][1] : null
    };
    if (!d.method) { d.reason = 'unsupported action kind (only "post" and "patch" can write)'; return d; }
    if (b === null) { d.reason = 'the request body has a "__proto__" key, so what it shows and what it sends would differ'; return d; }
    var safe = safeApiPath(action.path, isHost);
    if (safe === null) { d.reason = 'unsafe or ambiguous request path'; return d; }
    var u = pinnedUrl(base, safe);
    if (u === null) { d.reason = 'request resolves outside the PCC API origin'; return d; }
    var canon = canonicalPath(u.pathname);
    if (canon === null) { d.reason = 'ambiguous path encoding'; return d; }
    d.ok = true;
    d.url = u.toString();
    d.path = u.pathname + u.search;
    d.canonical = canon;
    d.destination = d.url;
    d.money = action.confirm === 'approval' || !isNonMoneyWrite(d.method, canon, u.search);
    return d;
  }

  // The display facts of that descriptor -- exactly the fields realRequestNode renders in "This will
  // send": method, the exact destination URL, amount/asset and job/escrow ref. The REAL request, never
  // manifest confirmation text (directive 10); `destination === null` means it was refused. Kept as
  // the pure surface the gateway's directive-10 tests pin.
  function describeRealRequest(apiBase, action, body, isHost) {
    var d = requestDescriptor(action, body, isHost, apiBase);
    return { method: d.method, destination: d.destination, amount: d.amount, asset: d.asset, refId: d.refId };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Formatting + dot-path pluck (no eval; a manual split/reduce)
  // ═══════════════════════════════════════════════════════════════════════

  // Dynamic data reads admit only enumerable own fields, as a fresh JSON copy
  // would. Read the requested field once; copying the object per read makes
  // loops quadratic in its width. The lint reviews this exact guarded read.
  // Numeric array/arguments/NodeList positions retain their requested-index semantics.
  function dataAt(raw, key) {
    if (raw == null) throw new TypeError('Cannot read absent data');
    if (typeof key === 'number' && key >= 0 && key % 1 === 0 && typeof raw.length === 'number') {
      return Array.prototype.slice.call(raw, key, key + 1)[0];
    }
    if (key === 'length' && typeof raw.length === 'number') return raw.length;
    return Object.prototype.propertyIsEnumerable.call(raw, key) ? raw[key] : undefined;
  }
  function dot(obj, path) {
    if (path == null || path === '') return obj;
    var parts = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      var k = dataAt(parts, i);
      cur = Array.isArray(cur) && /^\d+$/.test(k) ? dataAt(cur, parseInt(k, 10)) : dataAt(cur, k);
    }
    return cur;
  }

  // A settlement record's economics.amount is a raw integer in the token's BASE units (read-surface
  // contract rule 14). It becomes a display amount only with the record's own tokenDecimals (exact
  // string arithmetic, no float); without them it is shown as labelled base units, because
  // 1000000 base units of a 6-decimal token is 1, not 1,000,000.00. Anything else: null.
  function baseUnitsText(raw, decimals) {
    var s = typeof raw === 'number' && isFinite(raw) && raw % 1 === 0 && raw >= 0 ? String(raw) : raw;
    if (typeof s !== 'string' || !/^\d+$/.test(s)) return kitText('amount not reported');
    if (typeof decimals !== 'number' || decimals % 1 !== 0 || decimals < 0 || decimals > 36) {
      return mintText(String(s).replace(/^0+(?=\d)/, '') + ' base units (decimals not reported)');
    }
    while (s.length <= decimals) s = '0' + s;
    var ip = String(s.slice(0, s.length - decimals)).replace(/^0+(?=\d)/, ''), fp = String(s.slice(s.length - decimals)).replace(/0+$/, '');
    return mintText(String(ip).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fp ? '.' + fp : ''));
  }
  function fmtUsdRaw(v) {
    if (!(typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)))) return 'amount not reported';
    var n = Number(v);
    if (!isFinite(n)) return 'amount not reported';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtUsd(v) {
    var text = fmtUsdRaw(v);
    return text === 'amount not reported' ? kitText('amount not reported') : mintText(text);
  }
  function fmtTs(v) {
    if (!(canonicalPlainTime(v) || (typeof v === 'number' && isFinite(v)))) return kitText('time not reported');
    var d = new Date(v);
    if (!isFinite(d.getTime())) return kitText('time not reported');
    try { return mintText(d.toLocaleString()); } catch (e) { return mintText(d.toISOString()); }
  }
  function fmtVal(v, format, path) {
    if (v == null) return kitText('—');
    if (format === 'ts') return timeText(v);
    if (typeof v !== 'number' || !isFinite(v)) return boundText(path, v, false);
    switch (format) {
      case 'usd': return fmtUsd(v);
      case 'int': { var n = Number(v); return mintText(Math.round(n).toLocaleString('en-US')); }
      case 'pct': { var p = Number(v); return mintText((p <= 1 ? (p * 100).toFixed(0) : p.toFixed(0)) + '%'); }
      case 'ts': return timeText(v);
      default: return numberText(v);
    }
  }

  // Status -> semantic pill class (hue = meaning only).
  // MONEY HONESTY (read-route contract sec A + rule 1): money state is mapped by EXACT
  // normalized key, NEVER by substring -- "funded" must not green "refunded"/"underfunded",
  // "releas" must not green "unreleased", "complet" must not green "incomplete". A refund is a
  // FINAL settlement where the operator was NOT paid -> never green. Allocated-not-final and any
  // unmapped/unknown status FAIL CLOSED to a neutral pill, never "settled".
  // MONEY_STATUS mirrors the canonical @pcc/spec table (packages/spec/src/money/money-status.ts)
  // VERBATIM: this vanilla asset has no bundler, so it cannot import it. The CI conformance test
  // packages/spec/src/__tests__/money-status.conformance.test.ts proves the two tables agree key
  // for key (same keys, same tone, same label). Edit both, or CI fails.
  // <status-map v2> -- extracted verbatim by money-status.conformance.test.ts; keep the markers.
  // Only a plain status word is classified: a non-string, or punctuation / control / non-ASCII
  // characters ("RELEASED?", "releaſed", ["RELEASED"]) are REJECTED to '' -> unknown, never green.
  function normStatus(s) {
    if (typeof s !== 'string') return '';
    var t = s.trim();
    if (!/^[A-Za-z0-9 _-]+$/.test(t)) return '';
    return String(String(t.toUpperCase()).replace(/[ _-]+/g, '_')).replace(/^_+|_+$/g, '');
  }
  function freezeTable(t) {
    for (var k in t) { if (Object.prototype.hasOwnProperty.call(t, k)) Object.freeze(dataAt(t, k)); }
    return Object.freeze(t);
  }
  // Flat table for BARE words: key -> [pillClass, honest label]. It has NO st-settled entry: a bare
  // word is never authoritative settlement state (steward #2490). Green comes only from a V-next
  // settlement read model whose fields agree (settlementRecordClass). SETTLED, COMPLETED and
  // RELEASED take the conservative reading; AWAITING_FUNDING (state 0) is a read error.
  var MONEY_STATUS = freezeTable({
    // V-next UnitState names, as bare words
    FUNDED_ACTIVE:     ['st-running',  'active - funds committed, no outcome yet'],
    PRIMARY_ASSERTED:  ['st-waiting',  'primary assertion accepted - not final'],
    CHALLENGED:        ['st-waiting',  'challenged - not final'],
    BACKUP_PENDING:    ['st-waiting',  'escalated to backup - not final'],
    BACKUP_ASSERTED:   ['st-waiting',  'backup assertion accepted - not final'],
    RELEASE_ALLOCATED: ['st-waiting',  'release decided - payout outstanding'],
    REFUND_ALLOCATED:  ['st-waiting',  'refund decided - payer not yet refunded'],
    SETTLED_RELEASED:  ['st-waiting',  'reported released - not confirmed by a settlement read'],
    SETTLED_REFUNDED:  ['st-refunded', 'payer refunded - payees NOT paid'],
    // Escrow.status (spec types/settlement.ts)
    CREATED:    ['st-waiting',  'escrow created - unfunded'],
    FUNDED:     ['st-waiting',  'funds held - not released'],
    ACTIVE:     ['st-running',  'active'],
    COMPLETING: ['st-waiting',  'completing - not yet final'],
    COMPLETED:  ['st-waiting',  'completed - settlement not confirmed'],
    DISPUTED:   ['st-failed',   'disputed'],
    REFUNDED:   ['st-refunded', 'payer refunded - operator NOT paid'],
    // EscrowStatus (spec types/common.ts)
    UNFUNDED:  ['st-waiting',  'unfunded'],
    LOCKED:    ['st-running',  'funds locked - step in progress'],
    RELEASING: ['st-waiting',  'releasing - challenge window open, not yet paid'],
    RELEASED:  ['st-waiting',  'released - not confirmed by a settlement read'],
    SLASHED:   ['st-failed',   'bond slashed'],
    // Dashboard escrow DTO (apps/dashboard/src/types/dto.ts)
    PENDING: ['st-waiting', 'pending - not yet funded'],
    EXPIRED: ['st-failed',  'expired - not released'],
    // Context-pack escrow summary (gateway routes/context-pack.ts)
    MILESTONE_MET: ['st-waiting', 'milestone met - release pending']
  });
  // V-next unit states by ordinal: enum UnitState in packages/contracts/src/libraries/VNextSettlementLib.sol.
  var VNEXT_UNIT_STATES = Object.freeze(['AWAITING_FUNDING', 'FUNDED_ACTIVE', 'PRIMARY_ASSERTED', 'CHALLENGED', 'BACKUP_PENDING',
    'BACKUP_ASSERTED', 'RELEASE_ALLOCATED', 'REFUND_ALLOCATED', 'SETTLED_RELEASED', 'SETTLED_REFUNDED']);
  // Presentation of each reachable V-next state read from a CONSISTENT read model (the only green).
  var VNEXT_STATE_PRESENTATION = freezeTable({
    FUNDED_ACTIVE:     ['st-running',  'active - funds committed, no outcome yet'],
    PRIMARY_ASSERTED:  ['st-waiting',  'primary assertion accepted - not final'],
    CHALLENGED:        ['st-waiting',  'challenged - not final'],
    BACKUP_PENDING:    ['st-waiting',  'escalated to backup - not final'],
    BACKUP_ASSERTED:   ['st-waiting',  'backup assertion accepted - not final'],
    RELEASE_ALLOCATED: ['st-waiting',  'release decided - payout outstanding'],
    REFUND_ALLOCATED:  ['st-waiting',  'refund decided - payer not yet refunded'],
    SETTLED_RELEASED:  ['st-settled',  'released - payout distribution discharged'],
    SETTLED_REFUNDED:  ['st-refunded', 'refunded - payer refunded, payees NOT paid']
  });
  // The read models' `phase` per reachable state (gateway unit-state-mapper PHASE_BY_STATE).
  var VNEXT_PHASE = Object.freeze({
    FUNDED_ACTIVE: 'active', PRIMARY_ASSERTED: 'contest', CHALLENGED: 'contest',
    BACKUP_PENDING: 'escalation', BACKUP_ASSERTED: 'escalation',
    RELEASE_ALLOCATED: 'allocated', REFUND_ALLOCATED: 'allocated',
    SETTLED_RELEASED: 'settled', SETTLED_REFUNDED: 'settled'
  });
  // Generic (non-money) run/action states. NEVER consulted for money data (see dataStatusClass). Green
  // means money finally reached the payee and nothing else is ever green, so a generic success word is a
  // NEUTRAL acknowledgement (st-ack): whatever the routing heuristic decides, it cannot paint money green
  // (astra r2 on #313, F2).
  var GENERIC_STATES = Object.freeze({
    RUNNING: 'st-running', IN_PROGRESS: 'st-running', PROGRESS: 'st-running', STREAMING: 'st-running', BUILDING: 'st-running', CONNECTING: 'st-running',
    PENDING: 'st-waiting', QUEUED: 'st-waiting', WAITING: 'st-waiting', PAUSED: 'st-waiting', REVIEW: 'st-waiting', CONFIRM: 'st-waiting', NEEDS_INPUT: 'st-waiting', NEEDS_YOU: 'st-waiting',
    ERROR: 'st-failed', FAILED: 'st-failed', DENIED: 'st-failed', CANCELLED: 'st-failed', CANCELED: 'st-failed', REJECTED: 'st-failed',
    DONE: 'st-ack', COMPLETE: 'st-ack', COMPLETED: 'st-ack', OK: 'st-ack', SUCCESS: 'st-ack', SUCCEEDED: 'st-ack', RESOLVED: 'st-ack', READY: 'st-ack'
  });
  // NON-money data only (a job, a kernel): generic run/action states first, then the flat money
  // table (which has no green). Callers route money data away from here (dataStatusClass).
  function statusClass(s) {
    var k = normStatus(s);
    if (k !== '' && Object.prototype.hasOwnProperty.call(GENERIC_STATES, k)) return dataAt(GENERIC_STATES, k);
    if (k !== '' && Object.prototype.hasOwnProperty.call(MONEY_STATUS, k)) return dataAt(MONEY_STATUS, k)[0];
    return 'st-unknown'; // fail closed -- an unmapped status is NEVER rendered as settled/green
  }
  // A BARE money word: the flat table only (never green). A generic success word ("done",
  // "success", "ok") is not a money state.
  function moneyStatusClass(s) {
    var k = normStatus(s);
    return (k !== '' && Object.prototype.hasOwnProperty.call(MONEY_STATUS, k)) ? dataAt(MONEY_STATUS, k)[0] : 'st-unknown';
  }
  // Honest direction label for a bare money word; null for non-money/unknown.
  function settlementLabel(s) {
    var k = normStatus(s);
    return (k !== '' && Object.prototype.hasOwnProperty.call(MONEY_STATUS, k)) ? dataAt(MONEY_STATUS, k)[1] : null;
  }
  // The V-next state NAME for a wire value: an integer 1..9 or its exact name. 0 is a read error
  // (unitState() reverts for a missing unit); anything else is null.
  function vnextUnitStateName(v) {
    var i = -1;
    if (typeof v === 'number' && Math.floor(v) === v) i = v;
    else if (typeof v === 'string') i = VNEXT_UNIT_STATES.indexOf(v);
    return (i >= 1 && i <= 9) ? dataAt(VNEXT_UNIT_STATES, i) : null;
  }
  function ownKey(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isVNextRecord(o) { return !!o && typeof o === 'object' && !Array.isArray(o) && (ownKey(o, 'unitState') || ownKey(o, 'finalState')); }
  // A record classified by its SOURCE SCHEMA -> [pillClass, label or null, pill text]. Mirrors
  // classifySettlementRecord in @pcc/spec (the conformance test compares them over wire fixtures).
  // The read models' own field semantics (gateway unit-state-mapper): isTerminal is true for 8/9
  // only; isAllocated means "outcome decided, money NOT fully moved" (6/7 ONLY), so a settled
  // record says isAllocated:false; finalState names 8/9, else null; phase follows VNEXT_PHASE.
  // Every field present must agree, and a FINAL state needs them all (mirrors the spec).
  function settlementRecordClass(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return ['st-unknown', 'not a settlement record', 'no settlement state'];
    var DISAGREE = 'settlement fields disagree - not shown as final', INCOMPLETE = 'incomplete settlement record - not shown as final';
    if (ownKey(o, 'unitState')) {
      var name = vnextUnitStateName(o.unitState);
      if (name === null) return ['st-unknown', 'unreadable unit state', String(o.unitState)];
      var ord = VNEXT_UNIT_STATES.indexOf(name), terminal = ord >= 8, allocated = ord === 6 || ord === 7;
      var fs = o.finalState === undefined ? null : o.finalState;
      if ((ownKey(o, 'finalState') && fs !== (terminal ? name : null)) ||
          (ownKey(o, 'isAllocated') && o.isAllocated !== allocated) ||
          (ownKey(o, 'isTerminal') && o.isTerminal !== terminal) ||
          (ownKey(o, 'phase') && o.phase !== dataAt(VNEXT_PHASE, name))) {
        return ['st-unknown', DISAGREE, name];
      }
      // A FINAL state needs unitState, finalState, isAllocated and phase present: absence is not
      // corroboration. isTerminal is cross-checked above when present; /receipt (which gains
      // unitState, escrow #3163) does not carry it. The 6-vs-7 direction comes from unitState.
      if (terminal && !(ownKey(o, 'finalState') && ownKey(o, 'isAllocated') && ownKey(o, 'phase'))) {
        return ['st-unknown', INCOMPLETE, name];
      }
      return [dataAt(VNEXT_STATE_PRESENTATION, name)[0], dataAt(VNEXT_STATE_PRESENTATION, name)[1], name];
    }
    // A /receipt carries finalState, phase and isAllocated (no unitState, no isTerminal).
    if (ownKey(o, 'finalState')) {
      var f = o.finalState, final = f === 'SETTLED_RELEASED' || f === 'SETTLED_REFUNDED';
      if (ownKey(o, 'isTerminal') && o.isTerminal !== final) return ['st-unknown', DISAGREE, String(f)];
      if (final) {
        if (!ownKey(o, 'isAllocated') || !ownKey(o, 'phase')) return ['st-unknown', INCOMPLETE, f];
        if (o.isAllocated !== false || o.phase !== 'settled') return ['st-unknown', DISAGREE, f];
        return [dataAt(VNEXT_STATE_PRESENTATION, f)[0], dataAt(VNEXT_STATE_PRESENTATION, f)[1], f];
      }
      if (f === null && o.isAllocated === true) {
        if (ownKey(o, 'phase') && o.phase !== 'allocated') return ['st-unknown', DISAGREE, String(o.phase)];
        return ['st-waiting', 'outcome decided - not yet paid out', String(o.phase || 'allocated')];
      }
      if (f === null && o.isAllocated === false) {
        if (ownKey(o, 'phase') && !(o.phase === 'active' || o.phase === 'contest' || o.phase === 'escalation')) return ['st-unknown', DISAGREE, String(o.phase)];
        return ['st-waiting', 'in progress - no outcome decided', String(o.phase || 'in progress')];
      }
      return ['st-unknown', 'unreadable final state', String(f)];
    }
    if (typeof o.status === 'string' && (ownKey(o, 'contractAddress') || ownKey(o, 'escrowAddress') || Array.isArray(o.milestones) || ownKey(o, 'cwmId') || ownKey(o, 'totalAmount'))) {
      return [moneyStatusClass(o.status), settlementLabel(o.status), o.status];
    }
    return ['st-unknown', 'not a settlement record', o.status != null ? String(o.status) : 'no settlement state'];
  }
  // Which table a DATA surface (list rows, run status) uses is decided by the DATA, not the window
  // kind. Data is money unless its binding is a known NON-money read AND it carries no money field:
  // fail closed, so an escrow row's "success" or "completed" is never shown as paid.
  var NON_MONEY_READS = /^\/api\/(jobs|kernels|capabilities|agents|artifacts|csd|sensors|devices|skills)(\/|$)/;
  var MONEY_FIELDS = Object.freeze(['amount', 'totalAmount', 'price', 'fee', 'payout', 'payer', 'payee', 'escrow', 'escrowId', 'escrowAddress', 'settlement', 'txHash', 'unitState', 'finalState']);
  function isMoneyData(bindingPath, row) {
    var p = typeof bindingPath === 'string' ? bindingPath.split('?')[0] : '';
    if (!NON_MONEY_READS.test(p)) return true;
    if (row && typeof row === 'object') {
      for (var i = 0; i < MONEY_FIELDS.length; i++) {
        if (ownKey(row, dataAt(MONEY_FIELDS, i)) && dataAt(row, dataAt(MONEY_FIELDS, i)) != null) return true;
      }
    }
    return false;
  }
  // The only routes whose LIVE reads may present a FINAL settlement state (mirrors the spec's
  // SETTLEMENT_READ_ROUTE; the unit id is the route's own UNIT_ID_RE).
  var SETTLEMENT_READ_ROUTE = /^\/api\/settlement\/units\/0x[0-9a-fA-F]{64}\/(receipt|lifecycle)$/;
  // DISPLAY class of a settlement record given where it came from -> [pillClass, label, text]. Mirrors
  // classifySettlementRead: a FINAL V-next state (settled 8, refunded 9) needs a LIVE read of an exact
  // per-unit settlement route. Field shape is not provenance (astra r2 on #313, F1): a baked snapshot,
  // a fallback, a stream event or a settled-shaped body from any other route is unknown.
  function settlementReadClass(o, bindingPath, live) {
    var rc = settlementRecordClass(o);
    if (!isVNextRecord(o) || (rc[0] !== 'st-settled' && rc[0] !== 'st-refunded')) return rc;
    var p = typeof bindingPath === 'string' ? bindingPath.split('?')[0] : '';
    if (live === true && SETTLEMENT_READ_ROUTE.test(p)) return rc;
    return ['st-unknown', 'final state not shown - not a live read of a settlement route', rc[2]];
  }
  function dataStatusClass(bindingPath, row, s, live) {
    if (!isMoneyData(bindingPath, row)) return statusClass(s);
    if (isVNextRecord(row)) return settlementReadClass(row, bindingPath, live)[0]; // a read model: schema AND source
    return moneyStatusClass(s); // a bare money word: never green
  }
  // Pill TEXT (astra r4 on #313, F6; astra r5 on #313, F7-F9). The class decides the colour, and the text
  // may not claim more. Fails CLOSED over a CLOSED safe vocabulary (no blacklist to miss a spelling, and
  // no blacklist to over-qualify a non-money surface, astra r5 F7/F9): unverified text is shown as-is
  // only when it normalizes to a word on the surface's OWN safe list; anything else is qualified, with a
  // suffix that matches the surface (money: "settlement unconfirmed"; non-money: "status unverified").
  // Mirrors the spec's statusPillText (the conformance test compares them).
  var SAFE_STATUS_WORDS = Object.freeze({
    RUNNING: true, IN_PROGRESS: true, PROGRESS: true, STREAMING: true, BUILDING: true, CONNECTING: true,
    PENDING: true, QUEUED: true, WAITING: true, PAUSED: true, REVIEW: true, CONFIRM: true, NEEDS_INPUT: true, NEEDS_YOU: true,
    ERROR: true, FAILED: true, DENIED: true, CANCELLED: true, CANCELED: true, REJECTED: true,
    DONE: true, COMPLETE: true, COMPLETED: true, OK: true, SUCCESS: true, SUCCEEDED: true, RESOLVED: true, READY: true,
    DISPATCHED: true, ACCEPTED: true, PREPARING: true, EXECUTING: true, COLLECTING_EVIDENCE: true, AWAITING_PICKUP: true, TIMED_OUT: true,
    ONLINE: true, OFFLINE: true, MAINTENANCE: true, SUSPENDED: true, HEALTHY: true, DEGRADED: true, UNKNOWN: true,
    BIDDING: true, ASSIGNED: true, PROPOSED: true, OVER_BUDGET: true, NO_PATH_FOUND: true, APPROVED: true, EXPIRED: true,
    ACTIVE: true, INACTIVE: true, REVOKED: true, IDLE: true, BUSY: true, DRAFT: true, DEPRECATED: true, RESERVED: true, LIVE: true, STUB: true, PLANNED: true
  });
  var SAFE_MONEY_STATUS_WORDS = Object.freeze({
    RUNNING: true, IN_PROGRESS: true, PROGRESS: true, PENDING: true, QUEUED: true, WAITING: true, PAUSED: true, REVIEW: true,
    ERROR: true, FAILED: true, DENIED: true, CANCELLED: true, CANCELED: true, REJECTED: true, EXPIRED: true, UNKNOWN: true
  });
  var UNCONFIRMED_SUFFIX = ' - settlement unconfirmed';
  var UNVERIFIED_SUFFIX = ' - status unverified';
  function statusPillText(raw, verified, money) {
    var t = raw == null ? '' : String(raw);
    if (verified || t === '') return mintText(t);
    var k = normStatus(t);
    var safe = money ? SAFE_MONEY_STATUS_WORDS : SAFE_STATUS_WORDS;
    if (k !== '' && ownKey(safe, k)) return mintText(t);
    return mintText('reported status: ' + t + (money ? UNCONFIRMED_SUFFIX : UNVERIFIED_SUFFIX));
  }
  // A free-text server MESSAGE outside a pill (astra r6 F12): never PCC's own claim, so it is attributed
  // to its source, and on money data it says the settlement is unconfirmed. Callers pass `verified` only
  // for a VERIFIED PAYEE PAYMENT, never a verified refund (astra r6 F10). Mirrors the spec's reportedText.
  function reportedText(raw, verified, money) {
    var t = raw == null ? '' : String(raw);
    if (verified || t === '') return mintText(t);
    return mintText('reported: ' + t + (money ? UNCONFIRMED_SUFFIX : ''));
  }
  // The TEXT of a data status pill (list rows, run windows), paired with dataStatusClass. Money data shows
  // the classifier's honest label, and a VERIFIED final (a live read of an exact settlement route) keeps
  // its plain name. Anything else is the value itself, qualified when it claims money moved.
  function dataStatusText(bindingPath, row, s, live) {
    if (isMoneyData(bindingPath, row)) {
      var vnext = isVNextRecord(row);
      var rc = vnext ? settlementReadClass(row, bindingPath, live) : [moneyStatusClass(s), settlementLabel(s), s];
      if (vnext && (rc[0] === 'st-settled' || rc[0] === 'st-refunded')) return mintText(String(rc[2]));
      if (rc[1]) return mintText(rc[1]);
      return statusPillText(s, false, true);
    }
    return statusPillText(s, false, false);
  }
  // </status-map v2>

  // <plain-text helpers> — mirrored from @pcc/spec; parity checks the shipped bytes.
  var CLAIM_DETECTOR = initClaimDetector();
  function initClaimDetector() {
    try {
      // The test switch can only withhold more; unsupported engines still boot.
      if (window.__PCC_UI_FORCE_CLAIM_INIT_FAILURE__ === true) throw new Error('claim detector disabled');
      return (function () {
        // Claim logic mirrors the IR and spec; only syntax and initialization differ.
        var LOOKALIKE = {
            // Cyrillic
            "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x",
            "\u0456": "i", "\u0458": "j", "\u0455": "s", "\u0501": "d", "\u04bb": "h", "\u051b": "q", "\u051d": "w",
            "\u04cf": "l", "\u0410": "A", "\u0412": "B", "\u0415": "E", "\u041a": "K", "\u041c": "M", "\u041d": "H",
            "\u041e": "O", "\u0420": "P", "\u0421": "C", "\u0422": "T", "\u0425": "X", "\u0406": "I", "\u0408": "J",
            "\u0405": "S", "\u04ae": "Y", "\u051a": "Q", "\u051c": "W", "\u04c0": "I",
            // Greek
            "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0396": "Z", "\u0397": "H", "\u0399": "I", "\u039a": "K",
            "\u039c": "M", "\u039d": "N", "\u039f": "O", "\u03a1": "P", "\u03a4": "T", "\u03a5": "Y", "\u03a7": "X",
            "\u03bf": "o", "\u03b1": "a", "\u03c1": "p", "\u03bd": "v", "\u03b9": "i", "\u03ba": "k", "\u03c5": "u",
            "\u03c7": "x", "\u03b5": "e", "\u03c4": "t",
            // Latin letters with no compatibility decomposition: dotless i and j, IPA, small capitals, strokes, hooks
            "\u0131": "i", "\u0237": "j", "\u0251": "a", "\u0261": "g", "\u0269": "i", "\u1d00": "a", "\u0299": "b",
            "\u1d04": "c", "\u1d05": "d", "\u1d07": "e", "\ua730": "f", "\u0262": "g", "\u029c": "h", "\u026a": "i",
            "\u1d0a": "j", "\u1d0b": "k", "\u029f": "l", "\u1d0d": "m", "\u0274": "n", "\u1d0f": "o", "\u1d18": "p",
            "\u0280": "r", "\ua731": "s", "\u1d1b": "t", "\u1d1c": "u", "\u1d20": "v", "\u1d21": "w", "\u028f": "y",
            "\u1d22": "z", "\u0111": "d", "\u0180": "b", "\u0268": "i", "\u0142": "l", "\u00f8": "o", "\u0127": "h",
            "\u0167": "t", "\u01a5": "p", "\u0257": "d", "\u0256": "d", "\u0188": "c", "\u0253": "b", "\u0192": "f",
            "\u0266": "h", "\u0199": "k", "\u0271": "m", "\u0272": "n", "\u0273": "n", "\u0282": "s", "\u01ad": "t",
            "\u0288": "t", "\u01b4": "y", "\u0225": "z", "\u024d": "r", "\u0247": "e", "\u023c": "c", "\u0249": "j",
            "\u0110": "D", "\u0141": "L", "\u00d8": "O", "\u0126": "H", "\u0166": "T", "\u0197": "I", "\u01a4": "P",
            "\u018a": "D", "\u0187": "C", "\u0181": "B", "\u0191": "F", "\u0198": "K", "\u01ac": "T", "\u01b3": "Y",
            "\u0224": "Z", "\u024c": "R", "\u0246": "E", "\u023b": "C",
        };
        // Marks, format/bidi controls and invisible fillers vanish; a braille blank reads as a space.
        var INVISIBLE_RE = new RegExp("[\\p{M}\\p{Cf}\\u115f\\u1160\\u3164\\uffa0]", "gu");
        var MONEY_EMOJI_RE = new RegExp("[\\u{1F4B0}-\\u{1F4B8}\\u{1F911}\\u{1FA99}]", "gu");
        var CAMEL_RE = new RegExp("(?<![A-Z])([a-z])([A-Z])", "g");
        /** The one fold every check uses: lowercase Latin skeleton of what a reader sees. Whitespace runs
         *  collapse to one space, as HTML renders them; that also keeps every match below linear-time. */
        function foldForClaims(text) {
            var t = String(text.normalize("NFKD")).replace(INVISIBLE_RE, "").normalize("NFKC");
            t = String(String(t).replace(/\u2800/g, " ")).replace(MONEY_EMOJI_RE, " $ ");
            t = String(t).replace(/[^\x00-\x7f]/g, function (c) { return (dataAt(LOOKALIKE, c) === undefined ? c : dataAt(LOOKALIKE, c)); });
            // Split only a REAL camelCase join (a lowercase run ending, then an uppercase start): the
            // lowercase letter must not itself be sandwiched directly between two uppercase letters, else
            // "PAlD" (a single lowercased confusable inside an otherwise-capital word) would mis-split into
            // "PAl D" and never fold back to "paid" (astra r3 H1).
            return String(String(String(t).replace(CAMEL_RE, "$1 $2")).replace(/_/g, " ")).replace(/\s+/g, " ").toLowerCase();
        }
        // Digit and symbol spellings, read both ways for "1" (i and l).
        var LEET_I = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "|": "i" };
        var LEET_L = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "|": "l" };
        var LEET_RE = /[0134578@$!|]/g;
        var HAS_LEET = /[0134578@$!|]/;
        /** Every spelling view of the folded text: the digit/symbol leet views (when present), plus an
         *  l<->i confusable swap of each ("pald" reads "paid"; "settied" reads "settled"). Bounded: at
         *  most 3 leet bases x up to 2 l/i swaps = at most 9 views, each built once (still linear-time). */
        var views = function (f) {
            var base = HAS_LEET.test(f) ? [f, String(f).replace(LEET_RE, function (c) { return dataAt(LEET_I, c); }), String(f).replace(LEET_RE, function (c) { return dataAt(LEET_L, c); })] : [f];
            var out = base.slice();
            for (var i = 0; i < base.length; i++) {
                var b = dataAt(base, i);
                if (b.indexOf("l") !== -1)
                    out.push(String(b).replace(/l/g, "i"));
                if (b.indexOf("i") !== -1)
                    out.push(String(b).replace(/i/g, "l"));
            }
            return out;
        };
        // A run of three or more single letters split by up to three separators is read as one word ("p a i d").
        // Word boundaries mean nothing inside such a run, so a claim word anywhere in it counts ("p a i d x").
        var SPACED_RE = new RegExp("(?<![a-z0-9])[a-z](?:[^a-z0-9]{1,3}[a-z](?![a-z0-9])){2,}", "g");
        var spacedRuns = function (v) { return (v.match(SPACED_RE) || []).map(function (r) { return String(r).replace(/[^a-z]/g, ""); }).join(" "); };
        var CUR_CODE = "usdc|usdt|usde|usd|eurc|eur|gbp|jpy|cny|rmb|inr|chf|cad|aud|krw|rub|brl|mxn|eth|weth|btc|wbtc|dai|sol|matic|pol|xrp|ltc|bnb|busd|tusd|pyusd|gusd|frax|sats?|gwei|wei" +
            "|xlm|ada|dot|avax|trx|ton|near|atom|apt|sui|shib|doge|xmr|bch|etc|fil|icp|hbar|vet|algo|xtz|eos|cro|usdp|fdusd" +
            "|hkd|sgd|nzd|sek|nok|dkk|pln|try|zar|thb|idr|myr|vnd|ils|aed|sar|ars|clp|cop|pen|egp|ngn|kes|pkr|uah|czk|huf|ron";
        var CUR_WORD = "dollars?|bucks|cents?|euros?|pence|quid|yen|yuan|renminbi|rupees?|rubles?|roubles?|pesos?|francs?|satoshis?|bitcoins?|ethers?|stablecoins?";
        var MAGNITUDE = "thousand|million|billion|trillion|mil|mio|mrd|mm|mn|bn|tn|k|m|b|t";
        var NUMBER_WORD = "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|dozen|half";
        var CURRENCY = "(?:\\p{Sc}|(?:" + CUR_CODE + "|" + CUR_WORD + ")\\b)";
        // Every repeat is bounded and every branch starts at a rare token (a currency, a number word), so a
        // hostile run of digits, spaces or hyphens costs linear time, also across a whole dashboard's prose.
        // "5 USDC" is found from the currency, with a bounded look back for the number before it.
        var AMOUNT_RE = new RegExp("\\p{Sc} ?(?:\\d|(?:" + NUMBER_WORD + ")\\b)" + //                                   $5, $ 5, $five
            "|" + CURRENCY + "(?<=\\d[\\d,._]{0,40} ?(?:" + MAGNITUDE + ")? ?[(\\[]? ?" + CURRENCY + ")" + //     5 USDC, 1m USDC, 5$, 1 $ USDC
            "|\\b(?:" + NUMBER_WORD + ")\\b[ -]{0,3}(?:(?:" + MAGNITUDE + ")\\b[ -]{0,3})?" + CURRENCY + // one million dollars
            "|\\ban? (?:" + CUR_WORD + ")\\b" + //                                                  a dollar
            "|\\b(?:" + CUR_CODE + "|" + CUR_WORD + ")[ :=]{0,3}(?:\\d|(?:" + NUMBER_WORD + ")\\b)", //       USD 5, usdc:100, USDC five
        "u");
        // Payment and verification words: English, Spanish, French, German, Italian, Portuguese, Dutch,
        // Polish, Turkish and Indonesian, as folded (accents stripped, lowercase).
        var CLAIM_WORDS = [
            "paid|unpaid|prepaid|repaid|overpaid|underpaid|payout|payouts|paidout|refund|refunds|refunded|reimbursed",
            "settled|verified|guaranteed|funded|charged|deposited|withdrawn|credited|debited",
            "remitted|disbursed|escrowed",
            "da thanh toan", // Vietnamese "paid", with diacritics folded to this ASCII skeleton already
            "pagad[oa]s?|pago|abonad[oa]s?|reembolsad[oa]s?|reembolso|liquidad[oa]s?|cobrad[oa]s?|acreditad[oa]s?|depositad[oa]s?",
            "verificad[oa]s?|confirmad[oa]s?|aprobad[oa]s?|aprovad[oa]s?|recibid[oa]s?|recebid[oa]s?|creditad[oa]s?|debitad[oa]s?|quitad[oa]s?|saldo",
            "payee?s?|rembourse[es]?|remboursee?s?|remboursement|credite[es]?|creditee?s?|debite[es]?|debitee?s?|verifiee?s?",
            "confirmee?s?|approuvee?s?|encaissee?s?|recue?s?|solde",
            "bezahlt|gezahlt|ausgezahlt|uberwiesen|ueberwiesen|erstattet|ruckerstattet|rueckerstattet|gutgeschrieben|abgebucht",
            "bestatigt|bestaetigt|verifiziert|genehmigt|beglichen|eingegangen|kontostand|guthaben",
            "pagat[oaie]|rimborsat[oaie]|rimborso|accreditat[oaie]|addebitat[oaie]|verificat[oaie]|confermat[oaie]|approvat[oaie]",
            "saldat[oaie]|incassat[oaie]|ricevut[oaie]",
            "betaald|terugbetaald|uitbetaald|geverifieerd|bevestigd|goedgekeurd|ontvangen|gestort",
            "zaplacon[oay]|oplacon[oay]|zwrocon[oay]|potwierdzon[oay]|zweryfikowan[oay]",
            "odendi|onaylandi|dogrulandi|iade|bakiye|dibayar|lunas|dikembalikan|terverifikasi|disetujui",
        ].join("|");
        var CLAIM_RE = new RegExp("\\b(?:" + CLAIM_WORDS + ")\\b");
        var CLAIM_IN_RUN_RE = new RegExp("(?:" + CLAIM_WORDS + ")");
        // ── The pair rule (M4 fix): a GENERIC word (received/released/approved/confirmed/complete/...) is
        // physical-workflow prose on its own ("Sample received", "Run confirmed for 9:00") and is withheld
        // only when a MONEY_OR_VERIFICATION noun sits within 3 words of it, in either order ("payment
        // received", "funds released", "payout approved"). "balance"/"balances" moved here as nouns, not
        // generic words: a bare "Available balance" label states nothing, but "balance confirmed" does.
        var GENERIC_WORDS = "received|released|approved|confirmed|complete|completed|passed|succeeded|successful|cleared|processed|accepted|sent|done";
        var CLAIM_NOUNS = "payment|payments|funds|fund|money|payout|payouts|transfer|transfers|transaction|transactions|invoice|invoices|deposit|deposits|escrow|settlement|refund|refunds|balance|balances|wallet|charge|charges|fee|fees|amount|price|verification|identity|kyc|kyb|attestation|proof|audit|oracle";
        var CLAIM_NOUN_GROUP = "(?:" + CLAIM_NOUNS + "|" + CUR_CODE + "|" + CUR_WORD + ")";
        var GENERIC_GROUP = "(?:" + GENERIC_WORDS + ")";
        // Bounded repeats only (lazy, capped at 3 intervening words) — linear-time even across a whole
        // dashboard's joined prose, same discipline as the rest of this file's regexes.
        var PAIR_RE = new RegExp("\\b" + CLAIM_NOUN_GROUP + "\\b(?:\\W+\\w+){0,3}?\\W+" + GENERIC_GROUP + "\\b" +
            "|\\b" + GENERIC_GROUP + "\\b(?:\\W+\\w+){0,3}?\\W+" + CLAIM_NOUN_GROUP + "\\b");
        // Folded into the SAME `wordsIn` pass as MONEY_WORDS/NOTICE_WORDS below (one `views()` build, one
        // loop) rather than a second independent pass: re-building up to 9 spelling views of a whole
        // dashboard's joined prose twice over was measured to roughly 3.5x the adapt+validate time on the
        // benchmark's 2,000-char-per-note worst case. PAIR_RE needs no spaced-run check (that defense is
        // for single-letter-spaced words, not word-level pairing), so its "inRun" slot never matches.
        var PAIR_WORDS = [PAIR_RE, /(?!)/];
        // The same words in non-Latin scripts (Russian and Ukrainian, Chinese, Japanese, Korean, Arabic,
        // Hindi), matched in the folded text with spaces removed. Each is folded like the text (lower and
        // upper case), so a look-alike or all-capitals spelling still matches.
        var SCRIPT_CLAIM_WORDS = ["\u043e\u043f\u043b\u0430\u0447\u0435\u043d", "\u0432\u044b\u043f\u043b\u0430\u0447\u0435\u043d", "\u0441\u043f\u043b\u0430\u0447\u0435\u043d", "\u0432\u043e\u0437\u0432\u0440\u0430\u0449\u0435\u043d", "\u0432\u043e\u0437\u0432\u0440\u0430\u0442", "\u0437\u0430\u0447\u0438\u0441\u043b\u0435\u043d", "\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d", "\u043f\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043d", "\u043f\u0440\u043e\u0432\u0435\u0440\u0435\u043d", "\u043e\u0434\u043e\u0431\u0440\u0435\u043d", "\u0431\u0430\u043b\u0430\u043d\u0441", "\u043f\u043e\u043b\u0443\u0447\u0435\u043d", "\u5df2\u4ed8", "\u5df2\u652f\u4ed8", "\u652f\u4ed8\u6210\u529f", "\u9000\u6b3e", "\u5df2\u7ed3\u7b97", "\u5df2\u7d50\u7b97", "\u5df2\u786e\u8ba4", "\u5df2\u78ba\u8a8d", "\u5df2\u9a8c\u8bc1", "\u5df2\u9a57\u8b49", "\u5230\u8d26", "\u5230\u8cec", "\u4f59\u989d", "\u9918\u984d", "\u5df2\u6536\u6b3e", "\u5df2\u6279\u51c6", "\u652f\u6255\u6e08", "\u652f\u6255\u3044\u6e08", "\u652f\u6255\u5b8c\u4e86", "\u652f\u6255\u3044\u5b8c\u4e86", "\u5165\u91d1\u6e08", "\u8fd4\u91d1", "\u6c7a\u6e08\u6e08", "\u6c7a\u6e08\u5b8c\u4e86", "\u78ba\u8a8d\u6e08", "\u627f\u8a8d\u6e08", "\u6b8b\u9ad8", "\uc9c0\uae09\uc644\ub8cc", "\uacb0\uc81c\uc644\ub8cc", "\uacb0\uc81c\ub428", "\uc9c0\uae09\ub428", "\ud658\ubd88", "\uc794\uc561", "\uc785\uae08\uc644\ub8cc", "\ud655\uc778\ub428", "\uc2b9\uc778\ub428", "\u0645\u062f\u0641\u0648\u0639", "\u062a\u0645\u0627\u0644\u062f\u0641\u0639", "\u0627\u0633\u062a\u0631\u062f\u0627\u062f", "\u0631\u0635\u064a\u062f", "\u092d\u0941\u0917\u0924\u093e\u0928\u0915\u093f\u092f\u093e", "\u092d\u0941\u0917\u0924\u093e\u0928\u0939\u094b\u0917\u092f\u093e", "\u03c0\u03bb\u03b7\u03c1\u03ce\u03b8\u03b7\u03ba\u03b5", "\u03c0\u03bb\u03b7\u03c1\u03ce\u03b8\u03b7\u03ba\u03b1\u03bd", "\u03b5\u03c0\u03b9\u03c3\u03c4\u03c1\u03bf\u03c6\u03ae \u03c7\u03c1\u03b7\u03bc\u03ac\u03c4\u03c9\u03bd", "\u03c5\u03c0\u03cc\u03bb\u03bf\u03b9\u03c0\u03bf", "\u05e9\u05d5\u05dc\u05dd", "\u0e0a\u0e33\u0e23\u0e30\u0e41\u0e25\u0e49\u0e27"];
        var scriptWords = [];
        for (var si = 0; si < SCRIPT_CLAIM_WORDS.length; si++) {
            scriptWords.push(String(foldForClaims(dataAt(SCRIPT_CLAIM_WORDS, si))).replace(/\s+/g, ""));
            scriptWords.push(String(foldForClaims(dataAt(SCRIPT_CLAIM_WORDS, si).toUpperCase())).replace(/\s+/g, ""));
        }
        var SCRIPT_CLAIM_RE = new RegExp(scriptWords.filter(function (w, i) { return scriptWords.indexOf(w) === i; }).join("|"), "u"); // the words hold no regex syntax
        var NOTICE_RE = /\bwithh[eo]ld/;
        var NOTICE_IN_RUN_RE = /withh[eo]ld/;
        var MONEY_WORDS = [CLAIM_RE, CLAIM_IN_RUN_RE];
        var NOTICE_WORDS = [NOTICE_RE, NOTICE_IN_RUN_RE];
        /** Any of the word checks in any spelling view of the folded text (views are built once). */
        function wordsIn(f, checks) {
            var spellings = views(f);
            for (var i = 0; i < spellings.length; i++) {
                var v = dataAt(spellings, i);
                var runs = spacedRuns(v);
                for (var j = 0; j < checks.length; j++) {
                    var word = dataAt(checks, j)[0], inRun = dataAt(checks, j)[1];
                    if (word.test(v) || inRun.test(runs))
                        return true;
                }
            }
            return false;
        }
        var scriptIn = function (f) { return /[^\x00-\x7f]/.test(f) && SCRIPT_CLAIM_RE.test(String(f).replace(/ /g, "")); };
        function statesAmount(text) { return AMOUNT_RE.test(foldForClaims(text)); }
        /** Does the text state an amount or a payment or verification status? */
        function isMoneyClaim(text) { var f = foldForClaims(text); return AMOUNT_RE.test(f) || scriptIn(f) || wordsIn(f, [MONEY_WORDS, PAIR_WORDS]); }
        /** Does the text mention PCC's withheld notice ("withheld", "withhold")? Only PCC may say that. */
        function mentionsWithheld(text) { return wordsIn(foldForClaims(text), [NOTICE_WORDS]); }
        /** Agent prose that may not be shown: a money claim, or a mention of PCC's notice (one fold). */
        function isProseClaim(text) {
            var f = foldForClaims(text);
            return AMOUNT_RE.test(f) || scriptIn(f) || wordsIn(f, [MONEY_WORDS, NOTICE_WORDS, PAIR_WORDS]);
        }

        var IDENT_NOUN_RE = new RegExp("\\b" + CLAIM_NOUN_GROUP + "\\b");
        var IDENT_GENERIC_RE = new RegExp("\\b" + GENERIC_GROUP + "\\b");
        function isIdentifierClaim(value) {
          if (isMoneyClaim(value) || mentionsWithheld(value)) return true;
          var variants = views(foldForClaims(value));
          for (var i = 0; i < variants.length; i++) if (IDENT_NOUN_RE.test(dataAt(variants, i)) && IDENT_GENERIC_RE.test(dataAt(variants, i))) return true;
          return false;
        }
        return { identifier: isIdentifierClaim, fold: foldForClaims, amount: statesAmount, money: isMoneyClaim, notice: mentionsWithheld, prose: isProseClaim };
      })();
    } catch (e) { return null; }
  }
  function foldForClaims(text) { return CLAIM_DETECTOR ? CLAIM_DETECTOR.fold(text) : ''; }
  function statesAmount(text) { return !CLAIM_DETECTOR || CLAIM_DETECTOR.amount(text); }
  function isMoneyClaim(text) { return !CLAIM_DETECTOR || CLAIM_DETECTOR.money(text); }
  function mentionsWithheld(text) { return !CLAIM_DETECTOR || CLAIM_DETECTOR.notice(text); }
  function isProseClaim(text) { return !CLAIM_DETECTOR || CLAIM_DETECTOR.prose(text); }

  var PLAIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  var PLAIN_HEX_RE = /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
  var PLAIN_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
  var PLAIN_TRACE_RE = /^[A-Za-z0-9_-]{8,64}$/;
  /** Identifiers can spell prose: withhold claims and attribute all remaining values, as in the IR. */
  function idText(raw) {
      if (typeof raw === "string" && (!CLAIM_DETECTOR || CLAIM_DETECTOR.identifier(raw))) return WITHHELD_FIELD;
      return reportedText(raw, false, false);
  }
  /** Addresses and transaction hashes admit exactly their two wire lengths. */
  function hexText(raw) {
      return mintText(typeof raw === "string" && PLAIN_HEX_RE.test(raw) ? raw : "unrecognised value");
  }
  /** Canonical UTC, calendar-valid, and in the same 2000..2100 era as the IR kit. */
  function canonicalPlainTime(raw) {
      if (typeof raw !== "string")
          return false;
      var m = PLAIN_TIME_RE.exec(raw);
      if (!m)
          return false;
      var year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
      var hour = Number(m[4]), minute = Number(m[5]), second = Number(m[6]);
      var ms = m[7] ? Number((m[7] + "00").slice(0, 3)) : 0;
      if (year < 2000 || year > 2100)
          return false;
      var d = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
      return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day &&
          d.getUTCHours() === hour && d.getUTCMinutes() === minute && d.getUTCSeconds() === second &&
          d.getUTCMilliseconds() === ms;
  }
  /** Preserve the kit's locale-formatted timestamp after the UTC grammar check. */
  function timeText(raw) {
      if (!canonicalPlainTime(raw))
          return mintText("time not reported");
      return fmtTs(raw);
  }
  /** An invalid trace is omitted, so arbitrary response-header text is never shown. */
  function traceText(raw) {
      return mintText(typeof raw === "string" && PLAIN_TRACE_RE.test(raw) ? "trace " + raw : "");
  }
  /** Operator-chosen names are visibly framed; claims use PCC's withheld notice. */
  function nameText(raw) {
      if (typeof raw !== "string")
          return reportedText(raw, false, false);
      return mintText(isProseClaim(raw) ? "name withheld: stated money or verification" : "name: " + raw);
  }
  /** Editable defaults admit only the field kind's wire value, without coercion. */
  function fieldDefaultText(kind, raw) {
      if (kind === "number" || kind === "integer")
          return mintText(typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "");
      if (kind === "string")
          return mintText(typeof raw === "string" && !isProseClaim(raw) ? raw : "");
      return mintText("");
  }

  // </plain-text helpers>

  // Pull the first array out of a response (for list windows without a select).
  function firstArray(resp) {
    if (Array.isArray(resp)) return resp;
    if (resp && typeof resp === 'object') {
      var keys = Object.keys(resp);
      for (var i = 0; i < keys.length; i++) if (Array.isArray(dataAt(resp, dataAt(keys, i)))) return dataAt(resp, dataAt(keys, i));
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
  // sol#1 (#288) origin pin, ONE implementation: resolve against the transport base and REFUSE (null)
  // anything outside the fixed PCC API origin or carrying embedded credentials. Parsed-origin compare
  // subsumes the https pin. Reads/SSE reach it through Transport._pin; writes through
  // requestDescriptor, whose url Transport.send re-CHECKS here before any Bearer is attached.
  function pinnedUrl(base, target) {
    var u;
    try { u = new URL(target, base || location.origin); } catch (e) { return null; }
    if (u.origin !== API_ORIGIN || u.username || u.password) return null;
    return u;
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
    try { u = pinnedUrl(this.base, safe + this.qs(query)); } catch (e) { return null; }
    return u === null ? null : u.toString();
  };
  Transport.prototype._trace = function (res) {
    try { var t = res.headers.get('x-pcc-trace-id'); if (t) this.lastTrace = t; } catch (e) {}
  };
  Transport.prototype.qs = function (query) {
    if (!query) return '';
    var parts = [];
    var keys = Object.keys(query);
    for (var i = 0; i < keys.length; i++) {
      var v = dataAt(query, dataAt(keys, i));
      if (v == null) continue;
      parts.push(encodeURIComponent(dataAt(keys, i)) + '=' + encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : String(v)));
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
  // A write sends EXACTLY its validated request descriptor (ruling 3): desc.url with desc.method.
  // Nothing here re-derives the destination or the method. The #288 pin is re-CHECKED on that exact
  // string before any Bearer is attached: a descriptor that is not ok, not POST/PATCH, or not already
  // a pinned PCC URL in canonical serialization is refused ({refused:true}: nothing was sent).
  Transport.prototype.send = function (desc, body, idempotencyKey) {
    var self = this;
    function refuse(msg) { return Promise.resolve({ ok: false, status: 0, refused: true, body: { message: msg } }); }
    if (!desc || desc.ok !== true || typeof desc.url !== 'string') {
      return refuse('Refused: ' + ((desc && desc.reason) || 'no validated request') + ' - nothing was sent.');
    }
    if (desc.method !== 'POST' && desc.method !== 'PATCH') return refuse('Refused: unsupported method - nothing was sent.');
    var pinned = pinnedUrl(this.base, desc.url);
    if (pinned === null || pinned.toString() !== desc.url) return refuse('Refused: request resolves outside the PCC API origin.');
    var headers = this._headers({ 'Content-Type': 'application/json', Accept: 'application/json' });
    // A real Idempotency-Key HEADER: the gateway's idempotency middleware and the escrow money
    // routes read the header, never a body field. The caller owns key stability (see doPost).
    if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey);
    return fetch(desc.url, {
      method: desc.method,
      headers: headers,
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
            var line = dataAt(frames, i).split('\n')
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
  HostTransport.prototype.send = function (desc, body, idempotencyKey) {
    // R4 PR1 lockdown (D10): manifest-authored writes are DISABLED in MCP-App/
    // host mode. No mutating request is ever issued from a hosted view — write
    // controls render disabled and the action layer refuses; this transport-level
    // backstop holds even if a caller reaches send() directly (e.g. a compose
    // POST from renderChain). PR2 reintroduces writes via a typed, server-
    // authorized operation allowlist. (desc/body/key intentionally unused.)
    void desc; void body; void idempotencyKey;
    return Promise.resolve({ ok: false, status: 0, refused: true, body: { message: 'Actions are unavailable in this host view.' } });
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
      var d = dataAt(ctx.snapshot, binding.path);
      var picked = binding.select != null ? dot(d, binding.select) : d;
      return Promise.resolve({ data: picked, stale: true, error: d === undefined ? 'no snapshot for ' + binding.path : null });
    }
    return ctx.tx.getJSON(binding.path, binding.query).then(
      function (d) { return { data: binding.select != null ? dot(d, binding.select) : d, raw: d, stale: false, error: null }; },
      function (err) {
        // Live fetch failed → fall back to any baked snapshot, else stale-empty.
        if (ctx.snapshot && dataAt(ctx.snapshot, binding.path) !== undefined) {
          var s = dataAt(ctx.snapshot, binding.path);
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
    head.appendChild((title && typeof title === 'object' && AGENT_TEXT_BRANDS.has(title)) || title === WITHHELD_FIELD ?
      agentEl('span', 'pcc-win-title pcc-text', title) : el('span', 'pcc-win-title', title));
    if (statusText != null) head.appendChild(el('span', 'pcc-pill ' + (statusCls || ''), statusText));
    wrap.appendChild(head);
    var body = el('div', 'pcc-win-body');
    wrap.appendChild(body);
    wrap._body = body;
    wrap._setFoot = function (traceId, stale) {
      // Only ever replace the kit's own trace/stale META footer. Action bars also carry
      // .pcc-win-foot for styling and must never be removed by a footer refresh.
      var old = wrap.querySelector('.pcc-win-foot.pcc-foot-meta');
      if (old) old.parentNode.removeChild(old);
      var trace = traceText(traceId);
      if (!trace.t && !stale) return;
      var foot = el('div', 'pcc-win-foot pcc-foot-meta');
      if (stale) foot.appendChild(el('span', 'pcc-foot-stale', kitText('snapshot')));
      if (trace.t) foot.appendChild(el('span', 'pcc-mono pcc-foot-trace', trace));
      wrap.appendChild(foot);
    };
    return wrap;
  }
  function loadingLine() { return el('p', 'pcc-muted', kitText('Loading…')); }
  function errorLine(msg) {
    var p = el('p', 'pcc-err');
    p.appendChild(el('span', 'pcc-err-msg', isKitText(msg) ? msg : msg ? reportedText(msg, false, false) : kitText('Could not load this data.')));
    p.appendChild(el('span', 'pcc-err-honest', kitText(' Nothing was fabricated.')));
    return p;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Kit-owned labels (ruling 4). A manifest label is UNTRUSTED text: it can say
  // "Deny" or "Cancel" on a control that writes. One rule, everywhere:
  //  1. A control that EXECUTES a gated write (the approval window's Approve, the
  //     Approval gate's Approve) and every control that declines or closes
  //     (Deny, Cancel) carries KIT text only. The manifest's own label is shown
  //     beside them as quoted, attributed text -- never as a control's label.
  //  2. A manifest-labelled control that STARTS a write (actions bar, form
  //     submit, chain Plan/execute) keeps the manifest label (it names the task)
  //     but always ends in a kit-owned tag saying what the click really does:
  //     "needs approval" (opens the gate; this click sends nothing), "asks to
  //     confirm", "sends now" (an allowlisted non-money write, or a registered
  //     host operation), "blocked" (refused: nothing can be sent), "unavailable"
  //     (host lockdown) or "via assistant" (snapshot). So a manifest can never
  //     present a write as a harmless "Deny"/"Cancel": the kit's words follow it.
  // ═══════════════════════════════════════════════════════════════════════

  function writeTag(ctx, action, desc) {
    if (ctx.mode === 'snapshot') return kitText('via assistant');
    if (ctx.mode === 'host') return kitText(hostActionEnabled(action) ? 'sends now' : 'unavailable');
    if (!desc.ok) return kitText('blocked');
    if (desc.money) return kitText('needs approval');
    return kitText(action.confirm === 'inline' ? 'asks to confirm' : 'sends now');
  }
  // Styling comes from the SAME descriptor the gate uses: a money write can never look non-money.
  function writeButton(ctx, action, desc, fallbackLabel) {
    var b = el('button', 'pcc-btn ' + (desc.money ? 'pcc-btn-primary' : 'pcc-btn-quiet'));
    b.type = 'button';
    b.appendChild(action && action.label ? agentEl('span', 'pcc-btn-label pcc-text', agentText(action.label, false)) :
      el('span', 'pcc-btn-label', kitText(fallbackLabel === 'Submit' ? 'Submit' : fallbackLabel === 'Plan' ? 'Plan' : fallbackLabel === 'Execute' ? 'Execute' : 'Action')));
    b.appendChild(el('span', 'pcc-btn-tag', joinText(kitText(' · '), writeTag(ctx, action, desc))));
    return b;
  }
  // A manifest label shown as what it is: quoted, attributed, untrusted text.
  function untrustedLabel(label) {
    var p = el('p', 'pcc-untrusted-label');
    p.appendChild(el('span', 'pcc-untrusted-k', kitText('The dashboard calls this: ')));
    p.appendChild(el('span', 'pcc-untrusted-v', mintText('“' + String(label) + '”')));
    return p;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Window renderers — one per manifest window kind (schema-closed set)
  // ═══════════════════════════════════════════════════════════════════════

  // A binding path whose last segment names a status field (status, state, phase): its value is a status
  // LABEL, so it takes the closed-vocabulary text rule wherever it is shown (astra r6).
  function isStatusPath(p) {
    return typeof p === 'string' && /status|state|phase/i.test(p.split('.').pop() || '');
  }
  // A bound value shown as plain text (a list title or meta field, a metric): a status field takes the
  // closed-vocabulary rule (astra r6, the F8/F11 class); anything else (a name, an id, an amount) is shown
  // as sent. Never verified: these windows read collections, snapshots or single values, not a live
  // settlement read model.
  function boundText(path, v, money) {
    if (isStatusPath(path)) return statusPillText(v, false, money);
    var field = typeof path === 'string' ? path.split('.').pop() : '';
    if (/name$/i.test(field)) return nameText(v);
    if (/id$|type$/i.test(field)) return idText(v);
    return reportedText(typeof v === 'object' ? JSON.stringify(v) : v, false, money);
  }

  // note — prose; split on double newline into <p>, textContent only.
  function renderNote(ctx, w) {
    var wrap = el('article', 'pcc-win pcc-win-note');
    var text = String(w.text == null ? '' : w.text);
    var paras = text.split(/\n\n+/);
    for (var i = 0; i < paras.length; i++) {
      if (dataAt(paras, i) === '') continue;
      wrap.appendChild(agentEl('p', 'pcc-note-p pcc-text', agentText(dataAt(paras, i), true)));
    }
    return wrap;
  }

  // metric — single scalar, formatted, tabular.
  function renderMetric(ctx, w) {
    var wrap = winShell(w.label ? agentText(w.label, false) : kitText('Metric'), null, null);
    var val = el('div', 'pcc-metric-amount pcc-tnum', kitText('—'));
    wrap._body.appendChild(val);
    var sel = w.select != null ? w.select : (w.binding && w.binding.select);
    resolveBinding(ctx, w.binding).then(function (r) {
      var raw = sel != null ? dot(r.data, sel) : r.data;
      if (r.error) { clear(wrap._body); wrap._body.appendChild(errorLine(r.error)); }
      else setText(val, isStatusPath(sel) && raw != null && typeof raw !== 'object'
        ? boundText(sel, raw, isMoneyData(w.binding && w.binding.path, r.data)) : fmtVal(raw, w.format, sel));
      wrap._setFoot(ctx.tx && ctx.tx.lastTrace, r.stale);
    });
    return wrap;
  }

  // capability — one catalog row: name + provider + price + trust + assurance.
  function renderCapability(ctx, w) {
    var wrap = winShell(kitText('Capability'), null, null);
    wrap._body.appendChild(loadingLine());
    resolveBinding(ctx, w.binding).then(function (r) {
      clear(wrap._body);
      var c = r.data;
      if (r.error || !c) { wrap._body.appendChild(errorLine(r.error || kitText('No capability data.'))); wrap._setFoot(ctx.tx && ctx.tx.lastTrace, r.stale); return; }
      // Follow the API shape (CapabilityDTO) — render what it actually emits.
      var titleRow = el('div', 'pcc-cap-title');
      titleRow.appendChild(el('span', 'pcc-cap-name', c.name ? nameText(c.name) : c.id ? idText(c.id) : kitText('Capability')));
      var price = c.pricing && (c.pricing.baseCost != null ? c.pricing.baseCost : c.pricing.minimum);
      var currency = (c.pricing && c.pricing.currency) || 'USDC';
      if (price != null) titleRow.appendChild(el('span', 'pcc-price-chip pcc-tnum', joinText(fmtUsd(price), kitText(' '), currencyText(currency))));
      wrap._body.appendChild(titleRow);
      var meta = el('div', 'pcc-cap-meta');
      if (c.kernelName || c.kernelId) meta.appendChild(el('span', 'pcc-mono', c.kernelName ? nameText(c.kernelName) : idText(c.kernelId)));
      if (c.type) meta.appendChild(el('span', 'pcc-tag', idText(c.type)));
      if (typeof c.reputation === 'number') meta.appendChild(el('span', 'pcc-badge', joinText(kitText('rep '), numberText(c.reputation))));
      wrap._body.appendChild(meta);
      if (c.description) wrap._body.appendChild(el('p', 'pcc-cap-desc', reportedText(c.description, false, false)));
      var tiers = Array.isArray(c.assuranceTiers) ? c.assuranceTiers : null;
      if (tiers && tiers.length) {
        wrap._body.appendChild(el('p', 'pcc-cap-assurance', joinText(kitText('assurance tier '), joinWithText(kitText('/'), tiers.map(numberText)),
          c.available === false ? kitText(' · unavailable') : typeof c.queueDepth === 'number' ? joinText(kitText(' · queue '), numberText(c.queueDepth)) : kitText(''))));
      }
      wrap._setFoot(ctx.tx && ctx.tx.lastTrace, r.stale);
    });
    return wrap;
  }

  // list — a collection of light rows (title · meta · status pill).
  function renderList(ctx, w) {
    var wrap = winShell(kitText('List'), null, null);
    wrap._body.appendChild(loadingLine());
    resolveBinding(ctx, w.binding).then(function (r) {
      clear(wrap._body);
      if (r.error) { wrap._body.appendChild(errorLine(r.error)); wrap._setFoot(ctx.tx && ctx.tx.lastTrace, r.stale); return; }
      var rows = w.binding && w.binding.select != null ? (Array.isArray(r.data) ? r.data : firstArray(r.data)) : firstArray(r.raw != null ? r.raw : r.data);
      if (!rows.length) { wrap._body.appendChild(el('p', 'pcc-muted', kitText('Nothing here yet.'))); wrap._setFoot(ctx.tx && ctx.tx.lastTrace, r.stale); return; }
      var limit = w.limit || rows.length;
      var listNode = el('ul', 'pcc-list');
      for (var i = 0; i < rows.length && i < limit; i++) {
        var row = dataAt(rows, i);
        var li = el('li', 'pcc-list-row');
        var main = el('div', 'pcc-list-main');
        var rowMoney = isMoneyData(w.binding && w.binding.path, row);
        var tv = dot(row, w.item.title);
        main.appendChild(tv != null ? el('span', 'pcc-list-title', boundText(w.item.title, tv, rowMoney)) : agentEl('span', 'pcc-list-title', agentText(w.item.title || '', false)));
        var metaVals = [];
        var metaKeys = (w.item.meta || []);
        for (var j = 0; j < metaKeys.length; j++) {
          var mv = dot(row, dataAt(metaKeys, j));
          if (mv != null && mv !== '') metaVals.push(boundText(dataAt(metaKeys, j), mv, rowMoney));
        }
        if (metaVals.length) main.appendChild(el('span', 'pcc-list-meta', joinWithText(kitText(' · '), metaVals)));
        li.appendChild(main);
        if (w.item.statusFrom) {
          var st = dot(row, w.item.statusFrom);
          // A row is an element of a collection, never the top-level record a settlement route returns, so
          // it is never a verified read, however live the fetch (astra r7 F13).
          if (st != null) li.appendChild(el('span', 'pcc-pill ' + dataStatusClass(w.binding && w.binding.path, row, st, false), dataStatusText(w.binding && w.binding.path, row, st, false)));
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
      var name = dataAt(names, i);
      var spec = dataAt(props, name) || {};
      var isReq = required.indexOf(name) >= 0;
      var row = el('div', 'pcc-field');
      var lab = el('label', 'pcc-field-label');
      lab.appendChild(untrustedLabel(spec.title || name));
      if (isReq) lab.appendChild(el('span', null, kitText(' *')));
      var fieldId = 'pf-' + name + '-' + Math.random().toString(36).slice(2, 7);
      lab.setAttribute('for', fieldId);
      row.appendChild(lab);
      var input, kind = spec.type;
      if (kind === 'string' && Array.isArray(spec.enum)) {
        input = el('select', 'pcc-input');
        for (var e = 0; e < spec.enum.length; e++) {
          var option = el('option');
          option.appendChild(untrustedLabel(dataAt(spec.enum, e)));
          // Keep the wire value distinct from the attributed option label.
          setValue(option, enumValueText(dataAt(spec.enum, e)));
          input.appendChild(option);
        }
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
        setAttrText(input, 'placeholder', kitText(kind === 'array' ? '[ ]' : '{ }'));
        kind = 'json';
      } else {
        input = el('input', 'pcc-input'); input.type = 'text';
        kind = 'string';
      }
      input.id = fieldId;
      if (spec['default'] != null && kind !== 'boolean') setValue(input, fieldDefaultText(spec.type, spec['default']));
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
      var f = dataAt(form.fields, i);
      f.errLine.hidden = true; f.input.classList.remove('bad');
      var raw = f.kind === 'boolean' ? f.input.checked : f.input.value;
      var empty = f.kind === 'boolean' ? false : (raw == null || String(raw).trim() === '');
      if (f.required && empty) { markBad(f, kitText('Required.')); firstBad = firstBad || f; continue; }
      if (empty) continue;
      if (f.kind === 'number' || f.kind === 'integer') {
        var n = Number(raw);
        if (!isFinite(n)) { markBad(f, kitText('Enter a number.')); firstBad = firstBad || f; continue; }
        out[f.name] = n;
      } else if (f.kind === 'json') {
        try { out[f.name] = JSON.parse(raw); }
        catch (e) { markBad(f, kitText('Enter valid JSON.')); firstBad = firstBad || f; continue; }
      } else if (f.kind === 'boolean') {
        out[f.name] = !!raw;
      } else {
        out[f.name] = String(raw);
      }
    }
    if (firstBad) { var err = new Error('Please fix the highlighted fields.'); err._inline = true; throw err; }
    return out;
  }
  function markBad(f, msg) { f.input.classList.add('bad'); setText(f.errLine, msg); f.errLine.hidden = false; }

  function renderForm(ctx, w) {
    var wrap = winShell(kitText('Set up'), null, null);
    var form = buildForm(w.schema || {});
    wrap._body.appendChild(form.node);
    var foot = el('div', 'pcc-win-foot pcc-actionbar');
    // Styling + tag from the descriptor policy (classification never depends on the form values;
    // the click builds the descriptor that is actually sent, from the collected values).
    var submit = writeButton(ctx, w.submit, requestDescriptor(w.submit, (w.submit && w.submit.body) || {}, ctx.mode === 'host', ctx.apiBase), 'Submit');
    var status = el('span', 'pcc-action-status');
    submit.onclick = function () {
      var values;
      try { values = collectForm(form); }
      catch (e) { status.className = 'pcc-action-status st-failed'; setText(status, reportedText(e.message, false, false)); return; }
      dispatchAction(ctx, w.submit, { formValues: values, status: status });
    };
    foot.appendChild(submit);
    foot.appendChild(status);
    hostLockActionBar(foot); // host lockdown: disable the submit + show the note
    wrap.appendChild(foot);
    return wrap;
  }

  // run — live status + prominent latest line + collapsed event feed.
  function renderRun(ctx, w) {
    var wrap = winShell(kitText('Run'), kitText('connecting'), 'st-running');
    var pill = wrap.querySelector('.pcc-pill');
    var latest = el('div', 'pcc-run-latest', kitText('Waiting for the first update…'));
    wrap._body.appendChild(latest);
    var started = Date.now();
    var elapsed = el('div', 'pcc-run-elapsed pcc-mono', kitText(''));
    wrap._body.appendChild(elapsed);
    var toggle = el('button', 'pcc-link', kitText('Show all'));
    toggle.type = 'button';
    var feed = el('div', 'pcc-run-feed'); feed.hidden = true;
    toggle.onclick = function () { feed.hidden = !feed.hidden; setText(toggle, kitText(feed.hidden ? 'Show all' : 'Hide')); };
    wrap._body.appendChild(toggle);
    wrap._body.appendChild(feed);

    var tick = setInterval(function () {
      setText(elapsed, joinText(numberText(Math.floor((Date.now() - started) / 1000)), kitText('s elapsed')));
    }, 1000);

    // Secondary text is HELD raw and repainted under each read's verification (astra r7 F10): a later
    // read that is not a verified payee payment, or a failed read, requalifies what an earlier verified
    // read left plain. held.latest = { raw, isStatus, money }; held.feed = { lines: [{ ts, label }], money }.
    var held = { latest: null, feed: null };
    function paintLatest(verified) {
      var h = held.latest;
      if (h) setText(latest, h.isStatus ? statusPillText(h.raw, verified, h.money) : reportedText(h.raw, verified, h.money));
    }
    function paintFeed(verified) {
      var f = held.feed;
      if (!f) return;
      clear(feed);
      for (var i = 0; i < f.lines.length; i++) feedLine(joinText(dataAt(f.lines, i).ts, statusPillText(dataAt(f.lines, i).label, verified, f.money)));
    }

    // `live` is true only for a successful poll of the binding (never a snapshot or a stream event).
    function apply(statusVal, latestVal, data, full, live) {
      var bpath = w.binding && w.binding.path;
      var cls = null; // this read's pill class, when it sets one
      if (full && isVNextRecord(data) && isMoneyData(bpath, data)) {
        cls = settlementReadClass(data, bpath, live)[0]; // a settlement read model: by its schema AND source
        setText(pill, dataStatusText(bpath, data, statusVal, live)); pill.className = 'pcc-pill ' + cls;
      } else if (statusVal != null) {
        cls = dataStatusClass(bpath, data, statusVal, live);
        setText(pill, dataStatusText(bpath, data, statusVal, live)); pill.className = 'pcc-pill ' + cls;
      } else if (full) {
        // A full snapshot WITHOUT a status: the earlier status is no longer known (never kept green).
        setText(pill, kitText('unknown')); pill.className = 'pcc-pill st-unknown';
      }
      // Secondary text (the latest line, timeline and feed lines) is plain only on a VERIFIED PAYEE
      // PAYMENT: a V-next record whose live exact read is st-settled. A verified refund proves the payees
      // were NOT paid, so it vouches for no other claim (astra r6 F10).
      var payeeVerified = isVNextRecord(data) && cls === 'st-settled';
      if (latestVal != null && latestVal !== '') {
        // The latest line, on every surface (astra r5 F8, r6 F12). Status-sourced text (the status path
        // itself, or a status/state/phase field) is a label, so it takes the closed vocabulary; anything
        // else is a free-text message, attributed to its source.
        var latestIsStatus = typeof w.latestFrom === 'string' && (w.latestFrom === w.statusFrom || isStatusPath(w.latestFrom));
        held.latest = { raw: latestVal, isStatus: latestIsStatus, money: isMoneyData(bpath, data) };
      }
      paintLatest(payeeVerified); // this read decides, even when it carries no new latest value
      return payeeVerified;
    }
    function feedLine(txt) {
      var line = el('div', 'pcc-mono pcc-feed-line', txt);
      feed.appendChild(line);
      while (feed.childNodes.length > 40) feed.removeChild(feed.firstChild); // 40-row cap
    }

    if (ctx.mode === 'snapshot') {
      var snap = dataAt(ctx.snapshot, w.binding.path);
      apply(dot(snap, w.statusFrom), dot(snap, w.latestFrom), snap, true, false);
      var stat = dot(snap, w.statusFrom);
      // apply() has set the honest text (F6: never the raw word); only a status-less, non-read-model
      // snapshot keeps the plain 'snapshot' marker.
      if (stat == null && !isVNextRecord(snap)) setText(pill, kitText('snapshot'));
      var tl = dot(snap, 'job.timeline') || dot(snap, 'timeline');
      if (Array.isArray(tl) && tl.length) {
        // Timeline entries are labels (astra r6 F11): the closed vocabulary, never verified in a snapshot.
        var snapMoney = isMoneyData(w.binding.path, snap);
        for (var ti = 0; ti < tl.length; ti++) feedLine(joinText(dataAt(tl, ti).timestamp ? joinText(fmtTs(dataAt(tl, ti).timestamp), kitText(' \u00b7 ')) : kitText(''), statusPillText(dataAt(tl, ti).type || '', false, snapMoney)));
        var lastType = dataAt(tl, tl.length - 1).type; // last event = latest truth
        if (lastType != null && lastType !== '') setText(latest, statusPillText(lastType, false, snapMoney));
      }
      wrap._setFoot(null, true);
      clearInterval(tick); setText(elapsed, kitText(''));
      return wrap;
    }

    // Live: prefer fetch-SSE (Bearer), fall back to polling with backoff.
    var stopped = false;
    function poll(delay) {
      if (stopped) return;
      ctx.tx.getJSON(w.binding.path, w.binding.query).then(function (d) {
        var payeeVerified = apply(dot(d, w.statusFrom), dot(d, w.latestFrom), d, true, true);
        // Timeline feed, if the response carries one. Each entry (its type, or the raw entry) is a label:
        // the closed vocabulary, plain only on a verified payee payment (astra r6 F10, F11). It is held,
        // so a later unverified read requalifies it (astra r7 F10).
        var tl = dot(d, 'timeline') || dot(d, 'job.timeline');
        if (Array.isArray(tl)) {
          var lines = [];
          for (var i = 0; i < tl.length; i++) lines.push({ ts: dataAt(tl, i).timestamp ? joinText(fmtTs(dataAt(tl, i).timestamp), kitText(' \u00b7 ')) : kitText(''), label: dataAt(tl, i).type || JSON.stringify(dataAt(tl, i)) });
          held.feed = { lines: lines, money: isMoneyData(w.binding.path, d) };
        }
        paintFeed(payeeVerified);
        wrap._setFoot(ctx.tx.lastTrace, false);
        setTimeout(function () { poll(w.binding.pollMs || POLL_DEFAULT_MS); }, w.binding.pollMs || POLL_DEFAULT_MS);
      }, function () {
        var next = Math.min((delay || POLL_DEFAULT_MS) * 2, 120000); // backoff
        // A failed read never keeps an earlier state, least of all a final one (astra r2 on #313, F3).
        setText(pill, kitText('unknown · read failed')); pill.className = 'pcc-pill st-unknown';
        paintLatest(false); paintFeed(false); // nothing earlier stays vouched for (astra r7 F10)
        wrap._setFoot(ctx.tx.lastTrace, true);
        setTimeout(function () { poll(next); }, next);
      });
    }

    if (w.binding.sse) {
      ctx.tx.streamSSE(w.binding.sse, function (ev) {
        apply(dot(ev, w.statusFrom) != null ? dot(ev, w.statusFrom) : ev.status,
              dot(ev, w.latestFrom) != null ? dot(ev, w.latestFrom) : (ev.message || ev.type), ev, false, false);
        // The feed line (astra r5 F8, r6 F12). Every label (the event's type, its status or the raw
        // event) takes the closed vocabulary on every surface. A stream event is never a verified read.
        var feedMoney = isMoneyData(w.binding && w.binding.path, ev);
        var label = ev.type || ev.status || JSON.stringify(ev);
        feedLine(joinText(ev.timestamp ? joinText(fmtTs(ev.timestamp), kitText(' \u00b7 ')) : kitText(''), statusPillText(label, false, feedMoney)));
        wrap._setFoot(ctx.tx.lastTrace, false);
      }).catch(function () { poll(w.binding.pollMs || POLL_DEFAULT_MS); }); // stream dropped → poll
    } else {
      poll(w.binding.pollMs || POLL_DEFAULT_MS);
    }
    return wrap;
  }

  // approval — the what/who/cost block. Its Approve and Deny are KIT-owned (ruling 4): the manifest's
  // approve label is shown only as quoted, untrusted text. Only Approve sends, and it sends exactly
  // the descriptor displayed in "This will send".
  function renderApproval(ctx, w) {
    var wrap = winShell(kitText('Approval'), kitText('needs you'), 'st-waiting');
    wrap._body.appendChild(loadingLine());
    resolveBinding(ctx, w.binding).then(function (r) {
      clear(wrap._body);
      if (w.approve && w.approve.label) wrap._body.appendChild(untrustedLabel(w.approve.label));
      // The ONE descriptor for this approval (directive 10, ruling 3) comes FIRST: it is exactly what
      // Approve sends -- never manifest confirmation text. The bound record follows as attributed
      // context (review charlie F1): the manifest chose its path, and a PCC read can carry user text.
      var desc = requestDescriptor(w.approve, (w.approve && w.approve.body) || {}, ctx.mode === 'host', ctx.apiBase);
      wrap._body.appendChild(realRequestNode(desc));
      var mismatch = recordAmountMismatch(r.data, desc);
      if (mismatch) wrap._body.appendChild(el('p', 'pcc-action-status st-failed pcc-mismatch', mismatch));
      wrap._body.appendChild(recordNode(r, desc));
      var foot = el('div', 'pcc-win-foot pcc-actionbar');
      var status = el('span', 'pcc-action-status');
      var approve = el('button', 'pcc-btn pcc-btn-primary', kitText('Approve')); // kit text, never w.approve.label
      approve.type = 'button';
      var deny = null;
      var submitted = false; // a request may have left: Deny must never again say "nothing was sent"
      approve.onclick = function () {
        if (!desc.ok) { refuseStatus(status, desc); return; }
        if (ctx.mode === 'snapshot') { dispatchAction(ctx, w.approve, { status: status }); return; } // intent chip only
        // Submission starts: lock BOTH controls at once, so Deny can never report "nothing was sent"
        // while this request is in flight. The approval WINDOW is itself the confirmation surface.
        submitted = true;
        approve.disabled = true; if (deny) deny.disabled = true;
        var sent = dispatchAction(ctx, w.approve, { status: status, viaApproval: true, desc: desc,
          onSuccess: function () { rebindApproval(wrap, desc); } });
        if (!sent || typeof sent.then !== 'function') return;
        sent.then(function (outcome) {
          if (outcome && outcome.ok) return; // consumed: one effect per approval, controls stay locked
          // Money intent stays locked after any unaccepted/unknown outcome, including a throw.
          var intent = intentState(desc);
          approve.disabled = !!(desc.money && (intent.key || intent.posting || intent.done));
          if (approve.disabled) setText(status, joinText(outcome && outcome.message ? outcome.message : kitText('The outcome is not confirmed.'), kitText(' Reload and check it before sending another.')));
          // Deny stays locked because a request was sent -- unless the kit refused before sending.
          if (!approve.disabled && outcome && outcome.sent === false) { submitted = false; if (deny) deny.disabled = false; }
        });
      };
      foot.appendChild(approve);
      if (w.deny) {
        deny = el('button', 'pcc-btn pcc-btn-quiet', kitText('Deny')); // kit text, never w.deny.label
        deny.type = 'button';
        // Deny is UI-ONLY: it never dispatches a manifest-authored action. A hostile manifest could
        // set w.deny to a money POST, and dispatching it with viaApproval would SKIP the money gate,
        // turning "Deny" into a one-click unapproved payment. Deny closes the surface; nothing is
        // sent. (A real server-side deny needs a separately registered typed deny operation.)
        deny.onclick = function () {
          if (submitted) return; // a request already left: there is nothing to "deny" here
          status.className = 'pcc-action-status';
          setText(status, kitText('Closed here - nothing was sent. This does not decline it on the network.'));
          approve.disabled = true; deny.disabled = true;
          var pill = wrap.querySelector('.pcc-win-head .pcc-pill');
          if (pill) { setText(pill, kitText('not approved here')); pill.className = 'pcc-pill st-unknown'; }
        };
        foot.appendChild(deny);
      }
      foot.appendChild(status);
      hostLockActionBar(foot); // host lockdown: disable Approve/Deny + show the note
      // Footer first, action bar last (defense in depth: _setFoot only touches its own meta footer).
      wrap._setFoot(ctx.tx && ctx.tx.lastTrace, r.stale);
      wrap.appendChild(foot);
    });
    return wrap;
  }
  function rebindApproval(wrap, desc) {
    var pill = wrap.querySelector('.pcc-win-head .pcc-pill');
    if (!pill) return;
    // A 2xx is an ACKNOWLEDGEMENT, never settlement (ruling 2; astra r3 F5 on #313): a money approval reads "submitted"
    // (waiting); anything else a NEUTRAL "resolved". Settled-green comes only from a read model.
    if (desc.money) { setText(pill, kitText('submitted')); pill.className = 'pcc-pill st-waiting'; }
    else { setText(pill, kitText('resolved')); pill.className = 'pcc-pill st-ack'; }
  }
  // What the BOUND RECORD says about an approval: attributed context, never the request. Its amount
  // line is dropped whenever the request carries an amount (the request's amount is what is sent),
  // and a failed or empty read says so instead of showing nothing (review charlie F1, N5).
  function recordNode(r, desc) {
    var box = el('div', 'pcc-approval-record');
    box.appendChild(el('div', 'pcc-untrusted-k', kitText('The bound record says (context, not what will be sent):')));
    if (r.error || !r.data || typeof r.data !== 'object') {
      box.appendChild(el('p', 'pcc-muted', joinText(kitText('Details unavailable'), r.error ? joinText(kitText(': '), reportedText(r.error, false, false)) : kitText('.'))));
      return box;
    }
    box.appendChild(approvalDetails(r.data, { noCost: !!(desc.amounts && desc.amounts.length) }));
    return box;
  }
  // A kit warning when the bound record states an amount that no amount in the request matches.
  function recordAmountMismatch(data, desc) {
    if (!data || typeof data !== 'object' || !desc.amounts || !desc.amounts.length) return null;
    var ra = data.amount != null ? data.amount
      : (data.totalAmount != null ? data.totalAmount
      : (data.price && typeof data.price === 'object' ? (data.price.base != null ? data.price.base : data.price.amount) : null));
    if (ra == null) return null;
    var sent = [];
    for (var i = 0; i < desc.amounts.length; i++) {
      if (sameAmount(ra, dataAt(desc.amounts, i)[1])) return null;
      sent.push(amountText(dataAt(desc.amounts, i)[1]));
    }
    return joinText(kitText('The bound record says '), amountText(ra), kitText(', but the request sends '), joinWithText(kitText(' / '), sent), kitText('. Approve sends the request, not the record.'));
  }
  function approvalDetails(info, opts) {
    var box = el('div', 'pcc-approval');
    // what
    var summary = info.summary || info.name || info.description;
    if (summary) { var what = untrustedLabel(summary); what.classList.add('pcc-approval-what'); box.appendChild(what); }
    // who + cost
    var line = el('div', 'pcc-approval-line');
    var payee = info.payee || (info.provider && (info.provider.id || info.provider.name)) || info.operatorAddress;
    if (payee) line.appendChild(el('span', 'pcc-mono', joinText(kitText('to '), hexText(payee))));
    var amount = info.amount || info.totalAmount || (info.price && (info.price.base || info.price.amount));
    var currency = info.currency || (info.price && info.price.currency) || '';
    if (amount != null && !(opts && opts.noCost)) line.appendChild(el('span', 'pcc-approval-cost pcc-tnum', joinText(amountText(amount), currency ? joinText(kitText(' '), currencyText(currency)) : kitText(''))));
    if (line.childNodes.length) box.appendChild(line);
    if (info.rationale) { var rationale = untrustedLabel(info.rationale); rationale.classList.add('pcc-approval-rationale'); box.appendChild(rationale); }
    // args table (ui.summaryKeys when present)
    var args = info.args || info.params;
    if (args && typeof args === 'object') {
      var keys = (info.ui && Array.isArray(info.ui.summaryKeys)) ? info.ui.summaryKeys : Object.keys(args);
      var tbl = el('div', 'pcc-args');
      for (var i = 0; i < keys.length; i++) {
        var v = dataAt(args, dataAt(keys, i));
        if (v == null) continue;
        var kv = el('div', 'pcc-args-row');
        kv.appendChild(el('span', 'pcc-args-k', reportedText(JSON.stringify(dataAt(keys, i)), false, false)));
        kv.appendChild(el('span', 'pcc-args-v pcc-mono', reportedText(typeof v === 'object' ? JSON.stringify(v) : String(v), false, false)));
        tbl.appendChild(kv);
      }
      if (tbl.childNodes.length) box.appendChild(tbl);
    }
    return box;
  }

  // receipt — amount large + payer→payee + rail + event timeline + tx ids.
  function renderReceipt(ctx, w) {
    var wrap = winShell(kitText('Receipt'), null, null);
    wrap._body.appendChild(loadingLine());
    resolveBinding(ctx, w.binding).then(function (r) {
      clear(wrap._body);
      var e = r.data;
      if (r.error || !e) { wrap._body.appendChild(errorLine(r.error || kitText('No settlement data.'))); wrap._setFoot(ctx.tx && ctx.tx.lastTrace, r.stale); return; }
      // Nothing is invented: an amount, currency, payer, payee or rail the record does not carry is
      // shown as not reported, never defaulted ("USDC", "payer", "escrow-milestone").
      var econ = (e.economics && typeof e.economics === 'object') ? e.economics : {};
      var amount = e.totalAmount != null ? e.totalAmount : e.amount;
      var amtRow = el('div', 'pcc-receipt-amount pcc-tnum');
      var econText = (amount == null || amount === '') && econ.amount != null ? baseUnitsText(econ.amount, econ.tokenDecimals) : null;
      if (amount != null && amount !== '') {
        amtRow.appendChild(el('span', 'pcc-receipt-num', fmtUsd(amount)));
        amtRow.appendChild(el('span', 'pcc-receipt-cur', joinText(kitText(' '), currencyText(e.currency))));
      } else if (econText !== null) {
        // economics.amount is in the token's BASE units: never through fmtUsd, never with an invented currency.
        amtRow.appendChild(el('span', 'pcc-receipt-num', econText));
      } else {
        amtRow.appendChild(el('span', 'pcc-receipt-num pcc-muted', kitText('amount not reported')));
      }
      wrap._body.appendChild(amtRow);
      var payer = e.payer || e.funder, payee = e.payee || e.provider;
      var pay = el('div', 'pcc-receipt-parties');
      pay.appendChild(el('span', 'pcc-mono', payer ? hexText(payer) : kitText('payer not reported')));
      pay.appendChild(el('span', 'pcc-arrow', kitText('→')));
      pay.appendChild(el('span', 'pcc-mono', payee ? hexText(payee) : kitText('payee not reported')));
      wrap._body.appendChild(pay);
      // Settlement state by SOURCE SCHEMA (V-next /lifecycle or /receipt, a legacy escrow record,
      // or "not a settlement record"), never by a bare status word. Never inferred from a count or
      // from the receipt's existence (contract rule 12).
      // Authority needs the UNPROJECTED top-level response of the exact route: a binding.select projection
      // (or any nested object) never inherits the route's provenance (astra r7 F13).
      var recTopLevel = r.raw !== undefined && e === r.raw;
      var rec = settlementReadClass(e, w.binding && w.binding.path, !r.stale && ctx.mode !== 'snapshot' && recTopLevel);
      var railRow = el('div', 'pcc-receipt-rail');
      // The pill text may not claim more than the class (F6): only a verified final keeps its plain name;
      // "no settlement state" is PCC's own text.
      var recVerified = isVNextRecord(e) && (rec[0] === 'st-settled' || rec[0] === 'st-refunded');
      var payeePaid = isVNextRecord(e) && rec[0] === 'st-settled'; // secondary text: payee payment only
      railRow.appendChild(el('span', 'pcc-pill ' + rec[0], statusPillText(rec[2], recVerified || (!isVNextRecord(e) && e.status == null), true)));
      if (rec[1]) railRow.appendChild(el('span', 'pcc-muted pcc-settle-label', joinText(kitText(' '), settlementCaptionText(e, w.binding && w.binding.path, !r.stale && ctx.mode !== 'snapshot' && recTopLevel))));
      if (e.rail) railRow.appendChild(el('span', 'pcc-muted', joinText(kitText(' · '), idText(e.rail))));
      wrap._body.appendChild(railRow);
      // timeline of pcc.* / escrow events
      var events = e.events || e.timeline || (e.milestones);
      if (Array.isArray(events) && events.length) {
        var tl = el('ol', 'pcc-timeline');
        for (var i = 0; i < events.length; i++) {
          var ev = dataAt(events, i);
          var li = el('li', 'pcc-timeline-row');
          // Each entry is a server claim about this money record (astra r5 F8). Its label (type, name or
          // status) takes the closed vocabulary, plain only on a VERIFIED PAYEE PAYMENT: a verified refund
          // keeps its own pill text but vouches for no entry (astra r6 F10). 'event' is PCC's own placeholder.
          var evRaw = ev.type || ev.name || ev.status;
          var evTxt = evRaw != null && evRaw !== '' ? statusPillText(evRaw, payeePaid, true) : kitText('event');
          li.appendChild(el('span', 'pcc-timeline-type', evTxt));
          if (ev.timestamp) li.appendChild(el('span', 'pcc-mono pcc-timeline-ts', fmtTs(ev.timestamp)));
          tl.appendChild(li);
        }
        wrap._body.appendChild(tl);
      }
      var tx = e.txHash || e.tx || e.escrowAddress || e.address;
      if (tx) wrap._body.appendChild(el('div', 'pcc-mono pcc-receipt-tx', hexText(tx)));
      wrap._setFoot(ctx.tx && ctx.tx.lastTrace, r.stale);
    });
    return wrap;
  }

  // chain — the pinned re-plannable ComposeRequest. Plan is a WRITE (POST /api/compose) and takes the
  // SAME path as every other write (r1 finding 4): a kit-synthesized action (kit-owned label) through
  // dispatchAction, so it gets the descriptor, the Approval gate (an unlisted write is money), an
  // Idempotency-Key and the busy guard. It is created ONCE per window, so its kit state is stable.
  function renderChain(ctx, w) {
    var wrap = winShell(kitText('Value chain'), null, null);
    var cr = w.composeRef || {};
    var head = el('div', 'pcc-chain-head');
    head.appendChild(cr.outcomeType ? agentEl('span', 'pcc-chain-outcome', agentText(cr.outcomeType, false)) : el('span', 'pcc-chain-outcome', kitText('outcome')));
    if (cr.budgetUSD != null) head.appendChild(el('span', 'pcc-chain-budget pcc-tnum', joinText(kitText('budget '), fmtUsd(cr.budgetUSD), kitText(' USDC'))));
    wrap._body.appendChild(head);
    var seq = (cr.outcomeChain && cr.outcomeChain.length) ? cr.outcomeChain : (cr.steps || [cr.outcomeType]);
    var stepsRow = el('div', 'pcc-chain-steps');
    for (var i = 0; i < seq.length; i++) {
      if (i > 0) stepsRow.appendChild(el('span', 'pcc-arrow', kitText('→')));
      stepsRow.appendChild(agentEl('span', 'pcc-chain-step', agentText(dataAt(seq, i), false)));
    }
    wrap._body.appendChild(stepsRow);
    var optimize = el('p', 'pcc-muted', joinText(kitText('tier '), numberText(cr.minAssuranceTier != null ? cr.minAssuranceTier : 0), kitText(' · optimize for ')));
    optimize.appendChild(cr.optimizeFor ? agentEl('span', 'pcc-chain-optimize', agentText(cr.optimizeFor, false)) : el('span', null, kitText('price')));
    wrap._body.appendChild(optimize);
    var result = el('div', 'pcc-chain-result');
    wrap._body.appendChild(result);

    var foot = el('div', 'pcc-win-foot pcc-actionbar');
    var status = el('span', 'pcc-action-status');
    var planAction = { id: 'pcc-chain-plan', kind: 'post', path: '/api/compose', body: cr,
      intentText: 'pcc: plan ' + (cr.outcomeType || 'chain') };
    var plan = writeButton(ctx, planAction, requestDescriptor(planAction, cr, ctx.mode === 'host', ctx.apiBase), 'Plan');
    function showPlan(body) {
      clear(result);
      var steps = body.steps || [];
      var box = el('ol', 'pcc-plan');
      for (var i = 0; i < steps.length; i++) {
        var s = dataAt(steps, i);
        var li = el('li', 'pcc-plan-row');
        li.appendChild(el('span', 'pcc-plan-type', s.capabilityType || s.outcomeType ? idText(s.capabilityType || s.outcomeType) : joinText(kitText('step '), numberText(i + 1))));
        if (s.estimatedPriceUSD != null) li.appendChild(el('span', 'pcc-mono pcc-tnum', joinText(fmtUsd(s.estimatedPriceUSD), kitText(' USDC'))));
        box.appendChild(li);
      }
      result.appendChild(box);
      if (body.totalPriceUSD != null) result.appendChild(el('div', 'pcc-plan-total pcc-tnum', joinText(kitText('total '), fmtUsd(body.totalPriceUSD), kitText(' USDC'))));
      if (w.execute) {
        var execBtn = writeButton(ctx, w.execute, requestDescriptor(w.execute, w.execute.body || {}, ctx.mode === 'host', ctx.apiBase), 'Execute');
        execBtn.onclick = function () { dispatchAction(ctx, w.execute, { status: status }); };
        result.appendChild(execBtn);
      }
    }
    plan.onclick = function () {
      dispatchAction(ctx, planAction, { status: status, onSuccess: function (res) { showPlan((res && res.body) || {}); } });
    };
    foot.appendChild(plan);
    foot.appendChild(status);
    hostLockActionBar(foot); // host lockdown: disable Plan (its POST is refused) + note
    wrap.appendChild(foot);
    return wrap;
  }

  // actions — a bare bar of buttons.
  function renderActions(ctx, w) {
    var wrap = winShell(kitText('Actions'), null, null);
    var bar = el('div', 'pcc-actionbar');
    var status = el('span', 'pcc-action-status');
    (w.actions || []).forEach(function (a) {
      // An actions-bar body is static, so ONE descriptor serves the button's styling + kit tag and
      // the click itself (the gate displays it and the transport sends it). A projected MCP-App
      // action with no `path` has no raw request: refused, styled as money, and host-routed.
      var desc = requestDescriptor(a, (a && a.body) || {}, ctx.mode === 'host', ctx.apiBase);
      var btn = writeButton(ctx, a, desc, 'Action');
      // PR2: a button wired to a registered typed operation stays live under the
      // host lockdown (hostLockActionBar skips the pcc-host-op-enabled class).
      if (hostActionEnabled(a)) btn.className += ' pcc-host-op-enabled';
      btn.onclick = function () { dispatchAction(ctx, a, { status: status, desc: desc }); };
      bar.appendChild(btn);
    });
    hostLockActionBar(bar); // host lockdown: disable non-typed action buttons + note
    wrap._body.appendChild(bar);
    wrap._body.appendChild(status);
    return wrap;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Action layer — NOTHING fires on load; execution is a click. Every write is
  // validated into ONE request descriptor (requestDescriptor); every write that
  // is not on the kit's non-money allowlist passes the Approval surface; snapshot
  // mode emits copyable intent chips; host mode runs registered typed operations.
  // ═══════════════════════════════════════════════════════════════════════

  // 53-bit string hash (cyrb53) for a deterministic idempotency key. Not a security primitive.
  function hash53(str) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  // Pull the first text line out of an MCP tool-error result (server-authored,
  // never containing a credential) for display.
  function hostOpErrorText(result) {
    try {
      var c = result && result.content;
      if (c && c.length) {
        for (var i = 0; i < c.length; i++) {
          if (dataAt(c, i) && dataAt(c, i).type === 'text' && dataAt(c, i).text) return reportedText(dataAt(c, i).text, false, false);
        }
      }
    } catch (e) {}
    return kitText('Operation failed');
  }

  // R4 PR2 — run a REGISTERED typed operation from a hosted view. The manifest
  // action carries { operation_id, arguments }; the bridge sends a tools/call for
  // the mapped pcc.op.<id> tool and the SERVER derives the principal (from the
  // host connection's key) and authorizes. A raw HTTP write is never issued.
  // Unregistered/unknown ops (or no bridge) stay inert (the PR1 read-only state).
  function dispatchHostOperation(ctx, action, status) {
    if (!hostActionEnabled(action)) { markWriteUnavailable(status); return; }
    var st = actionState(action);
    // One in-flight call per action (r1 finding 4): a double-click never runs a typed operation twice.
    // (Money approval / dedupe for a typed operation is the trusted server operation's job.)
    if (st.posting) { alreadySubmitted(status, st); return; }
    st.posting = true;
    status.className = 'pcc-action-status'; setText(status, kitText('Working…'));
    function fail(err) {
      st.posting = false;
      status.className = 'pcc-action-status st-failed';
      setText(status, err && err.message ? reportedText(err.message, false, false) : kitText('Operation failed'));
    }
    var call;
    try { call = window.__PCC_HOST_BRIDGE__.callOperation(action.operation_id, action.arguments || {}); }
    catch (e) { fail(e); return; }
    Promise.resolve(call).then(function (result) {
      st.posting = false;
      if (result && result.isError) {
        status.className = 'pcc-action-status st-failed';
        setText(status, hostOpErrorText(result));
      } else {
        // An acknowledgement, never settlement (ruling 2; astra r3 F5 on #313): NEUTRAL, not green.
        status.className = 'pcc-action-status st-ack';
        setText(status, joinText(kitText('Done'), traceSuffixText(ctx && ctx.tx && ctx.tx.lastTrace)));
      }
    }, fail);
  }

  // Returns the write's settle promise ({ ok, sent }) when a request starts, else null.
  function dispatchAction(ctx, action, opts) {
    opts = opts || {};
    var status = opts.status || el('span', 'pcc-action-status');
    if (!action) return null;

    // Snapshot: never POST. Hand the LLM a copyable intent chip.
    if (ctx.mode === 'snapshot') { intentChip(status, action.intentText || ('pcc: ' + action.label)); return null; }

    // R4 PR2: in MCP-App/host mode a manifest still cannot author a RAW write,
    // but it MAY name a REGISTERED typed operation, executed via the host bridge
    // (a server-authorized tools/call). An unregistered/unknown operation, or no
    // bridge, stays inert exactly as PR1 shipped.
    if (ctx.mode === 'host') { dispatchHostOperation(ctx, action, status); return null; }

    // One effect per intent: while a request is in flight, or once a MONEY write was accepted in
    // this render (one-shot; a new intent needs a reload), a click says so and sends nothing.
    var st = actionState(action);
    if (st.posting || st.done) { alreadySubmitted(status, st); return null; }

    // Validate ONCE into the canonical descriptor; every step below uses this same object.
    var desc = opts.desc || requestDescriptor(action, action.body, false, ctx.apiBase, opts.formValues);
    if (!desc.ok) { refuseStatus(status, desc); return null; }
    var it = intentState(desc); // the same request from ANY action object (clone, window, button)
    if (it.posting || it.done) { alreadySubmitted(status, it); return null; }

    // Every write the kit's allowlist does not know is money: it passes the Approval gate first
    // (unless we ARE that gate -- the approval window, or the gate's own Approve).
    if (desc.money && !opts.viaApproval) { openApprovalGate(ctx, action, desc, opts); return null; }

    // An allowlisted non-money write with inline confirm: two-step, in place.
    if (action.confirm === 'inline' && !opts.viaApproval && !opts.confirmed) {
      inlineConfirm(status, action, function () {
        dispatchAction(ctx, action, Object.assign({}, opts, { confirmed: true, desc: desc }));
      });
      return null;
    }

    return doPost(ctx, action, desc, opts, status);
  }

  // Honest status for a write the kit REFUSED at validation: nothing was sent, and why.
  function refuseStatus(status, desc) {
    if (!status) return;
    status.className = 'pcc-action-status st-failed';
    setText(status, joinText(kitText('Refused: '), requestReasonText(desc), kitText(' - nothing was sent.')));
  }
  function alreadySubmitted(status, st) {
    if (!status) return;
    status.className = 'pcc-action-status st-waiting';
    setText(status, kitText(st.posting
      ? 'Already submitted - waiting for the response.'
      // st.done / it.done is set true only once a MONEY write was accepted (astra r4 F1 on #342: the
      // intent is now the whole view, not just this endpoint), so this is always that case.
      : 'Already submitted - a money request from this view was accepted. Reload the page to make another.'));
  }

  function doPost(ctx, action, desc, opts, status) {
    var st = actionState(action);
    // Belt and braces: the busy guard and the money one-shot hold even for a direct caller.
    if (st.posting || st.done) { alreadySubmitted(status, st); return null; }
    if (!desc || !desc.ok) { refuseStatus(status, desc); return null; }
    var it = intentState(desc);
    if (it.posting || it.done) { alreadySubmitted(status, it); return null; }
    // Idempotency INTENTS (r1 finding 5; astra r2 F1/F3; astra r4 F1), kit-owned: one key per intent
    // while its outcome is UNRESOLVED. For a NON-money write the intent is its own canonical request
    // (method, decoded route + sorted query, sorted-key body), so A (unknown outcome) -> B -> retry A
    // resends A's key and the server dedupes instead of double-charging, and a CLONED action for the
    // same request reuses it too. For a MONEY write the intent is the WHOLE VIEW (see INTENT_STATE):
    // once a money request was sent, every further one is refused, an identical retry included. A 2xx
    // consumes the key (a non-money write may then re-send under a new key; an accepted MONEY write is
    // one-shot for the whole view). A form reference
    // (idempotencyFrom) DERIVES the key from (method, canonical target with its query, reference,
    // body): the same logical intent dedupes even across a reload, and never shares a key with another
    // target or body.
    var fp = canonicalJson(desc.body);
    var request = requestFingerprint(desc);
    if (it.key && it.request !== null) {
      var sameRequest = it.request === request;
      if (desc.money) {
        // a money request from this view was already sent and not accepted (astra r5 F1, F2)
        show('pcc-action-status st-failed', kitText("Refused: a money request from this view was already sent and its outcome is not confirmed. Reload and check it before sending another - nothing was sent."));
        return null;
      } else if (!sameRequest) {
        // a DIFFERENT request to this endpoint whose earlier request has an unknown outcome
        show('pcc-action-status st-failed', kitText('Refused: an earlier request to this endpoint has an unknown outcome. Reload to check it before sending a different one - nothing was sent.'));
        return null;
      }
    }
    var key = it.key;
    if (!key) {
      var ref = (action.idempotencyFrom && opts.formValues) ? dataAt(opts.formValues, action.idempotencyFrom) : null;
      key = (ref != null && ref !== '')
        ? 'idem-' + hash53(desc.method + ' ' + canonicalTarget(desc) + '|' + String(ref) + '|' + fp)
        : 'idem-' + uuid();
      it.key = key; it.request = request;
    }
    var sendBody = Object.assign({}, desc.body);
    if (desc.method === 'POST') sendBody.idempotencyKey = key; // legacy body field (kind "post"), preserved
    var outcomeText = kitText('');
    function show(cls, text) {
      outcomeText = text;
      status.className = cls; setText(status, text);
      // The approval GATE closes after a moment; mirror the final outcome to the caller's status
      // line so it never stays at a stale "Working...".
      if (opts.mirror && opts.mirror !== status) { opts.mirror.className = cls; setText(opts.mirror, text); }
    }
    st.posting = true; it.posting = true;
    show('pcc-action-status', kitText('Working…'));
    var sending;
    try { sending = ctx.tx.send(desc, sendBody, key); }
    catch (e) { // the request never started (review charlie F6): release the guard, say so honestly
      st.posting = false; it.posting = false;
      show('pcc-action-status st-failed', kitText('Refused: the request could not be started - nothing was sent.'));
      return Promise.resolve({ ok: false, sent: false, message: outcomeText });
    }
    return sending.then(function (res) {
      st.posting = false; it.posting = false;
      if (res.ok) {
        it.key = null; it.request = null; // this intent is resolved
        var trace = traceSuffixText(ctx.tx.lastTrace);
        // An HTTP 2xx is an ACKNOWLEDGEMENT, never settlement (ruling 2; astra r3 F5 on #313). A money write reads
        // "submitted" (waiting) and is one-shot for this render; anything else a NEUTRAL "Done".
        // Settled-green comes only from a read model (a receipt window).
        if (desc.money) { st.done = true; it.done = true; show('pcc-action-status st-waiting', joinText(kitText('Submitted - awaiting network confirmation'), trace)); }
        else show('pcc-action-status st-ack', joinText(kitText('Done'), trace));
        if (typeof opts.onSuccess === 'function') opts.onSuccess(res, desc);
      } else {
        // Not accepted: the key is KEPT. No status proves the request had no effect (astra r5 F2), so
        // a money intent stays locked and every further money request from this view is refused.
        show('pcc-action-status st-failed', postErrorText(res, desc));
      }
      return { ok: !!res.ok, sent: !res.refused, message: outcomeText };
    }, function (err) {
      st.posting = false; it.posting = false;
      // A throw/network error is an UNKNOWN outcome (the request may have reached the server): the
      // key is kept, same as any other unresolved outcome.
      show('pcc-action-status st-failed', err && err.message ? reportedText(err.message, false, !!desc.money) : kitText('Request failed'));
      return { ok: false, sent: true, message: outcomeText };
    });
  }

  // Honest message for a failed write. Prefers the server's own message; otherwise explains the
  // C-03 endpoint changes instead of a bare status code.
  function postErrorText(res, desc) {
    var msg = res.body && (res.body.message || res.body.error);
    if (msg) return reportedText(typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 300), false, !!(desc && desc.money));
    var canon = (desc && desc.canonical) || '';
    if (res.status === 410) return kitText('This action is no longer available - the endpoint was removed. Nothing was executed.');
    if (res.status === 404 && /^\/api\/escrow\/chain\/[^\/]+\/fund$/.test(canon)) return kitText('Funding was refused: this escrow is not recognised by the protocol.');
    // A 5xx can come from the edge AFTER the gateway executed the write. The kit cannot know the
    // outcome, so it never claims that nothing was charged.
    if (res.status >= 500) return joinText(kitText('Failed (HTTP '), numberText(res.status), kitText(') - the outcome is unknown. Check the receipt before retrying.'));
    return joinText(kitText('Failed (HTTP '), numberText(res.status), kitText(')'));
  }

  function inlineConfirm(status, action, onConfirm) {
    clear(status); status.className = 'pcc-action-status';
    var yes = el('button', 'pcc-btn pcc-btn-primary pcc-btn-sm', kitText('Confirm'));
    yes.type = 'button';
    var no = el('button', 'pcc-btn pcc-btn-quiet pcc-btn-sm', kitText('Cancel'));
    no.type = 'button';
    yes.onclick = function () { clear(status); onConfirm(); };
    no.onclick = function () { clear(status); };
    var question = el('span', 'pcc-confirm-q');
    question.appendChild(el('span', null, kitText('Confirm “')));
    question.appendChild(agentEl('span', 'pcc-text', agentText(action.label, false)));
    question.appendChild(el('span', null, kitText('”?')));
    status.appendChild(question);
    status.appendChild(yes);
    status.appendChild(no);
  }

  // Kit-derived, textContent-only "This will send" block — the honest summary of
  // the REAL request (method + the exact destination URL + amount/asset +
  // job/escrow ref) the action fires, rendered from the SAME descriptor the
  // transport sends. Shown ALONGSIDE the manifest label so a misleading label can
  // never hide the true destination/amount (directive 10).
  function realRequestNode(desc) {
    var box = el('div', 'pcc-realreq');
    box.appendChild(el('div', 'pcc-realreq-title', kitText('This will send')));
    var line = el('div', 'pcc-realreq-line');
    if (!desc.ok || desc.destination === null) {
      line.appendChild(el('span', 'pcc-realreq-blocked', joinText(kitText('BLOCKED — '), requestReasonText(desc, true))));
    } else {
      line.appendChild(el('span', 'pcc-realreq-method', requestMethodText(desc)));
      line.appendChild(el('span', 'pcc-realreq-dest pcc-mono', requestDestinationText(desc)));
    }
    box.appendChild(line);
    // EVERY amount- and reference-like field the body carries. With more than one, each line names
    // its field, so a small first "amount" can never stand in for a larger "totalAmount" that is also
    // sent. A value that is not a plain decimal is shown as sent (JSON), never coerced into a sum.
    var amts = desc.amounts || [], refs = desc.refs || [], shown = new Set();
    // The unit is shown only when the request states one; the kit never supplies a currency.
    var asset = desc.asset != null ? joinText(kitText(' '), requestValueText(desc.asset)) : kitText(' (no currency in the request)');
    for (var i = 0; i < amts.length; i++) {
      shown.add(dataAt(amts, i)[0]);
      var amountLine = el('div', 'pcc-realreq-amt pcc-tnum');
      amountLine.appendChild(amts.length > 1 ? el('span', null, reportedText(JSON.stringify(dataAt(amts, i)[0]), false, false)) : el('span', null, kitText('Amount')));
      amountLine.appendChild(el('span', null, joinText(kitText(' '), amountText(dataAt(amts, i)[1]), asset)));
      box.appendChild(amountLine);
    }
    if (amts.length && desc.assetField) shown.add(desc.assetField);
    for (var j = 0; j < refs.length; j++) {
      shown.add(dataAt(refs, j)[0]);
      var refLine = el('div', 'pcc-realreq-ref pcc-mono');
      refLine.appendChild(refs.length > 1 ? el('span', null, reportedText(JSON.stringify(dataAt(refs, j)[0]), false, false)) : el('span', null, kitText('ref')));
      refLine.appendChild(el('span', null, joinText(kitText(' '), requestValueText(dataAt(refs, j)[1]))));
      box.appendChild(refLine);
    }
    // ...and every OTHER field of the body, exactly as the wire carries it. A POST's idempotencyKey
    // is the KIT's (one per request intent; it replaces any value the body names), so it is shown
    // as that, never with the body's value. Nothing the request sends is left off this block.
    var post = desc.ok && desc.method === 'POST';
    var rest = Object.keys(desc.body || {}).filter(function (k) { return !shown.has(k) && !(post && k === 'idempotencyKey'); });
    if (rest.length || post) {
      var tbl = el('div', 'pcc-args pcc-realreq-body');
      for (var r = 0; r < rest.length; r++) {
        var kv = el('div', 'pcc-args-row');
        kv.appendChild(el('span', 'pcc-args-k', reportedText(JSON.stringify(dataAt(rest, r)), false, false)));
        kv.appendChild(el('span', 'pcc-args-v pcc-mono', reportedText(JSON.stringify(dataAt(desc.body, dataAt(rest, r))), false, false)));
        tbl.appendChild(kv);
      }
      if (post) {
        var kr = el('div', 'pcc-args-row pcc-args-kit');
        kr.appendChild(el('span', 'pcc-args-k', kitText('idempotencyKey')));
        kr.appendChild(el('span', 'pcc-args-v pcc-muted', kitText('set by the kit when sent')));
        tbl.appendChild(kr);
      }
      box.appendChild(tbl);
    }
    return box;
  }
  // A string as itself; anything else as its JSON (what the wire carries).
  function wireText(v) { return typeof v === 'string' ? v : JSON.stringify(v); }
  // An amount is formatted as a sum only when the formatting is EXACT: a number whose 2-decimal form
  // round-trips, or a decimal string with at most 2 decimals (and a safe integer part). Anything else
  // (0.0049, "1234.5678", true, [1000], "0x0F4240", an object) is shown exactly as sent, so the display
  // never rounds, coerces or invents an amount.
  function amountText(v) {
    if (typeof v === 'number' && isFinite(v)) {
      var f = fmtUsdRaw(v);
      return mintText(Number(String(f).replace(/,/g, '')) === v ? f : String(v));
    }
    if (typeof v === 'string' && /^-?\d{1,15}(\.\d{1,2})?$/.test(v)) return fmtUsd(v);
    return mintText(JSON.stringify(v) || '');
  }
  // Do two wire amounts denote the same number? (Both must be numbers or numeric strings.)
  function sameAmount(a, b) {
    var ok = function (v) { return (typeof v === 'number' && isFinite(v)) || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)); };
    return ok(a) && ok(b) && Number(a) === Number(b);
  }

  // The kit's Approval window as a floating modal — only its kit-labelled Approve sends, and it sends
  // exactly the descriptor it displays.
  function openApprovalGate(ctx, action, desc, opts) {
    // Host lockdown: writes are disabled in a hosted view — never open the gate.
    // (dispatchAction already returns before here in host mode; belt-and-suspenders.)
    if (isHostEmbed()) { markWriteUnavailable(opts && opts.status); return; }
    var st = actionState(action), it = intentState(desc);
    // An intent in flight or already accepted: say so, never open a gate whose Approve would be inert.
    if (st.posting || st.done) { alreadySubmitted(opts && opts.status, st); return; }
    if (it.posting || it.done) { alreadySubmitted(opts && opts.status, it); return; }
    // One approval modal per action AND per request intent: neither a rapid second click nor a
    // cloned action for the same request can stack a second gate (astra r2 F1), and it says so.
    if (st.gate || it.gate) {
      if (opts && opts.status) { opts.status.className = 'pcc-action-status st-waiting'; setText(opts.status, kitText('An approval window for this is already open.')); }
      return;
    }
    var gate = {}; // THIS opening's identity: only it may release the one-gate guards
    st.gate = gate; it.gate = gate;
    var overlay = el('div', 'pcc-overlay');
    var card = el('div', 'pcc-modal');
    var head = el('div', 'pcc-win-head');
    head.appendChild(el('span', 'pcc-win-title', kitText('Approve')));
    head.appendChild(el('span', 'pcc-pill st-waiting', kitText('confirm')));
    card.appendChild(head);
    // The manifest's label is untrusted: quoted text only. The gate's controls are kit-owned.
    if (action.label) card.appendChild(untrustedLabel(action.label));
    // The ONE descriptor the Approve below sends, displayed verbatim (method + exact URL + every
    // body field: realRequestNode leaves nothing the wire carries off the block).
    card.appendChild(realRequestNode(desc));
    var foot = el('div', 'pcc-actionbar');
    var status = el('span', 'pcc-action-status');
    var approve = el('button', 'pcc-btn pcc-btn-primary', kitText('Approve'));
    approve.type = 'button';
    var cancel = el('button', 'pcc-btn pcc-btn-quiet', kitText('Cancel'));
    cancel.type = 'button';
    // Instance-specific cleanup (r1 finding 5): a stale close() -- e.g. this gate's delayed
    // auto-close firing after it was cancelled and a NEWER gate opened -- removes only its own
    // overlay and never releases the newer gate's guard.
    function close() {
      if (st.gate === gate) st.gate = null;
      if (it.gate === gate) it.gate = null;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    approve.onclick = function () {
      approve.disabled = true; // one Approve per gate opening
      var sent = doPost(ctx, action, desc, Object.assign({}, opts, { viaApproval: true, mirror: opts.status }), status);
      // Keep the gate (and its one-gate guard) until the request settles, then show the outcome briefly.
      var later = function () { setTimeout(close, 1200); };
      if (sent && typeof sent.then === 'function') sent.then(later, later); else later();
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
    var chipText = agentText(text, false);
    var chip = el('button', 'pcc-chip');
    chip.appendChild(agentEl('span', 'pcc-text', chipText));
    chip.type = 'button';
    setAttrText(chip, 'title', kitText('Copy — paste to your assistant to run this'));
    chip.onclick = function () {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
      } catch (e) {}
      clear(chip);
      chip.appendChild(el('span', null, kitText('copied ✓')));
      setTimeout(function () { clear(chip); chip.appendChild(agentEl('span', 'pcc-text', chipText)); }, 1400);
    };
    status.appendChild(el('span', 'pcc-chip-label', kitText('snapshot — run via your assistant: ')));
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
    var fn = dataAt(RENDERERS, w.kind);
    if (!fn) { // unknown kind (a newer manifest against an older kit): honest, never throws.
      var stub = winShell(w.kind ? agentText(w.kind, false) : kitText('window'), kitText('unsupported'), 'st-waiting');
      stub._body.appendChild(el('p', 'pcc-muted', kitText('This dashboard uses a window type this kit version does not render.')));
      return stub;
    }
    try { return fn(ctx, w); }
    catch (e) {
      var errw = winShell(w.kind ? agentText(w.kind, false) : kitText('window'), kitText('error'), 'st-failed');
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
    bar.appendChild(el('span', 'pcc-connect-label', kitText('Connect your PCC key to go live:')));
    var input = el('input', 'pcc-input pcc-connect-input');
    input.type = 'password';
    setAttrText(input, 'placeholder', kitText('pcc_live_…'));
    input.autocomplete = 'off';
    input.spellcheck = false;
    var btn = el('button', 'pcc-btn pcc-btn-primary pcc-btn-sm', kitText('Connect'));
    btn.type = 'button';
    btn.onclick = function () {
      var v = input.value.trim();
      if (!v) return;
      setKey(v);
      setValue(input, kitText('')); // never keep the key in the DOM
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
    banner.appendChild(el('span', 'pcc-banner-dot', kitText('')));
    banner.appendChild(el('span', null, ctx.degraded
      ? kitText('Snapshot — live data is unreachable; showing the last known values.')
      : joinText(kitText('Snapshot'), ts ? joinText(kitText(' — data as of '), fmtTs(ts)) : kitText(''), kitText(' · not live.'))));
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
      root.appendChild(el('p', 'pcc-err', kitText('No dashboard manifest found.')));
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
      var section = dataAt(manifest.sections, s);
      var secNode = el('section', 'pcc-section');
      if (section.heading) secNode.appendChild(agentEl('h2', 'pcc-section-heading pcc-heading', agentText(section.heading, true)));
      var wins = section.windows || [];
      for (var wi = 0; wi < wins.length; wi++) {
        secNode.appendChild(renderWindow(ctx, dataAt(wins, wi)));
      }
      wrap.appendChild(secNode);
    }

    // Foot attribution.
    var foot = el('div', 'pcc-kit-foot pcc-muted');
    foot.appendChild(el('span', null, joinText(kitText('PCC · '), modeText(ctx.mode), ctx.apiBase ? joinText(kitText(' · '), apiBaseText(ctx.apiBase)) : kitText(' · same-origin'))));
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
      '.pcc-pill.st-refunded{background:var(--wait-dim);color:var(--wait);}',
      '.pcc-pill.st-unknown{background:var(--surface-3);color:var(--ink-3);}',
      /* neutral acknowledgement: an HTTP 2xx is never settlement (ruling 2) -- no hue */
      '.pcc-pill.st-ack{background:var(--surface-3);color:var(--ink-2);}',
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
      '.pcc-action-status.st-ack{color:var(--ink-2);}',
      '.pcc-action-status.st-failed{color:var(--deny);}',
      /* kit-owned labels (ruling 4): the tag after a manifest label, and quoted untrusted text */
      '.pcc-btn-tag{font-weight:400;opacity:.72;}',
      '.pcc-untrusted-label{margin:0;font:400 13px/18px var(--font);color:var(--ink-3);}',
      '.pcc-untrusted-v{color:var(--ink-2);}',
      '.pcc-agent{border-left:2px dashed currentColor;padding-left:6px}',
      '.pcc-text.pcc-agent::before,.pcc-heading.pcc-agent::before{content:"agent-authored";display:block;font-size:10px;letter-spacing:.06em;text-transform:uppercase;opacity:.6}',
      '.pcc-withheld{font-style:italic}',
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
      '.pcc-realreq-amt{font:650 16px/22px var(--font);color:var(--ink);}',
      /* the bound record is attributed context under the request (review charlie F1) */
      '.pcc-approval-record{display:flex;flex-direction:column;gap:6px;border-top:1px dashed var(--hairline-strong);padding-top:8px;}',
      '.pcc-approval-record .pcc-approval-what{font:450 13px/19px var(--font);color:var(--ink-2);}',
      '.pcc-approval-record .pcc-approval-cost{font:450 13px/19px var(--font);color:var(--ink-2);}',
      '.pcc-mismatch{margin:0;}',
      '.pcc-args-kit .pcc-args-v{font-style:italic;}',
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
    setText(style, mintText(css)); // CSS text on a <style> node — not HTML injection
    document.head.appendChild(style);
  }

  // ES2015 runtime APIs: WeakSet, Set, Number.isFinite, WeakMap, Math.imul, Promise and Object.assign.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
