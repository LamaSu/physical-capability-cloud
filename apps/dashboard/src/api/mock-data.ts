import type {
  ShopKernel, Capability, KernelDevice, KernelJob,
  EvidenceEvent, EvidenceBundle, Escrow, EscrowMilestone,
  AssuranceTier,
} from "@pcc/spec";

// ── Capabilities ──

const fdmCapability: Capability = {
  id: "cap-fdm-nyc",
  kernelId: "kernel-nyc",
  type: "fdm",
  name: "Prusa MK4 FDM",
  description: "Desktop FDM printer for prototyping and small batch production",
  materials: ["pla", "petg", "abs", "tpu"],
  tolerances: { linear: "±0.2mm", surface: "Ra 12.5" },
  envelope: { x: 250, y: 210, z: 210, unit: "mm" },
  assuranceTiers: [0, 1, 2],
  pricing: { currency: "USDC", baseCost: "12.00", perMinute: "0.05", perGram: "0.03", minimum: "5.00" },
  availability: { timezone: "America/New_York", windows: {} },
  location: { lat: 40.7128, lng: -74.006 },
  queueDepth: 1,
  tags: ["prototype", "desktop"],
};

const laserCapability: Capability = {
  id: "cap-laser-nyc",
  kernelId: "kernel-nyc",
  type: "laser-cut",
  name: "Epilog Fusion Pro Laser",
  description: "CO2 laser for cutting and engraving sheet materials",
  materials: ["acrylic", "plywood", "mdf", "delrin", "leather"],
  tolerances: { linear: "±0.1mm" },
  envelope: { x: 1016, y: 711, z: 50, unit: "mm" },
  assuranceTiers: [0, 1],
  pricing: { currency: "USDC", baseCost: "8.00", perMinute: "0.10", minimum: "5.00" },
  availability: { timezone: "America/New_York", windows: {} },
  location: { lat: 40.7128, lng: -74.006 },
  queueDepth: 0,
  tags: ["sheet", "2d"],
};

const cncCapability: Capability = {
  id: "cap-cnc-sf",
  kernelId: "kernel-sf",
  type: "cnc-3axis",
  name: "Haas VF-2 CNC Mill",
  description: "Industrial 3-axis CNC milling for aluminum, steel, and plastics",
  materials: ["aluminum-6061", "aluminum-7075", "steel-1018", "delrin", "hdpe"],
  tolerances: { linear: "±0.05mm", surface: "Ra 1.6", positional: "±0.1mm" },
  envelope: { x: 762, y: 406, z: 508, unit: "mm" },
  assuranceTiers: [0, 1, 2, 3],
  pricing: { currency: "USDC", baseCost: "75.00", perMinute: "1.50", minimum: "50.00" },
  availability: { timezone: "America/Los_Angeles", windows: {} },
  location: { lat: 37.7749, lng: -122.4194 },
  queueDepth: 2,
  tags: ["metal", "industrial", "precision"],
};

const slaCapability: Capability = {
  id: "cap-sla-la",
  kernelId: "kernel-la",
  type: "sla",
  name: "Formlabs Form 3+ SLA",
  description: "High-resolution resin printing for detailed prototypes",
  materials: ["standard-resin", "tough-resin", "flexible-resin", "castable-resin"],
  tolerances: { linear: "±0.05mm", surface: "Ra 3.2" },
  envelope: { x: 145, y: 145, z: 185, unit: "mm" },
  assuranceTiers: [0, 1, 2],
  pricing: { currency: "USDC", baseCost: "20.00", perCm3: "0.15", minimum: "10.00" },
  availability: { timezone: "America/Los_Angeles", windows: {} },
  location: { lat: 34.0522, lng: -118.2437 },
  queueDepth: 0,
  tags: ["resin", "high-detail"],
};

// ── Devices ──

