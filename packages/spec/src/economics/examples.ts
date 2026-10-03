/**
 * Five worked agreements in plain economic language (technical pack §8 RETURN), plus one that must be
 * refused. They are golden fixtures for the compiler, reusable templates for agents (ADK), and the
 * demo data for the approval preview. Amounts are USDC base units (6 decimals): "25000000" is $25.00.
 *
 * Every address below is a readable test address, not a real wallet.
 */

import { computeScheduleHash, type RateSchedule } from "../types/rate-schedule.js";
import type { EconomicAgreement, License } from "./types.js";

const AS_OF = 1_790_000_000; // 2026-09-21T13:46:40Z
const ACCEPT_BY = AS_OF + 86_400;
const PROTOCOL_FEE_BPS = 235; // 2.35%, the protocol fee PCC documents
const PCC_TREASURY = "0xfee0000000000000000000000000000000000fee";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

function openGrants(): License["grants"] {
  return { commercialUse: true, compose: true, resell: true, modify: false, fieldsOfUse: ["*"], regions: ["*"] };
}

/** Fresh objects on every call: no two built agreements share a nested object a caller could mutate. */
function baseUse(): EconomicAgreement["use"] {
  return {
    commercial: true,
    composite: false,
    resell: false,
    fieldOfUse: "*",
    region: "US",
    modifies: [],
    outbound: { class: "proprietary", shareAlikeTag: null },
  };
}

function common() {
  return {
    schema: "pcc.economic-agreement.v1" as const,
    version: 1,
    supersedes: null,
    asOf: AS_OF,
    currency: { code: "USDC", decimals: 6 },
    fee: { feeBps: PROTOCOL_FEE_BPS, feeRecipient: PCC_TREASURY },
    terms: { acceptBy: ACCEPT_BY, changePolicy: "new-version-required" as const },
  };
}

// ── 1. A spare printer earns, and the kit it runs on earns a royalty ─────────

/** Priya's published royalty schedule for her printer kit: a flat 0.40% of every job, forever. */
export const PRINTER_KIT_SCHEDULE: RateSchedule = (() => {
  const body = {
    version: 1,
    segments: [{ kind: "constant" as const, startTime: 0, endTime: null, bps: 40 }],
    notes: "Flat 0.40% of each job that runs on the kit.",
    publishedAt: "2026-06-01T00:00:00Z",
  };
  return { ...body, scheduleHash: computeScheduleHash(body) };
})();

/**
 * "Dana pays $25.00 to have a bracket printed on Sam's spare printer. The printer runs Priya's
 * open-source printer kit, whose license asks for 0.40% of each job. PCC's fee is 2.35%.
 * Sam keeps everything else."
 */
export function exampleSparePrinter(): EconomicAgreement {
  const kit = "kit:octoprint-fdm@2";
  const royaltyRule = {
    kind: "percent" as const,
    bps: 40,
    of: "gross" as const,
    min: null,
    max: null,
    rateSource: {
      scheduleHash: PRINTER_KIT_SCHEDULE.scheduleHash,
      evaluatedAt: AS_OF,
      context: { jobValueCents: 2500, jobsPerDay: 3, captureClass: null },
    },
  };
  return {
    ...common(),
    agreementId: "ex1-spare-printer",
    payer: "dana",
    parties: [
      { partyId: "dana", label: "Dana (buyer)", kind: "person", payTo: addr(0xda0a01) },
      { partyId: "sam", label: "Sam (owns the printer)", kind: "person", payTo: addr(0x5a0002) },
      { partyId: "priya", label: "Priya (wrote the printer kit)", kind: "person", payTo: addr(0x9a1a03) },
    ],
    units: [
      { unitRef: "print", label: "Print the bracket", gross: "25000000", components: [{ ref: kit, uses: "1" }], measures: [] },
    ],
    splits: [],
    clauses: [
      {
        clauseId: "kit-royalty",
        label: "Kit royalty: 0.40% of the job",
        role: "integrator",
        to: { party: "priya" },
        subject: kit,
        appliesTo: { usingComponent: kit },
        underLicense: { licenseId: "lic-octoprint-fdm-kit", version: 2 },
        rule: royaltyRule,
      },
      {
        clauseId: "printer-owner",
        label: "Sam keeps the rest of the job",
        role: "operator",
        to: { party: "sam" },
        subject: null,
        appliesTo: { units: ["print"] },
        underLicense: null,
        rule: { kind: "residual" },
      },
    ],
    licenses: [
      {
        licenseId: "lic-octoprint-fdm-kit",
        version: 2,
        label: "Printer kit license v2: use it commercially, credit Priya, pay her schedule",
        licensor: "priya",
        subject: kit,
        class: "permissive",
        shareAlikeTag: null,
        grants: { ...openGrants(), modify: true },
        requires: {
          attribution: true,
          payments: [
            {
              requirementId: "royalty",
              role: "integrator",
              per: "using-unit",
              payee: { licensor: true },
              rule: { kind: "percent_by_schedule", scheduleHash: PRINTER_KIT_SCHEDULE.scheduleHash, of: "gross", min: null, max: null },
            },
          ],
        },
        validFrom: null,
        validUntil: null,
        authority: "registry-anchored",
      },
    ],
    use: { ...baseUse(), fieldOfUse: "3d-printing" },
  };
}

