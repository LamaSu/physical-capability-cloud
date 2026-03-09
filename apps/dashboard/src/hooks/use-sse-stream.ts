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

    // Listen for typed events (sensor_reading, sensor_anomaly, etc.)
    const eventTypes = [
      "sensor_reading", "sensor_anomaly", "process_log",
      "batch_created", "batch_sealed", "batch_started", "batch_completed",
      "sample_added", "sample_completed", "sample_failed",
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
