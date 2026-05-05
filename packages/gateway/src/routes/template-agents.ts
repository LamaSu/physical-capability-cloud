// repair-tier0-routes: agent factories for the two Tier-0 templates.
//
// `templateSessionRoutes` is a generic plugin that delegates the heavy
// per-route work to a `TemplateAgentHooks` object. This file owns the two
// concrete hook implementations:
//
//   physicalOperatorAgent — wraps @pcc/orchestrator-sdk's discovery tools
//                            (extractStructured, publishOperator, etc.) so
//                            the chat console can drive a real onboarding.
//   dataProductStubAgent  — minimal stub. Records inputs and returns a
//                            deterministic publication payload so the chat
//                            console renders without errors. The full data-
//                            product flow lives in
//                            @pcc/template-data-product but its runner is
//                            still under construction (Wave 2.5).
//
// Both factories are pure — they read no module state — so a test can
// instantiate them in isolation with no Fastify/db/scope dependencies.

import { z } from "zod";
import {
  extractStructured,
  publishOperator,
  writeOperatorMirror,
  withIdempotency,
  type DiscoveryProfile,
} from "@pcc/orchestrator-sdk";
import type {
  TemplateAgentFactory,
  TemplateAgentHooks,
  TemplateSession,
} from "./template-session.js";

/** Default extraction schema for the physical-operator scrape step. */
const PHYSICAL_OPERATOR_EXTRACT_SCHEMA = z.object({
  name: z.string().optional(),
  machines: z
    .array(
      z.object({
        name: z.string(),
        kind: z.string().optional(),
        envelope: z.string().optional(),
        notes: z.string().optional(),
      })
    )
    .optional(),
  hours: z.string().optional(),
  services: z.array(z.string()).optional(),
  contact: z.string().optional(),
  certifications: z.array(z.string()).optional(),
});

/**
 * Maintain a side-channel of accumulated extraction results per session.
 * The orchestrator-sdk doesn't persist its own per-session memory; the
 * generic TemplateSession likewise only stores counts + events. We track
 * the structured profile here so onBuild has something concrete to publish.
 *
 * Module-scoped to match the session store in template-session.ts. Wave 4
 * moves both into Postgres.
 */
const physicalOperatorState = new Map<string, {
  profile: Partial<DiscoveryProfile>;
  scraped_urls: string[];
  doc_urls: string[];
}>();

function ensurePhysicalState(session: TemplateSession) {
  let state = physicalOperatorState.get(session.id);
  if (!state) {
    state = {
      profile: {
        enterprise_id: session.id,
        name: session.name,
      },
      scraped_urls: [],
      doc_urls: [],
    };
    physicalOperatorState.set(session.id, state);
  }
  return state;
}

/**
 * Physical-operator agent. Wires the four hooks to the orchestrator-sdk's
 * discovery tools. Designed to fail soft: any tool error is caught,
 * surfaced via the session event log (the driver does this for us), and the
 * session continues. The chat console can retry by calling the same route
 * again.
 */
