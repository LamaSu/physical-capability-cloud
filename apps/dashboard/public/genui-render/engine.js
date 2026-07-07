/* @harness/genui-render — capability render engine
 *
 * renderCapability(cap, {lens, mode}) → HTMLElement
 *
 * The UI is a FUNCTION OF THE SCHEMA (UNIFIED-CONTROL-PLANE.md Part 6): a
 * UnifiedCapability record — the GenUI core eight fields plus the four
 * optional bundles (economic / assurance / receipt / definition) — is
 * projected into a working view the moment it is registered. No hand-drawn
 * page. Generation rules:
 *
 *   params (JSON Schema)      → an input form (string/number/boolean/enum/
 *                               object/array fields, required + defaults)
 *   ui.hint                   → card | table | chart | form | raw result view
 *   economic.price            → price tag            (absent for local caps)
 *   trustLevel + assurance    → authority badge + assurance-tier badges
 *   economic.provider         → provider chip (+DID +reputation by lens)
 *   receipt / evidence        → receipt panel
 *
 * lens ∈ {user, operator, orchestrator} — three projections of ONE record
 * (SYNTHESIS §4.3): user foregrounds price + order button; operator
 * foregrounds queue/margin/obligation/bond; orchestrator foregrounds
 * node/DID/composability/invoke-contract. The record never changes.
 *
 * mode ∈ {invoke, summary, result} — invoke = detail + form (default);
 * summary = compact catalog tile; result = render opts.result via ui.hint.
 *
 * Custom renderers registered in registry.js OVERRIDE the generated default
 * (resolution: cap:id > cap:kind > cap:source; a renderer returning null
 * declines and falls through). See registry.js for the extension contract.
 *
 * Invoking: the engine performs NO network I/O. Submitting the generated
 * form calls opts.onInvoke(cap, args, detail) if given AND dispatches a
 * bubbling CustomEvent 'genui:invoke' {detail:{capId, cap, args, lens}} —
 * the shell owns the POST (e.g. to /api/agui/run).
 *
 * Security: every dynamic string lands via textContent/createElement — no
 * innerHTML, ever (matches lib/agui-view.html + lib/genui/ui-bundles/*).
 * Module format: zero-build universal (see registry.js header).
 */
