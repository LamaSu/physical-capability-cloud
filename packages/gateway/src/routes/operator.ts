import type { FastifyInstance } from "fastify";
import type { MaintenanceEvent, OperatorCertification } from "@pcc/spec";

const mockMachines = [
  { id: "reg-001", name: "Prusa MK4 Workshop", type: "fdm", status: "active", utilization: 72, jobsCompleted: 98, uptime: 99.2 },
  { id: "reg-002", name: "Epilog Fusion Pro", type: "laser-cut", status: "active", utilization: 58, jobsCompleted: 44, uptime: 97.8 },
];

const mockCerts: OperatorCertification[] = [
  { id: "cert-1", name: "OSHA 10-Hour General Industry", issuer: "OSHA", issuedAt: "2025-06-15T00:00:00Z", expiresAt: "2028-06-15T00:00:00Z", status: "valid" },
  { id: "cert-2", name: "3D Printing Safety Training", issuer: "PCC Network", issuedAt: "2025-09-01T00:00:00Z", expiresAt: "2026-09-01T00:00:00Z", status: "valid" },
];

const mockMaintenance: MaintenanceEvent[] = [
  { id: "maint-1", machineId: "reg-001", type: "scheduled", description: "Replace nozzle and clean heatbreak", scheduledAt: "2026-03-10T09:00:00Z", status: "upcoming" },
  { id: "maint-2", machineId: "reg-001", type: "inspection", description: "Quarterly belt tension check", scheduledAt: "2026-03-20T14:00:00Z", status: "upcoming" },
  { id: "maint-3", machineId: "reg-001", type: "scheduled", description: "Firmware update v5.2.0", scheduledAt: "2026-03-01T10:00:00Z", completedAt: "2026-03-01T10:30:00Z", status: "completed" },
];

export async function operatorRoutes(app: FastifyInstance) {
  // List operator's machines
  app.get("/api/operator/machines", async () => {
    return { machines: mockMachines };
  });

  // Earnings data with period filter
  app.get("/api/operator/earnings", async (req) => {
    const query = req.query as Record<string, string>;
    const days = query.period === "7d" ? 7 : query.period === "90d" ? 90 : query.period === "1y" ? 365 : 30;

    const earnings = Array.from({ length: days }, (_, i) => {
      const daily = 15 + Math.random() * 40;
      return {
        date: new Date(Date.now() - (days - i) * 86400000).toISOString().split("T")[0],
        earnings: Math.round(daily * 100) / 100,
      };
    });

    let cumulative = 0;
    const withCumulative = earnings.map((e) => {
      cumulative += e.earnings;
      return { ...e, cumulative: Math.round(cumulative * 100) / 100 };
    });

    return { earnings: withCumulative, total: Math.round(cumulative * 100) / 100 };
  });

  // Certification list
  app.get("/api/operator/certifications", async () => {
    return { certifications: mockCerts };
  });

  // Maintenance events
  app.get("/api/operator/maintenance", async () => {
    return { events: mockMaintenance };
  });
}
