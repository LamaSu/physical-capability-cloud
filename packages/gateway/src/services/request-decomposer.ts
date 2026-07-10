/**
 * Request Decomposer Service
 *
 * Rule-based decomposition engine that maps natural language capability
 * requests to structured DAGs using predefined templates. Common physical
 * requests follow known patterns — the templates encode that domain knowledge.
 */

import type {
  CapabilityRequest,
  CapabilityNode,
  DecompositionResult,
  MaterialRequirement,
} from "@pcc/spec";

// ---------------------------------------------------------------------------
// Urgency multipliers — emergency requests cost and time more
// ---------------------------------------------------------------------------

const URGENCY_COST_MULTIPLIER: Record<string, number> = {
  standard: 1.0,
  rush: 1.4,
  emergency: 2.0,
};

const URGENCY_TIME_MULTIPLIER: Record<string, number> = {
  standard: 1.0,
  rush: 0.7,
  emergency: 0.5,
};

// ---------------------------------------------------------------------------
// Node builder helper
// ---------------------------------------------------------------------------

function makeNode(
  requestId: string,
  overrides: Partial<CapabilityNode> & {
    id: string;
    name: string;
    description: string;
    capabilityType: string;
    category: string;
    estimatedCost: number;
    estimatedHours: number;
    dependencies: string[];
    parallel: boolean;
  },
): CapabilityNode {
  return {
    status: "pending",
    assignedOperator: undefined,
    bountyId: undefined,
    materials: [],
    evidenceRequirements: ["photo_of_completed_work"],
    requestId,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

type TemplateFactory = (
  req: CapabilityRequest,
  budgetShare: (fraction: number) => number,
  hourShare: (fraction: number) => number,
) => CapabilityNode[];

const TEMPLATES: Record<string, TemplateFactory> = {
  // ── Robotics / animatronics / electromechanical builds ─────────
  robotics_build: (req, cost, hours) => [
    makeNode(req.id, {
      id: `${req.id}-mech-design`,
      name: "Mechanical design (CAD)",
      description: "Design structural skeleton, joints, and motion mechanisms in CAD",
      capabilityType: "cad",
      category: "design",
      estimatedCost: cost(0.08),
      estimatedHours: hours(0.12),
      dependencies: [],
      parallel: true,
      evidenceRequirements: ["cad_files", "design_review_screenshot"],
    }),
    makeNode(req.id, {
      id: `${req.id}-elec-design`,
      name: "Electronics design",
      description: "Design PCB or controller wiring, servo driver layout, power circuit",
      capabilityType: "cad",
      category: "design",
      estimatedCost: cost(0.05),
      estimatedHours: hours(0.08),
      dependencies: [],
      parallel: true,
      evidenceRequirements: ["schematic_files", "design_screenshot"],
    }),
    makeNode(req.id, {
      id: `${req.id}-soft-design`,
      name: "Soft goods / enclosure design",
      description: "Design plush exterior, fabric patterns, and soft enclosure geometry",
      capabilityType: "pattern-design",
      category: "design",
      estimatedCost: cost(0.04),
      estimatedHours: hours(0.06),
      dependencies: [],
      parallel: true,
      evidenceRequirements: ["pattern_files", "design_screenshot"],
    }),
    makeNode(req.id, {
      id: `${req.id}-3d-print`,
      name: "3D print structural components",
      description: "FDM print skeleton, brackets, servo mounts, and structural parts",
      capabilityType: "fdm",
      category: "fabrication",
      estimatedCost: cost(0.12),
      estimatedHours: hours(0.15),
      dependencies: [`${req.id}-mech-design`],
      parallel: false,
      materials: [
        { name: "PLA or PETG filament", quantity: 0.5, unit: "kg", estimatedCost: 12, marketplaceCategory: "plastics-polymers" },
      ],
      evidenceRequirements: ["photo_of_printed_parts", "dimensional_check"],
    }),
    makeNode(req.id, {
      id: `${req.id}-pcb`,
      name: "PCB fabrication or controller sourcing",
      description: "Fabricate custom PCB or source appropriate servo controller / MCU",
      capabilityType: "pcb",
      category: "fabrication",
      estimatedCost: cost(0.10),
      estimatedHours: hours(0.08),
      dependencies: [`${req.id}-elec-design`],
      parallel: false,
      materials: [
        { name: "FR4 PCB blanks or Arduino/ESP32", quantity: 1, unit: "each", estimatedCost: 15, marketplaceCategory: "electronics" },
      ],
      evidenceRequirements: ["photo_of_pcb", "continuity_test_results"],
    }),
    makeNode(req.id, {
      id: `${req.id}-soft-components`,
      name: "Laser cut / sew soft components",
      description: "Cut and sew plush exterior, felt panels, and soft outer shell",
      capabilityType: "laser-cut",
      category: "fabrication",
      estimatedCost: cost(0.09),
      estimatedHours: hours(0.10),
      dependencies: [`${req.id}-soft-design`],
      parallel: false,
      materials: [
        { name: "Plush fabric", quantity: 0.5, unit: "m", estimatedCost: 20, marketplaceCategory: "other" },
        { name: "Stuffing material", quantity: 200, unit: "g", estimatedCost: 8, marketplaceCategory: "other" },
      ],
      evidenceRequirements: ["photo_of_sewn_components"],
    }),
    makeNode(req.id, {
      id: `${req.id}-source-components`,
      name: "Source servos, MCU, sensors, battery",
      description: "Procure micro servos, microcontroller, touch/proximity sensors, and LiPo battery",
      capabilityType: "procurement",
      category: "procurement",
      estimatedCost: cost(0.15),
      estimatedHours: hours(0.06),
      dependencies: [],
      parallel: true,
      materials: [
        { name: "Micro servo motors (x6)", quantity: 6, unit: "each", estimatedCost: 30, marketplaceCategory: "electronics" },
        { name: "LiPo battery + charger", quantity: 1, unit: "each", estimatedCost: 15, marketplaceCategory: "electronics" },
      ],
      evidenceRequirements: ["photo_of_components", "invoice_or_receipt"],
    }),
    makeNode(req.id, {
      id: `${req.id}-firmware`,
      name: "Firmware development",
      description: "Write servo animation sequences, idle breathing, and I2C/UART control firmware",
      capabilityType: "embedded-software",
      category: "software",
      estimatedCost: cost(0.10),
      estimatedHours: hours(0.12),
      dependencies: [`${req.id}-elec-design`],
      parallel: true,
      evidenceRequirements: ["code_repository_link", "video_demo"],
    }),
    makeNode(req.id, {
      id: `${req.id}-assembly`,
      name: "Assembly and integration",
      description: "Assemble skeleton, mount servos, install PCB, attach plush outer layer",
      capabilityType: "assembly",
      category: "assembly",
      estimatedCost: cost(0.12),
      estimatedHours: hours(0.12),
      dependencies: [
        `${req.id}-3d-print`,
        `${req.id}-pcb`,
        `${req.id}-soft-components`,
        `${req.id}-source-components`,
      ],
      parallel: false,
      evidenceRequirements: ["photo_of_assembled_unit"],
    }),
    makeNode(req.id, {
      id: `${req.id}-programming`,
      name: "Programming and calibration",
      description: "Flash firmware, calibrate servos, tune animation timing and range of motion",
      capabilityType: "embedded-software",
      category: "software",
      estimatedCost: cost(0.07),
      estimatedHours: hours(0.08),
      dependencies: [`${req.id}-assembly`, `${req.id}-firmware`],
      parallel: false,
      evidenceRequirements: ["video_of_animations", "calibration_log"],
    }),
    makeNode(req.id, {
      id: `${req.id}-testing`,
      name: "Testing and QA",
      description: "Full motion test, endurance cycle, safety check, and final sign-off",
      capabilityType: "qa",
      category: "verification",
      estimatedCost: cost(0.08),
      estimatedHours: hours(0.06),
      dependencies: [`${req.id}-programming`],
      parallel: false,
      evidenceRequirements: ["test_report", "video_of_full_demo"],
    }),
  ],

  // ── Lab analysis (HPLC, assays, characterization) ───────────────
  lab_analysis: (req, cost, hours) => [
    makeNode(req.id, {
      id: `${req.id}-sample-prep`,
      name: "Sample preparation",
      description: "Prepare samples according to protocol: dilution, filtration, derivatization",
      capabilityType: "liquid-handling",
      category: "laboratory",
      estimatedCost: cost(0.15),
      estimatedHours: hours(0.20),
      dependencies: [],
      parallel: false,
      materials: [
        { name: "Solvents and buffers", quantity: 500, unit: "mL", estimatedCost: 25, marketplaceCategory: "chemicals" },
        { name: "Sample vials", quantity: 20, unit: "each", estimatedCost: 15, marketplaceCategory: "lab-consumables" },
      ],
      evidenceRequirements: ["photo_of_prepared_samples", "prep_log"],
    }),
    makeNode(req.id, {
      id: `${req.id}-analytical-run`,
      name: "Analytical run",
      description: "Execute the analytical method on the prepared samples using the appropriate instrument",
      capabilityType: "hplc",
      category: "laboratory",
      estimatedCost: cost(0.35),
      estimatedHours: hours(0.35),
      dependencies: [`${req.id}-sample-prep`],
      parallel: false,
      evidenceRequirements: ["raw_data_files", "chromatogram_screenshot", "instrument_log"],
    }),
    makeNode(req.id, {
      id: `${req.id}-data-analysis`,
      name: "Data analysis",
      description: "Process raw instrument output: peak integration, quantification, statistical analysis",
      capabilityType: "data-analysis",
      category: "software",
      estimatedCost: cost(0.25),
      estimatedHours: hours(0.25),
      dependencies: [`${req.id}-analytical-run`],
      parallel: false,
      evidenceRequirements: ["analysis_spreadsheet", "results_summary"],
    }),
    makeNode(req.id, {
      id: `${req.id}-report`,
      name: "Report generation",
      description: "Compile analytical results into a formal report with methods, results, and conclusions",
      capabilityType: "documentation",
      category: "documentation",
      estimatedCost: cost(0.25),
      estimatedHours: hours(0.20),
      dependencies: [`${req.id}-data-analysis`],
      parallel: false,
      evidenceRequirements: ["final_report_pdf", "signed_coa"],
    }),
  ],

  // ── Chemical / biological synthesis ────────────────────────────
  synthesis: (req, cost, hours) => [
    makeNode(req.id, {
      id: `${req.id}-protocol`,
      name: "Protocol design",
      description: "Design synthesis protocol: reaction scheme, conditions, safety assessment",
      capabilityType: "documentation",
      category: "design",
      estimatedCost: cost(0.10),
      estimatedHours: hours(0.12),
      dependencies: [],
      parallel: false,
      evidenceRequirements: ["protocol_document", "safety_review"],
    }),
    makeNode(req.id, {
      id: `${req.id}-reagents`,
      name: "Reagent sourcing",
      description: "Source and verify starting materials, solvents, and catalysts",
      capabilityType: "procurement",
      category: "procurement",
      estimatedCost: cost(0.20),
      estimatedHours: hours(0.08),
      dependencies: [`${req.id}-protocol`],
      parallel: false,
      evidenceRequirements: ["coa_documents", "photo_of_reagents"],
    }),
    makeNode(req.id, {
      id: `${req.id}-synthesis-run`,
      name: "Synthesis run",
      description: "Execute the synthesis reaction according to the approved protocol",
      capabilityType: "chemistry",
      category: "laboratory",
      estimatedCost: cost(0.30),
      estimatedHours: hours(0.35),
      dependencies: [`${req.id}-reagents`],
      parallel: false,
      evidenceRequirements: ["reaction_log", "photo_of_crude_product"],
    }),
    makeNode(req.id, {
      id: `${req.id}-purification`,
      name: "Purification",
      description: "Purify crude product via column chromatography, recrystallization, or distillation",
      capabilityType: "chemistry",
      category: "laboratory",
      estimatedCost: cost(0.20),
      estimatedHours: hours(0.20),
      dependencies: [`${req.id}-synthesis-run`],
      parallel: false,
      evidenceRequirements: ["purification_log", "photo_of_purified_product"],
    }),
    makeNode(req.id, {
      id: `${req.id}-qc`,
      name: "Analysis and QC",
      description: "Characterize product purity and identity by NMR, HPLC, or MS",
      capabilityType: "hplc",
      category: "verification",
      estimatedCost: cost(0.12),
      estimatedHours: hours(0.15),
      dependencies: [`${req.id}-purification`],
      parallel: false,
      evidenceRequirements: ["nmr_spectrum", "purity_report"],
    }),
    makeNode(req.id, {
      id: `${req.id}-documentation`,
      name: "Documentation",
      description: "Compile full batch record with yield, purity, and characterization data",
      capabilityType: "documentation",
      category: "documentation",
      estimatedCost: cost(0.08),
      estimatedHours: hours(0.10),
      dependencies: [`${req.id}-qc`],
      parallel: false,
      evidenceRequirements: ["batch_record_pdf"],
    }),
  ],

  // ── Print and deliver documents ─────────────────────────────────
  print_deliver: (req, cost, hours) => [
    makeNode(req.id, {
      id: `${req.id}-doc-prep`,
      name: "Document preparation",
      description: "Format, layout, and preflight-check document for printing",
      capabilityType: "documentation",
      category: "design",
      estimatedCost: cost(0.10),
      estimatedHours: hours(0.10),
      dependencies: [],
      parallel: false,
      evidenceRequirements: ["pdf_proof"],
    }),
    makeNode(req.id, {
      id: `${req.id}-printing`,
      name: "Printing",
      description: "Print document using appropriate printer and paper stock",
      capabilityType: "ipp",
      category: "fabrication",
      estimatedCost: cost(0.25),
      estimatedHours: hours(0.20),
      dependencies: [`${req.id}-doc-prep`],
      parallel: false,
      materials: [
        { name: "Paper stock", quantity: 50, unit: "sheets", estimatedCost: 5, marketplaceCategory: "other" },
      ],
      evidenceRequirements: ["photo_of_printed_document"],
    }),
    makeNode(req.id, {
      id: `${req.id}-courier-pickup`,
      name: "Courier pickup",
      description: "Package and hand off to courier for pickup",
      capabilityType: "logistics",
      category: "logistics",
      estimatedCost: cost(0.30),
      estimatedHours: hours(0.25),
      dependencies: [`${req.id}-printing`],
      parallel: false,
      evidenceRequirements: ["tracking_number", "pickup_confirmation"],
    }),
    makeNode(req.id, {
      id: `${req.id}-delivery`,
      name: "Delivery",
      description: "Last-mile delivery to recipient address",
      capabilityType: "logistics",
      category: "logistics",
      estimatedCost: cost(0.35),
      estimatedHours: hours(0.45),
      dependencies: [`${req.id}-courier-pickup`],
      parallel: false,
      evidenceRequirements: ["delivery_confirmation", "recipient_signature"],
    }),
  ],

  // -- Food delivery (pizza/carryout + courier) -----------
  // Live-vocab-aware template. Uses pcc-dominos (pizza.*) + pcc-courier
  // (courier.*) capability types directly so a 'pizza delivery' request
  // decomposes to the correct kernels, not document-printing or CNC.
  food_delivery: (req, cost, hours) => [
    makeNode(req.id, {
      id: `${req.id}-find-store`,
      name: "Find pizza store",
      description: "Locate the nearest orderable store for the delivery address",
      capabilityType: "pizza.findStore",
      category: "discovery",
      estimatedCost: cost(0.02),
      estimatedHours: hours(0.02),
      dependencies: [],
      parallel: false,
      evidenceRequirements: ["store_locator_response"],
    }),
    makeNode(req.id, {
      id: `${req.id}-menu`,
      name: "Fetch menu",
      description: "Pull the structured menu (variants, sizes, toppings, coupons) for the chosen store",
      capabilityType: "pizza.menu",
      category: "discovery",
      estimatedCost: cost(0.02),
      estimatedHours: hours(0.02),
      dependencies: [`${req.id}-find-store`],
      parallel: false,
      evidenceRequirements: ["menu_response"],
    }),
    makeNode(req.id, {
      id: `${req.id}-quote`,
      name: "Quote pizza order",
      description: "Validate the basket against the store + menu and price it (no charge)",
      capabilityType: "pizza.quote",
      category: "discovery",
      estimatedCost: cost(0.03),
      estimatedHours: hours(0.03),
      dependencies: [`${req.id}-menu`],
      parallel: false,
      evidenceRequirements: ["quote_response"],
    }),
    makeNode(req.id, {
      id: `${req.id}-courier-quote`,
      name: "Quote courier delivery",
      description: "Vendor-neutral courier quote against the pickup window from pizza.quote",
      capabilityType: "courier.quote",
      category: "logistics",
      estimatedCost: cost(0.03),
      estimatedHours: hours(0.02),
      dependencies: [`${req.id}-quote`],
      parallel: false,
      evidenceRequirements: ["courier_quote_response"],
    }),
    makeNode(req.id, {
      id: `${req.id}-order`,
      name: "Place pizza order (gated)",
      description: "Place the real pizza order. Gated -- only runs when payment, customer, env switch, and per-call confirm are all set.",
      capabilityType: "pizza.order",
      category: "fulfilment",
      estimatedCost: cost(0.55),
      estimatedHours: hours(0.05),
      dependencies: [`${req.id}-courier-quote`],
      parallel: false,
      evidenceRequirements: ["order_placed_response", "redacted_payment_receipt"],
    }),
    makeNode(req.id, {
      id: `${req.id}-courier-dispatch`,
      name: "Dispatch courier",
      description: "Dispatch a courier to arrive in the readyWindow. dispatchAt = readyAt - driverETA.",
      capabilityType: "courier.dispatch",
      category: "logistics",
      estimatedCost: cost(0.25),
      estimatedHours: hours(0.30),
      dependencies: [`${req.id}-order`],
      parallel: false,
      evidenceRequirements: ["courier_dispatched_response"],
    }),
    makeNode(req.id, {
      id: `${req.id}-track`,
      name: "Track pizza + courier",
      description: "Poll pizza.track + courier.track until delivered.",
      capabilityType: "pizza.track",
      category: "fulfilment",
      estimatedCost: cost(0.05),
      estimatedHours: hours(0.30),
      dependencies: [`${req.id}-courier-dispatch`],
      parallel: false,
      evidenceRequirements: ["delivery_confirmation"],
    }),
  ],

  // ── Custom fabricated product (default fallback) ────────────────
  custom_product: (req, cost, hours) => [
    makeNode(req.id, {
      id: `${req.id}-design`,
      name: "Industrial design / CAD",
      description: "Design the product: geometry, tolerances, materials, and assembly plan",
      capabilityType: "cad",
      category: "design",
      estimatedCost: cost(0.12),
      estimatedHours: hours(0.15),
      dependencies: [],
      parallel: false,
      evidenceRequirements: ["cad_files", "design_review"],
    }),
    makeNode(req.id, {
      id: `${req.id}-material-sourcing`,
      name: "Material sourcing",
      description: "Source raw materials, stock, and consumables required for fabrication",
      capabilityType: "procurement",
      category: "procurement",
      estimatedCost: cost(0.15),
      estimatedHours: hours(0.08),
      dependencies: [`${req.id}-design`],
      parallel: false,
      evidenceRequirements: ["purchase_orders", "photo_of_materials"],
    }),
    makeNode(req.id, {
      id: `${req.id}-fabrication`,
      name: "Fabrication",
      description: "Manufacture components using appropriate machining, forming, or additive processes",
      capabilityType: "cnc",
      category: "fabrication",
      estimatedCost: cost(0.35),
      estimatedHours: hours(0.35),
      dependencies: [`${req.id}-material-sourcing`],
      parallel: false,
      evidenceRequirements: ["photo_of_parts", "dimensional_inspection"],
    }),
    makeNode(req.id, {
      id: `${req.id}-assembly`,
      name: "Assembly",
      description: "Assemble components into final product",
      capabilityType: "assembly",
      category: "assembly",
      estimatedCost: cost(0.15),
      estimatedHours: hours(0.15),
      dependencies: [`${req.id}-fabrication`],
      parallel: false,
      evidenceRequirements: ["photo_of_assembled_product"],
    }),
    makeNode(req.id, {
      id: `${req.id}-inspection`,
      name: "Quality inspection",
      description: "Inspect finished product against specifications and acceptance criteria",
      capabilityType: "qa",
      category: "verification",
      estimatedCost: cost(0.12),
      estimatedHours: hours(0.12),
      dependencies: [`${req.id}-assembly`],
      parallel: false,
      evidenceRequirements: ["inspection_report", "photo_evidence"],
    }),
    makeNode(req.id, {
      id: `${req.id}-packaging`,
      name: "Packaging and shipping",
      description: "Package product securely for shipping and coordinate logistics",
      capabilityType: "logistics",
      category: "logistics",
      estimatedCost: cost(0.11),
      estimatedHours: hours(0.15),
      dependencies: [`${req.id}-inspection`],
      parallel: false,
      evidenceRequirements: ["packaged_photo", "shipping_label"],
    }),
  ],
};

// ---------------------------------------------------------------------------
// Keyword matching
// ---------------------------------------------------------------------------

const TEMPLATE_KEYWORDS: Record<string, string[]> = {
  robotics_build: [
    "robot", "animatronic", "servo", "plush", "mechanical", "interactive",
    "arm", "motor", "actuator", "electromechanical", "puppet", "automaton",
    "breathing", "animation", "firmware", "mcu", "arduino", "esp32",
  ],
  lab_analysis: [
    "analysis", "hplc", "assay", "test", "sample", "characterize",
    "chromatography", "mass spec", "spectroscopy", "titration", "pcr", "elisa",
    "purity", "concentration", "quantif",
  ],
  synthesis: [
    "synthesize", "synthesis", "compound", "reagent", "reaction", "prepare",
    "formulate", "molecule", "organic", "chemical", "extract", "ferment",
  ],
  // food_delivery is checked BEFORE print_deliver so a tie between them on
  // a "Pizza delivery to ..." request (1 hit each) goes to food_delivery.
  // detectTemplate keeps the FIRST highest-scoring template (`>` not `>=`).
  food_delivery: [
    "pizza", "pizzeria", "pie", "slice", "domino", "dominos", "papa john",
    "pizza hut", "carryout", "carry-out", "carry out", "takeout", "take-out",
    "take out", "order food", "order pizza", "food delivery",
    "deliver pizza", "deliver food", "doordash", "uber eats", "ubereats",
    "grubhub", "courier",
  ],
  print_deliver: [
    "print", "document", "deliver", "mail", "invoice",
    "letter", "brochure", "flyer", "poster",
  ],
  custom_product: [
    "fabricate", "manufacture", "custom", "product", "build", "make",
    "create", "produce", "cast", "machine", "mill", "lathe",
  ],
};

/**
 * Detect which template best fits the request description.
 *
 * When `availableTypes` is supplied (a snapshot of the live capability
 * registry's `type` column), templates whose nodes reference at least one
 * live type get a strong score boost. This is what lets a fresh-from-the-
 * registry capability like `pizza.order` win the template race over the
 * hardcoded fallback (`print_deliver` / `custom_product`) just because
 * the keyword "deliver" or "build" appears.
 *
 * The hardcoded vocabulary is preserved as a fallback for cold-start /
 * test setups where the registry is empty.
 */
function detectTemplate(description: string, availableTypes?: string[]): string {
  const lower = description.toLowerCase();
  let bestTemplate = "custom_product";
  let bestScore = 0;

  const liveTypes = new Set((availableTypes ?? []).map((t) => t.toLowerCase()));

  for (const [template, keywords] of Object.entries(TEMPLATE_KEYWORDS)) {
    let score = keywords.filter((kw) => lower.includes(kw)).length;

    // Live-vocabulary boost: if this template's node graph references at
    // least one capability type that is actually registered RIGHT NOW,
    // strongly prefer it. This is the core of the B1 fix -- the decomposer
    // is no longer blind to non-hardware capabilities that came online via
    // POST /api/capabilities after the templates were written.
    if (liveTypes.size > 0) {
      const templateCapTypes = templateNodeCapabilityTypes(template);
      const liveHit = templateCapTypes.some((t) => liveTypes.has(t.toLowerCase()));
      if (liveHit && score > 0) score += 10;
    }

    if (score > bestScore) {
      bestScore = score;
      bestTemplate = template;
    }
  }

  return bestTemplate;
}

/**
 * Static index of the capability types each template's nodes produce.
 * Used by the live-vocabulary boost in detectTemplate(). Kept hand-written
 * so it stays in sync with TEMPLATES above when a template is added.
 */
function templateNodeCapabilityTypes(template: string): string[] {
  switch (template) {
    case "robotics_build":
      return ["cad", "fdm", "pcb", "laser-cut", "procurement", "embedded-software", "assembly", "qa", "pattern-design"];
    case "lab_analysis":
      return ["liquid-handling", "hplc", "data-analysis", "documentation"];
    case "synthesis":
      return ["documentation", "procurement", "chemistry", "hplc"];
    case "print_deliver":
      return ["documentation", "ipp", "logistics"];
    case "food_delivery":
      return [
        "pizza.findStore", "pizza.menu", "pizza.quote", "pizza.order", "pizza.track",
        "courier.quote", "courier.dispatch", "courier.track",
      ];
    case "custom_product":
      return ["cad", "procurement", "cnc", "assembly", "qa", "logistics"];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Critical path calculation
// ---------------------------------------------------------------------------

function calculateCriticalPath(nodes: CapabilityNode[]): string[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Earliest completion time for each node (by hours)
  const ect = new Map<string, number>();

  function getECT(nodeId: string): number {
    if (ect.has(nodeId)) return ect.get(nodeId)!;
    const node = nodeMap.get(nodeId);
    if (!node) return 0;

    const depMax = node.dependencies.length > 0
      ? Math.max(...node.dependencies.map(getECT))
      : 0;

    const result = depMax + node.estimatedHours;
    ect.set(nodeId, result);
    return result;
  }

  nodes.forEach((n) => getECT(n.id));

  // Find the end node(s) — nodes with no dependents
  const hasDependents = new Set<string>();
  nodes.forEach((n) => n.dependencies.forEach((d) => hasDependents.add(d)));
  const endNodes = nodes.filter((n) => !hasDependents.has(n.id));

  // Find the node with the maximum ECT (the critical end)
  let criticalEnd = endNodes[0]?.id ?? nodes[nodes.length - 1]?.id;
  let maxTime = 0;
  for (const node of endNodes) {
    const t = ect.get(node.id) ?? 0;
    if (t > maxTime) {
      maxTime = t;
      criticalEnd = node.id;
    }
  }

  // Trace back from the critical end
  const path: string[] = [];
  let current: string | undefined = criticalEnd;

  while (current) {
    path.unshift(current);
    const node = nodeMap.get(current);
    if (!node || node.dependencies.length === 0) break;

    // Pick the dependency with the highest ECT (the critical predecessor)
    let nextId: string | undefined;
    let nextECT = -1;
    for (const depId of node.dependencies) {
      const t = ect.get(depId) ?? 0;
      if (t > nextECT) {
        nextECT = t;
        nextId = depId;
      }
    }
    current = nextId;
  }

  return path;
}

// ---------------------------------------------------------------------------
// Parallel track identification
// ---------------------------------------------------------------------------

function calculateParallelTracks(nodes: CapabilityNode[]): string[][] {
  const hasDependents = new Set<string>();
  nodes.forEach((n) => n.dependencies.forEach((d) => hasDependents.add(d)));

  // Group nodes by what they're blocked by — nodes with the same deps can run in parallel
  const groups = new Map<string, string[]>();

  for (const node of nodes) {
    if (!node.parallel) continue;
    const key = node.dependencies.sort().join(",");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(node.id);
  }

  // Only return groups with more than one node (actual parallelism)
  return [...groups.values()].filter((g) => g.length > 1);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decompose a capability request into a dependency DAG.
 * Scales costs and hours to fit the request budget and urgency.
 *
 * NOTE (coord 954b8361 — compose facade wiring): this is a pure template-to-DAG
 * planner. It emits the work breakdown with `assignedOperator: undefined`;
 * operators bind later at bounty-claim time, so there is no candidate-SELECTION
 * step here to route through CapabilityFacade (unlike compose.ts, whose
 * `facadeProvider` picks a concrete capability instance per step). Pre-binding
 * operators per node would change this planner's semantics, so facade wiring is
 * intentionally deferred — mirror compose.ts's `facadeProvider` if per-node
 * operator pre-binding is ever required.
 */
export interface DecomposeOptions {
  /**
   * Snapshot of the live capability registry's `type` column.
   * When provided, templates whose nodes reference a live type get a
   * scoring boost so a 'pizza delivery' request decomposes to
   * pizza.order + courier.dispatch (not document-printing) the moment
   * those kernels are registered. Cold-start safe: omit and the
   * hardcoded vocabulary still works.
   */
  availableTypes?: string[];
}

export function decomposeRequest(
  req: CapabilityRequest,
  opts: DecomposeOptions = {},
): DecompositionResult {
  const templateName = detectTemplate(req.description, opts.availableTypes);
  const templateFn = TEMPLATES[templateName] ?? TEMPLATES.custom_product;

  const urgency = req.urgency ?? "standard";
  const costMult = URGENCY_COST_MULTIPLIER[urgency] ?? 1.0;
  const timeMult = URGENCY_TIME_MULTIPLIER[urgency] ?? 1.0;

  // Cost and hour helpers that scale to the request budget
  // We'll compute raw first, then rescale to fit budget
  const budgetShare = (fraction: number) => Math.round(req.budget * fraction * costMult * 100) / 100;
  const hourShare = (fraction: number) => Math.round(fraction * 40 * timeMult * 10) / 10;

  const nodes = templateFn(req, budgetShare, hourShare);

  const totalEstimatedCost = nodes.reduce((sum, n) => sum + n.estimatedCost, 0);
  const totalEstimatedHours = nodes.reduce((sum, n) => sum + n.estimatedHours, 0);
  const criticalPath = calculateCriticalPath(nodes);
  const parallelTracks = calculateParallelTracks(nodes);

  return {
    nodes,
    totalEstimatedCost,
    totalEstimatedHours,
    criticalPath,
    parallelTracks,
  };
}

// ---------------------------------------------------------------------------
// Direct-match decomposition (single registered listing)
// ---------------------------------------------------------------------------

/**
 * A registered capability listing a request is routed directly to. Mirrors
 * `RoutedListing` in request-matcher; kept as a local input type so this module
 * stays pure (no DB access — the caller resolves the listing and passes it in).
 */
export interface DirectMatchListing {
  capabilityType: string;
  capabilityId: string;
  kernelId: string;
  name: string;
  /** Base price as a dollar-string, from the listing's pricing model. */
  basePrice: string;
  currency: string;
}

/**
 * A capability node that resolved to a specific listing. The optional
 * `kernelId` / `capabilityId` carry the routed operator + capability row so a
 * downstream step can fund an escrow against them. These are additive — generic
 * (template-decomposed) nodes simply omit them.
 */
export type RoutedCapabilityNode = CapabilityNode & {
  kernelId?: string;
  capabilityId?: string;
};

/**
 * Decompose a request that targets ONE registered capability listing into a
 * single direct-match node.
 *
 * Used for atomic ad-hoc orders (a ride, a pizza, a delivery) where there is no
 * multi-step build to plan — the request routes straight to the operator's
 * listing. Cost comes from the listing's OWN pricing model (basePrice * qty),
 * NOT the request budget or a composite template. The node carries the kernel +
 * capability id so the order/escrow path can settle against that operator.
 */
export function decomposeDirectMatch(
  req: CapabilityRequest,
  listing: DirectMatchListing,
  quantity = 1,
): DecompositionResult {
  const qty = Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1;
  const unit = Number(listing.basePrice);
  const estimatedCost = Math.round((Number.isFinite(unit) ? unit : 0) * qty * 100) / 100;

  const node: RoutedCapabilityNode = {
    id: `${req.id}-match`,
    requestId: req.id,
    name: listing.name,
    description: req.description,
    capabilityType: listing.capabilityType,
    category: "fulfillment",
    estimatedCost,
    estimatedHours: 1,
    dependencies: [],
    parallel: false,
    status: "pending",
    assignedOperator: undefined,
    bountyId: undefined,
    materials: [],
    evidenceRequirements: ["photo_of_completed_work"],
    kernelId: listing.kernelId,
    capabilityId: listing.capabilityId,
  };

  return {
    nodes: [node],
    totalEstimatedCost: estimatedCost,
    totalEstimatedHours: node.estimatedHours,
    criticalPath: [node.id],
    parallelTracks: [],
  };
}

/**
 * Expose template detection so tests can verify keyword routing.
 */
export function detectTemplateName(description: string, availableTypes?: string[]): string {
  return detectTemplate(description, availableTypes);
}