// ── 2. An agent composes print-and-mail from two operators and keeps a margin ─

/**
 * "Orbit, a small agent business, sells 'print and mail a letter' for $22.00. It pays a print shop a
 * fixed $12.00 to print, pays a courier a fixed $5.00 plus the $0.68 stamp at cost, and pays the
 * inventor of an address-checking method $0.25 each time the method runs. Orbit keeps what is left
 * of each step. If the mailing step fails, the buyer gets that step's money back and nobody on that
 * step is paid."
 */
export function examplePrintAndMail(): EconomicAgreement {
  const printKit = "kit:laser-print@1";
  const mailService = "service:letter-mail@3";
  const addrCheck = "method:address-verify@1";
  const addrFee = { kind: "per_use" as const, rate: "250000", per: { component: addrCheck }, cap: null };
  return {
    ...common(),
    agreementId: "ex2-print-and-mail",
    payer: "buyer",
    parties: [
      { partyId: "buyer", label: "Buyer's agent", kind: "agent", payTo: addr(0xb0b001) },
      { partyId: "orbit", label: "Orbit (composed the service)", kind: "organization", payTo: addr(0x0b17002) },
      { partyId: "printshop", label: "Corner Print Shop", kind: "organization", payTo: addr(0xc0a0003) },
      { partyId: "courier", label: "Last-Mile Courier", kind: "organization", payTo: addr(0xc0a1004) },
      { partyId: "inventor", label: "Mei (invented the address check)", kind: "person", payTo: addr(0x3e10005) },
    ],
    units: [
      { unitRef: "a-print", label: "Print the letter", gross: "14000000", components: [{ ref: printKit, uses: "1" }], measures: [] },
      {
        unitRef: "b-mail",
        label: "Check the address and mail the letter",
        gross: "8000000",
        components: [
          { ref: mailService, uses: "1" },
          { ref: addrCheck, uses: "1" },
        ],
        measures: [],
      },
    ],
    splits: [],
    clauses: [
      {
        clauseId: "print-cost",
        label: "Print shop's fixed price",
        role: "operator",
        to: { party: "printshop" },
        subject: printKit,
        appliesTo: { units: ["a-print"] },
        underLicense: null,
        rule: { kind: "fixed", amount: "12000000" },
      },
      {
        clauseId: "courier-fee",
        label: "Courier's fixed delivery fee",
        role: "operator",
        to: { party: "courier" },
        subject: mailService,
        appliesTo: { units: ["b-mail"] },
        underLicense: null,
        rule: { kind: "fixed", amount: "5000000" },
      },
      {
        clauseId: "postage",
        label: "Postage passed through at cost",
        role: "operator",
        to: { party: "courier" },
        subject: "postage",
        appliesTo: { units: ["b-mail"] },
        underLicense: null,
        rule: { kind: "pass_through", cost: "680000", markupBps: 0, costRef: "quote:usps-first-class-2026-09" },
      },
      {
        clauseId: "address-check-fee",
        label: "Address check: $0.25 each time it runs",
        role: "protocol-author",
        to: { party: "inventor" },
        subject: addrCheck,
        appliesTo: { usingComponent: addrCheck },
        underLicense: { licenseId: "lic-address-verify", version: 1 },
        rule: addrFee,
      },
      {
        clauseId: "orbit-margin",
        label: "Orbit keeps what is left of each step",
        role: "assembler",
        to: { party: "orbit" },
        subject: null,
        appliesTo: { allUnits: true },
        underLicense: null,
        rule: { kind: "residual" },
      },
    ],
    licenses: [
      {
        licenseId: "lic-laser-print-kit",
        version: 1,
        label: "Laser print kit: open, credit appreciated",
        licensor: "printshop",
        subject: printKit,
        class: "open",
        shareAlikeTag: null,
        grants: openGrants(),
        requires: { attribution: false, payments: [] },
        validFrom: null,
        validUntil: null,
        authority: "counterparty-accepted",
      },
      {
        licenseId: "lic-letter-mail",
        version: 3,
        label: "Courier service terms: may be resold inside a composed service",
        licensor: "courier",
        subject: mailService,
        class: "proprietary",
        shareAlikeTag: null,
        grants: { ...openGrants(), fieldsOfUse: ["document.print-and-mail", "mail.drop"], regions: ["US"] },
        requires: { attribution: false, payments: [] },
        validFrom: AS_OF - 86_400 * 30,
        validUntil: AS_OF + 86_400 * 365,
        authority: "counterparty-accepted",
      },
      {
        licenseId: "lic-address-verify",
        version: 1,
        label: "Address check method: $0.25 per use, commercial use allowed",
        licensor: "inventor",
        subject: addrCheck,
        class: "proprietary",
        shareAlikeTag: null,
        grants: openGrants(),
        requires: {
          attribution: true,
          payments: [{ requirementId: "per-use", role: "protocol-author", per: "using-unit", payee: { licensor: true }, rule: addrFee }],
        },
        validFrom: null,
        validUntil: null,
        authority: "registry-anchored",
      },
    ],
    use: { ...baseUse(), composite: true, resell: true, fieldOfUse: "document.print-and-mail" },
  };
}

