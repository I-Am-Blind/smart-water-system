# UI design brief v2: Cascade dashboard (shadcn-native)

One screen for a science-fair table. A judge must see in two seconds where water flows and whether anything leaks; the team must open valves and run the pump without fear. Names come from `branding.json` (brand.name, brand.branches, brand.colors.accent).

## Direction

Use shadcn/ui the way its own dashboard example uses it, and nothing more. References consulted: the shadcn dashboard example and `dashboard-01` block (neutral theme, site header, a row of section cards with a muted label over a large tabular number, one chart card, one data table with outline badges), and the Linear / Vercel school of dark product UI: near-black neutral surfaces, few borders, hierarchy from type weight and size, colour used only as a status signal, navigation reduced to a slim top bar so nearly every pixel is the work surface.

Rules that follow from that:

1. **Theme = shadcn defaults.** Run with the `neutral` base colour and keep the generated tokens (`--background`, `--card`, `--border`, `--muted-foreground`, `--chart-1..5`, `--radius: 0.625rem`) exactly as the CLI writes them. Dark only (`class="dark"` on `<html>`). Do not invent a navy palette. Brand colour appears in exactly two places: water in the 3D twin and the inflow line in the chart. Nothing else is tinted.
2. **Type = Geist Sans** via `next/font/google`, tabular numerals on `body`. Scale is shadcn's: `text-sm` body, `text-muted-foreground text-sm` labels (`CardDescription`), `text-2xl font-semibold tabular-nums` big readings (`CardTitle` in a section card), `text-base font-semibold` card titles. Units are `text-sm text-muted-foreground` after the number. Sentence case everywhere. No uppercase, no letter-spacing, no monospace, no icons except inside buttons (lucide, 16 px).
3. **Structure = shadcn blocks.** `Card` / `CardHeader` / `CardTitle` / `CardDescription` / `CardContent` / `CardFooter`; `Table` for anything tabular; `Badge variant="outline"` for status (a `destructive` badge only for a latched leak); `Button` variants `outline` / `ghost` / `destructive` at `size="sm"`; `Switch`; `AlertDialog`; `Tabs` for chart ranges; `Separator`; `Tooltip`; `Skeleton` while loading; `Dialog` for the QR code; `sonner` toasts. No custom panels, chips, pills, glass, gradients, glow, shadows beyond the card default, or entrance animations.
4. **Only measured data.** The rig measures 2 flow rates (the IN/OUT pair on the one monitored branch; the second branch has no meter and no number may ever be shown for it), valve and pump relay states, turbidity mV (with a rough NTU estimate) and TDS mV (ppm at 25 °C), plus device Wi-Fi RSSI, uptime and free heap. Nothing else exists. Remove anything not on that list: tank level, pressure, temperature, quality adjectives ("Cloudy", "Excellent"), taglines, savings counters, uptime and heap on the main screen. Turbidity and TDS are shown as numbers with units and a one-line reference in `CardDescription` ("drinking water is usually under 500 ppm"; "clear water is under 5 NTU"), not as judgements.
5. **Remove decoration from the twin.** No animated tank level (not measured). No chip for the shared line (it duplicates the section card), and no invented number for the unmetered branch: its chip says "valve open, no meter". Labels are `text-xs` Geist chips on `--card` with a `--border` line: branch name and `in → out` only. Ground is neutral (`--background` with a barely visible grid), pipes steel grey, water = brand accent, leak = `--destructive`, warn = `--chart-3` (amber). Legend is a `text-xs text-muted-foreground` line under the canvas, not a floating box.

## Layout

Scrolling page, like the shadcn dashboard. Max width none; `p-4 gap-4 md:p-6 md:gap-6`.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ brand.name                                   ● Rig online, 2 s ago  [⋯] [All off]│  h-14 border-b, flex, items-center
├─────────────────────────────────────────────────────────────────────────────┤
│ ┌ Water in    ┐ ┌ Pump ┐ ┌ Water lost ┐ ┌ Turbidity / TDS ┐                  │  4 section cards (grid, 1/2/4 cols)
│ │ 1.41 L/min  │ │ Running│ │ 0.8 %    │ │ 12 NTU  289 ppm │                  │  CardDescription + CardTitle 2xl
│ └─────────────┘ └────────┘ └──────────┘ └─────────────────┘                  │
├──────────────────────────────────────────────┬──────────────────────────────┤
│ Rig (Card, no title)                         │ Branches (Card + Table)      │  lg: grid-cols-3, twin col-span-2
│   3D twin fills CardContent, aspect ≥ 16/9   │  Branch | In | Out | Loss |  │
│   ghost icon button "Reset view" top-right   │  Status | Valve(Switch)      │
│   legend line under the canvas               │  CardFooter: [Run pump 2 min]│
│                                              │              [Clear leak]    │
├──────────────────────────────────────────────┴──────────────────────────────┤
│ Flow, L/min (Card) · Tabs 5 / 15 / 30 min · uPlot                            │
├─────────────────────────────────────────────────────────────────────────────┤
│ Events (Card + Table: Time | What happened), last 20                        │
└─────────────────────────────────────────────────────────────────────────────┘
```
Below `lg`: everything stacks in that order; the twin keeps a 16/10 aspect. The `[⋯]` is a `DropdownMenu` (ghost icon button) holding "Open on phone" (Dialog with QR + URL) and "Sound alerts" (checkbox item). Pump control lives with the branches (it is the supply valve of the same rig), behind an `AlertDialog` that explains the auto-stop in one sentence. "All off" is the only destructive button and needs no confirm.

## Copy

Buttons say what happens: "Run pump for 2 minutes", "Stop pump", "All off", "Clear leak", "Reset view", "Open on phone". Switch aria-labels "Open valve" / "Close valve". Table status column: empty when normal, "Warning" outline badge, "Leak" destructive badge; the loss column shows "closed by leak protection" (muted) when latched and "valve closed" when the valve is simply closed. Header: "Rig online, 2 s ago" / "Rig offline since 14:02". Toasts in plain words: "Couldn't open Branch 2: the leak is still latched. Clear the leak first." Empty states instruct: "Waiting for the rig to connect. Point its firmware at ws://192.168.0.3:3000/ws." / "Events from the rig will appear here."

## Chart

uPlot (performance), styled with shadcn tokens: axes and grid from `--border` / `--muted-foreground`, the monitored branch's IN line in brand accent (the one allowed use) and its OUT line in `--chart-2`, dashed. Two series only: there is nothing else to plot. No fills, no glow, 1.5 px lines. Title "Flow, last 15 minutes" with the unit "L/min" in the CardDescription.

## Self-critique before finishing

1. Screenshot at 1440×900 and 390×844 with the fake device and a leak on the monitored branch.
2. Open the shadcn dashboard example next to it: same chrome weight, same card rhythm, same badge style? If ours has more decoration than theirs, remove it.
3. Count non-neutral colours on screen with no leak: accent water in the twin and chart, the green online dot. Nothing else.
4. Every number on screen must trace to a field in docs/PROTOCOL.md §2.
5. Remove one thing.
