import { useEffect, useRef, useCallback } from "react";

interface UseSSEStreamOptions {
  /** SSE endpoint URL (e.g. "/sse/stream/kernel/kernel-nyc") */
  url: string | null;
  /** Called for each event received */
  onEvent: (type: string, data: unknown) => void;
  /** Whether to enable the stream */
  enabled?: boolean;
}

/**
 * Hook to connect to an SSE stream with auto-reconnect.
 * Passes Last-Event-ID on reconnect for replay support.
 */
export function useSSEStream({ url, onEvent, enabled = true }: UseSSEStreamOptions) {
  const lastEventIdRef = useRef<string | undefined>(undefined);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const connect = useCallback(() => {
    if (!url || !enabled) return undefined;

    const eventSource = new EventSource(url);

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (e.lastEventId) lastEventIdRef.current = e.lastEventId;
        onEventRef.current("message", data);
      } catch { /* ignore parse errors */ }
    };

    // Listen for typed events — covers sensor, batch, protocol, and log producers
    const eventTypes = [
      // Sensor
      "sensor_reading", "sensor_anomaly",
      // Process logs
      "process_log",
      // Batch lifecycle
      "batch_created", "batch_sealed", "batch_started", "batch_completed", "batch_failed",
      "sample_added", "sample_injection_start", "sample_acquisition_start",
      "sample_acquisition_end", "sample_result_available", "sample_completed", "sample_failed",
      // Protocol run lifecycle
      "protocol_run_started", "protocol_run_completed", "protocol_run_failed",
      "protocol_run_paused", "protocol_run_cancelled",
      "protocol_step_started", "protocol_step_completed", "protocol_step_failed",
      "protocol_transfer_started", "protocol_transfer_completed", "protocol_transfer_failed",
      "protocol_episode_recorded",
    ];
    for (const type of eventTypes) {
      eventSource.addEventListener(type, (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          if (e.lastEventId) lastEventIdRef.current = e.lastEventId;
          onEventRef.current(type, data);
        } catch { /* ignore */ }
      });
    }

    eventSource.onerror = () => {
      eventSource.close();
      // Auto-reconnect after 3 seconds
      setTimeout(() => connect(), 3000);
    };

    return eventSource;
  }, [url, enabled]);

  useEffect(() => {
    const es = connect();
    return () => es?.close();
  }, [connect]);
}
