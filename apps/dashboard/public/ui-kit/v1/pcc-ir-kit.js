/* GENERATED from packages/gateway/src/mcp/dashboard-ir-browser-entry.ts by
   scripts/build-dashboard-ir-kit.mjs — DO NOT EDIT. Regenerate with `pnpm build:ir-kit`. */
"use strict";
(() => {
  // src/mcp/dashboard-ir.ts
  var IR_NODE_TYPES = [
    "root",
    "section",
    "heading",
    "text",
    "stat",
    "card",
    "receipt",
    "list",
    "badge",
    "grid",
    "approval-notice",
    "plan",
    "form-summary",
    "field-label"
  ];
  var FROZEN = new Set(IR_NODE_TYPES);
  var BADGE_TONES = ["neutral", "info", "positive", "warning", "danger"];
  var TONE_SET = new Set(BADGE_TONES);
  var CARD_KINDS = /* @__PURE__ */ new Set(["capability", "run"]);
  var GRID_KINDS = /* @__PURE__ */ new Set(["actions-readonly"]);
  var PLAN_KINDS = /* @__PURE__ */ new Set(["composition"]);
  var LIM = {
    sections: 24,
    windowsPerSection: 32,
    nodesTotal: 2e3,
    depth: 8,
    inputDepth: 16,
    str: 2e3,
    listRows: 200,
    fields: 64,
    metaItems: 12,
    queryKeys: 16,
    path: 512,
    select: 256,
    title: 400,
    pollMinMs: 5e3,
    pollMaxMs: 36e5,
    boundWindowsTotal: 64,
    // poll-amplification cap (sol R5)
    cleanNodes: 5e4
    // deepClean traversal budget — >> any legit manifest/IR, kills wide-object DoS (sol R6)
  };
  var APPROVAL_NOTICE = "This action is confirmed only on the authenticated PCC surface.";
  var PATH_GRAMMAR = /^\/api\/[A-Za-z0-9._~\-/]+$/;
  var SSE_GRAMMAR = /^\/sse\/[A-Za-z0-9._~\-/]+$/;
  var SELECT_GRAMMAR = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
  var OP_ID_GRAMMAR = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
  var ID_SEG = "(?![a-z]+(?:-[a-z]+)*(?:/|$))[A-Za-z0-9_~.-]+";
  var escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function route(template) {
    return new RegExp("^" + template.split("/").map((s) => s === ":" ? ID_SEG : escRe(s)).join("/") + "$");
  }
  function routeCap(template) {
    return new RegExp("^" + template.split("/").map((s) => s === ":" ? "(" + ID_SEG + ")" : escRe(s)).join("/") + "$");
  }
  var RESERVED_EXACT = /* @__PURE__ */ new Set([
    "/api/capabilities/types",
    "/api/capabilities/templates",
    "/api/capabilities/search",
    "/api/capabilities/graph-stats",
    "/api/capabilities/graph-search",
    "/api/settlement/status",
    "/api/settlement/epochs",
    "/api/settlement/flush",
    "/api/settlement/submit",
    "/api/settlement/release",
    "/api/evidence/lit-status",
    "/api/evidence/archive",
    "/api/evidence/embed",
    "/api/evidence/search",
    "/api/jobs/submit",
    "/api/jobs/submit-from-discovery",
    "/api/kernels/marketplace",
    "/api/kernels/register",
    "/api/escrow/chain"
  ]);
  var BIND_POLICY = {
    // metric: object-returning read + a REQUIRED scalar `select` (else the whole object shows).
    metric: {
      routes: [
        route("/api/fiat-ramp/cdp/wallet/:/balance"),
        route("/api/jobs/:"),
        route("/api/jobs/:/status"),
        route("/api/escrow/:"),
        route("/api/settlement/:"),
        route("/api/kernels/:")
      ],
      needsSelect: true
    },
    capability: { routes: [route("/api/capabilities/:")] },
    // ID_SEG excludes types/templates/search/graph-*
    receipt: { routes: [route("/api/settlement/:"), route("/api/evidence/:")], schema: "receipt" },
    list: { routes: [route("/api/jobs"), route("/api/kernels"), route("/api/capabilities"), route("/api/escrow")] },
    run: {
      routes: [route("/api/jobs/:"), route("/api/jobs/:/status")],
      sse: [route("/sse/stream/job/:")],
      correlate: { pathRe: new RegExp("^/api/jobs/(" + ID_SEG + ")(?:/status)?$"), sseRe: routeCap("/sse/stream/job/:") }
    }
    // approval in B is a STATIC notice — no live bind (live approval state is C+D out-of-band).
  };
  var PROTO_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
  function isPlain(v) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
  }
  function strictStr(v, max = LIM.str) {
    return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
  }
  function onlyKeys(o, allowed) {
    const set = new Set(allowed);
    for (const k of Reflect.ownKeys(o)) {
      if (typeof k === "symbol") return false;
      if (!set.has(k)) return false;
      const d = Object.getOwnPropertyDescriptor(o, k);
      if (!d || !d.enumerable) return false;
    }
    return true;
  }
  var INDEX_KEY = /^(0|[1-9][0-9]*)$/;
  function deepClean(v, depth = 0, budget = { n: LIM.cleanNodes }) {
    if (depth > LIM.inputDepth) return false;
    if (--budget.n < 0) return false;
    const t = typeof v;
    if (v === null || t === "string" || t === "boolean") return true;
    if (t === "number") return Number.isFinite(v);
    if (Array.isArray(v)) {
      for (const k of Reflect.ownKeys(v)) {
        if (typeof k === "symbol") return false;
        if (k !== "length" && !INDEX_KEY.test(k)) return false;
      }
      for (const e of v) if (!deepClean(e, depth + 1, budget)) return false;
      return true;
    }
    if (!isPlain(v)) return false;
    for (const k of Reflect.ownKeys(v)) {
      if (typeof k === "symbol" || PROTO_KEYS.has(k)) return false;
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!d || !d.enumerable) return false;
      if (!deepClean(v[k], depth + 1, budget)) return false;
    }
    return true;
  }
  function isSelector(s) {
    if (typeof s !== "string" || !SELECT_GRAMMAR.test(s) || s.length > LIM.select) return false;
    for (const seg of s.split(".")) if (PROTO_KEYS.has(seg)) return false;
    return true;
  }
  function isReadPath(s, grammar = PATH_GRAMMAR) {
    if (typeof s !== "string" || !grammar.test(s) || s.length > LIM.path) return false;
    for (const seg of s.split("/")) if (seg === ".." || seg === ".") return false;
    return true;
  }
  var CRED_EXACT = /* @__PURE__ */ new Set([
    "password",
    "secret",
    "token",
    "credential",
    "apikey",
    "privatekey",
    "authorization",
    "bearer",
    "accesstoken",
    "refreshtoken",
    "clientsecret",
    "sessiontoken",
    "otp",
    "cvv",
    "pin",
    "mnemonic",
    "seedphrase",
    "passphrase",
    "privkey",
    "signingkey"
  ]);
  var CRED_SUBSTR = ["password", "secret", "privatekey", "apikey", "credential", "passphrase"];
  function isCredentialName(k) {
    const n = k.toLowerCase().replace(/[_\-\s]/g, "");
    if (CRED_EXACT.has(n)) return true;
    return CRED_SUBSTR.some((t) => n.includes(t));
  }
  function isOpDescriptor(v) {
    if (!isPlain(v) || !onlyKeys(v, ["id", "label", "confirm", "intentText", "operation_id", "arguments"])) return false;
    if (v.operation_id !== void 0 && (typeof v.operation_id !== "string" || !OP_ID_GRAMMAR.test(v.operation_id))) return false;
    if (v.id !== void 0 && strictStr(v.id, LIM.title) === null) return false;
    if (v.label !== void 0 && strictStr(v.label, LIM.title) === null) return false;
    if (v.intentText !== void 0 && strictStr(v.intentText, LIM.str) === null) return false;
    if (v.confirm !== void 0 && v.confirm !== "inline" && v.confirm !== "approval") return false;
    if (v.arguments !== void 0 && !isPlain(v.arguments)) return false;
    return true;
  }
  function bindMatchesPolicy(bind, key) {
    const policy = BIND_POLICY[key];
    if (!policy) return `no bind policy for ${key}`;
    if (!isReadPath(bind.path)) return "bind.path grammar";
    if (RESERVED_EXACT.has(bind.path)) return "bind.path is a reserved/collection route";
    if (!policy.routes.some((re) => re.test(bind.path))) return `bind.path outside ${key} allowlist`;
    if (bind.select !== void 0 && !isSelector(bind.select)) return "bind.select grammar";
    if (policy.needsSelect && bind.select === void 0) return `${key} requires a scalar select`;
    if (!policy.needsSelect && bind.select !== void 0) return `${key} may not select`;
    if (bind.query !== void 0) {
      if (!isPlain(bind.query) || Object.keys(bind.query).length > LIM.queryKeys) return "bind.query shape";
      for (const [k, v] of Object.entries(bind.query)) {
        if (!isSelector(k)) return "query key grammar";
        const t = typeof v;
        if (!(t === "string" && v.length <= LIM.str) && t !== "boolean" && !(t === "number" && Number.isFinite(v))) return "query value type";
      }
    }
    if (bind.pollMs !== void 0 && (typeof bind.pollMs !== "number" || !Number.isFinite(bind.pollMs) || bind.pollMs < LIM.pollMinMs || bind.pollMs > LIM.pollMaxMs)) return "bind.pollMs range";
    if (bind.sse !== void 0) {
      if (!policy.sse) return `${key} may not stream`;
      if (!isReadPath(bind.sse, SSE_GRAMMAR) || !policy.sse.some((re) => re.test(bind.sse))) return "bind.sse outside allowlist";
      if (policy.correlate) {
        const mp = policy.correlate.pathRe.exec(bind.path);
        const ms = policy.correlate.sseRe.exec(bind.sse);
        if (!mp || !ms || mp[1] !== ms[1]) return "sse/path identity mismatch";
      }
    }
    if (policy.schema) {
      if (bind.schema !== policy.schema) return `bind.schema must be ${policy.schema}`;
    } else if (bind.schema !== void 0) return "unexpected bind.schema";
    return null;
  }
  function dashboardManifestToIr(m) {
    if (!isPlain(m)) return { ok: false, reason: "manifest not a plain object" };
    if (!deepClean(m)) return { ok: false, reason: "prototype/nonfinite/symbol in manifest" };
    const mm = m;
    if (!onlyKeys(mm, ["csd", "title", "description", "theme", "sections"])) return { ok: false, reason: "unexpected top-level key" };
    const title = strictStr(mm.title, LIM.title);
    if (title === null) return { ok: false, reason: "title invalid" };
    if (!Array.isArray(mm.sections)) return { ok: false, reason: "sections not array" };
    if (mm.sections.length > LIM.sections) return { ok: false, reason: "too many sections" };
    let count = 0;
    const budget = () => ++count <= LIM.nodesTotal;
    let bindCount = 0;
    const bindBudget = () => ++bindCount <= LIM.boundWindowsTotal;
    const nextId = /* @__PURE__ */ (() => {
      let n = 0;
      return () => `n${++n}`;
    })();
    const sectionNodes = [];
    for (const secRaw of mm.sections) {
      if (!isPlain(secRaw) || !onlyKeys(secRaw, ["heading", "windows"])) return { ok: false, reason: "bad section" };
      if (!Array.isArray(secRaw.windows)) return { ok: false, reason: "section.windows not array" };
      if (secRaw.windows.length > LIM.windowsPerSection) return { ok: false, reason: "too many windows" };
      const children = [];
      if (secRaw.heading !== void 0) {
        const h = strictStr(secRaw.heading, LIM.title);
        if (h === null) return { ok: false, reason: "section.heading invalid" };
        if (!budget()) return { ok: false, reason: "node budget" };
        children.push({ type: "heading", id: nextId(), props: { level: 2, text: h }, untrusted: true });
      }
      for (const w of secRaw.windows) {
        const r = mapWindow(w, nextId, budget, bindBudget);
        if (!r.ok) return r;
        children.push(r.node);
      }
      if (!budget()) return { ok: false, reason: "node budget" };
      sectionNodes.push({ type: "section", id: nextId(), children });
    }
    if (!budget()) return { ok: false, reason: "node budget" };
    const titleNode = { type: "heading", id: nextId(), props: { level: 1, text: title }, untrusted: true };
    if (!budget()) return { ok: false, reason: "node budget" };
    return { ok: true, doc: { ir: "pcc-dashboard-ir/v1", title: titleNode, root: { type: "root", id: nextId(), children: sectionNodes } } };
  }
  function mapWindow(w, nextId, budget, bindBudget) {
    if (!budget()) return { ok: false, reason: "node budget" };
    if (!isPlain(w)) return { ok: false, reason: "window not plain object" };
    const kind = w.kind;
    if (typeof kind !== "string") return { ok: false, reason: "window.kind missing" };
    const id = nextId();
    const chargeBind = () => bindBudget();
    switch (kind) {
      case "note":
        if (!onlyKeys(w, ["kind", "text"])) return { ok: false, reason: "note extra key" };
        {
          const text = strictStr(w.text);
          if (text === null) return { ok: false, reason: "note.text" };
          return { ok: true, node: { type: "text", id, props: { text }, untrusted: true } };
        }
      case "metric":
        if (!onlyKeys(w, ["kind", "label", "binding", "select"])) return { ok: false, reason: "metric extra key" };
        {
          const label = strictStr(w.label, LIM.title);
          if (label === null) return { ok: false, reason: "metric.label" };
          if (!isSelector(w.select)) return { ok: false, reason: "metric.select grammar" };
          const b = mapBind(w.binding, "metric", w.select);
          if (!b.ok) return b;
          if (!chargeBind()) return { ok: false, reason: "bound-window budget" };
          return { ok: true, node: { type: "stat", id, props: { label }, bind: b.bind, untrusted: true } };
        }
      case "capability":
        if (!onlyKeys(w, ["kind", "binding"])) return { ok: false, reason: "capability extra key" };
        {
          const b = mapBind(w.binding, "capability");
          if (!b.ok) return b;
          if (!chargeBind()) return { ok: false, reason: "bound-window budget" };
          return { ok: true, node: { type: "card", id, props: { kind: "capability" }, bind: b.bind } };
        }
      case "receipt":
        if (!onlyKeys(w, ["kind", "binding"])) return { ok: false, reason: "receipt extra key" };
        {
          const b = mapBind(w.binding, "receipt");
          if (!b.ok) return b;
          if (!chargeBind()) return { ok: false, reason: "bound-window budget" };
          return { ok: true, node: { type: "receipt", id, bind: b.bind } };
        }
      case "list":
        if (!onlyKeys(w, ["kind", "binding", "item", "limit"])) return { ok: false, reason: "list extra key" };
        {
          const b = mapBind(w.binding, "list");
          if (!b.ok) return b;
          if (!chargeBind()) return { ok: false, reason: "bound-window budget" };
          const item = w.item;
          if (!isPlain(item) || !onlyKeys(item, ["title", "meta", "statusFrom"])) return { ok: false, reason: "list.item" };
          if (!isSelector(item.title)) return { ok: false, reason: "list.item.title selector" };
          const rowMeta = [];
          if (item.meta !== void 0) {
            if (!Array.isArray(item.meta) || item.meta.length > LIM.metaItems) return { ok: false, reason: "list.meta" };
            for (const mi of item.meta) {
              if (!isSelector(mi)) return { ok: false, reason: "list.meta selector" };
              rowMeta.push(mi);
            }
          }
          const props = { rowTitle: item.title, rowMeta };
          if (item.statusFrom !== void 0) {
            if (!isSelector(item.statusFrom)) return { ok: false, reason: "list.statusFrom selector" };
            props.statusFrom = item.statusFrom;
          }
          if (w.limit !== void 0) {
            if (typeof w.limit !== "number" || !Number.isInteger(w.limit) || w.limit <= 0 || w.limit > LIM.listRows) return { ok: false, reason: "list.limit" };
            props.limit = w.limit;
          }
          return { ok: true, node: { type: "list", id, bind: b.bind, props } };
        }
      case "run":
        if (!onlyKeys(w, ["kind", "binding", "statusFrom", "latestFrom"])) return { ok: false, reason: "run extra key" };
        {
          const b = mapBind(w.binding, "run");
          if (!b.ok) return b;
          if (!chargeBind()) return { ok: false, reason: "bound-window budget" };
          if (!isSelector(w.statusFrom) || !isSelector(w.latestFrom)) return { ok: false, reason: "run selectors" };
          return { ok: true, node: { type: "card", id, props: { kind: "run", statusFrom: w.statusFrom, latestFrom: w.latestFrom }, bind: b.bind } };
        }
      case "form":
        if (!onlyKeys(w, ["kind", "schema", "submit"])) return { ok: false, reason: "form extra key" };
        if (w.submit !== void 0 && !isOpDescriptor(w.submit)) return { ok: false, reason: "form.submit grammar" };
        {
          const labels = fieldLabels(w.schema);
          if (!labels.ok) return labels;
          const children = [];
          for (const l of labels.labels) {
            if (!budget()) return { ok: false, reason: "node budget" };
            children.push({ type: "field-label", id: nextId(), props: { label: l }, untrusted: true });
          }
          return { ok: true, node: { type: "form-summary", id, children } };
        }
      case "approval":
        if (!onlyKeys(w, ["kind", "binding", "approve", "deny"])) return { ok: false, reason: "approval extra key" };
        if (w.approve !== void 0 && !isOpDescriptor(w.approve)) return { ok: false, reason: "approval.approve grammar" };
        if (w.deny !== void 0 && !isOpDescriptor(w.deny)) return { ok: false, reason: "approval.deny grammar" };
        if (w.binding !== void 0 && !isPlain(w.binding)) return { ok: false, reason: "approval.binding shape" };
        return { ok: true, node: { type: "approval-notice", id, props: { notice: APPROVAL_NOTICE } } };
      case "chain":
        if (!onlyKeys(w, ["kind", "composeRef", "execute"])) return { ok: false, reason: "chain extra key" };
        if (!isPlain(w.composeRef)) return { ok: false, reason: "chain.composeRef shape" };
        if (w.execute !== void 0 && !isOpDescriptor(w.execute)) return { ok: false, reason: "chain.execute grammar" };
        return { ok: true, node: { type: "plan", id, props: { kind: "composition" } } };
      case "actions":
        if (!onlyKeys(w, ["kind", "actions"])) return { ok: false, reason: "actions extra key" };
        {
          const acts = w.actions;
          if (!Array.isArray(acts) || acts.length === 0 || acts.length > LIM.fields) return { ok: false, reason: "actions" };
          const children = [];
          for (const a of acts) {
            if (!budget()) return { ok: false, reason: "node budget" };
            if (!isOpDescriptor(a)) return { ok: false, reason: "action grammar" };
            const label = strictStr(a.label, LIM.title);
            if (label === null) return { ok: false, reason: "action.label" };
            children.push({ type: "badge", id: nextId(), props: { text: label, tone: "neutral" }, untrusted: true });
          }
          return { ok: true, node: { type: "grid", id, props: { kind: "actions-readonly" }, children } };
        }
      default:
        return { ok: false, reason: `unknown window kind: ${kind}` };
    }
  }
  function mapBind(b, key, topSelect) {
    const policy = BIND_POLICY[key];
    if (!policy) return { ok: false, reason: `no bind policy for ${key}` };
    const allowed = policy.sse ? ["path", "query", "pollMs", "sse"] : ["path", "query", "pollMs"];
    if (!isPlain(b) || !onlyKeys(b, allowed)) return { ok: false, reason: "binding shape" };
    const bind = { path: b.path };
    if (topSelect !== void 0) bind.select = topSelect;
    if (b.sse !== void 0) bind.sse = b.sse;
    if (b.pollMs !== void 0) bind.pollMs = b.pollMs;
    if (b.query !== void 0) {
      if (!isPlain(b.query)) return { ok: false, reason: "binding.query shape" };
      const q = {};
      for (const [k, v] of Object.entries(b.query)) {
        if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return { ok: false, reason: "query value type" };
        q[k] = v;
      }
      bind.query = q;
    }
    if (policy.schema) bind.schema = policy.schema;
    const reason = bindMatchesPolicy(bind, key);
    return reason ? { ok: false, reason } : { ok: true, bind };
  }
  function fieldLabels(schema) {
    if (!isPlain(schema) || !onlyKeys(schema, ["type", "properties", "required"])) return { ok: false, reason: "form.schema shape" };
    if (schema.type !== void 0 && schema.type !== "object") return { ok: false, reason: "form.schema.type" };
    if (schema.required !== void 0 && (!Array.isArray(schema.required) || !schema.required.every((x) => typeof x === "string"))) return { ok: false, reason: "form.schema.required" };
    const props = schema.properties;
    if (!isPlain(props)) return { ok: false, reason: "form.schema.properties" };
    const keys = Object.keys(props);
    if (keys.length > LIM.fields) return { ok: false, reason: "too many fields" };
    const labels = [];
    for (const key of keys) {
      if (PROTO_KEYS.has(key) || isCredentialName(key)) return { ok: false, reason: "credential/proto field" };
      const def = props[key];
      if (!isPlain(def) || !onlyKeys(def, ["type", "title", "description", "enum", "format", "minimum", "maximum", "minLength", "maxLength"])) return { ok: false, reason: "form field-def shape" };
      if (def.type !== void 0 && !["string", "number", "integer", "boolean"].includes(String(def.type))) return { ok: false, reason: "form field type" };
      if (def.title !== void 0 && strictStr(def.title, LIM.title) === null) return { ok: false, reason: "form field title" };
      const rawLabel = typeof def.title === "string" ? def.title : key;
      const s = strictStr(rawLabel, LIM.title);
      if (s === null) return { ok: false, reason: "field label" };
      labels.push(s);
    }
    return { ok: true, labels };
  }
  var NODE_SCHEMA = {
    root: { noBind: true, parentOf: ["section"], maxChildren: LIM.sections },
    section: { noBind: true, parentOf: ["heading", "text", "stat", "card", "receipt", "list", "grid", "approval-notice", "plan", "form-summary"] },
    heading: { props: { level: "level", text: "s400" }, required: ["level", "text"], noBind: true, prose: true, childless: true },
    text: { props: { text: "s2000" }, required: ["text"], noBind: true, prose: true, childless: true },
    stat: { props: { label: "s400" }, required: ["label"], bindKey: "metric", needsBind: true, prose: true, childless: true },
    card: { props: { kind: "card-kind", statusFrom: "selector", latestFrom: "selector" }, required: ["kind"], optional: ["statusFrom", "latestFrom"], bindKey: "capability", needsBind: true, childless: true },
    receipt: { bindKey: "receipt", needsBind: true, childless: true },
    list: { props: { rowTitle: "selector", rowMeta: "string[]", statusFrom: "selector", limit: "limit" }, required: ["rowTitle", "rowMeta"], optional: ["statusFrom", "limit"], bindKey: "list", needsBind: true, childless: true },
    badge: { props: { text: "s400", tone: "tone" }, required: ["text", "tone"], noBind: true, prose: true, childless: true },
    grid: { props: { kind: "grid-kind" }, required: ["kind"], noBind: true, parentOf: ["badge"], minChildren: 1, maxChildren: LIM.fields },
    "approval-notice": { props: { notice: "s2000" }, required: ["notice"], noBind: true, childless: true },
    plan: { props: { kind: "plan-kind" }, required: ["kind"], noBind: true, childless: true },
    "form-summary": { noBind: true, parentOf: ["field-label"], maxChildren: LIM.fields },
    "field-label": { props: { label: "s400" }, required: ["label"], noBind: true, prose: true, childless: true }
  };
  function propType(v, t) {
    switch (t) {
      case "s400":
        return typeof v === "string" && v.length > 0 && v.length <= LIM.title;
      case "s2000":
        return typeof v === "string" && v.length > 0 && v.length <= LIM.str;
      case "number":
        return typeof v === "number" && Number.isFinite(v);
      case "limit":
        return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= LIM.listRows;
      case "boolean":
        return typeof v === "boolean";
      case "string[]":
        return Array.isArray(v) && v.length <= LIM.metaItems && v.every((x) => isSelector(x));
      case "level":
        return v === 1 || v === 2 || v === 3;
      case "tone":
        return typeof v === "string" && TONE_SET.has(v);
      case "card-kind":
        return typeof v === "string" && CARD_KINDS.has(v);
      case "grid-kind":
        return typeof v === "string" && GRID_KINDS.has(v);
      case "plan-kind":
        return typeof v === "string" && PLAN_KINDS.has(v);
      case "selector":
        return isSelector(v);
    }
  }
  var hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function validateIr(doc) {
    if (!isPlain(doc) || doc.ir !== "pcc-dashboard-ir/v1" || !onlyKeys(doc, ["ir", "title", "root"])) return { ok: false, reason: "not an IR doc" };
    if (!deepClean(doc)) return { ok: false, reason: "proto/nonfinite/symbol in IR" };
    if (!isPlain(doc.title) || doc.title.type !== "heading" || doc.title.props?.level !== 1) return { ok: false, reason: "doc.title not H1" };
    if (!isPlain(doc.root) || doc.root.type !== "root") return { ok: false, reason: "doc.root not root" };
    const ids = /* @__PURE__ */ new Set();
    let count = 0;
    let bindCount = 0;
    const walk = (n, depth) => {
      if (depth > LIM.depth) return "depth";
      if (++count > LIM.nodesTotal) return "node count";
      if (!isPlain(n)) return "node not plain";
      if (!onlyKeys(n, ["type", "id", "props", "bind", "children", "untrusted"])) return "unexpected node key";
      if (typeof n.type !== "string" || !FROZEN.has(n.type)) return `type not frozen: ${String(n.type)}`;
      if (typeof n.id !== "string" || !/^n[0-9]+$/.test(n.id) || ids.has(n.id)) return "id format/dup";
      ids.add(n.id);
      const spec = NODE_SCHEMA[n.type];
      if (n.props !== void 0) {
        if (!isPlain(n.props) || !onlyKeys(n.props, Object.keys(spec.props ?? {}))) return `props off-schema for ${n.type}`;
        for (const [k, v] of Object.entries(n.props)) if (!propType(v, spec.props[k])) return `prop ${k} wrong type on ${n.type}`;
      }
      for (const req of spec.required ?? []) if (!n.props || !hasOwn(n.props, req)) return `missing prop ${req} on ${n.type}`;
      if (n.type === "approval-notice" && n.props?.notice !== APPROVAL_NOTICE) return "approval-notice text not the fixed PCC sentence";
      if (n.type === "card") {
        const k = n.props?.kind;
        if (k === "run") {
          if (!hasOwn(n.props, "statusFrom") || !hasOwn(n.props, "latestFrom")) return "run card missing selectors";
        } else if (hasOwn(n.props ?? {}, "statusFrom") || hasOwn(n.props ?? {}, "latestFrom")) return "capability card has run props";
      }
      if (n.bind !== void 0) {
        if (spec.noBind || !spec.bindKey) return `${n.type} must not bind`;
        if (!isPlain(n.bind) || !onlyKeys(n.bind, ["path", "select", "query", "pollMs", "sse", "schema"])) return "bind shape";
        const bk = n.type === "card" ? n.props.kind === "run" ? "run" : "capability" : spec.bindKey;
        const reason = bindMatchesPolicy(n.bind, bk);
        if (reason) return `bind: ${reason}`;
        if (++bindCount > LIM.boundWindowsTotal) return "bound-window budget";
      } else if (spec.needsBind) return `${n.type} requires a bind`;
      if (spec.prose && n.untrusted !== true) return `prose ${n.type} not untrusted`;
      if (!spec.prose && n.untrusted !== void 0) return `non-prose ${n.type} marked untrusted`;
      if (spec.childless) {
        if (n.children !== void 0) return `${n.type} may not have children`;
      } else {
        if (!Array.isArray(n.children)) return `${n.type} requires children array`;
        if (spec.minChildren !== void 0 && n.children.length < spec.minChildren) return `${n.type} too few children`;
        if (spec.maxChildren !== void 0 && n.children.length > spec.maxChildren) return `${n.type} too many children`;
        let windowKids = 0;
        for (let i = 0; i < n.children.length; i++) {
          const c = n.children[i];
          if (!isPlain(c) || !spec.parentOf || !spec.parentOf.includes(c.type)) return `illegal child under ${n.type}`;
          if (n.type === "section") {
            const ct = c.type;
            if (ct === "heading") {
              if (i !== 0) return "section heading must be first";
              if (c.props?.level !== 2) return "section heading must be H2";
            } else if (++windowKids > LIM.windowsPerSection) return "too many windows in section";
          }
          const e = walk(c, depth + 1);
          if (e) return e;
        }
      }
      return null;
    };
    const e1 = walk(doc.title, 0);
    if (e1) return { ok: false, reason: `title: ${e1}` };
    const e2 = walk(doc.root, 0);
    return e2 ? { ok: false, reason: e2 } : { ok: true };
  }

  // src/mcp/dashboard-ir-renderer.ts
  var CLS = {
    root: "pcc-ir",
    section: "pcc-section",
    heading: "pcc-heading",
    text: "pcc-text",
    stat: "pcc-stat",
    card: "pcc-card",
    receipt: "pcc-receipt",
    list: "pcc-list",
    badge: "pcc-badge",
    grid: "pcc-grid",
    "approval-notice": "pcc-approval",
    plan: "pcc-plan",
    "form-summary": "pcc-form",
    "field-label": "pcc-field",
    untrusted: "pcc-untrusted",
    invalid: "pcc-invalid",
    value: "pcc-value",
    row: "pcc-row",
    meta: "pcc-meta"
  };
  function readSelector(obj, sel) {
    let cur = obj;
    const segs = sel.split(".");
    for (const seg of segs) {
      if (seg === "__proto__" || seg === "constructor" || seg === "prototype") return "";
      if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return "";
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return "";
      cur = cur[seg];
    }
    if (typeof cur === "string") return cur;
    if (typeof cur === "number" && Number.isFinite(cur)) return String(cur);
    if (typeof cur === "boolean") return String(cur);
    return "";
  }
  function el(doc, cls, text, untrusted) {
    const n = doc.createElement("div");
    n.className = untrusted ? cls + " " + CLS.untrusted : cls;
    if (text !== void 0) n.textContent = text;
    return n;
  }
  function paintChildren(doc, node, into) {
    if (node.children) for (const c of node.children) into.appendChild(paintNode(doc, c));
  }
  var PAINTERS = Object.freeze({
    root: (d, n) => {
      const e = el(d, CLS.root);
      paintChildren(d, n, e);
      return e;
    },
    section: (d, n) => {
      const e = el(d, CLS.section);
      paintChildren(d, n, e);
      return e;
    },
    heading: (d, n) => el(d, CLS.heading, String(n.props?.text ?? ""), n.untrusted),
    text: (d, n) => el(d, CLS.text, String(n.props?.text ?? ""), n.untrusted),
    stat: (d, n) => {
      const e = el(d, CLS.stat);
      e.appendChild(el(d, CLS.heading, String(n.props?.label ?? ""), true));
      e.appendChild(el(d, CLS.value, "", true));
      return e;
    },
    card: (d, n) => el(d, CLS.card + (n.props?.kind === "run" ? " pcc-card-run" : " pcc-card-cap")),
    receipt: (d) => {
      const e = el(d, CLS.receipt);
      e.appendChild(el(d, CLS.value, "", true));
      return e;
    },
    list: (d) => {
      const e = el(d, CLS.list);
      return e;
    },
    // rows appended by bindList
    badge: (d, n) => {
      const e = el(d, CLS.badge, String(n.props?.text ?? ""), true);
      e.setAttr("data-tone", String(n.props?.tone ?? "neutral"));
      return e;
    },
    grid: (d, n) => {
      const e = el(d, CLS.grid);
      paintChildren(d, n, e);
      return e;
    },
    "approval-notice": (d, n) => el(d, CLS["approval-notice"], String(n.props?.notice ?? "")),
    plan: (d) => el(d, CLS.plan, "Composition (view-only)"),
    "form-summary": (d, n) => {
      const e = el(d, CLS["form-summary"]);
      paintChildren(d, n, e);
      return e;
    },
    "field-label": (d, n) => el(d, CLS["field-label"], String(n.props?.label ?? ""), true)
  });
  function paintNode(doc, node) {
    const p = PAINTERS[node.type];
    if (!p) {
      return el(doc, CLS.invalid, "");
    }
    return p(doc, node);
  }
  function renderIrDoc(doc, mount, ir) {
    while (mount.children.length) mount.children.pop();
    mount.appendChild(paintNode(doc, ir.title));
    mount.appendChild(paintNode(doc, ir.root));
  }
  function bindListRows(doc, listEl, node, rows) {
    const rowTitle = String(node.props?.rowTitle ?? "");
    const rowMeta = Array.isArray(node.props?.rowMeta) ? node.props.rowMeta : [];
    const statusFrom = typeof node.props?.statusFrom === "string" ? node.props.statusFrom : "";
    const limit = typeof node.props?.limit === "number" ? node.props.limit : rows.length;
    let shown = 0;
    for (const row of rows) {
      if (shown >= limit) break;
      if (row === null || typeof row !== "object") continue;
      const title = readSelector(row, rowTitle);
      if (title === "") continue;
      const line = el(doc, CLS.row);
      line.appendChild(el(doc, CLS.heading, title, true));
      for (const m of rowMeta) {
        const v = readSelector(row, m);
        if (v !== "") line.appendChild(el(doc, CLS.meta, v, true));
      }
      if (statusFrom) {
        const s = readSelector(row, statusFrom);
        if (s !== "") line.appendChild(el(doc, CLS.badge, s, true));
      }
      listEl.appendChild(line);
      shown++;
    }
  }
  function bindScalar(node, data) {
    const sel = node.bind?.select;
    if (!sel) return "";
    return readSelector(data, sel);
  }
  function bootIrView(doc, mount, rawDoc, validate) {
    if (!validate(rawDoc).ok) {
      while (mount.children.length) mount.children.pop();
      mount.appendChild(el(doc, CLS.invalid, "This dashboard could not be verified and was not rendered."));
      return false;
    }
    renderIrDoc(doc, mount, rawDoc);
    return true;
  }

  // src/mcp/dashboard-ir-binder.ts
  var BINDER_LIM = { maxBytes: 512 * 1024, maxRows: 200, minPollMs: 5e3, maxPollMs: 36e5, defaultPollMs: 3e4, sessionMs: 30 * 60 * 1e3 };
  function bindUrl(origin, bind) {
    const p = bind.path;
    if (typeof p !== "string" || p.length < 2) return null;
    if (p[0] !== "/" || p[1] === "/") return null;
    if (p.indexOf("..") !== -1) return null;
    if (/[\s<>"'`\\?#]/.test(p)) return null;
    if (p.indexOf("/api/") !== 0) return null;
    let qs = "";
    if (bind.query) {
      const parts = [];
      for (const k of Object.keys(bind.query)) {
        if (!Object.prototype.hasOwnProperty.call(bind.query, k)) continue;
        parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(bind.query[k])));
      }
      if (parts.length) qs = "?" + parts.join("&");
    }
    return origin + p + qs;
  }
  function channelFor(bind) {
    return bind.sse ? "sse" : "poll";
  }
  function clampPoll(bind) {
    const ms = typeof bind.pollMs === "number" && Number.isFinite(bind.pollMs) ? bind.pollMs : BINDER_LIM.defaultPollMs;
    return Math.max(BINDER_LIM.minPollMs, Math.min(ms, BINDER_LIM.maxPollMs));
  }
  function startBind(node, deps, onData) {
    const bind = node.bind;
    let stopped = false;
    let pollTimer = null;
    let sse = null;
    let sessionTimer = null;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (pollTimer !== null) {
        deps.clearTimer(pollTimer);
        pollTimer = null;
      }
      if (sessionTimer !== null) {
        deps.clearTimer(sessionTimer);
        sessionTimer = null;
      }
      if (sse) {
        sse.close();
        sse = null;
      }
    };
    if (!bind) return { stop };
    const url = bindUrl(deps.origin, bind);
    if (url === null) {
      stop();
      return { stop };
    }
    sessionTimer = deps.setTimer(stop, BINDER_LIM.sessionMs);
    if (channelFor(bind) === "sse" && deps.openSse && bind.sse) {
      const sseUrl = deps.origin + bind.sse;
      sse = deps.openSse(sseUrl, (d) => {
        if (!stopped) onData(d);
      }, () => stop());
    } else {
      let fails = 0;
      const nextDelay = () => Math.min(clampPoll(bind) * Math.pow(2, fails < 6 ? fails : 6), BINDER_LIM.maxPollMs);
      const tick = () => {
        if (stopped) return;
        deps.getJson(url, deps.makeSignal()).then((r) => {
          if (stopped) return;
          if (r.status === 200 && !r.redirected && !r.bytesOver) {
            fails = 0;
            onData(r.json);
          } else {
            fails++;
          }
          pollTimer = deps.setTimer(tick, nextDelay());
        }).catch(() => {
          if (stopped) return;
          fails++;
          pollTimer = deps.setTimer(tick, nextDelay());
        });
      };
      tick();
    }
    return { stop };
  }

  // src/mcp/dashboard-ir-browser-entry.ts
  var CAP = {
    docChars: 256 * 1024,
    // bounded manifest preflight: total string + key chars
    maxNodes: 2e4,
    // bounded manifest preflight: total DISTINCT nodes visited
    maxFanout: 4096,
    // bounded manifest preflight: per-container children
    maxPending: 1e5,
    // bounded manifest preflight: max enqueued (stack) references
    respBytes: 512 * 1024,
    // per-response byte cap (incremental)
    concurrent: 6,
    // global max in-flight binds
    reqTimeoutMs: 3e4,
    protocol: "2026-01-26",
    initId: 1
  };
  var MOUNT_ID = "pcc-ir-root";
  function pccApiOrigin() {
    const o = window.__PCC_IR_ORIGIN__;
    return typeof o === "string" && /^https:\/\/[a-z0-9.-]+$/i.test(o) ? o : null;
  }
  function wrapEl(real) {
    const children = [];
    const w = {
      _el: real,
      children,
      get textContent() {
        return real.textContent ?? "";
      },
      set textContent(v) {
        real.textContent = v;
      },
      get className() {
        return real.className;
      },
      set className(v) {
        real.className = v;
      },
      setAttr(n, v) {
        real.setAttribute(n, v);
      },
      appendChild(c) {
        real.appendChild(c._el);
        children.push(c);
        return c;
      }
    };
    return w;
  }
  var rdoc = { createElement: (tag) => wrapEl(document.createElement(tag)) };
  function inert(mount, msg) {
    const p = document.createElement("p");
    p.className = "pcc-invalid";
    p.textContent = msg;
    mount.replaceChildren(p);
  }
  function tooLarge(root) {
    const seen = /* @__PURE__ */ new WeakSet();
    let nodes = 0, chars = 0, pending = 1;
    const stack = [root];
    while (stack.length) {
      const v = stack.pop();
      pending--;
      if (++nodes > CAP.maxNodes) return true;
      if (typeof v === "string") {
        chars += v.length;
        if (chars > CAP.docChars) return true;
        continue;
      }
      if (!v || typeof v !== "object") continue;
      if (seen.has(v)) continue;
      seen.add(v);
      if (Array.isArray(v)) {
        if (v.length > CAP.maxFanout || pending + v.length > CAP.maxPending) return true;
        for (let i = 0; i < v.length; i++) {
          stack.push(v[i]);
          pending++;
        }
      } else {
        let kn = 0;
        for (const k in v) {
          if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
          if (++kn > CAP.maxFanout || pending + 1 > CAP.maxPending) return true;
          chars += k.length;
          if (chars > CAP.docChars) return true;
          stack.push(v[k]);
          pending++;
        }
      }
    }
    return false;
  }
  var inFlight = 0;
  var waiters = [];
  function acquire(signal) {
    if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
    if (inFlight < CAP.concurrent) {
      inFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const w = { wake: () => {
      }, onAbort: () => {
      } };
      w.onAbort = () => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(new DOMException("aborted", "AbortError"));
      };
      w.wake = () => {
        signal.removeEventListener("abort", w.onAbort);
        resolve();
      };
      signal.addEventListener("abort", w.onAbort, { once: true });
      waiters.push(w);
    });
  }
  function release() {
    const n = waiters.shift();
    if (n) n.wake();
    else inFlight--;
  }
  function concat(chunks, total) {
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
  async function realGetJson(url, signal) {
    const resp = await fetch(url, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store", headers: { accept: "application/json" }, signal });
    const redirected = resp.redirected;
    const ct = (resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (resp.status !== 200 || redirected || ct !== "application/json") {
      try {
        await resp.body?.cancel();
      } catch {
      }
      return { status: resp.status, redirected, bytesOver: false, json: null };
    }
    const reader = resp.body ? resp.body.getReader() : null;
    const chunks = [];
    let received = 0;
    if (reader) {
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.length;
          if (received > CAP.respBytes) {
            try {
              await reader.cancel();
            } catch {
            }
            return { status: 200, redirected: false, bytesOver: true, json: null };
          }
          chunks.push(value);
        }
      }
    }
    let json = null;
    try {
      json = JSON.parse(new TextDecoder().decode(concat(chunks, received)));
    } catch {
      json = null;
    }
    return { status: 200, redirected: false, bytesOver: false, json };
  }
  var rendered = false;
  var disposed = false;
  var boundHandles = [];
  var genController = null;
  var liveDoc = null;
  var liveRoot = null;
  function collectBound(doc) {
    const stats = [], lists = [], receipts = [];
    const walk = (n) => {
      if (n.bind) {
        if (n.type === "stat") stats.push(n);
        else if (n.type === "list") lists.push(n);
        else if (n.type === "receipt") receipts.push(n);
      }
      if (n.children) for (const c of n.children) walk(c);
    };
    walk(doc.root);
    return { stats, lists, receipts };
  }
  function startBinds(doc, root) {
    const origin = pccApiOrigin();
    if (!origin) return;
    const gen = new AbortController();
    genController = gen;
    const deps = {
      origin,
      // The signal is the GENERATION signal; per request we add a timeout + gen-link on a
      // fresh controller and clean BOTH up when the request settles (no leaked timer/listener).
      getJson: async (url, sig) => {
        const s = sig;
        await acquire(s);
        const ctrl = new AbortController();
        const onGen = () => ctrl.abort(new DOMException("generation aborted", "AbortError"));
        let timer = null;
        try {
          if (s.aborted) ctrl.abort();
          else s.addEventListener("abort", onGen, { once: true });
          timer = setTimeout(() => ctrl.abort(new DOMException("timeout", "TimeoutError")), CAP.reqTimeoutMs);
          return await realGetJson(url, ctrl.signal);
        } finally {
          if (timer !== null) clearTimeout(timer);
          s.removeEventListener("abort", onGen);
          release();
        }
      },
      // NO openSse: SSE transport intentionally absent (run cards are unbound below).
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h),
      makeSignal: () => gen.signal
    };
    const { stats, lists, receipts } = collectBound(doc);
    const byClass = (cls) => Array.from(root.querySelectorAll("." + cls));
    const statEls = byClass("pcc-stat"), listEls = byClass("pcc-list"), receiptEls = byClass("pcc-receipt");
    const push = (h) => boundHandles.push(h);
    stats.forEach((node, i) => {
      const el2 = statEls[i];
      const slot = el2?.querySelector(".pcc-value");
      if (slot) push(startBind(node, deps, (data) => {
        slot.textContent = bindScalar(node, data);
      }));
    });
    receipts.forEach((node, i) => {
      const el2 = receiptEls[i];
      const slot = el2?.querySelector(".pcc-value");
      if (slot) push(startBind(node, deps, (data) => {
        slot.textContent = bindScalar(node, data);
      }));
    });
    lists.forEach((node, i) => {
      const el2 = listEls[i];
      if (!el2) return;
      push(startBind(node, deps, (data) => {
        const rows = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray(data.items) ? data.items : [];
        el2.replaceChildren();
        bindListRows(rdoc, wrapEl(el2), node, rows);
      }));
    });
  }
  function stopBinds() {
    for (const h of boundHandles) h.stop();
    boundHandles = [];
    if (genController) {
      genController.abort();
      genController = null;
    }
  }
  function renderManifest(manifest) {
    if (disposed || rendered) return;
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;
    if (tooLarge(manifest)) {
      rendered = true;
      inert(mount, "This dashboard is too large and was not rendered.");
      return;
    }
    const r = dashboardManifestToIr(manifest);
    if (!r.ok) {
      rendered = true;
      inert(mount, "This dashboard could not be verified and was not rendered.");
      return;
    }
    rendered = true;
    const container = wrapEl(document.createElement("div"));
    const painted = bootIrView(rdoc, container, r.doc, validateIr);
    mount.replaceChildren(container._el);
    if (painted) {
      liveDoc = r.doc;
      liveRoot = container._el;
      startBinds(r.doc, container._el);
    }
  }
  function boot() {
    const parent = window.parent;
    let state = "init";
    window.addEventListener("message", (ev) => {
      if (ev.source !== parent) return;
      const d = ev.data;
      if (!d || typeof d !== "object" || d.jsonrpc !== "2.0") return;
      if (d.method === "ui/resource-teardown" && "id" in d) {
        if (!disposed) {
          disposed = true;
          stopBinds();
        }
        try {
          parent.postMessage({ jsonrpc: "2.0", id: d.id, result: {} }, "*");
        } catch {
        }
        return;
      }
      if (disposed) return;
      if (state === "init" && d.id === CAP.initId && d.result && typeof d.result === "object") {
        if (d.result.protocolVersion !== CAP.protocol) return;
        state = "ready";
        parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
        return;
      }
      if (state === "ready" && d.method === "ui/notifications/tool-result") {
        const params = d.params;
        const structured = params && typeof params === "object" ? params.structuredContent : null;
        const manifest = structured && typeof structured === "object" ? structured.manifest : null;
        if (manifest != null) renderManifest(manifest);
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (disposed) return;
      if (document.hidden) stopBinds();
      else if (liveDoc && liveRoot) {
        stopBinds();
        startBinds(liveDoc, liveRoot);
      }
    });
    window.addEventListener("pagehide", stopBinds);
    parent.postMessage({ jsonrpc: "2.0", id: CAP.initId, method: "ui/initialize", params: { protocolVersion: CAP.protocol, appInfo: { name: "pcc-dashboard-ir", version: "1" }, appCapabilities: {} } }, "*");
  }
  if (typeof window !== "undefined" && typeof document !== "undefined") boot();
})();
