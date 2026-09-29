/**
 * Printable, plain HTML intake form — one section per group (spec order), one
 * field per question. No external CSS/JS: everything is inlined so the file
 * opens standalone. Shared by the generator script
 * (packages/spec/scripts/build-onboarding-docs.mts, which writes it to
 * docs/onboarding/intake/form.html) and onboarding-intake.test.ts (which
 * regenerates it in-memory and compares against the committed file).
 */
import { INTAKE_GROUPS, type IntakeFieldDef, type IntakeGroup } from "./fields.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const GROUP_TITLES: Record<IntakeGroup, string> = {
  identity: "Identity",
  device: "Device",
  location: "Location",
  network: "Network",
  safety: "Safety",
  consumables: "Consumables",
  calibration: "Calibration",
  evidence: "Evidence",
  capability: "Capability",
  pricing: "Pricing",
  payout: "Payout",
  availability: "Availability",
  sla: "SLA",
};

function badge(text: string, kind: string): string {
  return `<span class="badge badge-${kind}">${escapeHtml(text)}</span>`;
}

function fieldBadges(field: IntakeFieldDef): string {
  const badges: string[] = [badge(`class ${field.class}`, "class")];
  if (field.neverDefault) badges.push(badge("never defaulted", "never-default"));
  if (field.selfDeclaredOnly) badges.push(badge("self-declared", "self-declared"));
  if (field.sensitive) badges.push(badge("sensitive: do not write it here", "sensitive"));
  if (field.evidencePrimitive) {
    const suffix = field.evidencePrimitive.status === "stub" ? " — stub = proves nothing yet" : "";
    badges.push(
      badge(`evidence: ${field.evidencePrimitive.id} (${field.evidencePrimitive.status}${suffix})`, "evidence"),
    );
  }
  return badges.join("\n        ");
}

function fieldSection(field: IntakeFieldDef): string {
  return `      <div class="field" id="${escapeHtml(field.id)}">
        <div class="field-id">${escapeHtml(field.id)}</div>
        <div class="question">${escapeHtml(field.question)}</div>
        <div class="why">${escapeHtml(field.why)}</div>
        ${fieldBadges(field)}
        <div class="meta">required for: ${escapeHtml(field.requiredFor)}</div>
      </div>`;
}

function groupSection(group: IntakeGroup, fields: readonly IntakeFieldDef[]): string {
  const rows = fields
    .filter((f) => f.group === group)
    .map(fieldSection)
    .join("\n");
  if (!rows) return "";
  return `    <section class="group">
      <h2>${escapeHtml(GROUP_TITLES[group])}</h2>
${rows}
    </section>`;
}

/** Build the full printable HTML form for `fields` (spec group order). */
export function buildFormHtml(fields: readonly IntakeFieldDef[]): string {
  const sections = INTAKE_GROUPS.map((g) => groupSection(g, fields))
    .filter((s) => s.length > 0)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>PCC Device Intake</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.6rem; }
  h2 { font-size: 1.15rem; margin-top: 2.5rem; border-bottom: 1px solid #ccc; padding-bottom: 0.25rem; }
  .field { margin: 1.25rem 0; padding: 0.75rem 1rem; border: 1px solid #ddd; border-radius: 6px; }
  .field-id { font-family: monospace; font-size: 0.8rem; color: #666; }
  .question { font-weight: 600; margin: 0.25rem 0; }
  .why { color: #444; font-size: 0.92rem; margin-bottom: 0.5rem; }
  .meta { font-size: 0.8rem; color: #666; margin-top: 0.4rem; }
  .badge { display: inline-block; font-size: 0.72rem; padding: 0.15rem 0.5rem; border-radius: 999px; margin: 0.1rem 0.3rem 0.1rem 0; border: 1px solid #999; }
  .badge-class { background: #eef; }
  .badge-never-default { background: #fee; border-color: #c33; color: #900; }
  .badge-self-declared { background: #ffe; border-color: #a90; color: #740; }
  .badge-sensitive { background: #fee; border-color: #c33; color: #900; }
  .badge-evidence { background: #eee; }
  @media print { .field { break-inside: avoid; } }
</style>
</head>
<body>
  <h1>PCC Device Intake</h1>
  <p>One question per field. Fields marked &quot;never defaulted&quot; or &quot;sensitive&quot; are never guessed or filled in for you &mdash; an empty answer blocks the step that needs it. Fields marked &quot;self-declared&quot; record only what you attest, never a researched or inferred value. An evidence badge marked &quot;stub&quot; proves nothing yet: the vocabulary defines it, but no verifier is live for it today.</p>
${sections}
</body>
</html>
`;
}
