// Static mirror — replaces cited.md as the SEO surface for onboarded operators.
//
// Each operator gets a self-contained HTML page with embedded JSON-LD
// (schema.org Organization) so search engines and buyer agents can index them
// without depending on Senso. Files are written to the configured output dir
// (default: `<package>/public/operators/`). They can also be rsynced into a
// GitHub Pages bucket for additional SEO reach.
//
// Ported from `LamaSu/navi` packages/backend/src/tools/static-mirror.ts.
// The default output directory now points inside the agent-onboarder package
// rather than the navi backend.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DiscoveryProfile } from "./pcc-discovery.js";

export interface MirrorWriteResult {
  path: string;
  slug: string;
  url_path: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/tools/static-mirror.ts -> ../../public/operators
const DEFAULT_DIR = path.resolve(__dirname, "..", "..", "public", "operators");

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "operator"
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface RenderOptions {
  outDir?: string;
  generatedAt?: string;
}

export function renderOperatorHtml(profile: DiscoveryProfile, generatedAt = new Date().toISOString()): string {
  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: profile.name,
    knowsAbout: profile.capabilities,
  };
  if (profile.url) jsonLd.url = profile.url;
  if (profile.contact_email) jsonLd.email = profile.contact_email;
  if (profile.city) jsonLd.address = { "@type": "PostalAddress", addressLocality: profile.city };
  if (profile.certifications && profile.certifications.length) {
    jsonLd.hasCredential = profile.certifications;
  }
  if (profile.agent_url) {
    jsonLd.potentialAction = {
      "@type": "OfferAction",
      target: profile.agent_url,
    };
  }

  const safeName = escapeHtml(profile.name);
  const capsHtml = profile.capabilities.map((c) => `<li>${escapeHtml(c)}</li>`).join("");
  const certsHtml = (profile.certifications ?? []).map((c) => `<li>${escapeHtml(c)}</li>`).join("");
  const materialsHtml = (profile.materials ?? []).map((m) => `<li>${escapeHtml(m)}</li>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${safeName} — PCC operator</title>
  <meta name="description" content="${safeName} on the Physical Capability Cloud. Capabilities: ${escapeHtml(profile.capabilities.slice(0, 3).join(", "))}.">
  <meta name="generated-at" content="${escapeHtml(generatedAt)}">
  <link rel="canonical" href="${escapeHtml(profile.url ?? "")}">
  <script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)}
  </script>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 720px; margin: 2em auto; padding: 0 1em; color: #111; }
    h1 { margin-bottom: 0.2em; }
    h2 { margin-top: 1.6em; font-size: 1.1em; color: #333; }
    ul { padding-left: 1.2em; }
    a { color: #0a58ca; }
    .meta { color: #666; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>${safeName}</h1>
  <p class="meta">${profile.city ? `Located in ${escapeHtml(profile.city)}. ` : ""}PCC-verified operator.</p>
  ${profile.url ? `<p>Website: <a href="${escapeHtml(profile.url)}">${escapeHtml(profile.url)}</a></p>` : ""}
  ${profile.contact_email ? `<p>Contact: <a href="mailto:${escapeHtml(profile.contact_email)}">${escapeHtml(profile.contact_email)}</a></p>` : ""}

  <h2>Capabilities</h2>
  <ul>${capsHtml}</ul>

  ${materialsHtml ? `<h2>Materials</h2><ul>${materialsHtml}</ul>` : ""}
  ${certsHtml ? `<h2>Certifications</h2><ul>${certsHtml}</ul>` : ""}
  ${profile.hours ? `<h2>Hours</h2><p>${escapeHtml(profile.hours)}</p>` : ""}

  <h2>Discoverability</h2>
  <ul>
    ${profile.agent_url ? `<li>PCC agent: <a href="${escapeHtml(profile.agent_url)}">${escapeHtml(profile.agent_url)}</a></li>` : ""}
    ${profile.marketplace_url ? `<li>x402 quote: <a href="${escapeHtml(profile.marketplace_url)}">${escapeHtml(profile.marketplace_url)}</a></li>` : ""}
  </ul>
  <p class="meta">Generated ${escapeHtml(generatedAt)} · <a href="/operators/">all operators</a></p>
</body>
</html>
`;
}

export async function writeOperatorMirror(
  profile: DiscoveryProfile,
  options: RenderOptions = {}
): Promise<MirrorWriteResult> {
  const outDir = options.outDir ?? DEFAULT_DIR;
  const slug = slugify(profile.name);
  const html = renderOperatorHtml(profile, options.generatedAt);
  await fs.mkdir(outDir, { recursive: true });
  const filePath = path.join(outDir, `${slug}.html`);
  await fs.writeFile(filePath, html, "utf8");
  return { path: filePath, slug, url_path: `/operators/${slug}.html` };
}

export interface DirectoryEntry {
  name: string;
  slug: string;
  capabilities?: string[];
  city?: string;
  url?: string;
}

/**
 * Render a directory page that links to every operator. Lightweight — reads
 * the optional entries list rather than scanning the filesystem so the caller
 * controls what's listed.
 */
export function renderDirectoryHtml(entries: DirectoryEntry[]): string {
  const items = entries
    .map((e) => {
      const capsLine =
        e.capabilities && e.capabilities.length ? ` — ${escapeHtml(e.capabilities.slice(0, 3).join(", "))}` : "";
      const cityLine = e.city ? ` (${escapeHtml(e.city)})` : "";
      return `  <li><a href="/operators/${escapeHtml(e.slug)}.html">${escapeHtml(e.name)}</a>${cityLine}${capsLine}</li>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>PCC operator directory</title>
  <meta name="description" content="Directory of operators registered on the Physical Capability Cloud.">
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 720px; margin: 2em auto; padding: 0 1em; color: #111; }
    ul { padding-left: 1.2em; }
    a { color: #0a58ca; }
    .meta { color: #666; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>PCC operator directory</h1>
  <p class="meta">${entries.length} operator${entries.length === 1 ? "" : "s"} registered on the Physical Capability Cloud.</p>
  <ul>
${items}
  </ul>
</body>
</html>
`;
}

export async function writeOperatorDirectory(
  entries: DirectoryEntry[],
  options: { outDir?: string } = {}
): Promise<{ path: string }> {
  const outDir = options.outDir ?? DEFAULT_DIR;
  await fs.mkdir(outDir, { recursive: true });
  const filePath = path.join(outDir, "index.html");
  await fs.writeFile(filePath, renderDirectoryHtml(entries), "utf8");
  return { path: filePath };
}
