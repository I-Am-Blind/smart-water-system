"use client";
import type { RigEvent, Stamped } from "@proto/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRig } from "@/lib/store";
import { fmtHms } from "@/components/status";

const BY: Record<RigEvent["src"], string> = {
  serial: "from the serial console",
  ws: "from the dashboard",
  leak: "by leak protection",
  wd: "by the time limit",
  interlock: "by the interlock",
  boot: "at start-up",
};

const BECAUSE: Record<NonNullable<RigEvent["reason"]>, string> = {
  max_on: "time limit reached",
  all_closed: "every valve is closed",
  failover: "taking over from the leaking branch",
};

function describe(e: Stamped<RigEvent>, names: readonly string[]): string {
  const where = e.b ? names[e.b - 1] ?? `branch ${e.b}` : "";
  const by = BY[e.src] ?? "";
  const because = e.reason ? ` (${BECAUSE[e.reason]})` : "";
  switch (e.ev) {
    case "leak":
      return `${e.kind === "burst" ? "Burst" : "Drip leak"} on ${where}, ${e.loss?.toFixed(0) ?? "?"} % lost. Valve closed.`;
    case "leak_clear":
      return `Leak alarm cleared ${by}.`;
    case "valve":
      return `${where} valve ${e.on ? "opened" : "closed"} ${by}${because}.`;
    case "pump":
      return `Pump ${e.on ? "started" : "stopped"} ${by}${because}.`;
    case "all_off":
      return `Everything switched off ${by}.`;
    case "boot":
      return "Rig started.";
    default:
      return e.ev;
  }
}

/** The last 12 events, newest first. Re-renders only when the event list changes. */
export function EventsCard({ className = "" }: { className?: string }) {
  const events = useRig((s) => s.events);
  const names = useRig((s) => s.brand.branches);
  const rows = events.slice(0, 12);
  return (
    <Card className={`overflow-hidden ${className}`}>
      <CardHeader>
        <CardTitle>Events</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        {rows.length === 0 ? (
          <p className="px-4 text-sm text-muted-foreground">Events from the rig will appear here.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28 pl-4">Time</TableHead>
                <TableHead className="pr-4">What happened</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e) => (
                <TableRow key={`${e.at}-${e.ms}-${e.ev}`}>
                  <TableCell className="pl-4 text-muted-foreground">{fmtHms(e.at)}</TableCell>
                  <TableCell className={`whitespace-normal pr-4 ${e.ev === "leak" ? "text-destructive" : ""}`}>{describe(e, names)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
