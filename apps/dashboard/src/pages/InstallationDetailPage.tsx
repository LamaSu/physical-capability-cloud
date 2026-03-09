import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { GlassPanel, GlowBadge } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";

const mockInstallations = [
  {
    id: "inst-001",
    equipment: "Prusa MK4 + MMU3 + Enclosure",
    space: "Brooklyn Maker Hub — Bay 3",
    status: "scheduled",
    assignee: { name: "Ryan George", type: "Operator", email: "ryan@makerhub.example.com", phone: "+1-718-555-0101" },
    scheduledDate: "Mar 12, 2026",
    estimatedHours: 4,
    bookingId: "book-001",
    steps: [
      { id: "s1", label: "Receive Delivery", description: "Accept delivery, verify package count and condition", status: "pending", est: "30 min", signoff: true },
      { id: "s2", label: "Uncrate & Inspect", description: "Remove packaging, inspect for shipping damage, photograph", status: "pending", est: "45 min", signoff: true },
      { id: "s3", label: "Position & Anchor", description: "Move equipment to Bay 3, level on work surface", status: "pending", est: "60 min", signoff: false },
      { id: "s4", label: "Connect Power", description: "Wire to dedicated circuit, verify 120V", status: "pending", est: "30 min", signoff: true },
      { id: "s5", label: "Connect Network", description: "Ethernet setup, verify connectivity to PCC gateway", status: "pending", est: "20 min", signoff: false },
      { id: "s6", label: "Connect Utilities", description: "No additional utilities required for this machine", status: "pending", est: "5 min", signoff: false },
      { id: "s7", label: "Safety Inspection", description: "E-stop test, enclosure latch check", status: "pending", est: "30 min", signoff: true },
      { id: "s8", label: "Calibrate", description: "Run Prusa auto-calibration: bed mesh, first-layer, input shaper", status: "pending", est: "60 min", signoff: true },
      { id: "s9", label: "Test Run", description: "Print calibration cube (20mm), verify dimensions and surface quality", status: "pending", est: "45 min", signoff: true },
      { id: "s10", label: "Commission Kernel", description: "Register as Shop Kernel, activate FDM capability, go online", status: "pending", est: "30 min", signoff: true },
    ],
    notes: [
      { time: "Mar 1", author: "System", message: "Installation order auto-created from space booking", type: "info" },
    ],
  },
  {
    id: "inst-002",
    equipment: "Haas VF-2 CNC Vertical Mill",
    space: "Brooklyn Maker Hub — Bay 5",
    status: "draft",
    assignee: { name: "Haas Field Service", type: "Vendor", email: "service@haas.example.com", phone: "+1-805-555-0300", company: "Haas Automation" },
    scheduledDate: "Mar 17, 2026",
    estimatedHours: 8,
    bookingId: "book-002",
    steps: [
      { id: "s1", label: "Receive Delivery", description: "Accept rigging crew delivery, crane/forklift unload from truck", status: "pending", est: "60 min", signoff: true },
      { id: "s2", label: "Uncrate & Inspect", description: "Remove skid, inspect for transit damage, check coolant reservoir", status: "pending", est: "45 min", signoff: true },
      { id: "s3", label: "Position & Anchor", description: "Crane to concrete pad in Bay 5, level with precision jacks, anchor bolts", status: "pending", est: "120 min", signoff: true },
      { id: "s4", label: "Connect Power", description: "Wire 480V 3-phase, 200A dedicated circuit, verify rotation direction", status: "pending", est: "60 min", signoff: true },
      { id: "s5", label: "Connect Network", description: "Ethernet to Haas NGC controller, configure IP, verify PCC gateway", status: "pending", est: "30 min", signoff: false },
      { id: "s6", label: "Connect Utilities", description: "Compressed air line (90 PSI), coolant fill, chip auger check", status: "pending", est: "45 min", signoff: true },
      { id: "s7", label: "Safety Inspection", description: "E-stop all stations, door interlock, chip guard, fire suppression", status: "pending", est: "45 min", signoff: true },
      { id: "s8", label: "Calibrate", description: "Haas service calibration: spindle warmup, tool offset, ball bar test", status: "pending", est: "120 min", signoff: true },
      { id: "s9", label: "Test Run", description: "Cut test coupon: bore, surface finish, dimensional verification with CMM", status: "pending", est: "90 min", signoff: true },
      { id: "s10", label: "Commission Kernel", description: "Register as Shop Kernel, activate CNC milling capability, go online", status: "pending", est: "30 min", signoff: true },
    ],
    notes: [
      { time: "Mar 8", author: "System", message: "Installation order created for CNC mill setup", type: "info" },
      { time: "Mar 9", author: "Ryan George", message: "Need rigging crew for unload — machine is 3100kg on skid", type: "warning" },
    ],
  },
];

const statusColor = (status: string): "green" | "gold" | "red" | "gray" => {
  if (["in_progress", "completed"].includes(status)) return "green";
  if (["scheduled", "pending"].includes(status)) return "gold";
  if (["failed", "blocked"].includes(status)) return "red";
  return "gray";
};

const noteColor = (type: string) => {
  if (type === "warning") return "text-yellow-400/60";
  if (type === "issue") return "text-red-400/60";
  if (type === "resolution") return "text-green-400/60";
  return "text-white/30";
};

