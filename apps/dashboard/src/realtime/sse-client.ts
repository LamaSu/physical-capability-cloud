export type SSEHandler = (event: string, data: unknown) => void;

export function createSSEClient(url: string, onEvent: SSEHandler) {
  let eventSource: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    eventSource = new EventSource(url);

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        onEvent("message", data);
      } catch {
        // Ignore parse errors
      }
    };

    eventSource.addEventListener("job_progress", (e) => {
      try { onEvent("job_progress", JSON.parse((e as MessageEvent).data)); } catch {}
    });

    eventSource.addEventListener("evidence", (e) => {
      try { onEvent("evidence", JSON.parse((e as MessageEvent).data)); } catch {}
    });

    eventSource.addEventListener("milestone", (e) => {
      try { onEvent("milestone", JSON.parse((e as MessageEvent).data)); } catch {}
    });

    eventSource.addEventListener("agent_message", (e) => {
      try { onEvent("agent_message", JSON.parse((e as MessageEvent).data)); } catch {}
    });

    eventSource.onerror = () => {
      eventSource?.close();
      onEvent("disconnected", null);
      // Reconnect after 3 seconds
      reconnectTimer = setTimeout(connect, 3000);
    };

    eventSource.onopen = () => {
      onEvent("connected", null);
    };
  }

  function disconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    eventSource?.close();
    eventSource = null;
  }

  return { connect, disconnect };
}
