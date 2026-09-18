"use client";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRig } from "@/lib/store";
import { fmt2 } from "@/components/status";

function Unit({ children }: { children: React.ReactNode }) {
  return <span className="ml-1 text-sm font-normal text-muted-foreground">{children}</span>;
}

/** The four headline numbers, every one a field of the `tel` message. */
export function SectionCards() {
  const tel = useRig((s) => s.tel);
  const monitored = useRig((s) => s.brand.branches[0]);
  // Only branch 1 is metered, so the headline flow and loss are its numbers. See docs/PROTOCOL.md §0.
  const lost = tel ? Math.max(0, tel.loss[0] ?? 0) : null;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Card>
        <CardHeader>
          <CardDescription>Water in</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums">
            {fmt2(tel?.f[0])}<Unit>L/min</Unit>
          </CardTitle>
          <CardDescription className="text-xs">entering {monitored}</CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>Valve control</CardDescription>
          <CardTitle className="text-2xl font-semibold">{tel ? (tel.auto ? "Automatic" : "Manual") : "--"}</CardTitle>
          <CardDescription className="text-xs">
            {tel ? (tel.auto ? "the rig switches branches on a leak" : "leaks are shown, you switch the valves") : ""}
          </CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>Water lost</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums">
            {lost === null ? "--" : lost.toFixed(1)}<Unit>%</Unit>
          </CardTitle>
          <CardDescription className="text-xs">in/out difference on {monitored}</CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <Tooltip>
            <TooltipTrigger render={<CardDescription className="w-fit cursor-help underline decoration-dotted underline-offset-4" />}>
              Water quality
            </TooltipTrigger>
            <TooltipContent>Clear water is under 5 NTU; drinking water is usually under 500 ppm.</TooltipContent>
          </Tooltip>
          <CardTitle className="flex flex-wrap gap-x-4 text-2xl font-semibold tabular-nums">
            <span>{tel ? Math.round(tel.turb.ntu) : "--"}<Unit>NTU</Unit></span>
            <span>{tel ? Math.round(tel.tds.ppm) : "--"}<Unit>ppm</Unit></span>
          </CardTitle>
        </CardHeader>
      </Card>
    </div>
  );
}