// ── 3. A repair guild: parts at cost, an inspector, a treasury, members by hours ─

/**
 * "Eastside Fixers, a repair guild, fixes a dishwasher for $180.01. Lee bought $42.50 of parts and is
 * paid back exactly. An independent inspector gets 1.5% of the price. Of what is left, 10% goes to the
 * guild's treasury and 90% to the three members who did the work, by hours: Ana 5, Ben 3, Cy 1."
 */
export function exampleGuildRepair(): EconomicAgreement {
  const service = "service:appliance-repair@1";
  return {
    ...common(),
    agreementId: "ex3-guild-repair",
    payer: "homeowner",
    parties: [
      { partyId: "homeowner", label: "Homeowner", kind: "person", payTo: addr(0x40ae001) },
      { partyId: "guild-treasury", label: "Eastside Fixers treasury", kind: "treasury", payTo: addr(0x7ea5002) },
      { partyId: "ana", label: "Ana (5 hours)", kind: "person", payTo: addr(0xa0a003) },
      { partyId: "ben", label: "Ben (3 hours)", kind: "person", payTo: addr(0xbe0004) },
      { partyId: "cy", label: "Cy (1 hour)", kind: "person", payTo: addr(0xc10005) },
      { partyId: "lee", label: "Lee (bought the parts)", kind: "person", payTo: addr(0x1ee0006) },
      { partyId: "inspector", label: "Independent inspector", kind: "organization", payTo: addr(0x15e0007) },
    ],
    units: [
      { unitRef: "repair", label: "Repair the dishwasher", gross: "180010000", components: [{ ref: service, uses: "1" }], measures: [] },
    ],
    splits: [
      {
        splitId: "guild-share",
        label: "Guild share: 10% treasury, 90% the members who did the work",
        members: [
          { to: { party: "guild-treasury" }, weight: 10, role: "network-treasury", subject: null },
          { to: { split: "members-by-hours" }, weight: 90, role: null, subject: null },
        ],
      },
      {
        splitId: "members-by-hours",
        label: "Members by hours worked",
        members: [
          { to: { party: "ana" }, weight: 5, role: null, subject: null },
          { to: { party: "ben" }, weight: 3, role: null, subject: null },
          { to: { party: "cy" }, weight: 1, role: null, subject: null },
        ],
      },
    ],
    clauses: [
      {
        clauseId: "parts",
        label: "Parts, paid back to Lee at cost",
        role: "operator",
        to: { party: "lee" },
        subject: "parts",
        appliesTo: { units: ["repair"] },
        underLicense: null,
        rule: { kind: "pass_through", cost: "42500000", markupBps: 0, costRef: "receipt:parts-7731" },
      },
      {
        clauseId: "inspection",
        label: "Independent inspection: 1.5% of the price",
        role: "verifier",
        to: { party: "inspector" },
        subject: null,
        appliesTo: { units: ["repair"] },
        underLicense: null,
        rule: { kind: "percent", bps: 150, of: "gross", min: null, max: null, rateSource: null },
      },
      {
        clauseId: "guild",
        label: "The guild's share of the job",
        role: "operator",
        to: { split: "guild-share" },
        subject: service,
        appliesTo: { units: ["repair"] },
        underLicense: null,
        rule: { kind: "residual" },
      },
    ],
    licenses: [
      {
        licenseId: "lic-guild-repair",
        version: 1,
        label: "Guild service terms",
        licensor: "guild-treasury",
        subject: service,
        class: "proprietary",
        shareAlikeTag: null,
        grants: openGrants(),
        requires: { attribution: false, payments: [] },
        validFrom: null,
        validUntil: null,
        authority: "counterparty-accepted",
      },
    ],
    use: { ...baseUse(), fieldOfUse: "appliance-repair" },
  };
}