export const mockDevices: KernelDevice[] = [
  { id: "dev-prusa", kernelId: "kernel-nyc", type: "machine", model: "Prusa MK4", firmware: "5.1.2", status: "busy", contributesToCapabilities: ["cap-fdm-nyc"], lastUpdated: "2026-03-03T14:30:00Z" },
  { id: "dev-laser", kernelId: "kernel-nyc", type: "machine", model: "Epilog Fusion Pro", firmware: "3.4.0", status: "idle", contributesToCapabilities: ["cap-laser-nyc"], lastUpdated: "2026-03-03T14:30:00Z" },
  { id: "dev-cam-1", kernelId: "kernel-nyc", type: "camera", model: "Logitech C920", firmware: "1.0.0", status: "idle", contributesToCapabilities: ["cap-fdm-nyc", "cap-laser-nyc"], lastUpdated: "2026-03-03T14:30:00Z" },
  { id: "dev-power", kernelId: "kernel-nyc", type: "sensor", model: "INA219 Power Monitor", firmware: "2.1.0", status: "busy", contributesToCapabilities: ["cap-fdm-nyc"], lastUpdated: "2026-03-03T14:30:00Z" },
  { id: "dev-haas", kernelId: "kernel-sf", type: "machine", model: "Haas VF-2", firmware: "100.23.1", status: "busy", contributesToCapabilities: ["cap-cnc-sf"], lastUpdated: "2026-03-03T14:25:00Z" },
  { id: "dev-tee", kernelId: "kernel-sf", type: "tee", model: "Intel SGX", firmware: "2.20.0", status: "idle", contributesToCapabilities: ["cap-cnc-sf"], lastUpdated: "2026-03-03T14:25:00Z" },
];

// ── Kernels ──

export const mockKernels: ShopKernel[] = [
  {
    id: "kernel-nyc",
    name: "NYC MakerSpace",
    operatorAddress: "0x1234567890abcdef1234567890abcdef12345678",
    location: { lat: 40.7128, lng: -74.006 },
    physicalAddress: "123 Maker Street, Brooklyn, NY 11201",
    capabilities: [fdmCapability, laserCapability],
    maxAssuranceTier: 2,
    publicKey: "0x04abc...",
    reputation: 950,
    totalJobsCompleted: 142,
    status: "online",
    registeredAt: "2025-06-15T00:00:00Z",
    lastHeartbeat: "2026-03-03T14:30:00Z",
    version: "0.1.0",
  },
  {
    id: "kernel-sf",
    name: "SF Precision Workshop",
    operatorAddress: "0xabcdef1234567890abcdef1234567890abcdef12",
    location: { lat: 37.7749, lng: -122.4194 },
    physicalAddress: "456 Industrial Blvd, San Francisco, CA 94107",
    capabilities: [cncCapability],
    maxAssuranceTier: 3,
    publicKey: "0x04def...",
    reputation: 870,
    totalJobsCompleted: 67,
    status: "online",
    registeredAt: "2025-09-01T00:00:00Z",
    lastHeartbeat: "2026-03-03T14:25:00Z",
    version: "0.1.0",
  },
  {
    id: "kernel-la",
    name: "LA Fab Lab",
    operatorAddress: "0x9876543210fedcba9876543210fedcba98765432",
    location: { lat: 34.0522, lng: -118.2437 },
    physicalAddress: "789 Design Ave, Los Angeles, CA 90012",
    capabilities: [slaCapability],
    maxAssuranceTier: 2,
    publicKey: "0x04ghi...",
    reputation: 720,
    totalJobsCompleted: 31,
    status: "offline",
    registeredAt: "2025-11-20T00:00:00Z",
    lastHeartbeat: "2026-03-02T22:00:00Z",
    version: "0.1.0",
  },
];

export const allCapabilities: Capability[] = [fdmCapability, laserCapability, cncCapability, slaCapability];

// ── Jobs ──

