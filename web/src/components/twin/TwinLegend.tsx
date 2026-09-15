"use client";

import { useRig } from "@/lib/store";
import type { Brand } from "@proto/types";

/** Inline colour key for the twin: `text-xs text-muted-foreground`, 8 px dots, no box. */
export function TwinLegend({ palette, className = "" }: { palette?: Brand["colors"]; className?: string }) {
  const brand = useRig((s) => s.brand);
  const accent = (palette ?? brand.colors).accent;
  const items: { label: string; style: React.CSSProperties }[] = [
    { label: "Flowing pipe", style: { background: accent } },
    { label: "Closed valve", style: { background: "#5b6472" } },
    { label: "Warning", style: { background: palette?.warn ?? "var(--chart-3)" } },
    { label: "Leak", style: { background: palette?.danger ?? "var(--destructive)" } },
    { label: "Offline", style: { border: "1px dashed var(--muted-foreground)" } },
  ];
  return (
    <ul className={`text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs ${className}`}>
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          <span className="inline-block size-2 shrink-0 rounded-full" style={it.style} aria-hidden="true" />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

export default TwinLegend;
