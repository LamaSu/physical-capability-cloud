import React, { useEffect } from "react";
import { Link } from "react-router-dom";
import { useUIStore } from "../../stores/ui-store.js";
import { TEMPLATE_LIST } from "./templates.js";

/**
 * Orchestrator landing — pick a template to start an automation flow.
 *
 * Each template (physical-operator, data-product, …) corresponds to a
 * @pcc/template-* package on the server. New templates appear here when
 * registered in apps/dashboard/src/routes/orchestrator/templates.ts (and
 * eventually via /api/orchestrator/templates once that route lands).
 */
export function OrchestratorLandingPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  useEffect(() => {
    setPageMeta("Orchestrator", "Pick a template to automate any business process on PCC.");
  }, [setPageMeta]);

  const physical = TEMPLATE_LIST.filter((t) => t.capability_class === "physical");
  const digital = TEMPLATE_LIST.filter((t) => t.capability_class === "digital");

  return (
    <div className="orchestrator-landing">
      <section>
        <h2>Physical capabilities</h2>
        <p className="muted">
          Templates that produce a kernel-agent for a real-world entity (shop, fleet, lab, warehouse, site).
        </p>
        <ul className="template-grid">
          {physical.map((t) => (
            <TemplateCard key={t.slug} template={t} />
          ))}
        </ul>
      </section>

      <section>
        <h2>Digital capabilities</h2>
        <p className="muted">
          Templates that produce a digital kernel — a queryable dataset, an inference endpoint, an automated knowledge-worker workflow.
        </p>
        <ul className="template-grid">
          {digital.map((t) => (
            <TemplateCard key={t.slug} template={t} />
          ))}
        </ul>
      </section>

      <p className="footnote muted">
        Adding a new template? Drop a manifest into <code>packages/template-&lt;slug&gt;/src/manifest.ts</code> using <code>defineTemplate()</code> from <code>@pcc/orchestrator-sdk</code>, then mirror the entry in <code>apps/dashboard/src/routes/orchestrator/templates.ts</code>.
      </p>
    </div>
  );
}

function TemplateCard({ template }: { template: typeof TEMPLATE_LIST[number] }) {
  return (
    <li className="template-card">
      <h3>{template.display_name}</h3>
      <p>{template.description}</p>
      <div className="template-card__row">
        <span className="pill">{template.capability_class}</span>
        <span className="pill">{template.produces_kind}</span>
      </div>
      <Link className="cta" to={`/orchestrator/${template.slug}/chat`}>
        Start →
      </Link>
    </li>
  );
}

export default OrchestratorLandingPage;