export const physicalOperatorAgent: TemplateAgentFactory = (): TemplateAgentHooks => ({
  async onStart(session) {
    const state = ensurePhysicalState(session);
    if (session.url) {
      state.profile.url = session.url;
    }
  },

  async onScrape(session, url) {
    const state = ensurePhysicalState(session);
    state.scraped_urls.push(url);

    // extractStructured kicks off a stealth fetch + Claude tool-use call.
    // It honours MOCK_WEB_EXTRACT for tests / dry-runs. We deliberately
    // don't await heavy work in the background — the route returns the
    // summary the moment we have it.
    const extracted = (await extractStructured({
      url,
      schema: PHYSICAL_OPERATOR_EXTRACT_SCHEMA,
      goal:
        "Extract company name, machines (each with name, kind, envelope/dimensions, notes), operating hours, services offered, primary contact email, and certifications.",
    })) as Record<string, unknown>;

    // Fold extracted fields into the running profile.
    if (typeof extracted.name === "string" && extracted.name.length > 0) {
      state.profile.name = extracted.name;
    }
    if (Array.isArray(extracted.services)) {
      state.profile.capabilities = extracted.services as string[];
    }
    if (typeof extracted.hours === "string") {
      state.profile.hours = extracted.hours;
    }
    if (typeof extracted.contact === "string") {
      state.profile.contact_email = extracted.contact;
    }
    if (Array.isArray(extracted.certifications)) {
      state.profile.certifications = extracted.certifications as string[];
    }

    return {
      url,
      name: extracted.name ?? state.profile.name ?? null,
      machines_found: Array.isArray(extracted.machines) ? extracted.machines.length : 0,
      services: extracted.services ?? [],
      hours: extracted.hours ?? null,
    };
  },

  async onIngestDocs(session, docUrls) {
    const state = ensurePhysicalState(session);
    state.doc_urls.push(...docUrls);
    // Document ingestion is a no-op at the gateway today — the v1 onboarder
    // queued these to a backend embedding pipeline. Wave 4 reconnects that;
    // for Tier 0 we just record the URLs so onBuild can include the count
    // in the publication summary.
  },

  async onBuild(session) {
    const state = ensurePhysicalState(session);
    const profile: DiscoveryProfile = {
      enterprise_id: session.id,
      name: state.profile.name ?? session.name,
      url: state.profile.url ?? session.url,
      capabilities: state.profile.capabilities ?? [],
      ...(state.profile.hours ? { hours: state.profile.hours } : {}),
      ...(state.profile.contact_email ? { contact_email: state.profile.contact_email } : {}),
      ...(state.profile.certifications ? { certifications: state.profile.certifications } : {}),
    };

    // Idempotency wrappers match the OnboarderAgent's tool-caller pattern in
    // packages/agent-onboarder/src/onboarder-agent.ts (T1.10). Two retries
    // with the same session_id produce one registration, one mirror.
    const publication = await withIdempotency(session.id, "publish_operator", () =>
      publishOperator(profile)
    );

    // Mirror is best-effort — failure shouldn't block the build response.
    try {
      await withIdempotency(session.id, "write_static_mirror", () =>
        writeOperatorMirror(profile)
      );
    } catch {
      // Mirror failures are non-fatal; the session log already carries the
      // build_complete entry which the chat console renders.
    }

    return {
      capabilities: profile.capabilities,
      operator_id: publication.registration_id,
      discovery_url: publication.discovery_url,
    };
  },
});

// ── Data-product stub agent ─────────────────────────────────────────────────
//
// The full data-product flow (identify → describe → schema → price → publish)
// lives in @pcc/template-data-product/src/flow.ts but the runner that walks
// it isn't wired yet. Until that lands, the stub records inputs in the
// session event log and returns a deterministic publication payload. The
// chat console doesn't crash; the user sees realistic progress; the URL
// returned points at a placeholder discovery slug we never have to back
// because nothing else queries it.
//
// This is the explicit fallback path the Tier-0 brief calls out: "If
// template-data-product doesn't have a runnable agent yet, mount the
// data-product prefix with a *minimal stub* agent."

const dataProductState = new Map<string, {
  scraped_urls: string[];
  doc_urls: string[];
}>();

export const dataProductStubAgent: TemplateAgentFactory = (): TemplateAgentHooks => ({
  async onStart(session) {
    if (!dataProductState.has(session.id)) {
      dataProductState.set(session.id, { scraped_urls: [], doc_urls: [] });
    }
  },

  async onScrape(session, url) {
    const state = dataProductState.get(session.id) ?? { scraped_urls: [], doc_urls: [] };
    state.scraped_urls.push(url);
    dataProductState.set(session.id, state);
    // Report what kind of data source this likely is — pure heuristic.
    let kind = "unknown";
    if (/postgres|postgresql/i.test(url)) kind = "postgres";
    else if (/snowflake/i.test(url)) kind = "snowflake";
    else if (/bigquery/i.test(url)) kind = "bigquery";
    else if (/graphql/i.test(url)) kind = "graphql";
    else if (/mcp/i.test(url)) kind = "mcp";
    else if (/\.csv$/i.test(url)) kind = "csv";
    else if (/api|rest/i.test(url)) kind = "rest";
    return {
      url,
      kind_detected: kind,
      note: "data-product stub recorded the source — schema discovery + pricing flow lands in Wave 2.5.",
    };
  },

  async onIngestDocs(session, docUrls) {
    const state = dataProductState.get(session.id) ?? { scraped_urls: [], doc_urls: [] };
    state.doc_urls.push(...docUrls);
    dataProductState.set(session.id, state);
  },

  async onBuild(session) {
    const state = dataProductState.get(session.id) ?? { scraped_urls: [], doc_urls: [] };
    // Manufacture a deterministic stub publication. Until the real flow
    // lands, the chat console gets a realistic-looking response (so it can
    // exercise its UI paths) but the IDs aren't backed by any registry.
    return {
      capabilities: [`data-product:${session.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`],
      operator_id: `dp-stub-${session.id.slice(0, 12)}`,
      discovery_url: `/data-products/${session.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
    };
  },
});

/** Test-only — clear all per-template state. */
export function _resetTemplateAgentStateForTests(): void {
  physicalOperatorState.clear();
  dataProductState.clear();
}
