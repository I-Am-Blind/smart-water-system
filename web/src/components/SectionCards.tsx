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
  const lost = tel ? Math.max(0, ...tel.loss) : null;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Card>
        <CardHeader>
          <CardDescription>Master flow</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums">
            {fmt2(tel?.f[0])}<Unit>L/min</Unit>
          </CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>Pump</CardDescription>
          <CardTitle className="text-2xl font-semibold">{tel ? (tel.pump ? "Running" : "Off") : "--"}</CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>Water lost</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums">
            {lost === null ? "--" : lost.toFixed(1)}<Unit>%</Unit>
          </CardTitle>
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