// ── 4. A lab assay using a trained model: minimum royalty, lineage, two roles ─

/**
 * "A lab runs a $400.00 chemistry assay. The lab is paid a fixed $320.00 to run it. The assay uses an
 * AI model whose license asks for 3% of the price, but never less than $15.00; the model's publisher
 * splits that 70% to the model's author and 30% to the two datasets it was trained on (18% and 12%).
 * The author of the assay protocol gets 0.5% of the net. The lab, which also put the assay together,
 * keeps what is left as its margin."
 */
export function exampleLabAssay(): EconomicAgreement {
  const model = "model:peak-detect@3";
  const protocol = "csd:hplc-assay@2";
  const royalty = { kind: "percent" as const, bps: 300, of: "gross" as const, min: "15000000", max: null, rateSource: null };
  const lineage = [
    { party: "model-author", weight: 7000, role: "model-author" as const, subject: model },
    { party: "dataset-a", weight: 1800, role: "dataset-contributor" as const, subject: "dataset:chromatograms-a" },
    { party: "dataset-b", weight: 1200, role: "dataset-contributor" as const, subject: "dataset:chromatograms-b" },
  ];
  return {
    ...common(),
    agreementId: "ex4-lab-assay",
    payer: "client",
    parties: [
      { partyId: "client", label: "Client lab", kind: "organization", payTo: addr(0xc11e001) },
      { partyId: "lab", label: "Harbor Analytical (runs and assembles the assay)", kind: "organization", payTo: addr(0x1ab0002) },
      { partyId: "model-author", label: "Rui (trained the model)", kind: "person", payTo: addr(0x3a10003) },
      { partyId: "dataset-a", label: "Dataset A contributors", kind: "organization", payTo: addr(0xda7a004) },
      { partyId: "dataset-b", label: "Dataset B contributors", kind: "organization", payTo: addr(0xda7b005) },
      { partyId: "protocol-author", label: "Ines (wrote the assay protocol)", kind: "person", payTo: addr(0x1e5006) },
    ],
    units: [
      {
        unitRef: "assay",
        label: "Run the assay",
        gross: "400000000",
        components: [
          { ref: model, uses: "1" },
          { ref: protocol, uses: "1" },
        ],
        measures: [],
      },
    ],
    splits: [
      {
        splitId: "model-lineage",
        label: "Model royalty: 70% author, 30% the training datasets",
        members: lineage.map((m) => ({ to: { party: m.party }, weight: m.weight, role: m.role, subject: m.subject })),
      },
    ],
    clauses: [
      {
        clauseId: "lab-run",
        label: "Lab's fixed price to run the assay",
        role: "operator",
        to: { party: "lab" },
        subject: null,
        appliesTo: { units: ["assay"] },
        underLicense: null,
        rule: { kind: "fixed", amount: "320000000" },
      },
      {
        clauseId: "model-royalty",
        label: "Model royalty: 3% of the price, at least $15.00",
        role: "model-author",
        to: { split: "model-lineage" },
        subject: model,
        appliesTo: { usingComponent: model },
        underLicense: { licenseId: "lic-peak-detect", version: 3 },
        rule: royalty,
      },
      {
        clauseId: "protocol-royalty",
        label: "Assay protocol: 0.5% of the net",
        role: "protocol-author",
        to: { party: "protocol-author" },
        subject: protocol,
        appliesTo: { usingComponent: protocol },
        underLicense: null,
        rule: { kind: "percent", bps: 50, of: "net", min: null, max: null, rateSource: null },
      },
      {
        clauseId: "lab-margin",
        label: "Lab keeps the rest as the assembler",
        role: "assembler",
        to: { party: "lab" },
        subject: null,
        appliesTo: { units: ["assay"] },
        underLicense: null,
        rule: { kind: "residual" },
      },
    ],
    licenses: [
      {
        licenseId: "lic-peak-detect",
        version: 3,
        label: "Peak-detect model license v3: 3% of each job, $15 minimum",
        licensor: "model-author",
        subject: model,
        class: "proprietary",
        shareAlikeTag: null,
        grants: openGrants(),
        requires: {
          attribution: true,
          payments: [
            {
              requirementId: "royalty",
              role: "model-author",
              per: "using-unit",
              payee: { distribution: lineage },
              rule: royalty,
            },
          ],
        },
        validFrom: null,
        validUntil: AS_OF + 86_400 * 365,
        authority: "registry-anchored",
      },
      {
        licenseId: "lic-hplc-protocol",
        version: 2,
        label: "HPLC assay protocol: open",
        licensor: "protocol-author",
        subject: protocol,
        class: "permissive",
        shareAlikeTag: null,
        grants: openGrants(),
        requires: { attribution: true, payments: [] },
        validFrom: null,
        validUntil: null,
        authority: "counterparty-accepted",
      },
    ],
    use: { ...baseUse(), fieldOfUse: "hplc" },
  };
}

