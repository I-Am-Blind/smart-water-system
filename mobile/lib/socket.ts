/**
 * One WebSocket to the server as a viewer (`?role=viewer`), with reconnect/backoff.
 * The URL is persisted with AsyncStorage (Settings screen). Until one is saved, the app assumes the
 * rig server runs on the laptop Expo Go loaded it from, which is how the Windows launcher sets it up.
 */
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { DEFAULT_WS_URL, VIEWER_QUERY } from "../../packages/protocol/types";
import type { ServerToViewer } from "../../packages/protocol/types";
import { applyMessage, clearPending, registerTransport, setConn } from "./store";

const STORAGE_KEY = "cascade.serverUrl";
const MAX_BACKOFF_MS = 10_000;

/** ws://<the laptop serving this app>:3000/ws, or the protocol default when not loaded from a dev server. */
function laptopUrl(): string {
  const host = Constants.expoConfig?.hostUri?.split(":")[0];
  return host ? `ws://${host}:3000/ws` : DEFAULT_WS_URL;
}

let url = laptopUrl();
let ws: WebSocket | null = null;
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

/** Accepts "192.168.0.3:3000", "http://host:3000", "ws://host:3000/ws" ... and returns a ws(s)://host[:port]/ws URL. */
export function normalizeUrl(raw: string): string {
  let s = raw.trim();
  if (!s) return laptopUrl();
  s = s.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
  if (!/^wss?:\/\//i.test(s)) s = `ws://${s}`;
  s = s.replace(/\?.*$/, "").replace(/\/+$/, "");
  if (!/\/ws$/i.test(s)) s += "/ws";
  return s;
}

export function getUrl(): string {
  return url;
}

export async function loadUrl(): Promise<string> {
  try {
    const saved = await AsyncStorage.getItem(STORAGE_KEY);
    if (saved) url = normalizeUrl(saved);
  } catch {
    // storage unavailable: keep the default
  }
  return url;
}

export async function saveUrl(raw: string): Promise<string> {
  url = normalizeUrl(raw);
  try {
    await AsyncStorage.setItem(STORAGE_KEY, url);
  } catch {
    // ignore; the in-memory value is still used for this session
  }
  reconnectNow();
  return url;
}

function clearTimer(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function schedule(): void {
  clearTimer();
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
  const delay = base + Math.floor(Math.random() * 300);
  attempt = Math.min(attempt + 1, 10);
  timer = setTimeout(connect, delay);
}

function connect(): void {
  clearTimer();
  if (ws) return; // already connecting/open
  setConn("connecting");
  let socket: WebSocket;
  try {
    socket = new WebSocket(`${url}${VIEWER_QUERY}`);
  } catch {
    schedule();
    return;
  }
  ws = socket;
  socket.onopen = () => {
    attempt = 0;
    setConn("open");
  };
  socket.onmessage = (e) => {
    try {
      applyMessage(JSON.parse(String(e.data)) as ServerToViewer);
    } catch {
      // ignore malformed frames
    }
  };
  socket.onerror = () => {
    // onclose follows; nothing to do here
  };
  socket.onclose = () => {
    if (ws === socket) ws = null;
    setConn("closed");
    clearPending();
    schedule();
  };
}

/** Drop the current socket (if any) and connect again immediately. */
export function reconnectNow(): void {
  attempt = 0;
  clearTimer();
  if (ws) {
    const old = ws;
    ws = null;
    old.onclose = null;
    old.onmessage = null;
    try {
      old.close();
    } catch {
      // ignore
    }
    setConn("closed");
  }
  connect();
}

/** Idempotent. Loads the saved URL, connects, and retries as soon as the app returns to the foreground. */
export function start(): void {
  if (started) return;
  started = true;
  registerTransport((json) => {
    if (ws && ws.readyState === 1) {
      ws.send(json);
      return true;
    }
    return false;
  });
  AppState.addEventListener("change", (s) => {
    if (s === "active" && (!ws || ws.readyState !== 1)) reconnectNow();
  });
  void loadUrl().then(connect);
}