export const mockJobs: KernelJob[] = [
  { id: "job-001", stepId: "step-1", cwmId: "cwm-001", capabilityId: "cap-fdm-nyc", status: "executing", assignedDevices: ["dev-prusa"], startedAt: "2026-03-03T13:00:00Z", progress: 67, evidenceBundleId: undefined },
  { id: "job-002", stepId: "step-2", cwmId: "cwm-002", capabilityId: "cap-cnc-sf", status: "executing", assignedDevices: ["dev-haas"], startedAt: "2026-03-03T12:00:00Z", progress: 23, evidenceBundleId: undefined },
  { id: "job-003", stepId: "step-3", cwmId: "cwm-003", capabilityId: "cap-laser-nyc", status: "queued", assignedDevices: [], progress: 0, evidenceBundleId: undefined },
  { id: "job-004", stepId: "step-4", cwmId: "cwm-001", capabilityId: "cap-fdm-nyc", status: "completed", assignedDevices: ["dev-prusa"], startedAt: "2026-03-03T09:00:00Z", completedAt: "2026-03-03T11:30:00Z", progress: 100, evidenceBundleId: "bundle-001" },
];

// ── Job metadata (not in kernel types, for UI) ──

export const jobMeta: Record<string, { name: string; kernelName: string; amount: string; tier: AssuranceTier }> = {
  "job-001": { name: "FDM Print — Gear Housing", kernelName: "NYC MakerSpace", amount: "45.00", tier: 1 },
  "job-002": { name: "CNC Mill — Mounting Bracket", kernelName: "SF Precision Workshop", amount: "245.00", tier: 2 },
  "job-003": { name: "Laser Cut — Control Panel", kernelName: "NYC MakerSpace", amount: "18.50", tier: 0 },
  "job-004": { name: "FDM Print — Enclosure Base", kernelName: "NYC MakerSpace", amount: "32.00", tier: 1 },
};

// ── Escrows ──

export const mockEscrows: Escrow[] = [
  {
    id: "esc-001",
    cwmId: "cwm-001",
    contractAddress: "0xEscrow1111111111111111111111111111111111",
    payer: "0x1234567890abcdef1234567890abcdef12345678",
    totalAmount: "77.00",
    currency: "USDC",
    milestones: [
      { stepId: "step-1", amount: "45.00", status: "locked", bondAmount: "2.25", challengeWindowStart: undefined, challengeWindowEnd: undefined },
      { stepId: "step-4", amount: "32.00", status: "releasing", bondAmount: "1.60", challengeWindowStart: "2026-03-03T11:30:00Z", challengeWindowEnd: "2026-03-03T15:30:00Z" },
    ],
    status: "active",
    createdAt: "2026-03-03T08:00:00Z",
    deadline: "2026-03-04T08:00:00Z",
  },
  {
    id: "esc-002",
    cwmId: "cwm-002",
    contractAddress: "0xEscrow2222222222222222222222222222222222",
    payer: "0x1234567890abcdef1234567890abcdef12345678",
    totalAmount: "245.00",
    currency: "USDC",
    milestones: [
      { stepId: "step-2", amount: "245.00", status: "locked", bondAmount: "36.75", challengeWindowStart: undefined, challengeWindowEnd: undefined },
    ],
    status: "active",
    createdAt: "2026-03-03T10:00:00Z",
    deadline: "2026-03-05T10:00:00Z",
  },
  {
    id: "esc-003",
    cwmId: "cwm-003",
    contractAddress: "0xEscrow3333333333333333333333333333333333",
    payer: "0x1234567890abcdef1234567890abcdef12345678",
    totalAmount: "18.50",
    currency: "USDC",
    milestones: [
      { stepId: "step-3", amount: "18.50", status: "funded", bondAmount: "0", challengeWindowStart: undefined, challengeWindowEnd: undefined },
    ],
    status: "funded",
    createdAt: "2026-03-03T13:00:00Z",
    deadline: "2026-03-04T13:00:00Z",
  },
];
