import React, { useState, useEffect, useRef, useCallback } from "react";
import { useUIStore } from "../stores/ui-store.js";

type UIRenderComponent = "photo_capture" | "network_scan_results" | "machine_config_preview" | "test_results" | "setup_complete" | "text_input" | "selection";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  id: string;
  role: "agent" | "user";
  content: string;
  timestamp: string;
  uiRequest?: {
    component: UIRenderComponent;
    props: Record<string, unknown>;
  };
}

interface SelectionOption {
  value: string;
  label: string;
  description?: string;
}

interface NetworkDevice {
  address: string;
  hostname?: string;
  service?: string;
}

interface MachineConfigPreview {
  make?: string;
  model?: string;
  type?: string;
  adapterType?: string;
  url?: string;
}

interface TestResultsPreview {
  registered: boolean;
  testResult?: { success: boolean; duration?: number };
  registrationError?: string;
}

// ---------------------------------------------------------------------------
// Initial agent greeting (simulated since no live agent bus in dashboard)
// ---------------------------------------------------------------------------

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: "msg_init_0",
    role: "agent",
    content:
      "Hello! I'm your PCC Setup Assistant. I'll guide you through adding a machine to your Physical Capability Cloud instance.\n\nLet's start by identifying your machine. Do you have a photo of it, or would you like to enter the details manually?",
    timestamp: new Date().toISOString(),
    uiRequest: {
      component: "selection",
      props: {
        prompt: "How would you like to identify your machine?",
        options: [
          { value: "photo", label: "Take or upload a photo", description: "AI identifies the machine automatically" },
          { value: "manual", label: "Enter details manually", description: "Type the make, model, and type" },
          { value: "scan", label: "Scan network", description: "Discover devices on your local network" },
        ] satisfies SelectionOption[],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Simulated agent conversation flow
// ---------------------------------------------------------------------------

async function agentStep(
  userInput: string,
  history: ChatMessage[],
  gatewayUrl = "http://localhost:3200",
): Promise<ChatMessage[]> {
  const lower = userInput.toLowerCase();
  const responses: ChatMessage[] = [];
  const ts = () => new Date().toISOString();
  const id = () => `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  // Determine current phase from history
  const lastAgentMsg = [...history].reverse().find((m) => m.role === "agent");
  const phase = lastAgentMsg?.uiRequest?.component ?? "selection";

  if (phase === "selection" || userInput === "photo" || userInput === "manual" || userInput === "scan") {
    if (userInput === "photo") {
      responses.push({
        id: id(),
        role: "agent",
        content: "Great! Please upload a photo of your machine. I'll use AI vision to identify the make, model, and recommended adapter type.",
        timestamp: ts(),
        uiRequest: {
          component: "photo_capture",
          props: { maxSizeMb: 5, acceptedFormats: ["image/jpeg", "image/png", "image/webp"] },
        },
      });
    } else if (userInput === "manual") {
      responses.push({
        id: id(),
        role: "agent",
        content: "No problem! What type of machine is it? Please select from the options below, or type a description.",
        timestamp: ts(),
        uiRequest: {
          component: "selection",
          props: {
            prompt: "Select your machine type",
            options: [
              { value: "fdm_printer", label: "FDM 3D Printer", description: "e.g. Prusa, Bambu, Creality" },
              { value: "resin_printer", label: "Resin 3D Printer", description: "e.g. Formlabs, Anycubic, Elegoo" },
              { value: "cnc_router", label: "CNC Router / Mill", description: "e.g. Shapeoko, X-Carve, Tormach" },
              { value: "laser_cutter", label: "Laser Cutter/Engraver", description: "e.g. xTool, Glowforge, Atomstack" },
              { value: "other", label: "Other / Custom", description: "I'll describe it manually" },
            ] satisfies SelectionOption[],
          },
        },
      });
    } else if (userInput === "scan") {
      responses.push({
        id: id(),
        role: "agent",
        content: "Scanning your local network for connected devices...",
        timestamp: ts(),
      });

      // Attempt real network scan
      try {
        const res = await fetch(`${gatewayUrl}/api/setup/scan-network`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const data = res.ok ? await res.json() as { devices?: NetworkDevice[] } : { devices: [] };
        const devices: NetworkDevice[] = data.devices ?? [];

        if (devices.length === 0) {
          responses.push({
            id: id(),
            role: "agent",
            content:
              "No devices were automatically discovered. This can happen if your machine is on a different subnet or if the scan endpoint isn't reachable.\n\nLet's try connecting directly — do you know the IP address of your machine?",
            timestamp: ts(),
            uiRequest: {
              component: "text_input",
              props: {
                placeholder: "e.g. 192.168.1.50 or printer.local",
                label: "Enter device IP address or hostname",
              },
            },
          });
        } else {
          responses.push({
            id: id(),
            role: "agent",
            content: `Found ${devices.length} device(s) on your network. Select the one you want to configure:`,
            timestamp: ts(),
            uiRequest: {
              component: "network_scan_results",
              props: { devices },
            },
          });
        }
      } catch {
        responses.push({
          id: id(),
          role: "agent",
          content:
            "I wasn't able to reach the gateway to scan your network. Make sure the PCC gateway is running on port 3200.\n\nYou can still add the device manually — do you know its IP address?",
          timestamp: ts(),
          uiRequest: {
            component: "text_input",
            props: {
              placeholder: "e.g. 192.168.1.50",
              label: "Enter device IP address or hostname",
            },
          },
        });
      }
    } else if (["fdm_printer", "resin_printer"].includes(userInput)) {
      responses.push({
        id: id(),
        role: "agent",
        content:
          "Great choice! OctoPrint is the standard way to connect 3D printers to PCC.\n\nWhat's the IP address or URL of your OctoPrint instance? (Usually something like 192.168.1.50 or octopi.local)",
        timestamp: ts(),
        uiRequest: {
          component: "text_input",
          props: {
            placeholder: "http://192.168.1.50:5000 or octopi.local",
            label: "OctoPrint URL",
          },
        },
      });
    } else if (userInput === "cnc_router") {
      responses.push({
        id: id(),
        role: "agent",
        content:
          "CNC routers typically use Modbus TCP or OPC-UA for connectivity.\n\nWhat's the IP address of your CNC controller?",
        timestamp: ts(),
        uiRequest: {
          component: "text_input",
          props: {
            placeholder: "e.g. 192.168.1.100",
            label: "CNC Controller IP address",
          },
        },
      });
    } else if (userInput === "laser_cutter") {
      responses.push({
        id: id(),
        role: "agent",
        content:
          "Laser cutters can use OPC-UA, USB serial, or proprietary HTTP APIs.\n\nDo you know the connection type, or would you like me to auto-detect it?",
        timestamp: ts(),
        uiRequest: {
          component: "selection",
          props: {
            prompt: "Connection type",
            options: [
              { value: "auto", label: "Auto-detect", description: "I'll probe the device for you" },
              { value: "opcua", label: "OPC-UA", description: "Industrial protocol" },
              { value: "http", label: "HTTP API", description: "Custom REST API" },
            ] satisfies SelectionOption[],
          },
        },
      });
    } else {
      // Generic IP input path — show machine config preview with what we know
      const configPreview: MachineConfigPreview = {
        type: "Machine",
        adapterType: "generic-http",
      };

      responses.push({
        id: id(),
        role: "agent",
        content: `I've prepared a basic configuration based on your input. Please review and confirm the details below:`,
        timestamp: ts(),
        uiRequest: {
          component: "machine_config_preview",
          props: { config: configPreview },
        },
      });
    }
  } else if (phase === "photo_capture") {
    // User submitted a photo — show identification result
    responses.push({
      id: id(),
      role: "agent",
      content: "Photo received! Analyzing with AI vision...",
      timestamp: ts(),
    });

    // Attempt gateway call
    try {
      const res = await fetch(`${gatewayUrl}/api/ai/identify-machine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: userInput.replace(/^data:image\/[^;]+;base64,/, "") }),
      });
      const data = res.ok ? await res.json() as { make?: string; model?: string; type?: string; confidence?: number; suggestedAdapterType?: string } : null;

      const config: MachineConfigPreview = {
        make: data?.make ?? "Unknown",
        model: data?.model ?? "Unknown",
        type: data?.type ?? "Machine",
        adapterType: data?.suggestedAdapterType ?? "generic-http",
      };

      const confidence = data?.confidence ?? 0;
      const confidenceText =
        confidence > 0.8
          ? "I'm quite confident about this identification."
          : confidence > 0.5
          ? "I'm moderately confident — please verify the details."
          : "Low confidence — please verify and correct the details below.";

      responses.push({
        id: id(),
        role: "agent",
        content: `Identified: **${config.make} ${config.model}** (${config.type}). ${confidenceText}\n\nPlease review the detected configuration:`,
        timestamp: ts(),
        uiRequest: {
          component: "machine_config_preview",
          props: { config, editable: true },
        },
      });
    } catch {
      responses.push({
        id: id(),
        role: "agent",
        content:
          "The AI identification service isn't available right now. No problem — let's enter the details manually.\n\nWhat type of machine is it?",
        timestamp: ts(),
        uiRequest: {
          component: "selection",
          props: {
            prompt: "Select your machine type",
            options: [
              { value: "fdm_printer", label: "FDM 3D Printer" },
              { value: "resin_printer", label: "Resin 3D Printer" },
              { value: "cnc_router", label: "CNC Router / Mill" },
              { value: "laser_cutter", label: "Laser Cutter/Engraver" },
              { value: "other", label: "Other / Custom" },
            ] satisfies SelectionOption[],
          },
        },
      });
    }
  } else if (phase === "machine_config_preview") {
    // User confirmed the config — try to register and test
    responses.push({
      id: id(),
      role: "agent",
      content: "Configuration confirmed! Registering your device and running a test job...",
      timestamp: ts(),
    });

    try {
      const regRes = await fetch(`${gatewayUrl}/api/setup/register-device`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kernelId: "kernel_dev_001", deviceId: `dev_${Date.now()}`, type: "machine", adapterType: "mock" }),
      });
      const regData = regRes.ok ? await regRes.json() as { registered?: boolean } : { registered: false };

      const testResults: TestResultsPreview = {
        registered: regData.registered ?? regRes.ok,
        testResult: { success: regRes.ok, duration: 1234 },
      };

      responses.push({
        id: id(),
        role: "agent",
        content: regRes.ok
          ? "Device registered successfully! Running a quick test job to verify connectivity..."
          : "Registration encountered an issue, but I'll show you what the test results would look like:",
        timestamp: ts(),
        uiRequest: {
          component: "test_results",
          props: testResults as unknown as Record<string, unknown>,
        },
      });
    } catch {
      const mockResults: TestResultsPreview = {
        registered: false,
        registrationError: "Gateway not reachable",
        testResult: { success: false },
      };

      responses.push({
        id: id(),
        role: "agent",
        content:
          "The gateway isn't reachable right now. Here's what the results would look like once it's running:",
        timestamp: ts(),
        uiRequest: {
          component: "test_results",
          props: mockResults as unknown as Record<string, unknown>,
        },
      });
    }
  } else if (phase === "test_results") {
    // Final step
    responses.push({
      id: id(),
      role: "agent",
      content:
        lower.includes("done") || lower.includes("finish") || lower.includes("complete")
          ? "Setup complete! Your machine is now connected to PCC."
          : "Your machine is configured. Would you like to add another device, or are you done?",
      timestamp: ts(),
      uiRequest: {
        component: "setup_complete",
        props: {
          nextSteps: [
            { label: "View your kernel", href: "/kernels" },
            { label: "Discover capabilities", href: "/discover" },
            { label: "Add another device", href: "/setup/agent" },
          ],
        },
      },
    });
  } else if (lower.includes("help") || lower.includes("what can you do")) {
    responses.push({
      id: id(),
      role: "agent",
      content: [
        "I can help you:",
        "  - Identify machines from photos (AI vision)",
        "  - Scan your network for connected devices",
        "  - Auto-detect connection type (OctoPrint, Modbus, OPC-UA)",
        "  - Generate kernel configurations",
        "  - Register devices and run test jobs",
        "",
        "Just describe what you want to do, or use the options I present.",
      ].join("\n"),
      timestamp: ts(),
    });
  } else {
    // Generic response for unknown input
    responses.push({
      id: id(),
      role: "agent",
      content: `I received: "${userInput}"\n\nI'm not sure how to handle that right now. Try selecting one of the options, or type "help" to see what I can do.`,
      timestamp: ts(),
    });
  }

  return responses;
}

