/* @harness/control-plane — regions/portal-mount.js  (B3 wave 1)
 *
 * Shell-side wiring for the agent portal (genui-render/portal.js):
 *
 *   - loads portal.js (classic <script> injection, path candidates, fail-open
 *     — same technique as regions/activity.js uses for engine/events),
 *   - configures the documented HTTP transport against CP.api.base(),
 *   - mounts the GLOBAL affordance (floating ✦ button, its own thread),
 *   - injects the PER-VIEW composer ("Ask about / refine this view") into
 *     every capability detail sheet the catalog opens (bus 'cap:opened' —
 *     no catalog.js edits), with an AG-UI thread scoped to that view
 *     (stable 't-view-<capId>' so reopening continues the conversation),
 *   - routes agent-driven re-renders: CUSTOM portal.view data lands back
 *     through engine.renderCapability(mode:'result') — which consults
 *     registry.registerRenderer'd overrides, so a portal.renderer template
 *     visibly reshapes the view.
 *
 * HONESTY: the portal module itself owns the degraded state ("No agent
 * connected — connect an LLM to enable conversation", probe of
 * GET /api/portal/agent). This file only wires; it adds no pretending.
 * If portal.js cannot be loaded (e.g. /genui-render/* not served on this
 * origin), nothing mounts and nothing breaks.
 */
(function () {
  'use strict';

  var CP = window.CP = window.CP || {};
  if (!CP.bus || !CP.api) return;
  var bus = CP.bus;
  var el = CP.el || function (tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  };

  function havePortal() {
    var G = window.GenUIRender;
    return !!(G && G.portal && typeof G.portal.attach === 'function');
  }
  function injectScript(src) {
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = function () { resolve(true); };
      s.onerror = function () { if (s.parentNode) s.parentNode.removeChild(s); resolve(false); };
      (document.head || document.body || document.documentElement).appendChild(s);
    });
  }
  function loadPortal() {
    if (havePortal()) return Promise.resolve(true);
    var candidates = ['../genui-render/portal.js', '/genui-render/portal.js', './engine/portal.js'];
    var i = 0;
    function next() {
      if (havePortal()) return Promise.resolve(true);
      if (i >= candidates.length) return Promise.resolve(false);
      return injectScript(candidates[i++]).then(function () { return next(); });
    }
    return next();
  }

  function threadForCap(capId) {
    return 't-view-' + String(capId || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48);
  }

  function findCap(capId) {
    if (!CP.catalog || !CP.catalog.all) return null;
    var all = CP.catalog.all();
    for (var i = 0; i < all.length; i++) if (all[i].id === capId) return all[i];
    return null;
  }

  // Render agent-refreshed view data back INTO the view through the engine —
  // this path consults custom renderers, so portal.renderer templates
  // registered via registry.registerRenderer visibly re-shape the result.
  function renderViewData(host, cap, value) {
    var G = window.GenUIRender;
    if (!host) return;
    var block = el('div', 'gur-scope');
    block.appendChild(el('div', 'muted small', 'view updated by the agent'));
    var node = null;
    if (G && G.engine && typeof G.engine.renderCapability === 'function' && cap) {
      try {
        node = G.engine.renderCapability(cap, {
          mode: 'result',
          result: value && value.result !== undefined ? value.result : value,
          lens: CP.lens && CP.lens.get()
        });
      } catch (e) { node = null; }
    }
    if (!node) {
      node = el('pre', 'intr-meta');
      try { node.textContent = JSON.stringify(value, null, 2); } catch (e) { node.textContent = String(value); }
    }
    block.appendChild(node);
    host.appendChild(block);
    try { host.scrollTop = host.scrollHeight; } catch (e) { /* fine */ }
  }

  function mountIntoDetail(capId) {
    if (!havePortal()) return;
    var panel = document.querySelector('.detail');
    if (!panel || panel.querySelector('.gur-portal')) return; // one per sheet
    var cap = findCap(capId);
    var portal = window.GenUIRender.portal;
    var view = {
      threadId: threadForCap(capId),
      capId: capId,
      lens: CP.lens && CP.lens.get(),
      title: (cap && cap.name) || capId,
      rendererKey: capId ? ('cap:id:' + capId) : null,
      onRerender: function (key) {
        if (CP.toast) CP.toast('View renderer updated by the agent');
        bus.emit('portal:rerender', { key: key, capId: capId });
      }
    };
    var mounted = portal.attach(panel, view);
    // stream agent view-data refreshes into the composer's reply area
    view.onViewData = function (value) {
      var replies = mounted.el.querySelector('.gur-portal-replies');
      if (replies) replies.classList.add('has-content');
      renderViewData(replies, cap, value);
    };
  }

  loadPortal().then(function (ok) {
    if (!ok) return; // absent on this origin — documented gap, nothing to fake
    var portal = window.GenUIRender.portal;
    portal.setTransport(portal.httpTransport(CP.api.base() || ''));

    // keep the transport pointed at the right spine if the user re-targets it
    bus.on('api:base-changed', function (p) {
      portal.setTransport(portal.httpTransport((p && p.base) || CP.api.base() || ''));
    });

    // the global affordance — one floating entry point to the agent
    portal.attachGlobal({ lens: CP.lens && CP.lens.get() });

    // the per-view affordance — every capability detail sheet gets one
    bus.on('cap:opened', function (p) {
      if (p && p.capId) mountIntoDetail(p.capId);
    });

    bus.emit('portal:ready', {});
  });
})();
