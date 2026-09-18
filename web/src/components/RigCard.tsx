"use client";
import dynamic from "next/dynamic";
import { TwinLegend } from "@/components/twin";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useRig } from "@/lib/store";
import { fmtHm } from "@/components/status";

const RigCanvas = dynamic(() => import("@/components/RigCanvas"), {
  ssr: false,
  loading: () => <Skeleton className="absolute inset-0 rounded-none" />,
});

/** First-run instruction over the canvas until a rig has ever reported. */
function WaitingNote() {
  const hasTel = useRig((s) => s.tel !== null);
  if (hasTel) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center px-4">
      <p className="rounded-md border bg-card px-3 py-2 text-center text-sm">
        Waiting for the rig to connect.
        <span className="block text-muted-foreground">Plug the Arduino into this laptop with its USB cable.</span>
      </p>
    </div>
  );
}

function OfflineNote() {
  const online = useRig((s) => s.online);
  const lastSeen = useRig((s) => s.lastSeen);
  if (online || !lastSeen) return null;
  return <span>Rig offline, showing the last reading from {fmtHm(lastSeen)}</span>;
}

/** The rig from above. No title: the picture is the title. */
export function RigCard({ className = "" }: { className?: string }) {
  const online = useRig((s) => s.online);
  return (
    <Card className={`gap-0 overflow-hidden py-0 ${className}`}>
      <div className={`relative aspect-[16/10] lg:aspect-[16/9] ${online ? "" : "saturate-50"}`}>
        <RigCanvas />
        <WaitingNote />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-xs text-muted-foreground">
        <TwinLegend />
        <OfflineNote />
      </div>
    </Card>
  );
}