export function InstallationDetailPage() {
  const { installationId } = useParams();
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  const installation = installationId
    ? mockInstallations.find((i) => i.id === installationId)
    : null;

  React.useEffect(() => {
    setPageMeta("Installation", installation?.equipment ?? "All Installations");
  }, [setPageMeta, installation]);

  // List view if no ID
  if (!installationId) {
    return (
      <div className="space-y-6">
        <button
          onClick={() => navigate("/logistics")}
          className="text-[10px] text-white/20 hover:text-white/40 transition-colors"
        >
          ← Back to Logistics Hub
        </button>

        <div className="space-y-3">
          {mockInstallations.map((inst) => {
            const completedSteps = inst.steps.filter((s) => s.status === "completed").length;
            return (
              <GlassPanel
                key={inst.id}
                hover
                padding="md"
                className="cursor-pointer"
                onClick={() => navigate(`/logistics/installations/${inst.id}`)}
              >
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-white/70">{inst.equipment}</span>
                      <GlowBadge color={statusColor(inst.status)}>{inst.status}</GlowBadge>
                    </div>
                    <div className="text-[10px] text-white/20">{inst.space}</div>
                    <div className="text-[10px] text-white/15">Assigned: {inst.assignee.name} ({inst.assignee.type})</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] text-white/20">Scheduled</div>
                    <div className="text-xs text-white/50">{inst.scheduledDate}</div>
                    <div className="text-[10px] text-white/15 mt-1">{completedSteps}/{inst.steps.length} steps</div>
                  </div>
                </div>
              </GlassPanel>
            );
          })}
        </div>
      </div>
    );
  }

  if (!installation) {
    return (
      <div className="text-center py-12 text-white/20 text-sm">
        Installation not found.{" "}
        <button onClick={() => navigate("/logistics/installations")} className="text-green-400/60 underline">
          Back
        </button>
      </div>
    );
  }

  const completedSteps = installation.steps.filter((s) => s.status === "completed").length;
  const progressPercent = Math.round((completedSteps / installation.steps.length) * 100);

  return (
    <div className="space-y-6">
      <button
        onClick={() => navigate("/logistics/installations")}
        className="text-[10px] text-white/20 hover:text-white/40 transition-colors"
      >
        ← Back to Installations
      </button>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-lg text-white/80">{installation.equipment}</span>
            <GlowBadge color={statusColor(installation.status)}>{installation.status}</GlowBadge>
          </div>
          <div className="text-xs text-white/20 mt-1">{installation.space}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-white/20">Scheduled</div>
          <div className="text-sm text-white/60">{installation.scheduledDate}</div>
          <div className="text-[10px] text-white/15">~{installation.estimatedHours}h estimated</div>
        </div>
      </div>

      {/* Progress Bar */}
      <GlassPanel padding="sm">
        <div className="flex items-center gap-3">
          <div className="flex-1 h-2 bg-white/[0.04] rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500/40 rounded-full transition-all"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <span className="text-xs text-white/30">{completedSteps}/{installation.steps.length}</span>
        </div>
      </GlassPanel>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Steps Checklist */}
        <div className="md:col-span-2">
          <GlassPanel padding="md">
            <div className="text-xs text-white/30 mb-3">Installation Checklist</div>
            <div className="space-y-1">
              {installation.steps.map((step, i) => (
                <div
                  key={step.id}
                  className={`flex items-start gap-3 p-2 rounded-lg ${
                    step.status === "completed" ? "bg-green-500/[0.03]" : step.status === "in_progress" ? "bg-blue-500/[0.03]" : ""
                  }`}
                >
                  <div className="mt-0.5 shrink-0">
                    {step.status === "completed" ? (
                      <div className="w-5 h-5 rounded bg-green-500/20 flex items-center justify-center text-green-400 text-[10px]">✓</div>
                    ) : step.status === "in_progress" ? (
                      <div className="w-5 h-5 rounded bg-blue-500/20 flex items-center justify-center text-blue-400 text-[10px]">◎</div>
                    ) : (
                      <div className="w-5 h-5 rounded bg-white/[0.04] flex items-center justify-center text-white/15 text-[10px]">{i + 1}</div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs ${step.status === "completed" ? "text-white/40 line-through" : "text-white/60"}`}>
                        {step.label}
                      </span>
                      {step.signoff && <span className="text-[8px] text-yellow-400/30 border border-yellow-400/15 rounded px-1">SIGNOFF</span>}
                    </div>
                    <div className="text-[10px] text-white/15 mt-0.5">{step.description}</div>
                    <div className="text-[10px] text-white/10 mt-0.5">Est: {step.est}</div>
                  </div>
                </div>
              ))}
            </div>
          </GlassPanel>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Assignee */}
          <GlassPanel padding="md">
            <div className="text-xs text-white/30 mb-3">Assigned To</div>
            <div className="space-y-2 text-[10px]">
              <div>
                <span className="text-white/50 text-sm">{installation.assignee.name}</span>
                <div className="text-white/20">{installation.assignee.type}{installation.assignee.company ? ` · ${installation.assignee.company}` : ""}</div>
              </div>
              <div className="text-white/20">{installation.assignee.email}</div>
              <div className="text-white/20">{installation.assignee.phone}</div>
            </div>
          </GlassPanel>

          {/* Notes */}
          <GlassPanel padding="md">
            <div className="text-xs text-white/30 mb-3">Notes</div>
            <div className="space-y-2">
              {installation.notes.map((n, i) => (
                <div key={i} className="text-[10px]">
                  <div className={noteColor(n.type)}>{n.message}</div>
                  <div className="text-white/10 mt-0.5">{n.author} · {n.time}</div>
                </div>
              ))}
            </div>
          </GlassPanel>

          {/* Links */}
          <div className="space-y-2">
            <button
              onClick={() => navigate(`/logistics/bookings/${installation.bookingId}`)}
              className="w-full px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white/40 text-[10px] hover:text-white/60 transition-colors"
            >
              View Space Booking →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