// ── 5. A deck built in three milestones, with insurance and an inspector ─────

/**
 * "A homeowner has a deck built in three steps, each paid when it is done: design ($800), build
 * ($6,500) and final inspection ($700). The designer is paid $600 for the plans. The lumber yard is
 * paid the $3,210.40 lumber bill at cost. An insurer is paid 1.2% of the build step to cover it. An
 * independent inspector is paid $250. The contractor keeps the rest of each step. If the build step
 * fails, the homeowner gets the $6,500 back and the design and inspection steps settle on their own."
 */
export function exampleDeckMilestones(): EconomicAgreement {
  const plan = "plan:deck-12x16@1";
  return {
    ...common(),
    agreementId: "ex5-deck-milestones",
    payer: "homeowner",
    parties: [
      { partyId: "homeowner", label: "Homeowner", kind: "person", payTo: addr(0x40ae101) },
      { partyId: "contractor", label: "Birch & Sons (contractor)", kind: "organization", payTo: addr(0xb1c0102) },
      { partyId: "designer", label: "Olu (drew the plans)", kind: "person", payTo: addr(0xde50103) },
      { partyId: "lumber", label: "Cedar Yard (lumber)", kind: "organization", payTo: addr(0xced0104) },
      { partyId: "insurer", label: "Harbor Mutual (insurer)", kind: "organization", payTo: addr(0x1250105) },
      { partyId: "inspector", label: "County-certified inspector", kind: "person", payTo: addr(0x15e0106) },
    ],
    units: [
      { unitRef: "m1-design", label: "Design", gross: "800000000", components: [{ ref: plan, uses: "1" }], measures: [] },
      { unitRef: "m2-build", label: "Build", gross: "6500000000", components: [], measures: [] },
      { unitRef: "m3-inspect", label: "Final inspection", gross: "700000000", components: [], measures: [] },
    ],
    splits: [],
    clauses: [
      {
        clauseId: "design-fee",
        label: "Designer's fee for the plans",
        role: "protocol-author",
        to: { party: "designer" },
        subject: plan,
        appliesTo: { units: ["m1-design"] },
        underLicense: null,
        rule: { kind: "fixed", amount: "600000000" },
      },
      {
        clauseId: "lumber",
        label: "Lumber bill, paid at cost",
        role: "operator",
        to: { party: "lumber" },
        subject: "lumber",
        appliesTo: { units: ["m2-build"] },
        underLicense: null,
        rule: { kind: "pass_through", cost: "3210400000", markupBps: 0, costRef: "invoice:cedar-yard-5520" },
      },
      {
        clauseId: "insurance",
        label: "Insurance on the build: 1.2%",
        role: "insurer",
        to: { party: "insurer" },
        subject: null,
        appliesTo: { units: ["m2-build"] },
        underLicense: null,
        rule: { kind: "percent", bps: 120, of: "gross", min: null, max: null, rateSource: null },
      },
      {
        clauseId: "inspection",
        label: "Independent final inspection",
        role: "verifier",
        to: { party: "inspector" },
        subject: null,
        appliesTo: { units: ["m3-inspect"] },
        underLicense: null,
        rule: { kind: "fixed", amount: "250000000" },
      },
      {
        clauseId: "contractor",
        label: "Contractor keeps the rest of each step",
        role: "operator",
        to: { party: "contractor" },
        subject: null,
        appliesTo: { allUnits: true },
        underLicense: null,
        rule: { kind: "residual" },
      },
    ],
    licenses: [
      {
        licenseId: "lic-deck-plan",
        version: 1,
        label: "Deck plans: licensed for one build",
        licensor: "designer",
        subject: plan,
        class: "proprietary",
        shareAlikeTag: null,
        grants: { ...openGrants(), resell: false },
        requires: { attribution: false, payments: [] },
        validFrom: null,
        validUntil: null,
        authority: "counterparty-accepted",
      },
    ],
    use: { ...baseUse(), fieldOfUse: "construction" },
  };
}

