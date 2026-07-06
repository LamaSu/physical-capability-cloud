/* @harness/control-plane — walkthrough.js
 *
 * The first-run onboarding: a short guided tour that IS the entry point.
 * What this is → pick your lens → the Ask box → run your first capability
 * → the trust/approval moment, seen once → how the plane grows.
 *
 * Skippable at every step; re-launchable from the "?" in the header.
 * Mobile: bottom sheet. Desktop: centered card. Targets get a spotlight
 * ring and are scrolled into view. Persists cp.walkthrough.done.
 */
(function () {
  'use strict';

  var CP = window.CP = window.CP || {};
  var DONE_KEY = 'cp.walkthrough.done';
  var active = false;
  var stepIndex = 0;
  var overlay = null;
  var spotEl = null;

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  // ── the steps ────────────────────────────────────────────────────────────
  var STEPS = [
    {
      title: 'Welcome to your control plane',
      body: 'One place to see and steer everything your agents can do — from a local code search to a priced, real-world job. You stay on this surface; the agents do the work behind it.',
      cta: 'Show me around'
    },
    {
      title: 'Pick your lens',
      body: 'The same plane, three projections. User: get an outcome. Operator: run and monetize your capacity. Orchestrator: compose and control everything. Switch anytime — it changes what is foregrounded, never what is true.',
      target: 'cp-lens',
      render: renderLensStep,
      cta: 'Continue'
    },
    {
      title: 'Just ask',
      body: 'Describe what you want in plain words. The plane routes it to the closest capability. Try "check the code index" or "who else is working right now".',
      target: 'region-ask',
      cta: 'Next'
    },
    {
      title: 'Your first capability',
      body: 'This is the Catalog — a curated handful to start, with the whole registry one tap away. Every card is generated from the capability itself, so new ones get a working view the moment they register. Tap any card to see its form and run it.',
      target: 'region-catalog',
      cta: 'Next'
    },
    {
      title: 'Trust, shown once',
      body: 'Badges tell you the stakes before you tap. Green read runs instantly. Anything that writes, executes, reaches out, or spends pauses first and asks you — like this:',
      render: renderTrustStep,
      cta: 'Got it'
    },
    {
      title: 'It grows as you go',
      body: 'You are seeing the smallest useful surface. Run something and Activity appears. Get asked for approval and Approvals appears. Switch lens and your console appears. The ＋ More button opens anything early, and ? replays this tour.',
      cta: 'Start using it'
    }
  ];

  function renderLensStep(host) {
    var row = el('div', 'wt-lens-row');
    (CP.lens && CP.lens.LENSES || []).forEach(function (L) {
      var b = el('button', 'wt-lens' + (CP.lens.get() === L.id ? ' active' : ''), '');
      b.type = 'button';
      b.appendChild(el('strong', null, L.label));
      b.appendChild(el('span', null, L.hint));
      b.onclick = function () {
        // silent: don't fire reveal toasts mid-tour; lens:changed still emits
        CP.lens.set(L.id, { silent: true });
        var sibs = row.querySelectorAll('.wt-lens');
        for (var i = 0; i < sibs.length; i++) sibs[i].classList.remove('active');
        b.classList.add('active');
      };
      row.appendChild(b);
    });
    host.appendChild(row);
  }

  function renderTrustStep(host) {
    // An inert sample approval card — the trust moment, previewed safely.
    var card = el('div', 'intr-card wt-sample');
    var head = el('div', 'run-head');
    head.appendChild(el('span', 'run-name', 'Order a Pizza'));
    head.appendChild(CP.render.trustBadge('write'));
    card.appendChild(head);
    card.appendChild(el('p', 'intr-msg', 'pizza.order wants to place a $18.99 order (escrowed until delivery is proven). Approve?'));
    var acts = el('div', 'actions');
    var ok = el('button', 'btn primary', 'Approve');
    var no = el('button', 'btn deny', 'Deny');
    ok.type = no.type = 'button';
    ok.disabled = no.disabled = true;
    acts.appendChild(ok);
    acts.appendChild(no);
    acts.appendChild(el('span', 'muted small', ' sample — nothing runs'));
    card.appendChild(acts);
    host.appendChild(card);
  }

  // ── overlay machinery ────────────────────────────────────────────────────
  function buildOverlay() {
    overlay = el('div', 'wt-overlay');
    overlay.id = 'cp-walkthrough';
    var sheet = el('div', 'wt-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Guided tour');
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
    return sheet;
  }

  function clearSpot() {
    if (spotEl) { spotEl.classList.remove('wt-spot'); spotEl = null; }
  }

  function spotlight(id) {
    clearSpot();
    if (!id) return;
    var t = document.getElementById(id);
    if (!t || t.hidden) return;
    t.classList.add('wt-spot');
    spotEl = t;
    try {
      var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
      t.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
    } catch (e) { /* older webview scrollIntoView(bool) */ }
  }

  function showStep(i) {
    stepIndex = i;
    var step = STEPS[i];
    var sheet = overlay.querySelector('.wt-sheet');
    while (sheet.firstChild) sheet.removeChild(sheet.firstChild);

    // progress dots
    var dots = el('div', 'wt-dots');
    for (var d = 0; d < STEPS.length; d++) {
      dots.appendChild(el('span', 'wt-dot' + (d === i ? ' on' : '')));
    }
    sheet.appendChild(dots);

    sheet.appendChild(el('h3', 'wt-title', step.title));
    sheet.appendChild(el('p', 'wt-body', step.body));
    if (step.render) {
      var extra = el('div', 'wt-extra');
      step.render(extra);
      sheet.appendChild(extra);
    }

    var acts = el('div', 'wt-actions');
    if (i > 0) {
      var back = el('button', 'btn ghost', 'Back');
      back.type = 'button';
      back.onclick = function () { showStep(i - 1); };
      acts.appendChild(back);
    }
    var skip = el('button', 'btn ghost', 'Skip tour');
    skip.type = 'button';
    skip.onclick = finish;
    acts.appendChild(skip);
    var next = el('button', 'btn primary', step.cta || (i === STEPS.length - 1 ? 'Done' : 'Next'));
    next.type = 'button';
    next.onclick = function () {
      if (i + 1 >= STEPS.length) finish();
      else showStep(i + 1);
    };
    acts.appendChild(next);
    sheet.appendChild(acts);

    spotlight(step.target);
    try { next.focus(); } catch (e) { /* no-op */ }
  }

  function finish() {
    clearSpot();
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    active = false;
    try { localStorage.setItem(DONE_KEY, '1'); } catch (e) { /* ignore */ }
    CP.bus.emit('walkthrough:done', { atStep: stepIndex });
  }

  function start(force) {
    if (active) return;
    if (!force && isDone()) return;
    active = true;
    buildOverlay();
    showStep(0);
    CP.bus.emit('walkthrough:started', {});
  }

  function isDone() {
    try { return localStorage.getItem(DONE_KEY) === '1'; } catch (e) { return false; }
  }

  CP.walkthrough = {
    start: start,
    finish: finish,
    isDone: isDone,
    maybeAutoStart: function () {
      // First run only. Small delay lets the shell paint underneath so the
      // spotlight has something real to point at.
      if (isDone()) return;
      setTimeout(function () { start(false); }, 350);
    }
  };
})();
