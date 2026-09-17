# web – server + dashboard

One Node process does everything: serves the Next.js pages, hosts the WebSocket hub on `/ws`,
answers `/api/*`, and keeps 24 h of telemetry in SQLite (`web/data/rig.db`, created on first run).
It runs unchanged on the laptop at the fair and on Render.

## Run on the laptop

```bash
cd web
pnpm install
pnpm build          # once, and after code changes (needs internet the first time for fonts)
pnpm start          # http://localhost:3000  (LAN URL is printed; also shown as a QR on the dashboard)
```

- The first start makes macOS ask whether `node` may accept incoming connections: click **Allow**
  (or System Settings → Network → Firewall → Options). Phones on the same Wi-Fi then open the printed LAN URL.
- Keep the Mac awake during the demo: `caffeinate -dims pnpm start`.
- Point the ESP32 at `ws://<laptop-ip>:3000/ws` over its serial console (`server=` command).
- `pnpm dev` runs the same process with hot reload for UI work.

## Without hardware

```bash
pnpm fake            # simulated rig; keys l leak, 1/2 valves, p pump, o offline 15 s, q quit
pnpm smoke           # end-to-end check against a running server, prints SMOKE OK
pnpm test            # golden protocol samples validate
```

## Pages and endpoints

| Path | What |
|---|---|
| `/` | The dashboard: live 3D twin of the rig (top-side view), branch valves, pump, water quality, flow chart, events, QR |
| `/dashboard` | redirects to `/` |
| `GET /api/status`, `/api/history?minutes=30`, `/api/events`, `/api/branding`, `/api/qr.svg`, `POST /api/cmd` | see `docs/PROTOCOL.md` |
| `ws://host:3000/ws` | device socket; viewers add `?role=viewer` |

Branding (names, colours, branch names) is read from `../branding.json` at start and re-read when the file changes;
every open browser updates live.

## UI

Built on shadcn/ui (`src/components/ui/*`, added with `pnpm dlx shadcn@latest add <name>`; neutral theme, dark only)
and Tailwind v4, following `docs/DESIGN.md`. Type is Geist with tabular numerals. The only brand colour on the page is
`--brand-accent` (from `branding.json`): water in the 3D twin and the inflow line in the chart.

- `src/app/page.tsx` composes the screen: `AppHeader` (rig status, menu with "Open on phone" and "Sound alerts", All off),
  `SectionCards` (water in, pump, water lost, water quality), `RigCard` (3D twin from `src/components/twin`, loaded
  client-side by `RigCanvas`), `BranchesCard` (both branches with valve switches, pump and clear-leak actions; the
  unmetered branch shows dashes instead of numbers),
  `EventsCard` (last 12 events), `FlowCard` (uPlot, data kept outside React), plus `PhoneDialog`, `Toasts`, `BrandVars`, `Boot`.
- Live state comes from `src/lib/store.ts` (`useRig(selector)`); components select primitives or stable slices so the
  1 Hz telemetry only re-renders what changed.
- On screens 1024 px and wider the branches and events cards sit beside the rig and the chart spans the full width below;
  smaller screens stack cards, rig, branches, chart, events.

## Render (optional, free)

Connect the repo, pick "Blueprint", and Render reads `render.yaml` at the repo root. The device must use
`wss://<service>.onrender.com/ws`. Free-tier caveats: the service sleeps after 15 min without traffic
(the rig's telemetry keeps it awake), cold start is about a minute, and the SQLite history is lost on every deploy.

## Why not Vercel

Vercel functions are request-scoped (5 min max on Hobby) and there is no persistent process or writable disk, so a
device WebSocket that stays open for hours and an in-memory rig state cannot live there. A static export of the UI
could be hosted on Vercel and pointed at a remote `wss://` server, but that is not set up.