// ── 6. Refused: a non-commercial dataset inside a paid job ───────────────────

/**
 * "An agent tries to sell a paid defect-inspection service built on a model trained with a dataset
 * that is licensed for non-commercial research only." The compiler must refuse: the rights do not
 * allow paid use, so no split is invented.
 */
export function exampleIncompatibleLicense(): EconomicAgreement {
  const dataset = "dataset:weld-defects@1";
  return {
    ...common(),
    agreementId: "ex6-incompatible",
    payer: "factory",
    parties: [
      { partyId: "factory", label: "Factory (buyer)", kind: "organization", payTo: addr(0xfac0001) },
      { partyId: "agent", label: "Inspection agent", kind: "agent", payTo: addr(0xa6e0002) },
      { partyId: "university", label: "University lab (dataset owner)", kind: "organization", payTo: addr(0x0e10003) },
    ],
    units: [
      { unitRef: "inspect", label: "Inspect 200 welds", gross: "90000000", components: [{ ref: dataset, uses: "1" }], measures: [] },
    ],
    splits: [],
    clauses: [
      {
        clauseId: "agent",
        label: "Inspection agent keeps the job",
        role: "operator",
        to: { party: "agent" },
        subject: null,
        appliesTo: { allUnits: true },
        underLicense: null,
        rule: { kind: "residual" },
      },
    ],
    licenses: [
      {
        licenseId: "lic-weld-defects",
        version: 1,
        label: "Weld defect dataset: non-commercial research only",
        licensor: "university",
        subject: dataset,
        class: "noncommercial",
        shareAlikeTag: null,
        grants: { commercialUse: false, compose: true, resell: false, modify: false, fieldsOfUse: ["*"], regions: ["*"] },
        requires: { attribution: true, payments: [] },
        validFrom: null,
        validUntil: null,
        authority: "registry-anchored",
      },
    ],
    use: { ...baseUse(), composite: true, fieldOfUse: "weld-inspection" },
  };
}

