/**
 * NetworkTransport — WebSocket + REST transport for A2A messages.
 *
 * Allows agents running in separate processes to communicate over the network
 * via a central Gateway relay. Messages are sent via HTTP POST and received
 * via WebSocket push.
 */

import type { A2AMessage } from "./types.js";

export interface NetworkTransportConfig {
  /** Gateway relay URL (e.g. "http://localhost:3200") */
  relayUrl: string;
  /** This agent's ID */
  agentId: string;
  /**
   * API key used to authenticate HTTP POST and WebSocket handshake with the
   * relay. Required in production — the relay's `requireA2AAuth` preHandler
   * will 401 any request that lacks `Authorization: Bearer pcc_...` or
   * `?apiKey=pcc_...`. Optional here so in-memory / bypass contexts
   * (e.g. legacy tests that predate auth hardening) still type-check.
   */
  apiKey?: string;
  /** Reconnect interval in ms (default: 3000) */
  reconnectInterval?: number;
  /** Maximum reconnect attempts before giving up (default: Infinity) */
  maxReconnectAttempts?: number;
}

type MessageHandler = (message: A2AMessage) => void | Promise<void>;

export class NetworkTransport {
  private readonly config: Required<Omit<NetworkTransportConfig, "maxReconnectAttempts" | "apiKey">> & {
    maxReconnectAttempts: number;
    apiKey: string | undefined;
  };
  private ws: WebSocket | null = null;
  private handlers: MessageHandler[] = [];
  private _connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private intentionalClose = false;

  constructor(config: NetworkTransportConfig) {
    this.config = {
      relayUrl: config.relayUrl,
      agentId: config.agentId,
      apiKey: config.apiKey,
      reconnectInterval: config.reconnectInterval ?? 3000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? Infinity,
    };
  }

  /** Establish a WebSocket connection to the relay */
  async connect(): Promise<void> {
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    return this.doConnect();
  }

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wsUrl = this.config.relayUrl
        .replace(/^http/, "ws")
        .replace(/\/$/, "");
      // Auth on the WS handshake: browsers cannot set headers on `new WebSocket`,
      // so we pass the API key as a query param (the relay accepts either form).
      const authParam = this.config.apiKey
        ? `&apiKey=${encodeURIComponent(this.config.apiKey)}`
        : "";
      const url = `${wsUrl}/ws/a2a?agentId=${encodeURIComponent(this.config.agentId)}${authParam}`;

      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        reject(err);
        return;
      }

      const onOpen = () => {
        this._connected = true;
        this.reconnectAttempts = 0;
        cleanup();
        resolve();
      };

      const onError = (ev: Event) => {
        cleanup();
        if (!this._connected) {
          reject(new Error(`WebSocket connection failed to ${url}`));
        }
      };

      const cleanup = () => {
        this.ws?.removeEventListener("open", onOpen);
        this.ws?.removeEventListener("error", onError);

        // Attach long-lived listeners
        if (this.ws) {
          this.ws.addEventListener("message", this.handleWsMessage);
          this.ws.addEventListener("close", this.handleWsClose);
          this.ws.addEventListener("error", this.handleWsError);
        }
      };

      this.ws.addEventListener("open", onOpen);
      this.ws.addEventListener("error", onError);
    });
  }

  /** Send a message via REST POST to the relay */
  async send(message: A2AMessage): Promise<void> {
    const url = `${this.config.relayUrl.replace(/\/$/, "")}/api/a2a/send`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Relay POST failed (${resp.status}): ${text}`);
    }
  }

  /** Register a handler for incoming WebSocket messages */
  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  /** Remove a previously registered handler */
  offMessage(handler: MessageHandler): void {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  /** Cleanly disconnect from the relay */
  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeEventListener("message", this.handleWsMessage);
      this.ws.removeEventListener("close", this.handleWsClose);
      this.ws.removeEventListener("error", this.handleWsError);
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, "client disconnect");
      }
      this.ws = null;
    }
    this._connected = false;
  }

  /** Whether the WebSocket is currently connected */
  get connected(): boolean {
    return this._connected;
  }

  // ── Private handlers ────────────────────────────────────────────

  private handleWsMessage = (ev: MessageEvent) => {
    try {
      const data = typeof ev.data === "string" ? ev.data : String(ev.data);
      const message: A2AMessage = JSON.parse(data);
      for (const handler of this.handlers) {
        try {
          const result = handler(message);
          if (result && typeof (result as Promise<void>).catch === "function") {
            (result as Promise<void>).catch((err) => {
              console.error(`[NetworkTransport] Handler error:`, err);
            });
          }
        } catch (err) {
          console.error(`[NetworkTransport] Handler error:`, err);
        }
      }
    } catch (err) {
      console.error(`[NetworkTransport] Failed to parse WebSocket message:`, err);
    }
  };

  private handleWsClose = () => {
    this._connected = false;
    if (!this.intentionalClose) {
      this.scheduleReconnect();
    }
  };

  private handleWsError = () => {
    // Close will follow, which triggers reconnect
  };

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      return;
    }
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect().catch(() => {
        // Failed to reconnect — will try again via handleWsClose
      });
    }, this.config.reconnectInterval);
  }
}
