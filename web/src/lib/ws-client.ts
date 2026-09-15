/** Viewer WebSocket client with exponential backoff. `start()` is idempotent. */
import type { ServerToViewer } from "@proto/types";
import { onServerMessage } from "./alerts";
import { _setSender, applyMessage, setState } from "./store";

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10000];
let socket: WebSocket | null = null;
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function url(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws?role=viewer`;
}

function connect(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  setState({ conn: "connecting" });
  const ws = new WebSocket(url());
  socket = ws;
  ws.onopen = () => {
    attempt = 0;
    _setSender((text) => { if (ws.readyState === WebSocket.OPEN) { ws.send(text); return true; } return false; });
    setState({ conn: "open" });
  };
  ws.onmessage = (ev) => {
    let msg: ServerToViewer;
    try { msg = JSON.parse(String(ev.data)) as ServerToViewer; } catch { return; }
    applyMessage(msg);
    onServerMessage(msg);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    _setSender(null);
    setState({ conn: "closed", pending: {}, lastError: "server connection lost" });
    scheduleReconnect();
  };
  ws.onerror = () => { /* onclose follows */ };
}

function scheduleReconnect(): void {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  attempt++;
  const delay = base + Math.random() * 300;
  timer = setTimeout(connect, delay);
}

/** Seconds until the next reconnect attempt (for the banner); 0 when connected. */
export function retryDelayMs(): number {
  return BACKOFF_MS[Math.min(Math.max(attempt - 1, 0), BACKOFF_MS.length - 1)];
}

export function start(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  connect();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !socket) { attempt = 0; connect(); }
  });
}
