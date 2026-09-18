/**
 * One command that runs everything on the laptop at the fair (Windows, macOS or Linux):
 *   1. installs what is missing (the first run needs internet and takes a few minutes),
 *   2. builds the dashboard when its source changed,
 *   3. starts the rig server: dashboard + the Arduino over USB, on port 3000,
 *   4. opens the dashboard in the browser and starts the Expo server for the phone app.
 *
 *   Windows: double-click start.cmd        anywhere: node scripts/start.mjs
 *   --no-expo   skip the phone app server       --no-open   do not open the browser
 *
 * Needs only Node.js 22. No dependencies of its own: it runs before anything is installed.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const web = path.join(root, "web");
const mobile = path.join(root, "mobile");
const win = process.platform === "win32";
const args = new Set(process.argv.slice(2));
const withExpo = !args.has("--no-expo");
const PORT = 3000;

const say = (msg) => console.log(`\n== ${msg}`);
function die(msg) {
  console.error(`\n!! ${msg}\n`);
  process.exit(1);
}

// ---------- Node version ----------
const [major, minor] = process.versions.node.split(".").map(Number);
if (major !== 22 || minor < 18) {
  die(`This needs Node.js 22 (22.18 or newer), found ${process.versions.node}.\n` +
    `   Install "Node.js 22 LTS" from https://nodejs.org/en/download and run this again.`);
}

// ---------- helpers ----------
/** Runs a command to completion with its output on this console; stops everything if it fails. */
function run(cmd, cmdArgs, cwd, env = {}) {
  // .cmd shims (npm, npx, corepack) need a shell on Windows.
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", shell: win, env: { ...process.env, ...env } });
  if (r.status !== 0) die(`"${cmd} ${cmdArgs.join(" ")}" failed (in ${path.relative(root, cwd) || "."}). Check the messages above.`);
}

/** pnpm at the exact version web/package.json pins, fetched by corepack (bundled with Node). */
const pnpm = (pnpmArgs) => run("corepack", ["pnpm", ...pnpmArgs], web, { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" });

const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);

/** Newest modification time of anything under p. */
function newest(p) {
  if (!existsSync(p)) return 0;
  const st = statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let t = st.mtimeMs;
  for (const e of readdirSync(p)) {
    if (e !== "node_modules" && e !== ".next") t = Math.max(t, newest(path.join(p, e)));
  }
  return t;
}

/** The laptop's Wi-Fi/Ethernet address, skipping VM/WSL/VPN adapters (same rule as web/server/branding.ts). */
function lanIp() {
  const virtual = /vethernet|virtualbox|vbox|vmware|wsl|hyper-v|docker|bridge|utun|tailscale|zerotier|npcap/i;
  const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
  let fallback = "";
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      if (!virtual.test(name) && priv.test(ni.address)) return ni.address;
      fallback ||= ni.address;
    }
  }
  return fallback || "localhost";
}

/** First port from `from` up that nothing listens on, so Expo never stops to ask for another one. */
async function freePort(from) {
  for (let port = from; port < from + 20; port++) {
    const free = await new Promise((resolve) => {
      const probe = net.createServer().once("error", () => resolve(false));
      probe.listen(port, () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  return from;
}

async function waitForServer(child) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) return false;
    try {
      const r = await fetch(`http://localhost:${PORT}/api/status`);
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ---------- install / build ----------
if (mtime(path.join(web, "node_modules", ".modules.yaml")) < mtime(path.join(web, "pnpm-lock.yaml"))) {
  say("Installing the dashboard server (first run: a few minutes)");
  pnpm(["install", "--frozen-lockfile"]);
}

const sourceTime = Math.max(
  newest(path.join(web, "src")),
  newest(path.join(root, "packages")),
  mtime(path.join(web, "next.config.ts")),
  mtime(path.join(web, "package.json")),
  mtime(path.join(root, "branding.json")),
);
if (mtime(path.join(web, ".next", "BUILD_ID")) < sourceTime) {
  say("Building the dashboard (first run: about a minute)");
  pnpm(["build"]);
}

if (withExpo && mtime(path.join(mobile, "node_modules", ".package-lock.json")) < mtime(path.join(mobile, "package-lock.json"))) {
  say("Installing the phone app server (first run: a few minutes)");
  run("npm", ["ci", "--no-audit", "--no-fund"], mobile);
}

// ---------- run ----------
const ip = lanIp();
const children = [];
let stopping = false;
function stopAll(code) {
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exit(code);
}
process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

say("Starting the rig server");
const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", "server/index.ts"], {
  cwd: web,
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), LAN_IP: ip },
});
children.push(server);
server.on("exit", (code) => {
  if (stopping) return;
  console.error(`\n!! The rig server stopped (exit code ${code}).` +
    (code === 1 ? ` If it says the address is in use, it is already running in another window.` : ""));
  stopAll(1);
});

if (!(await waitForServer(server))) die("The rig server did not start. Check the messages above.");

const dashboard = `http://localhost:${PORT}`;
if (!args.has("--no-open")) {
  const opener = win ? spawn("cmd", ["/c", "start", "", dashboard], { stdio: "ignore" })
    : spawn(process.platform === "darwin" ? "open" : "xdg-open", [dashboard], { stdio: "ignore" });
  opener.on("error", () => {});
}

console.log(`
============================================================
  Dashboard on this laptop   ${dashboard}
  Dashboard on phones        http://${ip}:${PORT}   (same Wi-Fi)
  Phone app                  ${withExpo ? "install Expo Go, then scan the QR code below" : "(skipped: --no-expo)"}
  Arduino                    plug it in by USB; keep the Arduino IDE
                             Serial Monitor closed, only one program
                             can use the port
  Stop everything            Ctrl+C, or close this window
============================================================
`);

if (withExpo) {
  const expoPort = await freePort(8081);
  const expo = spawn("npx", ["expo", "start", "--lan", "--port", String(expoPort)], {
    cwd: mobile,
    stdio: "inherit",
    shell: win,
    // The QR code must carry the same address the phone uses to reach the rig server.
    env: { ...process.env, REACT_NATIVE_PACKAGER_HOSTNAME: ip, EXPO_NO_TELEMETRY: "1" },
  });
  children.push(expo);
  expo.on("exit", (code) => {
    if (code && !stopping) console.error(`\n!! The phone app server stopped (exit code ${code}). The dashboard keeps running.`);
  });
}
