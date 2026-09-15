"use client";
import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { HistoryResponse } from "@proto/types";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Ring } from "@/lib/ring";
import { getState, subscribe, useRig } from "@/lib/store";

const WINDOWS = [5, 15, 30] as const;
type WindowMin = (typeof WINDOWS)[number];
/** Branch pairs use the neutral chart tokens; only the master line carries the brand colour. */
const BRANCH_TOKENS = ["--chart-1", "--chart-2", "--chart-4"];

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Breaks the line where samples are more than 5 s apart (server restarts, rig offline). */
function withGaps(data: [number[], ...number[][]]): uPlot.AlignedData {
  const [x, ...ys] = data;
  const ox: number[] = [];
  const oys: (number | null)[][] = ys.map(() => []);
  for (let i = 0; i < x.length; i++) {
    if (i > 0 && x[i] - x[i - 1] > 5) {
      ox.push(x[i - 1] + 1);
      oys.forEach((col) => col.push(null));
    }
    ox.push(x[i]);
    ys.forEach((col, s) => oys[s].push(col[i]));
  }
  return [ox, ...oys];
}

/**
 * uPlot canvas of the seven flow meters. The ring buffer and the chart live outside React;
 * React owns the container, the range tabs and the legend line.
 */
export function FlowCard({ className = "" }: { className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const ring = useRef(new Ring());
  const names = useRig((s) => s.brand.branches);
  const [windowMin, setWindowMin] = useState<WindowMin>(15);
  const windowRef = useRef<WindowMin>(15);
  windowRef.current = windowMin;
  const [colors, setColors] = useState<string[]>([]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const accent = cssVar("--brand-accent", "#22d3ee");
    const muted = cssVar("--muted-foreground", "#a1a1a1");
    const grid = cssVar("--border", "rgba(255,255,255,0.1)");
    const shades = BRANCH_TOKENS.map((t) => cssVar(t, "#888"));
    setColors([accent, ...shades]);
    const fmt = (_u: uPlot, v: number | null) => (v == null ? "--" : v.toFixed(2));
    const axis: uPlot.Axis = { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 }, font: "12px Geist, sans-serif" };
    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height: el.clientHeight || 240,
      cursor: { drag: { x: false, y: false } },
      legend: { show: false },
      scales: { x: { time: true }, y: { range: (_u, min, max) => [0, Math.max(0.5, max * 1.15, min)] } },
      axes: [
        { ...axis, values: (_u, splits) => splits.map((t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) },
        { ...axis, size: 44, values: (_u, v) => v.map((n) => n.toFixed(1)) },
      ],
      series: [
        { label: "Time" },
        { label: "Master", stroke: accent, width: 1.5, value: fmt },
        ...([0, 1, 2] as const).flatMap((i) => [
          { label: `${names[i]} in`, stroke: shades[i], width: 1.5, value: fmt },
          { label: `${names[i]} out`, stroke: shades[i], width: 1.5, dash: [5, 4], value: fmt },
        ]),
      ],
    };
    const u = new uPlot(opts, withGaps(ring.current.toData(windowRef.current * 60_000)), el);
    plot.current = u;

    let raf = 0;
    const redraw = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        u.setData(withGaps(ring.current.toData(windowRef.current * 60_000)));
      });
    };

    let cancelled = false;
    const seed = async () => {
      try {
        const res = await fetch("/api/history?minutes=30", { cache: "no-store" });
        if (!res.ok) return;
        const h = (await res.json()) as HistoryResponse;
        if (cancelled) return;
        ring.current.seed(h);
        const tel = getState().tel;
        if (tel) ring.current.push(tel);
        redraw();
      } catch { /* server unreachable; live samples fill in */ }
    };
    void seed();

    let lastConn = getState().conn;
    const unsub = subscribe(() => {
      const s = getState();
      if (s.tel && ring.current.push(s.tel)) redraw();
      if (s.conn === "open" && lastConn !== "open") void seed();
      lastConn = s.conn;
    });

    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height: Math.max(140, el.clientHeight) }));
    ro.observe(el);

    return () => {
      cancelled = true;
      unsub();
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      u.destroy();
      plot.current = null;
    };
  }, [names]);

  useEffect(() => {
    plot.current?.setData(withGaps(ring.current.toData(windowMin * 60_000)));
  }, [windowMin]);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Flow, last {windowMin} minutes</CardTitle>
        <CardDescription>L/min</CardDescription>
        <CardAction>
          <Tabs value={String(windowMin)} onValueChange={(v) => setWindowMin(Number(v) as WindowMin)}>
            <TabsList>
              {WINDOWS.map((w) => (
                <TabsTrigger key={w} value={String(w)}>{w} min</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div ref={host} className="h-[260px] w-full [&_.uplot]:h-full" />
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {["Master", ...names].map((n, i) => (
            <li key={n} className="flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block h-0.5 w-4" style={{ background: colors[i] ?? "currentColor" }} />
              {n}
            </li>
          ))}
          <li>dashed line = out meter</li>
        </ul>
      </CardContent>
    </Card>
  );
}