(function (root, factory) {
  'use strict';
  var isNodeModule = (typeof module === 'object' && module !== null && module.exports);
  var api = factory(root, isNodeModule ? function (n) { return require(n); } : null);
  var g = (root.GenUIRender = root.GenUIRender || {});
  g.engine = api;
  if (isNodeModule) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, nodeRequire) {
  'use strict';

  var LENSES = ['user', 'operator', 'orchestrator'];
  var TIER_NAMES = ['Self-Attested', 'Verified', 'Certified', 'Sovereign'];
  var VERDICT_PHASES = ['pre-auth', 'verified', 'settled'];

  function getRegistry() {
    if (nodeRequire) { try { return nodeRequire('./registry.js'); } catch (e) { /* optional */ } }
    var g = root.GenUIRender;
    return (g && g.registry) ? g.registry : null;
  }
  function doc() { return root.document; }

  // ── tiny DOM helpers (textContent-only) ────────────────────────────────────
  function el(tag, cls, txt) {
    var e = doc().createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined && txt !== null) e.textContent = String(txt);
    return e;
  }
  function chip(txt, cls) { return el('span', 'gur-chip' + (cls ? ' ' + cls : ''), txt); }
  function row(cls) { return el('div', 'gur-row' + (cls ? ' ' + cls : '')); }
  function clearChildren(e) { while (e.firstChild) e.removeChild(e.firstChild); }
  function stringify(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'object') { try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); } }
    return String(v);
  }
  function shortHash(h) {
    var s = String(h);
    return s.length > 14 ? s.slice(0, 8) + '…' + s.slice(-4) : s;
  }
  function kvGrid(obj, opts) {
    opts = opts || {};
    var grid = el('div', 'gur-kv');
    var keys = Object.keys(obj || {});
    if (opts.promote && opts.promote.length) {
      var promoted = opts.promote.filter(function (k) { return keys.indexOf(k) !== -1; });
      keys = promoted.concat(keys.filter(function (k) { return promoted.indexOf(k) === -1; }));
    }
    keys.forEach(function (k) {
      var v = obj[k];
      grid.appendChild(el('div', 'gur-k', k));
      var vEl = el('div', 'gur-v' + (v === null || v === undefined ? ' gur-muted' : ''), stringify(v));
      grid.appendChild(vEl);
    });
    if (!keys.length) grid.appendChild(el('div', 'gur-empty', 'empty'));
    return grid;
  }

  // ── styles (injected once per document; mobile-first, host-themeable) ─────
  var STYLE_ID = 'gur-styles';
  var CSS = [
    '.gur-scope{--gur-bg:#0f1117;--gur-panel:#171923;--gur-panel2:#1e2130;--gur-edge:#2a2e3f;',
    ' --gur-ink:#e6e8ef;--gur-muted:#9aa0b4;--gur-accent:#8b5cf6;--gur-amber:#f1be64;',
    ' --gur-green:#22c55e;--gur-red:#ef4444;--gur-blue:#60a5fa;',
    ' --gur-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;',
    ' color:var(--gur-ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}',
    '@media (prefers-color-scheme: light){.gur-scope:not(.gur-dark){--gur-bg:#f6f7f9;--gur-panel:#ffffff;',
    ' --gur-panel2:#eef0f4;--gur-edge:#d4d8e2;--gur-ink:#1a1d27;--gur-muted:#5b6172;}}',
    '.gur-cap,.gur-ev,.gur-strip-block{background:var(--gur-panel);border:1px solid var(--gur-edge);',
    ' border-radius:12px;padding:14px;margin:8px 0;max-width:100%;box-sizing:border-box;}',
    '.gur-cap{display:flex;flex-direction:column;gap:10px;}',
    '.gur-cap *,.gur-ev *{box-sizing:border-box;}',
    '.gur-name{margin:0;font-size:15px;font-weight:650;letter-spacing:.2px;}',
    '.gur-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0;}',
    '.gur-chip{font-size:11px;padding:2px 9px;border-radius:20px;border:1px solid var(--gur-edge);',
    ' color:var(--gur-muted);font-family:var(--gur-mono);white-space:nowrap;max-width:100%;',
    ' overflow:hidden;text-overflow:ellipsis;}',
    '.gur-trust-read{color:var(--gur-green);border-color:#1e7a44;}',
    '.gur-trust-write{color:var(--gur-amber);border-color:#7a5e22;}',
    '.gur-trust-exec{color:#fb923c;border-color:#7a4a22;}',
    '.gur-trust-network{color:var(--gur-blue);border-color:#2b5488;}',
    '.gur-trust-credential{color:var(--gur-red);border-color:#7a2222;}',
    '.gur-chip-tier{color:var(--gur-blue);border-color:#2b5488;}',
    '.gur-chip-mock{color:var(--gur-amber);border-color:#7a5e22;font-weight:700;}',
    '.gur-chip-effects{color:var(--gur-amber);border-color:#7a5e22;}',
    '.gur-chip-provider{color:var(--gur-ink);}',
    '.gur-chip-phase-pre-auth{color:var(--gur-amber);border-color:#7a5e22;}',
    '.gur-chip-phase-verified{color:var(--gur-blue);border-color:#2b5488;}',
    '.gur-chip-phase-settled{color:var(--gur-green);border-color:#1e7a44;}',
    '.gur-price{font-size:20px;font-weight:700;font-family:var(--gur-mono);}',
    '.gur-price-unit,.gur-price-extra{font-size:12px;color:var(--gur-muted);font-weight:400;}',
    '.gur-desc{color:var(--gur-muted);font-size:13px;margin:0;}',
    '.gur-kv{display:grid;grid-template-columns:minmax(80px,auto) 1fr;gap:4px 12px;font-size:12.5px;}',
    '.gur-k{color:var(--gur-muted);font-weight:600;text-transform:uppercase;font-size:10.5px;',
    ' letter-spacing:.5px;padding-top:2px;}',
    '.gur-v{font-family:var(--gur-mono);word-break:break-word;white-space:pre-wrap;min-width:0;}',
    '.gur-muted{color:var(--gur-muted);}',
    '.gur-panel-h{font-size:10.5px;text-transform:uppercase;letter-spacing:.7px;color:var(--gur-muted);',
    ' margin:2px 0 4px;font-weight:700;}',
    '.gur-panel{background:var(--gur-panel2);border:1px solid var(--gur-edge);border-radius:8px;padding:10px 12px;}',
    '.gur-panel-warn{border-color:#7a5e22;}',
    '.gur-form{display:flex;flex-direction:column;gap:8px;margin:0;}',
    '.gur-field{display:flex;flex-direction:column;gap:3px;}',
    '.gur-label{font-size:12px;color:var(--gur-muted);font-weight:600;}',
    '.gur-req{color:var(--gur-red);}',
    '.gur-form input[type=text],.gur-form input[type=number],.gur-form select,.gur-form textarea{',
    ' width:100%;background:var(--gur-panel2);border:1px solid var(--gur-edge);color:var(--gur-ink);',
    ' border-radius:8px;padding:9px 10px;font-family:var(--gur-mono);font-size:16px;}',
    '@media (min-width:720px){.gur-form input[type=text],.gur-form input[type=number],',
    ' .gur-form select,.gur-form textarea{font-size:13px;}}',
    '.gur-form textarea{resize:vertical;min-height:44px;}',
    '.gur-check{display:flex;gap:8px;align-items:center;font-size:13px;}',
    '.gur-btn{background:var(--gur-accent);color:#fff;border:none;border-radius:8px;padding:10px 16px;',
    ' font-weight:650;cursor:pointer;font-size:14px;min-height:40px;}',
    '.gur-btn:hover{filter:brightness(1.1);}.gur-btn:disabled{opacity:.5;cursor:default;}',
    '.gur-btn-deny{background:var(--gur-red);}',
    '.gur-btn-ghost{background:transparent;border:1px solid var(--gur-edge);color:var(--gur-ink);}',
    '.gur-err{color:var(--gur-red);font-size:12px;}',
    '.gur-invalid{border-color:var(--gur-red) !important;}',
    '.gur-table-wrap{overflow-x:auto;max-width:100%;}',
    '.gur-table{width:100%;border-collapse:collapse;font-family:var(--gur-mono);font-size:11.5px;}',
    '.gur-table th{text-align:left;padding:6px 10px;background:var(--gur-panel2);color:var(--gur-muted);',
    ' border-bottom:1px solid var(--gur-edge);text-transform:uppercase;font-size:10px;letter-spacing:.5px;}',
    '.gur-table td{padding:6px 10px;border-bottom:1px solid var(--gur-edge);vertical-align:top;',
    ' word-break:break-word;max-width:360px;}',
    '.gur-pre{background:var(--gur-bg);border:1px solid var(--gur-edge);border-radius:6px;',
    ' padding:8px 10px;font-family:var(--gur-mono);font-size:12px;white-space:pre-wrap;',
    ' word-break:break-word;overflow:auto;max-height:320px;margin:0;}',
    '.gur-bars{display:flex;flex-direction:column;gap:5px;}',
    '.gur-bar-row{display:grid;grid-template-columns:minmax(70px,auto) 1fr auto;gap:8px;',
    ' align-items:center;font-size:12px;}',
    '.gur-bar-track{background:var(--gur-panel2);border-radius:6px;height:10px;overflow:hidden;}',
    '.gur-bar-fill{display:block;height:100%;background:linear-gradient(90deg,var(--gur-accent),var(--gur-amber));}',
    '.gur-summary{display:flex;flex-direction:column;gap:6px;cursor:default;}',
    // event cards (used by events.js — one shared stylesheet)
    '.gur-ev{padding:10px 12px;margin:6px 0;}',
    '.gur-ev-lbl{font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;color:var(--gur-muted);',
    ' font-weight:700;display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
    '.gur-ev-interrupt{border-color:var(--gur-amber);}',
    '.gur-ev-error{border-color:var(--gur-red);}',
    '.gur-ev-success{border-color:#1e7a44;}',
    '.gur-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;}',
    '.gur-feedline{font-family:var(--gur-mono);font-size:12px;color:var(--gur-muted);padding:2px 0;}',
    // escrow / settle progress strip
    '.gur-strip{display:flex;align-items:flex-start;gap:0;overflow-x:auto;padding:6px 0 2px;}',
    '.gur-stage{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:64px;flex:1;}',
    '.gur-stage-dot{width:14px;height:14px;border-radius:50%;background:var(--gur-panel2);',
    ' border:2px solid var(--gur-edge);}',
    '.gur-stage-lbl{font-size:10px;color:var(--gur-muted);text-transform:uppercase;letter-spacing:.4px;',
    ' text-align:center;white-space:nowrap;}',
    '.gur-stage-link{height:2px;background:var(--gur-edge);flex:1;margin-top:6px;min-width:12px;}',
    '.gur-stage.gur-done .gur-stage-dot{background:var(--gur-green);border-color:var(--gur-green);}',
    '.gur-stage.gur-active .gur-stage-dot{background:var(--gur-amber);border-color:var(--gur-amber);',
    ' box-shadow:0 0 8px var(--gur-amber);}',
    '.gur-stage.gur-failed .gur-stage-dot{background:var(--gur-red);border-color:var(--gur-red);}',
    '.gur-stage.gur-done .gur-stage-lbl,.gur-stage.gur-active .gur-stage-lbl{color:var(--gur-ink);}',
    '.gur-strip-detail{font-family:var(--gur-mono);font-size:11.5px;color:var(--gur-muted);margin-top:6px;',
    ' word-break:break-all;}',
  ].join('\n');

  function ensureStyles(targetDoc) {
    var d = targetDoc || doc();
    if (!d || !d.createElement) return;
    if (d.getElementById && d.getElementById(STYLE_ID)) return;
    var s = d.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    (d.head || d.documentElement || d.body).appendChild(s);
  }

  // ── bundle panels (the standard generated pieces) ─────────────────────────

  function detectMock(cap) {
    if (cap.mock === true || cap.live === false) return true;
    var avail = cap.economic && cap.economic.availability;
    return typeof avail === 'string' && /mock|stub|sandbox/i.test(avail);
  }
  function isJobShaped(cap) {
    var kind = (cap.definition && cap.definition.kind) || cap.kind;
    return kind === 'job' || cap.source === 'pcc' || cap.source === 'a2a';
  }

  function panelHeader(cap, o) {
    var wrap = el('div');
    var name = el('h3', 'gur-name', cap.name || cap.id);
    wrap.appendChild(name);
    var chips = row();
    var owner = cap.sourceDetail && cap.sourceDetail.owner;
    chips.appendChild(chip(cap.source + (owner ? ':' + owner : ''), 'gur-chip-source'));
    var kind = (cap.definition && cap.definition.kind) || cap.kind;
    if (kind) chips.appendChild(chip('kind:' + kind));
    if (cap.definition && cap.definition.version) chips.appendChild(chip('v' + cap.definition.version));
    var prov = cap.economic && cap.economic.provider;
    if (prov && prov.id) chips.appendChild(chip(prov.id, 'gur-chip-provider'));
    if (prov && typeof prov.reputation === 'number') chips.appendChild(chip('rep ' + prov.reputation));
    if (detectMock(cap)) chips.appendChild(chip('MOCK', 'gur-chip-mock'));
    wrap.appendChild(chips);
    return wrap;
  }

  function panelTrust(cap, o) {
    var r = row('gur-trust-row');
    if (cap.trustLevel) r.appendChild(chip(cap.trustLevel, 'gur-trust-' + cap.trustLevel));
    if (cap.sideEffects) r.appendChild(chip('side-effects', 'gur-chip-effects'));
    var tiers = cap.assurance && cap.assurance.offeredTiers;
    if (Array.isArray(tiers)) {
      tiers.forEach(function (t) {
        var nm = TIER_NAMES[t] || ('tier ' + t);
        r.appendChild(chip('Tier ' + t + ' · ' + nm, 'gur-chip-tier'));
      });
    }
    return (r.childNodes && r.childNodes.length) ? r : null;
  }

  function formatPriceExtras(price) {
    var extras = [];
    if (price.minimum !== undefined) extras.push('min ' + price.minimum);
    if (price.model && price.model !== 'flat') extras.push(price.model);
    var impacts = price.impacts;
    if (Array.isArray(impacts)) {
      impacts.forEach(function (im) {
        if (im === null || im === undefined) return;
        if (typeof im === 'string') { extras.push(im); return; }
        var label = im.label || im.name || im.key || im.factor || 'impact';
        var amt = (im.amount !== undefined ? im.amount : im.base);
        var per = im.per || im.unit;
        extras.push('+' + (amt !== undefined ? amt : '?') + (per ? ' / ' + per : '') + ' ' + label);
      });
    } else if (impacts && typeof impacts === 'object') {
      Object.keys(impacts).forEach(function (k) { extras.push('+' + stringify(impacts[k]) + ' / ' + k); });
    }
    return extras;
  }

  function panelPrice(cap, o) {
    var price = cap.economic && cap.economic.price;
    if (!price) return null; // local cap: no economic chrome at all (zero-regression)
    var wrap = el('div', 'gur-price-wrap');
    var main = el('div', 'gur-price');
    var cur = price.currency || '';
    main.textContent = (cur ? cur + ' ' : '') + (price.base !== undefined ? price.base : '—');
    if (price.unit) main.appendChild(el('span', 'gur-price-unit', ' / ' + price.unit));
    wrap.appendChild(main);
    formatPriceExtras(price).forEach(function (x) {
      wrap.appendChild(el('div', 'gur-price-extra', x));
    });
    return wrap;
  }

  function panelProvider(cap, o) {
    var eco = cap.economic;
    if (!eco || !eco.provider) return null;
    var full = o.lens === 'orchestrator';
    var obj = {};
    obj.provider = eco.provider.id;
    if (full && eco.provider.did) obj.did = eco.provider.did;
    if (eco.provider.reputation !== undefined) obj.reputation = eco.provider.reputation;
    if (eco.location) obj.location = eco.location;
    if (eco.availability) obj.availability = eco.availability;
    var p = el('div', 'gur-panel');
    p.appendChild(el('div', 'gur-panel-h', 'provider'));
    p.appendChild(kvGrid(obj));
    return p;
  }

  function panelObligation(cap, o) {
    var a = cap.assurance;
    if (!a) return null;
    var obj = {};
    if (a.evidence !== undefined) obj['evidence required'] = a.evidence;
    if (a.settlement) {
      if (a.settlement.rail) obj.rail = a.settlement.rail;
      if (a.settlement.bond !== undefined) obj['bond at risk'] = a.settlement.bond;
      if (a.settlement.challengeWindowS !== undefined) obj['challenge window'] = a.settlement.challengeWindowS + 's';
    }
    if (!Object.keys(obj).length) return null;
    var p = el('div', 'gur-panel' + (o.lens === 'operator' ? ' gur-panel-warn' : ''));
    p.appendChild(el('div', 'gur-panel-h', o.lens === 'operator' ? 'your obligations' : 'assurance'));
    p.appendChild(kvGrid(obj));
    return p;
  }

  function panelOperational(cap, o) {
    var op = cap.operational; // adapter-supplied operator-side data; render only if present
    if (!op || typeof op !== 'object') return null;
    var p = el('div', 'gur-panel');
    p.appendChild(el('div', 'gur-panel-h', 'queue & margin'));
    p.appendChild(kvGrid(op));
    return p;
  }

  function panelContract(cap, o) {
    var p = el('div', 'gur-panel');
    p.appendChild(el('div', 'gur-panel-h', 'invoke contract'));
    var obj = {
      returns: isJobShaped(cap) ? 'job handle + watch (SSE)' : 'sync value',
      trust: cap.trustLevel + (cap.sideEffects ? ' · side-effects' : ''),
    };
    if (cap.definition) {
      if (cap.definition.baseDefinition) obj.base = cap.definition.baseDefinition;
      if (cap.definition.url) obj.definition = cap.definition.url;
    }
    if (cap.ui && cap.ui.hint) obj['result view'] = cap.ui.hint;
    p.appendChild(kvGrid(obj));
    return p;
  }

  /** Receipt / evidence panel — also used by events.js for RUN_FINISHED receipts. */
  function renderReceipt(receipt) {
    var p = el('div', 'gur-panel gur-receipt');
    p.appendChild(el('div', 'gur-panel-h', 'receipt / evidence'));
    if (!receipt || typeof receipt !== 'object' || !Object.keys(receipt).length) {
      p.appendChild(el('div', 'gur-muted', 'no receipt (local, unattested)'));
      return p;
    }
    var obj = {};
    if (receipt.receiptCID) obj.receiptCID = shortHash(receipt.receiptCID);
    if (receipt.dccClass !== undefined) obj.dccClass = receipt.dccClass;
    if (receipt.evidenceBundleHash) obj['evidence bundle'] = shortHash(receipt.evidenceBundleHash);
    if (receipt.paymentTxHash) obj['payment tx'] = shortHash(receipt.paymentTxHash);
    if (receipt.pccFeeBps !== undefined) obj['pcc fee'] = (receipt.pccFeeBps / 100) + '%';
    Object.keys(receipt).forEach(function (k) {
      if (!(k in obj) && ['receiptCID', 'evidenceBundleHash', 'paymentTxHash', 'pccFeeBps', 'dccClass'].indexOf(k) === -1) {
        obj[k] = receipt[k];
      }
    });
    p.appendChild(kvGrid(obj));
    return p;
  }

  /** One Verdict (3-phase trust-gate outcome) as a chip row. */
  function renderVerdict(verdict) {
    var r = row('gur-verdict');
    if (!verdict) return r;
    var phase = verdict.phase || 'pre-auth';
    r.appendChild(chip((verdict.ok === false ? '✗ ' : '✓ ') + phase, 'gur-chip-phase-' + phase));
    if (verdict.approvedBy) r.appendChild(chip('by ' + verdict.approvedBy));
    if (verdict.authorityClass) r.appendChild(chip(verdict.authorityClass));
    if (verdict.assuranceTierMet !== undefined) {
      r.appendChild(chip('tier met: ' + verdict.assuranceTierMet, 'gur-chip-tier'));
    }
    if (verdict.settlement && verdict.settlement.status) {
      r.appendChild(chip('settlement ' + verdict.settlement.status +
        (verdict.settlement.txHash ? ' ' + shortHash(verdict.settlement.txHash) : '')));
    }
    if (verdict.receiptCID) r.appendChild(chip('receipt ' + shortHash(verdict.receiptCID)));
    return r;
  }

  // ── params (JSON Schema) → form ────────────────────────────────────────────

  function buildField(name, prop, required) {
    prop = prop || {};
    var field = el('div', 'gur-field');
    var label = el('label', 'gur-label', name);
    if (required) label.appendChild(el('span', 'gur-req', ' *'));
    if (prop.description) label.appendChild(el('span', 'gur-muted', ' — ' + prop.description));
    var control, getValue;
    var errEl = el('div', 'gur-err', '');

    if (Array.isArray(prop.enum) && prop.enum.length) {
      control = el('select');
      if (!required) control.appendChild(el('option', null, ''));
      prop.enum.forEach(function (v) {
        var opt = el('option', null, String(v));
        opt.value = String(v);
        control.appendChild(opt);
      });
      if (prop.default !== undefined) control.value = String(prop.default);
      getValue = function () {
        var raw = control.value;
        if (raw === '' && !required) return undefined;
        if (prop.type === 'number' || prop.type === 'integer') return Number(raw);
        if (prop.type === 'boolean') return raw === 'true';
        return raw;
      };
    } else if (prop.type === 'boolean') {
      field.className += ' gur-check-field';
      var wrap = el('div', 'gur-check');
      control = el('input');
      control.type = 'checkbox';
      if (prop.default === true) control.checked = true;
      wrap.appendChild(control);
      wrap.appendChild(label);
      field.appendChild(wrap);
      field.appendChild(errEl);
      getValue = function () { return !!control.checked; };
      return { el: field, name: name, get: getValue, control: control, err: errEl, required: required, jsonField: false };
    } else if (prop.type === 'number' || prop.type === 'integer') {
      control = el('input');
      control.type = 'number';
      if (prop.type === 'number') control.step = 'any';
      if (prop.default !== undefined) control.value = String(prop.default);
      getValue = function () {
        var raw = String(control.value == null ? '' : control.value).trim();
        if (raw === '') return undefined;
        var n = Number(raw);
        return isNaN(n) ? undefined : (prop.type === 'integer' ? Math.trunc(n) : n);
      };
    } else if (prop.type === 'object' || prop.type === 'array') {
      control = el('textarea');
      control.placeholder = prop.type === 'array' ? '[ ]  (JSON)' : '{ }  (JSON)';
      if (prop.default !== undefined) control.value = JSON.stringify(prop.default, null, 2);
      getValue = function () {
        var raw = String(control.value == null ? '' : control.value).trim();
        if (raw === '') return undefined;
        try { return JSON.parse(raw); }
        catch (e) { return { __gurParseError: String(e.message || e) }; }
      };
      var f = finishField();
      f.jsonField = true;
      return f;
    } else { // string / unknown
      control = el('input');
      control.type = 'text';
      if (prop.default !== undefined) control.value = String(prop.default);
      getValue = function () {
        var raw = String(control.value == null ? '' : control.value);
        return raw === '' ? undefined : raw;
      };
    }
    return finishField();

    function finishField() {
      field.appendChild(label);
      field.appendChild(control);
      field.appendChild(errEl);
      return { el: field, name: name, get: getValue, control: control, err: errEl, required: required, jsonField: false };
    }
  }

  /**
   * Generate the input form for a capability's params JSON Schema.
   * Exposed on the api (and to custom renderers) so rich views can reuse it.
   * opts.onInvoke(cap, args, detail) + a bubbling 'genui:invoke' CustomEvent.
   */
  function renderParamsForm(cap, opts) {
    opts = opts || {};
    var lens = opts.lens || 'orchestrator';
    var schema = cap.params || { type: 'object', properties: {} };
    var props = schema.properties || {};
    var required = schema.required || [];
    var form = el('form', 'gur-form');
    var fields = [];
    Object.keys(props).forEach(function (name) {
      var f = buildField(name, props[name], required.indexOf(name) !== -1);
      fields.push(f);
      form.appendChild(f.el);
    });
    if (!fields.length) form.appendChild(el('div', 'gur-muted', 'no parameters'));

    var label = opts.buttonLabel ||
      (lens === 'user' ? (cap.economic ? 'Order' : 'Run')
        : lens === 'operator' ? 'Test invoke'
          : 'Invoke');
    var btn = el('button', 'gur-btn', label);
    btn.type = 'submit';
    var formErr = el('div', 'gur-err', '');
    form.appendChild(btn);
    form.appendChild(formErr);

    function collect() {
      var args = {};
      var ok = true;
      fields.forEach(function (f) {
        f.err.textContent = '';
        if (f.control.classList) f.control.classList.remove('gur-invalid');
        var v = f.get();
        if (v && typeof v === 'object' && v.__gurParseError) {
          f.err.textContent = 'invalid JSON: ' + v.__gurParseError;
          if (f.control.classList) f.control.classList.add('gur-invalid');
          ok = false;
          return;
        }
        if (v === undefined) {
          if (f.required) {
            f.err.textContent = 'required';
            if (f.control.classList) f.control.classList.add('gur-invalid');
            ok = false;
          }
          return;
        }
        args[f.name] = v;
      });
      return ok ? args : null;
    }

    function onSubmit(e) {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      formErr.textContent = '';
      var args = collect();
      if (args === null) { formErr.textContent = 'fix the highlighted fields'; return; }
      var detail = { capId: cap.id, cap: cap, args: args, lens: lens };
      try { if (typeof opts.onInvoke === 'function') opts.onInvoke(cap, args, detail); }
      catch (err) { formErr.textContent = 'invoke handler error: ' + String(err && err.message || err); }
      if (typeof root.CustomEvent === 'function' && typeof form.dispatchEvent === 'function') {
        form.dispatchEvent(new root.CustomEvent('genui:invoke', { detail: detail, bubbles: true, composed: true }));
      }
    }
    form.addEventListener('submit', onSubmit);
    // direct click support for shims/webviews where type=submit wiring is absent
    btn.addEventListener('click', function (e) { onSubmit(e); });
    form._gurCollect = collect; // exposed for tests
    return form;
  }

  // ── result rendering (ui.hint → card/table/chart/form/raw) ────────────────

  function normalizeRows(d) {
    if (d === null || d === undefined) return [];
    if (Array.isArray(d)) return d;
    if (typeof d === 'object') {
      var keys = ['rows', 'items', 'results', 'events', 'parsed'];
      for (var i = 0; i < keys.length; i++) {
        if (Array.isArray(d[keys[i]])) return d[keys[i]];
      }
      if (d.parsed && Array.isArray(d.parsed.rows)) return d.parsed.rows;
    }
    return [d];
  }

  function renderTable(data) {
    var rows = normalizeRows(data);
    var wrap = el('div', 'gur-table-wrap');
    if (!rows.length) { wrap.appendChild(el('div', 'gur-empty gur-muted', 'no rows')); return wrap; }
    var cols = [];
    rows.forEach(function (r) {
      if (r && typeof r === 'object') {
        Object.keys(r).forEach(function (k) { if (cols.indexOf(k) === -1) cols.push(k); });
      }
    });
    cols = cols.slice(0, 12);
    if (!cols.length) {
      var pre = el('pre', 'gur-pre', stringify(rows));
      wrap.appendChild(pre);
      return wrap;
    }
    var tbl = el('table', 'gur-table');
    var thead = el('thead');
    var trh = el('tr');
    cols.forEach(function (c) { trh.appendChild(el('th', null, c)); });
    thead.appendChild(trh);
    tbl.appendChild(thead);
    var tbody = el('tbody');
    rows.slice(0, 200).forEach(function (r) {
      var tr = el('tr');
      cols.forEach(function (c) {
        var v = (r && typeof r === 'object') ? r[c] : undefined;
        tr.appendChild(el('td', null, v === undefined || v === null ? '—'
          : (typeof v === 'object' ? JSON.stringify(v) : String(v))));
      });
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    return wrap;
  }

  function renderChart(data) {
    // textContent-only bar chart: object of numbers, or array of {label,value}
    var items = [];
    if (Array.isArray(data)) {
      data.forEach(function (d, i) {
        if (d && typeof d === 'object') {
          items.push({ label: String(d.label !== undefined ? d.label : (d.name !== undefined ? d.name : i)),
            value: Number(d.value !== undefined ? d.value : d.count) });
        } else if (typeof d === 'number') items.push({ label: String(i), value: d });
      });
    } else if (data && typeof data === 'object') {
      Object.keys(data).forEach(function (k) {
        if (typeof data[k] === 'number') items.push({ label: k, value: data[k] });
      });
    }
    items = items.filter(function (it) { return !isNaN(it.value); }).slice(0, 40);
    if (!items.length) return renderRaw(data);
    var max = items.reduce(function (m, it) { return Math.max(m, it.value); }, 0) || 1;
    var wrap = el('div', 'gur-bars');
    items.forEach(function (it) {
      var r = el('div', 'gur-bar-row');
      r.appendChild(el('div', 'gur-muted', it.label));
      var track = el('div', 'gur-bar-track');
      var fill = el('span', 'gur-bar-fill');
      fill.style.width = Math.max(1, Math.round((it.value / max) * 100)) + '%';
      track.appendChild(fill);
      r.appendChild(track);
      r.appendChild(el('div', null, String(it.value)));
      wrap.appendChild(r);
    });
    return wrap;
  }

  function renderRaw(data) {
    return el('pre', 'gur-pre', typeof data === 'string' ? data : stringify(data));
  }

  function renderCardResult(data, summaryKeys) {
    if (data === null || data === undefined) return el('div', 'gur-empty gur-muted', 'no data');
    if (typeof data !== 'object') return el('pre', 'gur-pre', String(data));
    if (Array.isArray(data)) return renderTable(data);
    return kvGrid(data, { promote: summaryKeys || [] });
  }

  /** Render an invoke RESULT payload per the capability's ui.hint. */
  function renderResult(cap, data) {
    ensureStyles();
    var hint = (cap && cap.ui && cap.ui.hint) || 'card';
    var summaryKeys = (cap && cap.ui && cap.ui.summaryKeys) || [];
    var body;
    if (hint === 'table') body = renderTable(data);
    else if (hint === 'chart') body = renderChart(data);
    else if (hint === 'raw') body = renderRaw(data);
    else body = renderCardResult(data, summaryKeys); // card + form → kv grid
    var wrap = el('div', 'gur-result gur-scope');
    wrap.appendChild(body);
    return wrap;
  }

  // ── lens projection: the SAME record, three renderings ────────────────────

  function composeDefault(cap, o) {
    var art = el('article', 'gur-cap gur-scope gur-lens-' + o.lens + ' gur-mode-' + o.mode);
    if (art.setAttribute) {
      art.setAttribute('data-cap-id', cap.id || '');
      art.setAttribute('data-lens', o.lens);
      art.setAttribute('data-renderer', 'generated');
    }
    function add(node) { if (node) art.appendChild(node); }

    add(panelHeader(cap, o));

    if (o.mode === 'summary') {
      art.className += ' gur-summary';
      add(panelTrust(cap, o));
      var priceChipRow = cap.economic && cap.economic.price ? row() : null;
      if (priceChipRow) {
        var pr = cap.economic.price;
        priceChipRow.appendChild(chip((pr.currency ? pr.currency + ' ' : '') + pr.base +
          (pr.unit ? ' / ' + pr.unit : ''), 'gur-chip-provider'));
        add(priceChipRow);
      }
      if (cap.description) add(el('p', 'gur-desc', cap.description));
      return art;
    }

    if (o.mode === 'result') {
      add(renderResult(cap, o.result !== undefined ? o.result : o.data));
      if (cap.receipt) add(renderReceipt(cap.receipt));
      return art;
    }

    // mode: invoke — full detail + form, ordered per lens
    if (o.lens === 'user') {
      add(panelPrice(cap, o));                        // price foregrounded
      add(panelTrust(cap, o));                        // tier badge = proof level
      if (cap.description) add(el('p', 'gur-desc', cap.description));
      var eta = cap.economic && cap.economic.availability;
      if (eta && !detectMock(cap)) {
        var etaRow = row();
        etaRow.appendChild(chip('ETA ' + eta));
        add(etaRow);
      }
      add(renderParamsForm(cap, o));                  // one primary button: Order/Run
      // escrow mechanics deliberately invisible on the user lens
    } else if (o.lens === 'operator') {
      add(panelPrice(cap, o));                        // their listing price
      add(panelObligation(cap, o));                   // evidence + bond emphasized
      add(panelOperational(cap, o));                  // queue/margin when supplied
      add(panelTrust(cap, o));
      if (cap.description) add(el('p', 'gur-desc gur-muted', cap.description));
      add(renderParamsForm(cap, o));
    } else {                                          // orchestrator (default)
      add(panelTrust(cap, o));
      add(panelContract(cap, o));                     // job-handle vs sync-value
      add(panelProvider(cap, o));                     // incl. DID
      add(panelPrice(cap, o));
      add(panelObligation(cap, o));
      if (cap.description) add(el('p', 'gur-desc', cap.description));
      add(renderParamsForm(cap, o));
    }
    if (cap.receipt) add(renderReceipt(cap.receipt)); // phase-5 record, all lenses
    return art;
  }

  /**
   * MAIN ENTRY — render one UnifiedCapability.
   * @param {object} cap  UnifiedCapability (core fields + optional bundles)
   * @param {{lens?:'user'|'operator'|'orchestrator', mode?:'invoke'|'summary'|'result',
   *          result?:*, onInvoke?:Function, buttonLabel?:string, skipCustom?:boolean}} [opts]
   * @returns {HTMLElement}
   */
  function renderCapability(cap, opts) {
    if (!cap || typeof cap !== 'object') {
      ensureStyles();
      return el('div', 'gur-scope gur-err', 'renderCapability: no capability record');
    }
    var o = Object.assign({ lens: 'orchestrator', mode: 'invoke' }, opts || {});
    if (LENSES.indexOf(o.lens) === -1) o.lens = 'orchestrator';
    ensureStyles(o.document);

    // custom renderers first (id > kind > source); null return = decline
    if (!o.skipCustom) {
      var reg = getRegistry();
      if (reg) {
        var entries = reg.resolveAll(cap);
        for (var i = 0; i < entries.length; i++) {
          var node = null;
          try { node = entries[i].fn(cap, o, api); }
          catch (e) { node = null; /* fail-open to next candidate */ }
          if (node) {
            if (node.setAttribute) {
              node.setAttribute('data-renderer', entries[i].key);
              node.setAttribute('data-cap-id', cap.id || '');
            }
            if (node.classList && node.classList.add) node.classList.add('gur-scope');
            return node;
          }
        }
      }
    }
    return composeDefault(cap, o);
  }

  var api = {
    renderCapability: renderCapability,
    renderResult: renderResult,
    renderParamsForm: renderParamsForm,
    renderReceipt: renderReceipt,
    renderVerdict: renderVerdict,
    ensureStyles: ensureStyles,
    panels: {
      header: panelHeader,
      trust: panelTrust,
      price: panelPrice,
      provider: panelProvider,
      obligation: panelObligation,
      operational: panelOperational,
      contract: panelContract,
      paramsForm: renderParamsForm,
      receipt: renderReceipt,
      verdict: renderVerdict,
    },
    helpers: { el: el, chip: chip, kvGrid: kvGrid, stringify: stringify, shortHash: shortHash,
      renderTable: renderTable, renderChart: renderChart, renderRaw: renderRaw,
      clearChildren: clearChildren, isJobShaped: isJobShaped, detectMock: detectMock },
    LENSES: LENSES,
    TIER_NAMES: TIER_NAMES,
    VERDICT_PHASES: VERDICT_PHASES,
  };
  return api;
});
