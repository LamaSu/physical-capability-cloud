/* @harness/control-plane — regions/publish.js  (B3 wave 2)
 *
 * Upgraded Publish region: "Turn an API or a machine into a listed
 * capability" — the onboarding/registration walkthrough (operator /
 * orchestrator lens).
 *
 * A step-by-step form (the walkthrough.js dots/steps idiom, inline in the
 * region body — no overlay):
 *
 *   1. Source    — API endpoint / local skill / machine kernel. A fourth
 *                  affordance, "Run your own agent here", is a DISABLED
 *                  "coming soon" stub: hosting an agent runtime on this
 *                  plane is deliberately deferred. This region publishes
 *                  CAPABILITIES only.
 *   2. Identity  — name, id (slug-suggested from name + source prefix),
 *                  description, provider, origin (provenance stays visible
 *                  on every catalog card — the federated-catalog rule).
 *   3. Authority — trustLevel pick with the derived authority rung shown
 *                  beside each class (browser mirror of
 *                  lib/genui/verdict.js AUTHORITY_CLASS: read→observe,
 *                  write→mutate, exec→actuate, network→reach-out,
 *                  credential→privileged).
 *   4. Inputs    — parameter rows composed into JSON-schema params (the
 *                  same schema catalog.js generates run forms from).
 *   5. Review    — the exact Capability JSON, then submit.
 *
 * Registration path (probed, never faked):
 *   - On build: GET {base}/api/capabilities (the GenUI registry read path)
 *     establishes reachability + existing ids; a best-effort OPTIONS probe
 *     checks whether POST is advertised (many plain-node servers 404
 *     OPTIONS — that leaves it "unknown", and submit still reports the
 *     real outcome).
 *   - Submit attempts POST {base}/api/capabilities and reports what
 *     ACTUALLY happened. 2xx → re-read the registry to confirm the id
 *     appears before calling it registered (bus 'registry:grew' then
 *     refreshes the catalog). 404/405/501 or network failure → the honest
 *     preview state: "Preview — registration backend not wired on this
 *     origin yet", with the composed JSON shown for copy/hand-off.
 *     A success is never faked.
 *
 * Registration: CP.regionBuilders.publish (the B3 shell hook). Loads after
 * shell.js, before boot. The draft survives rebuilds (module state).
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
  var STYLE_ID = 'cp-publish-styles';
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.pub-status{font-size:12.5px;color:var(--muted);margin:0 0 10px;}',
      '.pub-status.ok{color:var(--green);}',
      '.pub-wiz-body{padding:14px;}',
      '.pub-dots{display:flex;gap:6px;margin:0 0 10px;}',
      '.pub-dot{width:7px;height:7px;border-radius:50%;background:var(--edge);}',
      '.pub-dot.on{background:var(--accent);}',
      '.pub-step-t{margin:0 0 4px;font-size:15px;}',
      '.pub-step-b{margin:0 0 12px;color:var(--muted);font-size:12.5px;}',
      '.pub-src-grid{display:grid;gap:8px;}',
      '@media (min-width:640px){.pub-src-grid{grid-template-columns:repeat(2,1fr);}}',
      '.pub-src{display:grid;gap:3px;text-align:left;background:var(--panel2);',
      ' border:1px solid var(--edge);border-radius:10px;padding:12px;color:var(--ink);}',
      '.pub-src:hover{border-color:var(--accent);}',
      '.pub-src.active{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent);}',
      '.pub-src.stub{border-style:dashed;opacity:.55;cursor:default;}',
      '.pub-src.stub:hover{border-color:var(--edge);}',
      '.pub-src .t{font-weight:650;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.pub-src .d{color:var(--muted);font-size:12px;}',
      '.pub-soon{font-size:10.5px;font-family:var(--mono);padding:1px 7px;border-radius:16px;',
      ' border:1px dashed var(--edge);color:var(--muted);white-space:nowrap;}',
      '.pub-form{display:grid;gap:12px;}',
      '.pub-auth-grid{display:grid;gap:8px;}',
      '.pub-auth{display:flex;gap:10px;align-items:center;text-align:left;background:var(--panel2);',
      ' border:1px solid var(--edge);border-radius:10px;padding:10px 12px;color:var(--ink);flex-wrap:wrap;}',
      '.pub-auth.active{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent);}',
      '.pub-auth .a{font-family:var(--mono);font-size:12px;color:var(--teal);white-space:nowrap;}',
      '.pub-auth .h{color:var(--muted);font-size:12px;flex:1;min-width:160px;}',
      '.pub-inrow{display:grid;gap:6px;grid-template-columns:1fr;background:var(--panel2);',
      ' border:1px solid var(--edge);border-radius:10px;padding:10px;}',
      '@media (min-width:720px){.pub-inrow{grid-template-columns:140px 110px 1fr auto auto;align-items:center;}}',
      '.pub-inrow input[type=text],.pub-inrow select{background:var(--panel);border:1px solid var(--edge);',
      ' border-radius:8px;padding:7px 9px;font-size:13px;width:100%;}',
      '.pub-req{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted);white-space:nowrap;}',
      '.pub-nav{display:flex;gap:8px;margin-top:14px;justify-content:flex-end;flex-wrap:wrap;}',
      '.pub-err{color:var(--red);font-size:12.5px;margin:8px 0 0;min-height:1em;}',
      '.pub-json{background:var(--panel2);border:1px solid var(--edge);border-radius:8px;padding:10px 12px;',
      ' font-family:var(--mono);font-size:11.5px;overflow:auto;max-height:260px;white-space:pre;}',
      '.pub-ok{color:var(--green);font-size:13px;}',
      '.pub-warn{color:var(--amber);font-size:13px;}',
      '.pub-cli{margin-top:4px;}',
      '.pub-cli summary{color:var(--muted);font-size:12.5px;cursor:pointer;}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  }

  // ── the authority ladder (browser mirror of lib/genui/verdict.js §3a) ────
  var AUTHORITY_CLASS = {
    read: 'observe',
    write: 'mutate',
    exec: 'actuate',
    network: 'reach-out',
    credential: 'privileged'
  };
  var TRUST_CHOICES = [
    { id: 'read',       hint: 'Observe only — runs immediately.' },
    { id: 'write',      hint: 'Changes state — pauses for approval.' },
    { id: 'exec',       hint: 'Executes on a host or machine — pauses for approval.' },
    { id: 'network',    hint: 'Reaches out over the network — pauses for approval.' },
    { id: 'credential', hint: 'Touches credentials — always pauses for approval.' }
  ];

  var SOURCE_TYPES = [
    { key: 'api', source: 'api', idPrefix: 'api', label: 'API endpoint',
      desc: 'Wrap an HTTP endpoint you operate as a callable capability.',
      originLabel: 'Endpoint URL', originHint: 'https://api.example.com/v1/thing' },
    { key: 'skill', source: 'skill', idPrefix: 'skill', label: 'Local skill',
      desc: 'List a skill or command already installed on this machine.',
      originLabel: 'Skill / command path', originHint: 'skills/<name>/SKILL.md' },
    { key: 'kernel', source: 'pcc', idPrefix: 'pcc', label: 'Machine kernel',
      desc: 'A physical or machine capability served by a kernel — the networked (PCC) face.',
      originLabel: 'Kernel id / gateway origin', originHint: 'kernel-name @ https://capability.network' }
  ];
  function sourceType(key) {
    for (var i = 0; i < SOURCE_TYPES.length; i++) if (SOURCE_TYPES[i].key === key) return SOURCE_TYPES[i];
    return null;
  }

  var STEPS = ['Source', 'Identity', 'Authority', 'Inputs', 'Review'];
  var PARAM_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array'];

  // ── module state (the draft survives region rebuilds) ────────────────────
  function newDraft() {
    return {
      step: 0, type: null,
      name: '', id: '', idTouched: false,
      description: '', owner: '', origin: '',
      trustLevel: 'write',
      inputs: []
    };
  }
  var draft = newDraft();
  var reg = { probed: false, probing: false, reachable: false, count: 0, ids: {}, postAllowed: null };

  function slugify(s) {
    return String(s || '').toLowerCase()
      .replace(/[^a-z0-9.]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
  }
  function suggestId() {
    var st = sourceType(draft.type);
    return (st ? st.idPrefix : 'cap') + ':' + (slugify(draft.name) || 'my-capability');
  }

  /** The exact object submit sends — nothing more. */
  function composeCapability() {
    var st = sourceType(draft.type);
    var props = {};
    var required = [];
    draft.inputs.forEach(function (p) {
      var nm = String(p.name || '').trim();
      if (!nm) return;
      var spec = { type: p.type || 'string' };
      var d = String(p.description || '').trim();
      if (d) spec.description = d;
      props[nm] = spec;
      if (p.required) required.push(nm);
    });
    var cap = {
      id: String(draft.id || '').trim() || suggestId(),
      source: st ? st.source : 'api',
      name: String(draft.name || '').trim() || String(draft.id || '').trim(),
      description: String(draft.description || '').trim(),
      params: { type: 'object', properties: props },
      ui: { hint: Object.keys(props).length ? 'form' : 'card' },
      trustLevel: draft.trustLevel,
      sideEffects: draft.trustLevel !== 'read'
    };
    if (required.length) cap.params.required = required;
    var sd = {};
    if (String(draft.owner || '').trim()) sd.owner = String(draft.owner).trim();
    if (String(draft.origin || '').trim()) sd.origin = String(draft.origin).trim();
    if (sd.owner || sd.origin) cap.sourceDetail = sd;
    return cap;
  }

  // ── registration-path probe (read-only; never a fake write) ─────────────
  function probeRegistry() {
    if (reg.probing) return;
    reg.probing = true;
    renderRegStatus();
    CP.api.getJSON('/api/capabilities').then(function (list) {
      reg.probed = true;
      reg.reachable = true;
      reg.count = Array.isArray(list) ? list.length : 0;
      reg.ids = {};
      if (Array.isArray(list)) list.forEach(function (c) { if (c && c.id) reg.ids[c.id] = 1; });
      return probePost();
    }, function () {
      reg.probed = true;
      reg.reachable = false;
    }).then(function () {
      reg.probing = false;
      renderRegStatus();
    }, function () {
      reg.probing = false;
      renderRegStatus();
    });
  }

  // Best-effort: does the server advertise POST on the registry route?
  // Plain-node servers often 404 OPTIONS — then postAllowed stays null
  // (unknown) and submit simply reports the real POST outcome.
  function probePost() {
    try {
      return fetch(CP.api.base() + '/api/capabilities', { method: 'OPTIONS' }).then(function (r) {
        var allow = '';
        try { allow = (r.headers && (r.headers.get('allow') || r.headers.get('access-control-allow-methods'))) || ''; } catch (e) { /* opaque */ }
        if (allow) reg.postAllowed = /(^|[,\s])POST([,\s]|$)/i.test(allow);
      }, function () { /* unknown — fine */ });
    } catch (e) { return Promise.resolve(); }
  }

  function renderRegStatus() {
    var s = document.getElementById('cp-pub-status');
    if (!s) return;
    s.className = 'pub-status';
    if (reg.probing && !reg.probed) { s.textContent = 'Probing the registration path…'; return; }
    if (!reg.probed) { s.textContent = ''; return; }
    if (!reg.reachable) {
      s.textContent = 'Registration backend not wired on this origin yet — the walkthrough still works and ends in an honest preview you can hand to an orchestrator.';
      return;
    }
    var post = reg.postAllowed === false
      ? ' POST is not advertised by the server — submit may land in preview.'
      : (reg.postAllowed === true ? ' POST is advertised — live registration expected.' : '');
    s.className = 'pub-status ok';
    s.textContent = 'Registry reachable — ' + reg.count + ' capabilities listed.' + post;
  }

  // ── the wizard ────────────────────────────────────────────────────────────
  function renderStep() {
    var wb = document.getElementById('cp-pub-wiz-body');
    if (!wb) return;
    clear(wb);

    var dots = el('div', 'pub-dots');
    for (var i = 0; i < STEPS.length; i++) dots.appendChild(el('span', 'pub-dot' + (i === draft.step ? ' on' : '')));
    wb.appendChild(dots);
    wb.appendChild(el('h3', 'pub-step-t', 'Step ' + (draft.step + 1) + ' of ' + STEPS.length + ' — ' + STEPS[draft.step]));

    var err = el('p', 'pub-err', '');
    var content = el('div');
    [stepSource, stepIdentity, stepAuthority, stepInputs, stepReview][draft.step](content);
    wb.appendChild(content);

    var nav = el('div', 'pub-nav');
    if (draft.step > 0) {
      var back = el('button', 'btn ghost', 'Back');
      back.type = 'button';
      back.onclick = function () { draft.step--; renderStep(); };
      nav.appendChild(back);
    }
    if (draft.step < STEPS.length - 1) {
      var cont = el('button', 'btn primary', 'Continue');
      cont.type = 'button';
      cont.onclick = function () {
        var msg = validateStep();
        if (msg) { err.textContent = msg; return; }
        if (draft.step === 1 && !draft.id) draft.id = suggestId();
        draft.step++;
        renderStep();
      };
      nav.appendChild(cont);
    }
    wb.appendChild(nav);
    wb.appendChild(err);
  }

  function validateStep() {
    switch (draft.step) {
      case 0:
        return draft.type ? null : 'Pick a source type to continue.';
      case 1:
        if (!String(draft.name || '').trim()) return 'Name is required.';
        var id = String(draft.id || '').trim();
        if (!id) return 'Id is required.';
        if (!/^[a-z0-9][a-z0-9:._-]*$/i.test(id)) return 'Id may only contain letters, digits, ":", ".", "_" and "-".';
        return null;
      case 2:
        return AUTHORITY_CLASS[draft.trustLevel] ? null : 'Pick an authority class.';
      case 3:
        var seen = {};
        for (var i = 0; i < draft.inputs.length; i++) {
          var p = draft.inputs[i];
          var nm = String(p.name || '').trim();
          var hasOther = String(p.description || '').trim() || p.required;
          if (!nm && hasOther) return 'Every input needs a name (or remove the row).';
          if (nm && seen[nm]) return 'Duplicate input name: ' + nm;
          if (nm) seen[nm] = 1;
        }
        return null;
      default:
        return null;
    }
  }

  // step 1 — source type
  function stepSource(host) {
    host.appendChild(el('p', 'pub-step-b', 'What are you turning into a listed capability?'));
    var grid = el('div', 'pub-src-grid');
    SOURCE_TYPES.forEach(function (st) {
      var b = el('button', 'pub-src' + (draft.type === st.key ? ' active' : ''));
      b.type = 'button';
      b.appendChild(el('span', 't', st.label));
      b.appendChild(el('span', 'd', st.desc));
      b.onclick = function () {
        draft.type = st.key;
        if (!draft.idTouched) draft.id = suggestId();
        renderStep();
      };
      grid.appendChild(b);
    });
    // The deliberate stop: agent hosting is deferred. One disabled
    // affordance, honestly labeled — no runtime, no tenant backend here.
    var stub = el('button', 'pub-src stub');
    stub.type = 'button';
    stub.disabled = true;
    stub.setAttribute('aria-disabled', 'true');
    var t = el('span', 't', 'Run your own agent here');
    t.appendChild(el('span', 'pub-soon', 'coming soon'));
    stub.appendChild(t);
    stub.appendChild(el('span', 'd',
      'Hosting an agent runtime on this plane is deliberately deferred. This walkthrough publishes capabilities.'));
    grid.appendChild(stub);
    host.appendChild(grid);
  }

  // step 2 — identity / provenance
  function textField(form, lbl, hint, value, mono, placeholder, oninput) {
    var row = el('label', 'field');
    row.appendChild(el('span', 'field-lbl', lbl));
    if (hint) row.appendChild(el('span', 'field-hint', hint));
    var input = el('input');
    input.type = 'text';
    if (mono) input.style.fontFamily = 'var(--mono)';
    input.value = value || '';
    if (placeholder) input.placeholder = placeholder;
    input.oninput = function () { oninput(input.value); };
    row.appendChild(input);
    form.appendChild(row);
    return input;
  }

  function stepIdentity(host) {
    var st = sourceType(draft.type);
    host.appendChild(el('p', 'pub-step-b',
      'Who is this, and where does it come from? Provenance stays visible on every catalog card.'));
    var form = el('div', 'pub-form');
    var idInput = null;
    textField(form, 'Name', '', draft.name, false, 'e.g. Label Printer', function (v) {
      draft.name = v;
      if (!draft.idTouched) {
        draft.id = suggestId();
        if (idInput) idInput.value = draft.id;
      }
    });
    if (!draft.id) draft.id = suggestId();
    idInput = textField(form, 'Id', 'Stable identifier in the registry.', draft.id, true, '', function (v) {
      draft.idTouched = true;
      draft.id = v;
    });
    var drow = el('label', 'field');
    drow.appendChild(el('span', 'field-lbl', 'Description'));
    drow.appendChild(el('span', 'field-hint', 'One or two sentences — shown on the catalog card.'));
    var ta = el('textarea');
    ta.rows = 3;
    ta.value = draft.description || '';
    ta.oninput = function () { draft.description = ta.value; };
    drow.appendChild(ta);
    form.appendChild(drow);
    textField(form, 'Provider / owner', 'Shown as provenance.', draft.owner, false, 'e.g. your operator handle', function (v) {
      draft.owner = v;
    });
    textField(form, st ? st.originLabel : 'Origin', 'Where this capability actually lives.', draft.origin, true,
      st ? st.originHint : '', function (v) { draft.origin = v; });
    host.appendChild(form);
  }

  // step 3 — authority class
  function stepAuthority(host) {
    host.appendChild(el('p', 'pub-step-b',
      'How much authority does a run exercise? Everything beyond read pauses for approval before it acts. ' +
      'The derived authority rung (the unified ladder) is shown beside each class.'));
    var grid = el('div', 'pub-auth-grid');
    TRUST_CHOICES.forEach(function (c) {
      var b = el('button', 'pub-auth' + (draft.trustLevel === c.id ? ' active' : ''));
      b.type = 'button';
      if (CP.render && CP.render.trustBadge) b.appendChild(CP.render.trustBadge(c.id));
      else b.appendChild(el('span', 'badge trust-' + c.id, c.id));
      b.appendChild(el('span', 'a', '→ ' + AUTHORITY_CLASS[c.id]));
      b.appendChild(el('span', 'h', c.hint));
      b.onclick = function () { draft.trustLevel = c.id; renderStep(); };
      grid.appendChild(b);
    });
    host.appendChild(grid);
  }

  // step 4 — inputs
  function stepInputs(host) {
    host.appendChild(el('p', 'pub-step-b',
      'Declare the inputs a caller fills in. They register as a JSON schema; the catalog generates the run form from it. Zero inputs is fine.'));
    var list = el('div', 'pub-form');
    draft.inputs.forEach(function (p, idx) { list.appendChild(inputRow(p, idx)); });
    if (!draft.inputs.length) list.appendChild(el('p', 'muted small', 'No inputs declared yet.'));
    host.appendChild(list);
    var add = el('button', 'btn', '＋ Add input');
    add.type = 'button';
    add.onclick = function () {
      draft.inputs.push({ name: '', type: 'string', description: '', required: false });
      renderStep();
    };
    host.appendChild(add);
  }

  function inputRow(p, idx) {
    var row = el('div', 'pub-inrow');
    var nm = el('input');
    nm.type = 'text';
    nm.placeholder = 'name';
    nm.value = p.name || '';
    nm.oninput = function () { p.name = nm.value; };
    row.appendChild(nm);
    var sel = el('select');
    PARAM_TYPES.forEach(function (t) {
      var o = el('option', null, t);
      o.value = t;
      if ((p.type || 'string') === t) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = function () { p.type = sel.value; };
    row.appendChild(sel);
    var ds = el('input');
    ds.type = 'text';
    ds.placeholder = 'description (optional)';
    ds.value = p.description || '';
    ds.oninput = function () { p.description = ds.value; };
    row.appendChild(ds);
    var req = el('label', 'pub-req');
    var cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !!p.required;
    cb.onchange = function () { p.required = cb.checked; };
    req.appendChild(cb);
    req.appendChild(el('span', null, 'required'));
    row.appendChild(req);
    var rm = el('button', 'btn ghost', 'Remove');
    rm.type = 'button';
    rm.onclick = function () { draft.inputs.splice(idx, 1); renderStep(); };
    row.appendChild(rm);
    return row;
  }

  // step 5 — review + submit
  function stepReview(host) {
    var cap = composeCapability();
    host.appendChild(el('p', 'pub-step-b', 'This exact object is what registration submits — nothing more is sent.'));
    var pre = el('pre', 'pub-json');
    try { pre.textContent = JSON.stringify(cap, null, 2); } catch (e) { pre.textContent = String(cap.id); }
    host.appendChild(pre);

    var line = el('p', 'muted small');
    if (reg.reachable) {
      line.textContent = 'Submit will POST /api/capabilities on ' + (CP.api.base() || 'this origin') + '.';
      if (reg.ids[cap.id]) {
        host.appendChild(el('p', 'pub-warn',
          '"' + cap.id + '" already exists in the registry — the backend may reject or replace it.'));
      }
    } else if (reg.probed) {
      line.textContent = 'Registration backend not reachable — submitting shows an honest preview instead.';
    } else {
      line.textContent = 'Registration path not probed yet — submit will attempt it and report what actually happened.';
    }
    host.appendChild(line);

    var acts = el('div', 'actions');
    var submit = el('button', 'btn primary', reg.probed && !reg.reachable ? 'Preview registration' : 'Register capability');
    submit.type = 'button';
    var reset = el('button', 'btn ghost', 'Start over');
    reset.type = 'button';
    acts.appendChild(submit);
    acts.appendChild(reset);
    host.appendChild(acts);
    var result = el('div', 'pub-result');
    host.appendChild(result);

    submit.onclick = function () { submitCap(cap, result, submit); };
    reset.onclick = function () { draft = newDraft(); renderStep(); };
  }

  // ── submit: attempt the real registration; report the real outcome ──────
  function submitCap(cap, host, btn) {
    clear(host);
    if (reg.probed && !reg.reachable) {
      showPreview(host, cap, 'registration backend not reachable on this origin');
      return;
    }
    btn.disabled = true;
    host.appendChild(el('p', 'muted', 'Registering…'));
    var url = CP.api.base() + '/api/capabilities';
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cap)
    }).then(function (r) {
      btn.disabled = false;
      if (r.ok) { onAccepted(host, cap); return; }
      if (r.status === 404 || r.status === 405 || r.status === 501) {
        showPreview(host, cap, 'POST /api/capabilities returned HTTP ' + r.status);
        return;
      }
      clear(host);
      host.appendChild(el('p', 'err-txt', 'Registration failed: HTTP ' + r.status + '. Nothing was registered.'));
      appendCapJson(host, cap);
    }, function (err) {
      btn.disabled = false;
      showPreview(host, cap, String((err && err.message) || err));
    });
  }

  // POST accepted → verify the id actually appears before claiming success.
  function onAccepted(host, cap) {
    clear(host);
    host.appendChild(el('p', 'muted', 'Accepted — verifying it appears in the registry…'));
    CP.api.getJSON('/api/capabilities').then(function (list) {
      clear(host);
      var found = Array.isArray(list) && list.some(function (c) { return c && c.id === cap.id; });
      if (found) {
        reg.ids[cap.id] = 1;
        reg.count = Array.isArray(list) ? list.length : reg.count;
        host.appendChild(el('p', 'pub-ok', 'Registered — ' + cap.id + ' is live in the catalog.'));
        bus.emit('registry:grew', { added: 1, total: reg.count });
        if (CP.toast) CP.toast('Capability registered: ' + cap.id);
      } else {
        host.appendChild(el('p', 'pub-warn',
          'The server accepted the POST, but ' + cap.id + ' has not appeared in the registry list. ' +
          'Not marking this registered — re-check the catalog.'));
      }
      addResetButton(host);
      renderRegStatus();
    }, function () {
      clear(host);
      host.appendChild(el('p', 'pub-warn',
        'The server accepted the POST, but the registry could not be re-read to confirm. Check the catalog before relying on it.'));
      addResetButton(host);
    });
  }

  function showPreview(host, cap, why) {
    clear(host);
    host.appendChild(el('p', 'pub-warn',
      'Preview — registration backend not wired on this origin yet' + (why ? ' (' + why + ')' : '') +
      '. Nothing was registered. This is the capability JSON the walkthrough composed:'));
    appendCapJson(host, cap);
  }

  function appendCapJson(host, cap) {
    var pre = el('pre', 'pub-json');
    var txt = '';
    try { txt = JSON.stringify(cap, null, 2); } catch (e) { txt = String(cap && cap.id); }
    pre.textContent = txt;
    host.appendChild(pre);
    var copy = el('button', 'btn', 'Copy JSON');
    copy.type = 'button';
    copy.onclick = function () {
      try {
        navigator.clipboard.writeText(txt);
        if (CP.toast) CP.toast('Copied');
      } catch (e) {
        if (CP.toast) CP.toast('Select and copy manually');
      }
    };
    host.appendChild(copy);
  }

  function addResetButton(host) {
    var again = el('button', 'btn ghost', 'Register another');
    again.type = 'button';
    again.onclick = function () { draft = newDraft(); renderStep(); };
    host.appendChild(again);
  }

  // ── the region builder ────────────────────────────────────────────────────
  function buildPublish() {
    var body = CP.regionBody('publish');
    if (!body) return;
    ensureStyles();
    clear(body);

    body.appendChild(el('p', 'muted',
      'Turn an API or a machine into a listed capability. Five short steps — nothing registers until you submit ' +
      'on the review step, and the result is reported honestly either way.'));

    var status = el('p', 'pub-status', '');
    status.id = 'cp-pub-status';
    body.appendChild(status);

    var wiz = el('div', 'panel');
    wiz.appendChild(el('div', 'panel-h', 'Publish a capability'));
    var wb = el('div', 'pub-wiz-body');
    wb.id = 'cp-pub-wiz-body';
    wiz.appendChild(wb);
    body.appendChild(wiz);

    // The orchestrator lane the inline builder taught — kept, tucked away.
    var cli = el('details', 'pub-cli');
    cli.appendChild(el('summary', null, 'Prefer the orchestrator lane? (/forge + /vet)'));
    var pre = el('pre', 'pub-cmd');
    pre.textContent = '/forge <tool-name> <api-docs-url>   # generate an MCP server\n' +
      '/vet   <path>                        # security-scan it (Gate A)\n' +
      '# it registers into the catalog on approval';
    cli.appendChild(pre);
    body.appendChild(cli);

    renderStep();
    renderRegStatus();
    probeRegistry();
  }

  (CP.regionBuilders = CP.regionBuilders || {}).publish = buildPublish;

  // Late-load edge: shell booted before this file → rebuild with ours.
  try {
    if (CP.rebuildRegion && CP.expand && CP.expand.isRevealed('publish')) {
      var rb = CP.regionBody && CP.regionBody('publish');
      if (rb && rb.childNodes.length) CP.rebuildRegion('publish');
    }
  } catch (e) { /* boot not far enough — the normal path builds us */ }

  // Exposed for headless tests (read-only surface + draft injection).
  CP._publish = {
    SOURCE_TYPES: SOURCE_TYPES,
    AUTHORITY_CLASS: AUTHORITY_CLASS,
    slugify: slugify,
    suggestId: suggestId,
    composeCapability: composeCapability,
    validateStep: validateStep,
    draft: function () { return draft; },
    _setDraft: function (d) { draft = d; },
    _reg: function () { return reg; }
  };
})();
