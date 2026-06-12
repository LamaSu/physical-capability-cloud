import React from "react";

/**
 * AgentLandingHero — the agent-first hero for capability.network.
 *
 * Ports the design DNA of pcc-operator-onboard/onboard-ui.html: dark/lime/Bricolage
 * aesthetic, grid + glow + grain atmosphere, the machine / human / asset lanes, and the
 * "Agentically compose reality." manifesto.
 *
 * Two deliberate adaptations vs the source:
 *  - Atmosphere layers are position:absolute (scoped to this <section>), NOT position:fixed,
 *    so the existing LandingPage renders cleanly below with its own look intact.
 *  - Every entrypoint is a real <a href> pointing at a live PCC endpoint, so an agent
 *    reading the DOM finds the agent-package, the ERC-8004 well-known file, and the
 *    capabilities API immediately. Pairs with index.html JSON-LD + public/llms.txt.
 *
 * All CSS is scoped under `.alh` (own custom-property block, own class prefix) so it
 * cannot collide with the 3,300-line landing that follows it.
 */
export function AgentLandingHero() {
  return (
    <>
      <style>{CSS}</style>
      <section className="alh" aria-label="Physical Capability Cloud — agent entrypoint">
        <div className="alh-grid" aria-hidden="true" />
        <div className="alh-glow" aria-hidden="true" />
        <div className="alh-grain" aria-hidden="true" />

        <div className="alh-top">
          <a className="alh-brand" href="/" aria-label="PCC home">
            <span className="alh-mark" aria-hidden="true" />
            <b>PCC</b>
            <span>// capability.network</span>
          </a>
          <nav className="alh-entry" aria-label="Agent entrypoints">
            <a href="/agent-package.json">agent-package.json</a>
            <a href="/.well-known/agent-registration.json">.well-known</a>
            <a href="/api/capabilities">/api/capabilities</a>
          </nav>
        </div>

        <div className="alh-hero">
          <div className="alh-eyebrow">The cloud instance for the physical world</div>
          <h1>
            Put any <span className="em">capability</span> on the network.
            <br />
            Agents compose the rest.
          </h1>
          <p>
            Wrap a machine, a human skill, or an autonomous asset as a callable, composable
            PCC capability. Humans and AI agents share one API — discover, price, and settle on
            verified evidence with milestone escrow.
          </p>
          <div className="alh-manifesto">
            <span className="mk" aria-hidden="true">&#9670;</span> Agentically compose reality.
          </div>

          <div className="alh-cta">
            <a className="alh-btn primary" href="/onboard">Publish a capability →</a>
            <a className="alh-btn" href="/discover">Browse capabilities</a>
            <a className="alh-btn ghost" href="/agent-package.json">Agent package ↗</a>
          </div>
        </div>

        <div className="alh-lanes">
          <a className="alh-lane m" href="/onboard">
            <div className="ico">▣ MACHINE</div>
            <h3>A machine</h3>
            <p>
              Robot, printer, instrument, lab. Bound by an adapter; <code>pcc-node</code> polls for
              jobs and runs them locally — your endpoint never faces the network.
            </p>
            <span className="tag">Opentrons · Prusa · HPLC · CNC</span>
          </a>
          <a className="alh-lane h" href="/onboard">
            <div className="ico">◐ HUMAN</div>
            <h3>A human skill</h3>
            <p>
              A person offering a skill. Gets pinged, accepts within a window, finishes by a
              deadline — the rideshare contract, on-chain.
            </p>
            <span className="tag">courier · field tech · inspector</span>
          </a>
          <a className="alh-lane a" href="/onboard">
            <div className="ico">◈ ASSET</div>
            <h3>An asset</h3>
            <p>
              An asset that posts <b>outbound demand</b> on its own behalf. You set its budget; it
              bids for the capabilities it needs to use.
            </p>
            <span className="tag">warehouse · vehicle · dataset</span>
          </a>
        </div>

        <div className="alh-agentbar">
          <span className="alh-agentbar-h">Agents start here</span>
          <a href="/agent-package.json">219-tool agent package</a>
          <a href="/.well-known/agent-registration.json">ERC-8004 registration</a>
          <a href="/api/capabilities/types">capability types</a>
          <a href="/llms.txt">llms.txt</a>
          <span className="alh-scroll" aria-hidden="true">↓ the full site below</span>
        </div>
      </section>
    </>
  );
}