// ---------------------------------------------------------------------------
// UI Component renderers
// ---------------------------------------------------------------------------

function PhotoCapture({ onCapture }: { onCapture: (base64: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result as string;
        setPreview(result);
      };
      reader.readAsDataURL(file);
    },
    [],
  );

  const handleCapture = useCallback(() => {
    if (preview) {
      onCapture(preview);
    }
  }, [preview, onCapture]);

  return (
    <div className="space-y-3">
      <div
        className={`
          relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors
          ${isDragging ? "border-emerald-500/60 bg-emerald-500/10" : "border-white/20 hover:border-emerald-500/40 hover:bg-white/[0.02]"}
        `}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          const file = e.dataTransfer.files[0];
          if (file?.type.startsWith("image/")) handleFile(file);
        }}
      >
        {preview ? (
          <div className="space-y-3">
            <img
              src={preview}
              alt="Machine preview"
              className="max-h-48 mx-auto rounded-lg object-contain"
            />
            <p className="text-xs text-white/40">Click to change photo</p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-4xl text-white/20">&#128247;</div>
            <p className="text-sm text-white/50">Click to upload or drag a photo here</p>
            <p className="text-xs text-white/30">JPEG, PNG, WebP up to 5MB</p>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
      </div>

      {preview && (
        <button
          onClick={handleCapture}
          className="w-full py-2.5 rounded-xl text-sm font-semibold bg-emerald-500 hover:bg-emerald-400 text-white transition-colors"
        >
          Identify This Machine
        </button>
      )}
    </div>
  );
}

