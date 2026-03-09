import type { FastifyInstance } from "fastify";
import type { DocumentAnalysisResult, MachineRegistration } from "@pcc/spec";

// Mock storage
const registrations: MachineRegistration[] = [];

export async function onboardRoutes(app: FastifyInstance) {
  // Upload document and return mock AI analysis
  app.post("/api/onboard/analyze", async (req) => {
    const result: DocumentAnalysisResult = {
      suggestedCapabilities: [
        {
          id: `sug-${Date.now()}`,
          type: "fdm",
          name: "Standard FDM Printing",
          description: "Layer-by-layer extrusion with 0.4mm nozzle",
          materials: ["PLA", "PETG", "ABS", "TPU"],
          tolerances: { linear: "±0.2mm", surface: "Ra 12.5" },
          envelope: { x: 250, y: 210, z: 210, unit: "mm" },
          suggestedParams: [],
          confidence: 0.92,
          sourceReason: "Extracted from manufacturer datasheet",
        },
      ],
      extractedSpecs: {
        "build-volume": "250 x 210 x 210 mm",
        "layer-height": "0.05 - 0.30 mm",
        "nozzle-temp-max": "300°C",
        "bed-temp-max": "120°C",
      },
      extractedMaterials: ["PLA", "PETG", "ABS", "TPU", "ASA", "PC"],
      extractedTolerances: [{ linear: "±0.2mm", surface: "Ra 12.5" }],
      confidence: 0.89,
      sourceDocumentId: "doc-uploaded",
    };
    return { status: "ok", analysis: result };
  });

  // Submit machine registration
  app.post("/api/onboard/register", async (req) => {
    const body = req.body as Partial<MachineRegistration>;
    const registration: MachineRegistration = {
      id: `reg-${Date.now()}`,
      name: body.name ?? "Unknown",
      category: body.category ?? "custom",
      manufacturer: body.manufacturer ?? "",
      model: body.model ?? "",
      serialNumber: body.serialNumber,
      description: body.description,
      photos: body.photos ?? [],
      documents: body.documents ?? [],
      capabilities: body.capabilities ?? [],
      spaceRequirements: body.spaceRequirements ?? {
        footprint: { width: 0, depth: 0, height: 0, unit: "mm" },
        clearances: { front: 0, back: 0, left: 0, right: 0, above: 0, unit: "mm" },
        weight: { value: 0, unit: "kg" },
        power: { voltage: 120, amperage: 15, phase: 1 },
        environmental: { ventilationRequired: false, dustExtraction: false, fumeExtraction: false },
        utilities: { compressedAir: false, water: false, coolant: false, wasteDrainage: false },
        vibrationIsolation: false,
      },
      pricing: body.pricing ?? { baseCost: "0", minimum: "0", currency: "USDC" },
      operator: body.operator ?? {
        walletAddress: "0x0000000000000000000000000000000000000000",
        displayName: "Unknown",
        certifications: [],
        trainingAcknowledgments: {},
      },
      status: "submitted",
      createdAt: new Date().toISOString(),
      submittedAt: new Date().toISOString(),
    };
    registrations.push(registration);
    return { status: "ok", registration };
  });

  // List registrations
  app.get("/api/onboard/registrations", async () => {
    return { registrations };
  });

  // Get registration detail
  app.get<{ Params: { id: string } }>("/api/onboard/registrations/:id", async (req) => {
    const reg = registrations.find((r) => r.id === req.params.id);
    if (!reg) return { error: "not_found" };
    return { registration: reg };
  });
}