const CSS = `
.alh{
  --bg:#0a0c10; --bg2:#0c0f15; --surface:#11151d; --surface2:#161b25;
  --line:rgba(150,172,205,.10); --line2:rgba(150,172,205,.20);
  --fg:#e9edf4; --muted:#8b94a6; --faint:#5b6475;
  --lime:#c6f24e; --cyan:#6cd6ff; --amber:#ffb24d; --violet:#c8a2ff;
  --accent:var(--lime);
  --mono:'JetBrains Mono',ui-monospace,monospace;
  --sans:'Instrument Sans',system-ui,sans-serif;
  --display:'Bricolage Grotesque',var(--sans);
  position:relative; isolation:isolate; overflow:hidden;
  background:var(--bg); color:var(--fg); font-family:var(--sans);
  -webkit-font-smoothing:antialiased; line-height:1.5;
  min-height:100vh; display:flex; flex-direction:column;
  padding:0 clamp(18px,4vw,52px) clamp(40px,6vw,72px);
}
.alh *{box-sizing:border-box}
.alh-grid,.alh-glow,.alh-grain{position:absolute;inset:0;pointer-events:none;z-index:0}
.alh-grid{
  background-image:
    linear-gradient(var(--line) 1px,transparent 1px),
    linear-gradient(90deg,var(--line) 1px,transparent 1px),
    linear-gradient(rgba(150,172,205,.05) 1px,transparent 1px),
    linear-gradient(90deg,rgba(150,172,205,.05) 1px,transparent 1px);
  background-size:160px 160px,160px 160px,32px 32px,32px 32px;
  mask-image:radial-gradient(ellipse 120% 90% at 50% 0%,#000 30%,transparent 95%);
  -webkit-mask-image:radial-gradient(ellipse 120% 90% at 50% 0%,#000 30%,transparent 95%);
  opacity:.6;
}
.alh-glow{
  background:
    radial-gradient(60% 50% at 82% -5%,rgba(198,242,78,.12),transparent 60%),
    radial-gradient(55% 45% at 8% 8%,rgba(108,214,255,.09),transparent 60%);
}
.alh-grain{
  opacity:.045;mix-blend-mode:overlay;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
.alh > *:not(.alh-grid):not(.alh-glow):not(.alh-grain){position:relative;z-index:1}

.alh-top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 0 0;flex-wrap:wrap}
.alh-brand{display:flex;align-items:center;gap:12px;font-family:var(--mono);font-size:13px;letter-spacing:.04em;text-decoration:none;color:var(--fg)}
.alh-mark{width:26px;height:26px;border:1.5px solid var(--lime);border-radius:7px;position:relative;flex:none}
.alh-mark::before,.alh-mark::after{content:"";position:absolute;background:var(--lime)}
.alh-mark::before{inset:6px auto 6px 6px;width:2px}
.alh-mark::after{inset:6px 6px auto 6px;height:2px}
.alh-brand b{color:var(--fg);font-weight:700}
.alh-brand span{color:var(--faint)}
.alh-entry{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-family:var(--mono);font-size:11.5px}
.alh-entry a{color:var(--muted);text-decoration:none;padding:6px 11px;border:1px solid var(--line2);border-radius:999px;transition:.18s;white-space:nowrap}
.alh-entry a:hover{color:var(--cyan);border-color:rgba(108,214,255,.4)}

.alh-hero{margin:clamp(40px,9vh,104px) 0 clamp(26px,4vw,42px);max-width:900px}
.alh-eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:var(--accent)}
.alh-hero h1{font-family:var(--display);font-weight:800;font-size:clamp(34px,6vw,66px);line-height:1.03;letter-spacing:-.025em;margin:.3em 0 .22em}
.alh-hero h1 .em{color:var(--accent)}
.alh-hero p{color:var(--muted);max-width:62ch;font-size:clamp(15px,1.5vw,17px)}
.alh-manifesto{font-family:var(--display);font-weight:800;font-size:clamp(22px,3.6vw,40px);letter-spacing:-.025em;margin-top:26px;color:var(--lime);display:flex;align-items:center;gap:14px;text-shadow:0 0 44px rgba(198,242,78,.35)}
.alh-manifesto .mk{font-size:.58em;opacity:.78;animation:alh-blip 2.4s infinite}
.alh-manifesto::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,rgba(198,242,78,.5),transparent)}
@keyframes alh-blip{0%,100%{opacity:1}50%{opacity:.3}}

.alh-cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:30px}
.alh-btn{font-family:var(--mono);font-size:13.5px;letter-spacing:.02em;padding:13px 22px;border-radius:11px;border:1px solid var(--line2);background:transparent;color:var(--muted);cursor:pointer;transition:.18s;text-decoration:none;display:inline-flex;align-items:center}
.alh-btn:hover{color:var(--fg);border-color:var(--fg);transform:translateY(-1px)}
.alh-btn.primary{background:var(--accent);color:#0a0c10;border-color:var(--accent);font-weight:700}
.alh-btn.primary:hover{filter:brightness(1.08)}
.alh-btn.ghost{color:var(--faint)}

.alh-lanes{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:8px}
@media(max-width:820px){.alh-lanes{grid-template-columns:1fr}}
.alh-lane{position:relative;text-align:left;padding:22px;border:1px solid var(--line2);border-radius:14px;background:var(--surface2);text-decoration:none;color:var(--fg);transition:.22s;overflow:hidden;display:block}
.alh-lane:hover{transform:translateY(-3px);border-color:var(--lc)}
.alh-lane::after{content:"";position:absolute;inset:0;background:radial-gradient(120% 80% at 100% 0%,var(--lcg),transparent 60%);opacity:.5;pointer-events:none}
.alh-lane .ico{font-family:var(--mono);font-size:12px;color:var(--lc);letter-spacing:.1em}
.alh-lane h3{font-family:var(--display);font-weight:700;font-size:22px;margin:10px 0 6px}
.alh-lane p{color:var(--muted);font-size:13.5px;margin:0}
.alh-lane code{font-family:var(--mono);font-size:12px;color:var(--lc)}
.alh-lane .tag{margin-top:14px;display:inline-block;font-family:var(--mono);font-size:10.5px;color:var(--faint);border:1px solid var(--line);border-radius:6px;padding:4px 8px}
.alh-lane.m{--lc:var(--cyan);--lcg:rgba(108,214,255,.16)}
.alh-lane.h{--lc:var(--amber);--lcg:rgba(255,178,77,.16)}
.alh-lane.a{--lc:var(--violet);--lcg:rgba(200,162,255,.16)}

.alh-agentbar{margin-top:26px;display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;padding:15px 18px;border:1px solid var(--line);border-radius:12px;background:linear-gradient(180deg,var(--surface),var(--bg2));font-family:var(--mono);font-size:12px}
.alh-agentbar-h{color:var(--lime);letter-spacing:.14em;text-transform:uppercase;font-size:11px}
.alh-agentbar a{color:var(--muted);text-decoration:none;border-bottom:1px dashed var(--line2);padding-bottom:1px;transition:.15s}
.alh-agentbar a:hover{color:var(--cyan);border-color:var(--cyan)}
.alh-scroll{margin-left:auto;color:var(--faint)}
@media(max-width:560px){.alh-scroll{margin-left:0}}
`;