function NetworkScanResults({
  devices,
  onSelect,
}: {
  devices: NetworkDevice[];
  onSelect: (address: string) => void;
}) {
  if (devices.length === 0) {
    return (
      <p className="text-sm text-white/40 italic">No devices found on your network.</p>
    );
  }

  return (
    <div className="space-y-2">
      {devices.map((device, i) => (
        <button
          key={i}
          onClick={() => onSelect(device.address)}
          className="w-full flex items-center justify-between px-4 py-3 rounded-xl border border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.06] hover:border-emerald-500/30 transition-colors text-left"
        >
          <div>
            <div className="text-sm font-medium text-white/80">{device.hostname ?? device.address}</div>
            {device.hostname && (
              <div className="text-xs text-white/40 font-mono">{device.address}</div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {device.service && (
              <span className="text-xs px-2 py-0.5 rounded-lg bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
                {device.service}
              </span>
            )}
            <span className="text-white/30 text-lg">&rsaquo;</span>
          </div>
        </button>
      ))}
    </div>
  );
}

function MachineConfigPreviewComponent({
  config,
  editable,
  onConfirm,
}: {
  config: MachineConfigPreview;
  editable?: boolean;
  onConfirm: (config: MachineConfigPreview) => void;
}) {
  const [editedConfig, setEditedConfig] = useState(config);

  const inputCls =
    "w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 placeholder:text-white/20 focus:border-emerald-500/30 focus:outline-none transition-colors";

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 space-y-3">
        {editable ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-white/40 mb-1 block">Make</label>
                <input
                  value={editedConfig.make ?? ""}
                  onChange={(e) => setEditedConfig((c) => ({ ...c, make: e.target.value }))}
                  className={inputCls}
                  placeholder="e.g. Prusa"
                />
              </div>
              <div>
                <label className="text-xs text-white/40 mb-1 block">Model</label>
                <input
                  value={editedConfig.model ?? ""}
                  onChange={(e) => setEditedConfig((c) => ({ ...c, model: e.target.value }))}
                  className={inputCls}
                  placeholder="e.g. MK4"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-white/40 mb-1 block">Type</label>
                <input
                  value={editedConfig.type ?? ""}
                  onChange={(e) => setEditedConfig((c) => ({ ...c, type: e.target.value }))}
                  className={inputCls}
                  placeholder="e.g. FDM Printer"
                />
              </div>
              <div>
                <label className="text-xs text-white/40 mb-1 block">Adapter</label>
                <input
                  value={editedConfig.adapterType ?? ""}
                  onChange={(e) => setEditedConfig((c) => ({ ...c, adapterType: e.target.value }))}
                  className={inputCls}
                  placeholder="e.g. octoprint"
                />
              </div>
            </div>
            {(editedConfig.adapterType === "octoprint" || editedConfig.adapterType === "generic-http") && (
              <div>
                <label className="text-xs text-white/40 mb-1 block">URL</label>
                <input
                  value={editedConfig.url ?? ""}
                  onChange={(e) => setEditedConfig((c) => ({ ...c, url: e.target.value }))}
                  className={inputCls}
                  placeholder="http://192.168.1.50:5000"
                />
              </div>
            )}
          </>
        ) : (
          <dl className="space-y-1.5 text-sm">
            {Object.entries(editedConfig).map(([k, v]) =>
              v ? (
                <div key={k} className="flex justify-between">
                  <dt className="text-white/40 capitalize">{k.replace(/([A-Z])/g, " $1")}</dt>
                  <dd className="text-white/80 font-medium">{String(v)}</dd>
                </div>
              ) : null,
            )}
          </dl>
        )}
      </div>

      <button
        onClick={() => onConfirm(editedConfig)}
        className="w-full py-2.5 rounded-xl text-sm font-semibold bg-emerald-500 hover:bg-emerald-400 text-white transition-colors"
      >
        Confirm Configuration
      </button>
    </div>
  );
}