export const EXAMPLE_FORBIDDEN_RECIPIENTS: readonly string[] = [];

/** The five compilable examples, in order. */
export const EXAMPLE_AGREEMENTS = [
  exampleSparePrinter,
  examplePrintAndMail,
  exampleGuildRepair,
  exampleLabAssay,
  exampleDeckMilestones,
] as const;

/**
 * The same five examples as listable templates, for agents (ADK) and the approval preview. `build`
 * returns a fresh copy each time. `compileOptions` is what the example needs besides itself: example 1's
 * royalty is pinned from Priya's schedule, so its body is passed to verify the pin. A server supplies
 * its own options (fee, forbidden recipients, sealed schedules); these are the demo's.
 */
export interface AgreementTemplate {
  templateId: string;
  title: string;
  summary: string;
  build: () => EconomicAgreement;
  compileOptions: { schedules: readonly RateSchedule[] };
}

export const AGREEMENT_TEMPLATES: readonly AgreementTemplate[] = [
  {
    templateId: "spare-printer",
    title: "A spare printer earns, and its kit earns a royalty",
    summary: "Dana pays $25.00 to print a bracket on Sam's spare printer. The printer's open-source kit asks 0.40% of each job for its author, Priya. PCC's fee is 2.35%, and Sam keeps the rest.",
    build: exampleSparePrinter,
    compileOptions: { schedules: [PRINTER_KIT_SCHEDULE] },
  },
  {
    templateId: "print-and-mail",
    title: "An agent composes print-and-mail and keeps a margin",
    summary: "Orbit sells 'print and mail a letter' for $22.00. It pays a print shop $12.00, and a courier $5.00 plus the $0.68 stamp at cost. The address check's inventor gets $0.25 each time it runs, and Orbit keeps what is left of each step. A failed step refunds that step only.",
    build: examplePrintAndMail,
    compileOptions: { schedules: [] },
  },
  {
    templateId: "guild-repair",
    title: "A repair guild: parts at cost, an inspector, a treasury, members by hours",
    summary: "A $180.01 repair: Lee is paid back $42.50 of parts exactly and the inspector gets 1.5%. Of what is left, the guild treasury gets 10%, and three members share 90% by hours (5, 3 and 1).",
    build: exampleGuildRepair,
    compileOptions: { schedules: [] },
  },
  {
    templateId: "lab-assay",
    title: "A lab assay that uses a licensed AI model",
    summary: "A $400.00 assay: the lab gets $320.00 to run it. The model's license asks 3% (never under $15.00), which its publisher splits 70% to the model's author and 30% to two datasets. The protocol's author gets 0.5% of net, and the lab keeps the rest.",
    build: exampleLabAssay,
    compileOptions: { schedules: [] },
  },
  {
    templateId: "deck-milestones",
    title: "A deck built in three paid milestones",
    summary: "Design ($800), build ($6,500) and inspection ($700), each paid when done. The designer, the lumber yard (at cost), an insurer (1.2% of the build) and the inspector are paid, and the contractor keeps the rest of each step. A failed step refunds that step.",
    build: exampleDeckMilestones,
    compileOptions: { schedules: [] },
  },
];
