/* @harness/genui-render — renderer registry (THE extensibility mechanism)
 *
 * The control-plane UI is a function of the schema: engine.js GENERATES a
 * working view for every UnifiedCapability, and events.js renders the AG-UI
 * event vocabulary. This module is how you OVERRIDE that default with a
 * custom rich renderer (a 3D-print preview, a map, a DAG) without touching
 * core — the "add on to things, e.g. limited to kind:job" mechanism.
 *
 * ── EXTENSION CONTRACT ──────────────────────────────────────────────────────
 *
 *   registerRenderer(key, fn [, opts]) → unregister()
 *
 *   key — WHAT the renderer applies to. One of five prefixed forms:
 *     'cap:id:<capability-id>'   exact capability id      (specificity 30)
 *     'cap:kind:<kind>'          cap.definition.kind      (specificity 20)
 *                                (falls back to cap.kind) e.g. 'job'
 *     'cap:source:<source>'      cap.source               (specificity 10)
 *                                e.g. 'pcc', 'mcp', 'cli'
 *     'event:custom:<name>'      CUSTOM AG-UI events by   (specificity 20)
 *                                event.name, e.g. 'pcc.escrow'
 *     'event:type:<TYPE>'        any AG-UI event.type     (specificity 10)
 *                                e.g. 'TOOL_CALL_RESULT'
 *
 *   fn — the renderer:
 *     capability renderer:  fn(cap,   opts, api) → HTMLElement | null
 *     event renderer:       fn(event, ctx,  api) → HTMLElement | null
 *     Return an element to take over rendering. Return null/undefined to
 *     DECLINE — resolution falls through to the next candidate and finally
 *     to the generated default. `api` is the engine/events public surface
 *     (panels, form generator, helpers) so custom renderers can COMPOSE the
 *     generated pieces (e.g. draw a 3D preview, then append
 *     api.panels.paramsForm(cap, opts) underneath).
 *
 *   opts — { name?: string, priority?: number } (default priority 0).
 *   Resolution order: specificity desc → priority desc → latest registered.
 *
 *   HYGIENE REQUIRED of custom renderers: untrusted strings go through
 *   textContent / createElement ONLY — never innerHTML. Same rule core obeys.
 *
 * ── USER RENDERER FILES (drop-in, no core edits) ────────────────────────────
 *
 *   Conventional dir: ~/.claude/genui-renderers/*.js
 *   Template: lib/genui-render/user-renderer.example.js
 *
 *   A user renderer file must work in BOTH load modes:
 *     browser  — self-register on load:
 *                  (function (G) { if (!G || !G.registry) return;
 *                     G.registry.registerRenderer('cap:kind:job', fn, {...});
 *                  })(globalThis.GenUIRender);
 *     node     — additionally export a hook:
 *                  if (typeof module !== 'undefined') module.exports =
 *                    function register(registry) { ... };
 *
 *   Loading:
 *     Node:     registry.loadUserRenderers()            — reads the dir above
 *               registry.loadUserRenderers('/some/dir') — explicit dir
 *     Browser:  registry.loadUserRenderers(['./user-renderer.example.js'])
 *               registry.loadUserRenderers('/api/genui-renderers')  — a URL
 *               returning a JSON array of script URLs; each script
 *               self-registers as above. Fail-open: one bad file never
 *               blocks the rest; errors are collected and returned.
 *
 * ── MODULE FORMAT (zero-build universal) ────────────────────────────────────
 * Plain script + CommonJS + ES-module-compatible (side-effect import).
 * No `export` statements on purpose: Chrome refuses `import` of file:// module
 * URLs, and demo.html must open with no server; plain <script src> works
 * everywhere (dashboard http, Android webview, file://). Consumption:
 *   browser:  <script src="registry.js"></script> → globalThis.GenUIRender.registry
 *   node:     const registry = require('./registry.js');
 *   esm:      import './registry.js'; then globalThis.GenUIRender.registry
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  var g = (root.GenUIRender = root.GenUIRender || {});
  g.registry = api;
  if (typeof module === 'object' && module !== null && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VALID_PREFIXES = ['cap:id:', 'cap:kind:', 'cap:source:', 'event:custom:', 'event:type:'];
  var SPECIFICITY = { 'cap:id:': 30, 'cap:kind:': 20, 'cap:source:': 10, 'event:custom:': 20, 'event:type:': 10 };

  /** @type {Map<string, Array<{key:string, fn:Function, name:string, priority:number, seq:number}>>} */
  var buckets = new Map();
  var seqCounter = 0;

  function prefixOf(key) {
    for (var i = 0; i < VALID_PREFIXES.length; i++) {
      if (key.indexOf(VALID_PREFIXES[i]) === 0 && key.length > VALID_PREFIXES[i].length) {
        return VALID_PREFIXES[i];
      }
    }
    return null;
  }

  /**
   * Register a custom renderer. See EXTENSION CONTRACT in the file header.
   * @param {string} key       e.g. 'cap:kind:job', 'cap:id:pcc:print3d:job.submit'
   * @param {Function} fn      (capOrEvent, optsOrCtx, api) → HTMLElement|null
   * @param {{name?:string, priority?:number}} [opts]
   * @returns {Function} unregister — removes exactly this registration
   */
  function registerRenderer(key, fn, opts) {
    if (typeof key !== 'string' || !prefixOf(key)) {
      throw new TypeError(
        'registerRenderer: key must be one of ' + VALID_PREFIXES.map(function (p) { return p + '<value>'; }).join(', ') +
        ' — got: ' + String(key)
      );
    }
    if (typeof fn !== 'function') {
      throw new TypeError('registerRenderer: fn must be a function (cap|event, opts|ctx, api) → HTMLElement|null');
    }
    opts = opts || {};
    var entry = {
      key: key,
      fn: fn,
      name: typeof opts.name === 'string' ? opts.name : key,
      priority: typeof opts.priority === 'number' ? opts.priority : 0,
      seq: ++seqCounter,
    };
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
    return function unregister() {
      var arr = buckets.get(key);
      if (!arr) return false;
      var i = arr.indexOf(entry);
      if (i === -1) return false;
      arr.splice(i, 1);
      if (arr.length === 0) buckets.delete(key);
      return true;
    };
  }

  /** Remove ALL renderers registered under a key. @returns {number} removed count */
  function unregisterRenderer(key) {
    var arr = buckets.get(key);
    var n = arr ? arr.length : 0;
    buckets.delete(key);
    return n;
  }

  /** True when the subject looks like an AG-UI event (UPPER_SNAKE .type, no .source). */
  function isEvent(subject) {
    return !!subject && typeof subject.type === 'string' &&
      /^[A-Z][A-Z0-9_]*$/.test(subject.type) && typeof subject.source === 'undefined';
  }

  function candidateKeys(subject) {
    if (!subject || typeof subject !== 'object') return [];
    if (isEvent(subject)) {
      var keys = [];
      if (subject.type === 'CUSTOM' && typeof subject.name === 'string') {
        keys.push('event:custom:' + subject.name);
      }
      keys.push('event:type:' + subject.type);
      return keys;
    }
    // Capability
    var out = [];
    if (typeof subject.id === 'string') out.push('cap:id:' + subject.id);
    var kind = (subject.definition && subject.definition.kind) || subject.kind;
    if (typeof kind === 'string') out.push('cap:kind:' + kind);
    if (typeof subject.source === 'string') out.push('cap:source:' + subject.source);
    return out;
  }

  function sortEntries(a, b) {
    var sa = SPECIFICITY[prefixOf(a.key)] || 0;
    var sb = SPECIFICITY[prefixOf(b.key)] || 0;
    if (sb !== sa) return sb - sa;              // higher specificity first
    if (b.priority !== a.priority) return b.priority - a.priority; // higher priority first
    return b.seq - a.seq;                       // latest registered first
  }

  /**
   * All matching renderer entries for a capability or event, in resolution
   * order (specificity → priority → recency). The caller tries each fn until
   * one returns a node, then falls through to the generated default.
   * @returns {Array<{key:string, fn:Function, name:string, priority:number}>}
   */
  function resolveAll(subject) {
    var keys = candidateKeys(subject);
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var arr = buckets.get(keys[i]);
      if (arr) out = out.concat(arr);
    }
    out.sort(sortEntries);
    return out;
  }

  /**
   * The single best custom renderer for a capability or event, or null.
   * (engine/events use resolveAll for decline-fallthrough; this is the
   * simple query surface.)
   * @returns {{key:string, fn:Function, name:string, priority:number} | null}
   */
  function resolveRenderer(subject) {
    var all = resolveAll(subject);
    return all.length ? all[0] : null;
  }

  /** Snapshot of every registration (for debugging / the demo page). */
  function listRenderers() {
    var out = [];
    buckets.forEach(function (arr) {
      for (var i = 0; i < arr.length; i++) {
        out.push({ key: arr[i].key, name: arr[i].name, priority: arr[i].priority, seq: arr[i].seq });
      }
    });
    out.sort(function (a, b) { return a.seq - b.seq; });
    return out;
  }

  /** Remove everything (tests). */
  function clear() { buckets = new Map(); }

  // ── User-renderer loading (conventional dir / script URLs) ────────────────

  var DEFAULT_USER_DIR_SEGMENTS = ['.claude', 'genui-renderers'];

  function isNode() {
    return typeof process !== 'undefined' && process.versions && process.versions.node &&
      typeof require === 'function';
  }

  /**
   * Load drop-in user renderer files. Fail-open per file.
   *
   * Node:    loadUserRenderers([dirPath]) — default ~/.claude/genui-renderers.
   *          Requires each *.js; if the module exports a function it is called
   *          with this registry; `{ register(registry) }` also honored; files
   *          may instead self-register via globalThis.GenUIRender.registry.
   * Browser: loadUserRenderers(arrayOfScriptUrls | manifestUrl) — injects
   *          <script> tags sequentially; scripts self-register on load.
   *          A manifestUrl must return a JSON array of script URLs.
   *
   * @returns {Promise<{ok:boolean, loaded:string[], errors:Array<{file:string, error:string}>}>}
   */
  function loadUserRenderers(target) {
    if (isNode()) return Promise.resolve(loadUserRenderersNode(target));
    return loadUserRenderersBrowser(target);
  }

  function loadUserRenderersNode(dirPath) {
    var fs = require('fs');
    var path = require('path');
    var os = require('os');
    var dir = typeof dirPath === 'string' && dirPath
      ? dirPath
      : path.join(os.homedir(), DEFAULT_USER_DIR_SEGMENTS[0], DEFAULT_USER_DIR_SEGMENTS[1]);
    var result = { ok: true, dir: dir, loaded: [], errors: [] };
    var names;
    try { names = fs.readdirSync(dir); }
    catch (e) { return result; } // no dir → nothing to load; not an error
    names.sort();
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (name.charAt(0) === '.' || name.charAt(0) === '_') continue;
      if (!/\.js$/.test(name)) continue;
      var abs = path.join(dir, name);
      try {
        var mod = require(abs);
        if (typeof mod === 'function') mod(api);
        else if (mod && typeof mod.register === 'function') mod.register(api);
        // else: the file self-registered via globalThis.GenUIRender.registry
        result.loaded.push(abs);
      } catch (e) {
        result.ok = false;
        result.errors.push({ file: abs, error: String((e && e.message) || e) });
      }
    }
    return result;
  }

  function loadUserRenderersBrowser(target) {
    var doc = root.document;
    if (!doc || !doc.createElement) {
      return Promise.resolve({ ok: false, loaded: [], errors: [{ file: '(document)', error: 'no DOM available' }] });
    }
    var urlsPromise;
    if (Array.isArray(target)) {
      urlsPromise = Promise.resolve(target);
    } else if (typeof target === 'string') {
      urlsPromise = fetch(target)
        .then(function (r) { return r.json(); })
        .then(function (j) { return Array.isArray(j) ? j : []; });
    } else {
      urlsPromise = Promise.resolve([]);
    }
    return urlsPromise.then(function (urls) {
      var result = { ok: true, loaded: [], errors: [] };
      var chain = Promise.resolve();
      urls.forEach(function (url) {
        chain = chain.then(function () {
          return new Promise(function (resolve) {
            var s = doc.createElement('script');
            s.src = url;
            s.async = false;
            s.onload = function () { result.loaded.push(url); resolve(); };
            s.onerror = function () {
              result.ok = false;
              result.errors.push({ file: url, error: 'script load failed' });
              resolve(); // fail-open: keep loading the rest
            };
            (doc.head || doc.body || doc.documentElement).appendChild(s);
          });
        });
      });
      return chain.then(function () { return result; });
    }).catch(function (e) {
      return { ok: false, loaded: [], errors: [{ file: String(target), error: String((e && e.message) || e) }] };
    });
  }

  var api = {
    registerRenderer: registerRenderer,
    unregisterRenderer: unregisterRenderer,
    resolveRenderer: resolveRenderer,
    resolveAll: resolveAll,
    listRenderers: listRenderers,
    loadUserRenderers: loadUserRenderers,
    clear: clear,
    isEvent: isEvent,
    _candidateKeys: candidateKeys, // exposed for tests
  };
  return api;
});