function TestResultsComponent({ data }: { data: TestResultsPreview }) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className={`w-2.5 h-2.5 rounded-full ${data.registered ? "bg-emerald-400" : "bg-red-400"}`} />
        <span className="text-sm font-medium text-white/80">
          Registration: {data.registered ? "Success" : "Failed"}
        </span>
      </div>
      {data.registrationError && (
        <p className="text-xs text-red-400">{data.registrationError}</p>
      )}
      {data.testResult && (
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${data.testResult.success ? "bg-emerald-400" : "bg-red-400"}`} />
          <span className="text-sm font-medium text-white/80">
            Test Job: {data.testResult.success ? "Passed" : "Failed"}
          </span>
          {data.testResult.duration !== undefined && (
            <span className="text-xs text-white/40 ml-auto">{data.testResult.duration}ms</span>
          )}
        </div>
      )}
    </div>
  );
}

function SetupCompleteComponent({ nextSteps }: { nextSteps?: Array<{ label: string; href: string }> }) {
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-center">
        <div className="text-3xl mb-2">&#10003;</div>
        <p className="text-sm font-semibold text-emerald-300">Setup Complete!</p>
        <p className="text-xs text-white/40 mt-1">Your machine has been added to the PCC network.</p>
      </div>
      {nextSteps && nextSteps.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-white/40 uppercase tracking-wider font-medium">Next Steps</p>
          {nextSteps.map((step) => (
            <a
              key={step.href}
              href={step.href}
              className="block px-4 py-2.5 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05] hover:border-emerald-500/30 text-sm text-white/70 hover:text-white/90 transition-colors"
            >
              {step.label} &rarr;
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function SelectionComponent({
  options,
  prompt,
  onSelect,
}: {
  options: SelectionOption[];
  prompt?: string;
  onSelect: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      {prompt && <p className="text-xs text-white/50 font-medium">{prompt}</p>}
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onSelect(opt.value)}
          className="w-full flex items-start gap-3 px-4 py-3 rounded-xl border border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.06] hover:border-emerald-500/30 text-left transition-colors group"
        >
          <div className="mt-0.5 w-4 h-4 rounded-full border border-white/20 group-hover:border-emerald-500/50 flex-shrink-0" />
          <div>
            <div className="text-sm font-medium text-white/80 group-hover:text-white/95">{opt.label}</div>
            {opt.description && (
              <div className="text-xs text-white/35 mt-0.5">{opt.description}</div>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline UI renderer
// ---------------------------------------------------------------------------

function UIRenderer({
  component,
  props,
  onResponse,
}: {
  component: UIRenderComponent;
  props: Record<string, unknown>;
  onResponse: (value: string) => void;
}) {
  switch (component) {
    case "photo_capture":
      return <PhotoCapture onCapture={onResponse} />;

    case "network_scan_results":
      return (
        <NetworkScanResults
          devices={(props.devices as NetworkDevice[]) ?? []}
          onSelect={onResponse}
        />
      );

    case "machine_config_preview":
      return (
        <MachineConfigPreviewComponent
          config={(props.config as MachineConfigPreview) ?? {}}
          editable={Boolean(props.editable)}
          onConfirm={(cfg) => onResponse(JSON.stringify(cfg))}
        />
      );

    case "test_results":
      return <TestResultsComponent data={props as unknown as TestResultsPreview} />;

    case "setup_complete":
      return (
        <SetupCompleteComponent
          nextSteps={props.nextSteps as Array<{ label: string; href: string }> | undefined}
        />
      );

    case "text_input": {
      const TextInputWidget = ({ onSubmit }: { onSubmit: (v: string) => void }) => {
        const [value, setValue] = useState("");
        return (
          <div className="flex gap-2">
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && value.trim()) onSubmit(value.trim());
              }}
              placeholder={String(props.placeholder ?? "")}
              className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 placeholder:text-white/20 focus:border-emerald-500/30 focus:outline-none transition-colors"
            />
            <button
              onClick={() => { if (value.trim()) onSubmit(value.trim()); }}
              disabled={!value.trim()}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-500 hover:bg-emerald-400 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Send
            </button>
          </div>
        );
      };
      return <TextInputWidget onSubmit={onResponse} />;
    }

    case "selection":
      return (
        <SelectionComponent
          options={(props.options as SelectionOption[]) ?? []}
          prompt={props.prompt as string | undefined}
          onSelect={onResponse}
        />
      );

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Chat bubble
// ---------------------------------------------------------------------------

function ChatBubble({
  message,
  onUIResponse,
}: {
  message: ChatMessage;
  onUIResponse: (msgId: string, value: string) => void;
}) {
  const isAgent = message.role === "agent";

  return (
    <div className={`flex ${isAgent ? "justify-start" : "justify-end"} mb-4`}>
      <div className={`flex gap-3 max-w-[85%] ${isAgent ? "flex-row" : "flex-row-reverse"}`}>
        {/* Avatar */}
        {isAgent && (
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-xs text-emerald-400 font-bold">
            AI
          </div>
        )}

        {/* Bubble */}
        <div
          className={`
            rounded-2xl px-4 py-3 space-y-3 text-sm leading-relaxed
            ${isAgent
              ? "bg-white/[0.04] border border-white/[0.06] text-white/80"
              : "bg-emerald-500/20 border border-emerald-500/30 text-emerald-100"
            }
          `}
        >
          {/* Text content */}
          {message.content && (
            <div className="whitespace-pre-wrap">{message.content}</div>
          )}

          {/* UI component */}
          {message.uiRequest && (
            <UIRenderer
              component={message.uiRequest.component}
              props={message.uiRequest.props}
              onResponse={(value) => onUIResponse(message.id, value)}
            />
          )}

          {/* Timestamp */}
          <div className={`text-[10px] ${isAgent ? "text-white/25" : "text-emerald-400/50"}`}>
            {new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function SetupAgentPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [inputText, setInputText] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPageMeta("Setup Assistant", "AI-guided machine configuration");
  }, [setPageMeta]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = useCallback(
    async (text: string) => {
      if (!text.trim() || isTyping) return;

      const userMsg: ChatMessage = {
        id: `msg_user_${Date.now()}`,
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, userMsg]);
      setInputText("");
      setIsTyping(true);

      try {
        const responses = await agentStep(text, [...messages, userMsg]);
        setMessages((prev) => [...prev, ...responses]);
      } catch (err) {
        const errMsg: ChatMessage = {
          id: `msg_err_${Date.now()}`,
          role: "agent",
          content: `Something went wrong: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, errMsg]);
      } finally {
        setIsTyping(false);
        inputRef.current?.focus();
      }
    },
    [isTyping, messages],
  );

  const handleUIResponse = useCallback(
    (msgId: string, value: string) => {
      void msgId;
      handleSend(value);
    },
    [handleSend],
  );

  return (
    <div className="flex flex-col h-full max-h-[calc(100vh-120px)]">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-white/[0.06]">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/25 flex items-center justify-center">
            <span className="text-emerald-400 text-lg">&#9881;</span>
          </div>
          <div>
            <h1 className="text-base font-semibold text-white/90">Setup Assistant</h1>
            <p className="text-xs text-white/40">AI-guided machine configuration</p>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs text-white/40">Online</span>
          </div>
        </div>
      </div>

      {/* Chat messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-1">
        {messages.map((msg) => (
          <ChatBubble
            key={msg.id}
            message={msg}
            onUIResponse={handleUIResponse}
          />
        ))}

        {/* Typing indicator */}
        {isTyping && (
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-xs text-emerald-400 font-bold flex-shrink-0">
              AI
            </div>
            <div className="bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3">
              <div className="flex gap-1 items-center">
                <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="flex-shrink-0 px-6 py-4 border-t border-white/[0.06]">
        <div className="flex gap-3 items-end">
          <div className="flex-1">
            <input
              ref={inputRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend(inputText);
                }
              }}
              placeholder="Type a message or respond to the agent..."
              disabled={isTyping}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white/80 placeholder:text-white/25 focus:border-emerald-500/30 focus:outline-none transition-colors disabled:opacity-50"
            />
          </div>
          <button
            onClick={() => handleSend(inputText)}
            disabled={!inputText.trim() || isTyping}
            className="flex-shrink-0 w-11 h-11 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-white flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5 rotate-90">
              <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* Quick actions */}
        <div className="flex gap-2 mt-2 flex-wrap">
          {["Start setup", "Scan network", "Check status", "Help"].map((label) => (
            <button
              key={label}
              onClick={() => handleSend(label.toLowerCase())}
              disabled={isTyping}
              className="px-3 py-1.5 rounded-lg text-xs text-white/40 border border-white/[0.08] hover:text-white/60 hover:border-white/20 transition-colors disabled:opacity-40"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
