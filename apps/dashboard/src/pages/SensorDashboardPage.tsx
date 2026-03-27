import React from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { GlassPanel, GlowBadge } from "@pcc/ui";
import type { SensorChannelDescriptor, SensorReading, SensorAnomaly } from "@pcc/spec";
import { useUIStore } from "../stores/ui-store.js";
import { useSensorStreamStore } from "../stores/sensor-stream-store.js";
import { useSSEStream } from "../hooks/use-sse-stream.js";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { getAuthHeaders } from "../stores/auth-store.js";

const GATEWAY = "/api";

export function SensorDashboardPage() {
  const { kernelId } = useParams<{ kernelId?: string }>();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const {
    selectedChannels, channelDescriptors, recentReadings, anomalies, isStreaming,
    addChannel, removeChannel, setDescriptors, pushReading, setStreaming,
  } = useSensorStreamStore();

  React.useEffect(() => {
    setPageMeta("Sensor Dashboard", kernelId ? `Kernel: ${kernelId}` : "Live sensor monitoring");
  }, [setPageMeta, kernelId]);

  // Fetch channel descriptors
  const channelsUrl = kernelId
    ? `${GATEWAY}/sensors/channels/${kernelId}`
    : `${GATEWAY}/sensors/channels`;

  const { data: channelData } = useQuery({
    queryKey: ["sensor-channels", kernelId],
    queryFn: () => fetch(channelsUrl, { headers: { ...getAuthHeaders() } }).then((r) => r.json()),
  });

  React.useEffect(() => {
    if (channelData?.channels) {
      setDescriptors(channelData.channels);
      if (selectedChannels.length === 0 && channelData.channels.length > 0) {
        addChannel(channelData.channels[0].channel);
      }
    }
  }, [channelData]);

  // Fetch anomalies
  const { data: anomalyData } = useQuery({
    queryKey: ["sensor-anomalies", kernelId],
    queryFn: () =>
      fetch(`${GATEWAY}/sensors/anomalies${kernelId ? `?kernelId=${kernelId}` : ""}`, { headers: { ...getAuthHeaders() } }).then((r) => r.json()),
    refetchInterval: 10_000,
  });

  // Stream sensor readings via SSE
  const sseUrl = selectedChannels.length > 0
    ? `/sse/stream/kernel/${kernelId ?? "kernel-nyc"}`
    : null;

  const handleSSEEvent = React.useCallback(
    (type: string, data: unknown) => {
      if (type === "sensor_reading") {
        const reading = data as SensorReading;
        if (selectedChannels.includes(reading.channel)) {
          pushReading(reading);
        }
      }
    },
    [selectedChannels, pushReading],
  );

  useSSEStream({ url: sseUrl, onEvent: handleSSEEvent });

  // Track streaming state based on SSE connection
  React.useEffect(() => {
    setStreaming(selectedChannels.length > 0);
    return () => setStreaming(false);
  }, [selectedChannels.length, setStreaming]);

  const selectedDesc = channelDescriptors.find((d) => selectedChannels.includes(d.channel));

  return (
    <div className="space-y-6">
      {/* Anomaly banner */}
      {(anomalyData?.anomalies?.length ?? 0) > 0 && (
        <GlassPanel padding="sm">
          <div className="flex items-center gap-2 text-amber-400">
            <span className="text-sm font-medium">Anomalies Detected</span>
            <GlowBadge color="gold">{anomalyData.anomalies.length}</GlowBadge>
          </div>
          <div className="mt-2 space-y-1">
            {(anomalyData.anomalies as SensorAnomaly[]).slice(0, 3).map((a) => (
              <div key={a.id} className="text-xs text-white/50">
                <span className={a.severity === "critical" ? "text-red-400" : "text-amber-400"}>
                  [{a.severity}]
                </span>{" "}
                {a.message}
              </div>
            ))}
          </div>
        </GlassPanel>
      )}

      <div className="grid grid-cols-4 gap-6">
        {/* Channel selector */}
        <div className="col-span-1 space-y-3">
          <GlassPanel padding="md">
            <h3 className="text-sm font-medium text-white/60 mb-3">Channels</h3>
            <div className="space-y-1">
              {channelDescriptors.map((desc) => (
                <button
                  key={desc.channel}
                  onClick={() =>
                    selectedChannels.includes(desc.channel)
                      ? removeChannel(desc.channel)
                      : addChannel(desc.channel)
                  }
                  className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all ${
                    selectedChannels.includes(desc.channel)
                      ? "bg-green-500/15 border border-green-500/30 text-green-400"
                      : "bg-white/[0.03] border border-white/[0.06] text-white/40 hover:border-white/[0.12]"
                  }`}
                >
                  <div className="font-medium">{desc.label}</div>
                  <div className="text-[10px] opacity-60">
                    {desc.sampleRateHz}Hz · {desc.unit} · {desc.retentionPolicy}
                  </div>
                </button>
              ))}
            </div>
          </GlassPanel>

          {/* Channel info */}
          {selectedDesc && (
            <GlassPanel padding="md">
              <h3 className="text-sm font-medium text-white/60 mb-2">Channel Info</h3>
              <div className="space-y-1 text-xs text-white/40">
                <div>Unit: <span className="text-white/70">{selectedDesc.unit}</span></div>
                <div>Rate: <span className="text-white/70">{selectedDesc.sampleRateHz} Hz</span></div>
                {selectedDesc.range && (
                  <div>Range: <span className="text-white/70">[{selectedDesc.range.min}, {selectedDesc.range.max}]</span></div>
                )}
                <div>Retention: <span className="text-white/70">{selectedDesc.retentionPolicy}</span></div>
                <div>Evidence: <GlowBadge color={selectedDesc.evidenceGrade ? "green" : "gray"}>{selectedDesc.evidenceGrade ? "Yes" : "No"}</GlowBadge></div>
              </div>
            </GlassPanel>
          )}
        </div>

        {/* Chart area */}
        <div className="col-span-3 space-y-4">
          <GlassPanel padding="md">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-white/60">Live Data</h3>
              <div className="flex items-center gap-2">
                {isStreaming && (
                  <span className="flex items-center gap-1 text-xs text-green-400">
                    <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
                    Streaming
                  </span>
                )}
              </div>
            </div>

            {selectedChannels.length === 0 ? (
              <div className="text-center py-16 text-white/30 text-sm">
                Select a channel to view live data
              </div>
            ) : (
              <div className="space-y-6">
                {selectedChannels.map((channel) => {
                  const readings = recentReadings[channel] ?? [];
                  const desc = channelDescriptors.find((d) => d.channel === channel);
                  const chartData = readings.slice(-60).map((r) => ({
                    time: new Date(r.timestamp).toLocaleTimeString(),
                    value: typeof r.value === "number" ? r.value : 0,
                  }));

                  return (
                    <div key={channel}>
                      <div className="text-xs text-white/50 mb-2">
                        {desc?.label ?? channel} ({desc?.unit})
                      </div>
                      <div className="h-48">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={chartData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                            <XAxis dataKey="time" tick={{ fontSize: 10, fill: "rgba(255,255,255,0.3)" }} />
                            <YAxis tick={{ fontSize: 10, fill: "rgba(255,255,255,0.3)" }} domain={desc?.range ? [desc.range.min, desc.range.max] : ["auto", "auto"]} />
                            <Tooltip
                              contentStyle={{ background: "rgba(0,0,0,0.8)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 11 }}
                              labelStyle={{ color: "rgba(255,255,255,0.5)" }}
                            />
                            <Line type="monotone" dataKey="value" stroke="#22c55e" strokeWidth={1.5} dot={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </GlassPanel>

          {/* Stats summary */}
          {selectedChannels.length > 0 && (
            <GlassPanel padding="md">
              <h3 className="text-sm font-medium text-white/60 mb-3">Statistics</h3>
              <div className="grid grid-cols-4 gap-4">
                {selectedChannels.map((channel) => {
                  const readings = recentReadings[channel] ?? [];
                  const values = readings.filter((r) => typeof r.value === "number").map((r) => r.value as number);
                  if (values.length === 0) return null;
                  const min = Math.min(...values);
                  const max = Math.max(...values);
                  const mean = values.reduce((a, b) => a + b, 0) / values.length;
                  const stddev = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
                  const desc = channelDescriptors.find((d) => d.channel === channel);

                  return (
                    <div key={channel} className="text-xs text-white/40 space-y-1">
                      <div className="text-white/60 font-medium">{desc?.label ?? channel}</div>
                      <div>Min: <span className="text-white/70">{min.toFixed(1)}</span></div>
                      <div>Max: <span className="text-white/70">{max.toFixed(1)}</span></div>
                      <div>Mean: <span className="text-white/70">{mean.toFixed(1)}</span></div>
                      <div>Std: <span className="text-white/70">{stddev.toFixed(2)}</span></div>
                    </div>
                  );
                })}
              </div>
            </GlassPanel>
          )}
        </div>
      </div>
    </div>
  );
}
