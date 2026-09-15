"use client";
import { useState } from "react";
import { BRANCHES, PUMP_UI_DUR_S, type Branch, type Telemetry } from "@proto/types";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { sendCmd, useRig } from "@/lib/store";
import { fmt2 } from "@/components/status";

const PUMP_MIN = PUMP_UI_DUR_S / 60;

function ValveSwitch({ b, open, latched }: { b: Branch; open: boolean; latched: boolean }) {
  const name = useRig((s) => s.brand.branches[b - 1]);
  const online = useRig((s) => s.online);
  const pending = useRig((s) => Object.values(s.pending).some((c) => c.act === "valve" && c.b === b));
  const disabled = !online || pending || (latched && !open);
  const hint = !online ? "The rig is offline" : pending ? "Waiting for the rig" : latched && !open ? "Clear the leak first" : open ? "Close valve" : "Open valve";
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Switch
          aria-label={`${open ? "Close" : "Open"} valve, ${name}`}
          checked={open}
          disabled={disabled}
          onCheckedChange={(next) => sendCmd({ act: "valve", b, on: next })}
        />
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

function BranchRow({ b, tel }: { b: Branch; tel: Telemetry | null }) {
  const name = useRig((s) => s.brand.branches[b - 1]);
  const level = tel?.leak[b - 1] ?? 0;
  const open = tel?.v[b - 1] === 1;
  const latched = level >= 2;
  const loss = tel?.loss[b - 1] ?? 0;
  const lossCell = !tel ? "--" : latched || !open ? <span className="text-muted-foreground">closed</span> : `${loss.toFixed(1)} %`;
  return (
    <TableRow>
      <TableCell className="font-medium">{name}</TableCell>
      <TableCell className="text-right tabular-nums">{fmt2(tel?.f[2 * b - 1])}</TableCell>
      <TableCell className="text-right tabular-nums">{fmt2(tel?.f[2 * b])}</TableCell>
      <TableCell className="text-right tabular-nums">{lossCell}</TableCell>
      <TableCell>
        {level === 1 && <Badge variant="outline">Warning</Badge>}
        {latched && (
          <Tooltip>
            <TooltipTrigger render={<Badge variant="destructive" />}>Leak</TooltipTrigger>
            <TooltipContent>Valve closed by leak protection. Press Clear leak to reset.</TooltipContent>
          </Tooltip>
        )}
      </TableCell>
      <TableCell className="text-right">
        <ValveSwitch b={b} open={open} latched={latched} />
      </TableCell>
    </TableRow>
  );
}

function PumpButton() {
  const online = useRig((s) => s.online);
  const pumpOn = useRig((s) => s.tel?.pump === 1);
  const anyValveOpen = useRig((s) => (s.tel ? s.tel.v.some((v) => v === 1) : false));
  const pending = useRig((s) => Object.values(s.pending).some((c) => c.act === "pump"));
  const [open, setOpen] = useState(false);
  if (pumpOn) {
    return (
      <Button variant="outline" size="sm" disabled={!online || pending} onClick={() => sendCmd({ act: "pump", on: false })}>
        Stop pump
      </Button>
    );
  }
  const blocked = !online ? "The rig is offline" : !anyValveOpen ? "Open a valve first" : null;
  const trigger = (
    <AlertDialogTrigger render={<Button variant="outline" size="sm" disabled={!!blocked || pending} />}>
      Run pump for {PUMP_MIN} minutes
    </AlertDialogTrigger>
  );
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {blocked ? (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>{trigger}</TooltipTrigger>
          <TooltipContent>{blocked}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Run the pump for {PUMP_MIN} minutes?</AlertDialogTitle>
          <AlertDialogDescription>
            It stops by itself when the time is up, when the last valve closes, or when the rig detects a leak before the branches.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => { setOpen(false); sendCmd({ act: "pump", on: true, dur: PUMP_UI_DUR_S }); }}>
            Run pump
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ClearLeakButton() {
  const online = useRig((s) => s.online);
  const latched = useRig((s) => (s.tel ? s.tel.leak.some((l) => l >= 2) || s.tel.mleak === 1 : false));
  const pending = useRig((s) => Object.values(s.pending).some((c) => c.act === "reset_leak"));
  if (!latched) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="outline" size="sm" disabled={!online || pending} onClick={() => sendCmd({ act: "reset_leak" })}>
            Clear leak
          </Button>
        }
      />
      <TooltipContent>Clears the leak alarm. Valves stay closed until you open them.</TooltipContent>
    </Tooltip>
  );
}

/** The three branches with their meters and valves, and the pump that feeds them. */
export function BranchesCard({ className = "" }: { className?: string }) {
  const tel = useRig((s) => s.tel);
  const mleak = tel?.mleak === 1;
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Branches</CardTitle>
        <CardDescription>Litres per minute at the two meters of each branch.</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Branch</TableHead>
              <TableHead className="text-right">In</TableHead>
              <TableHead className="text-right">Out</TableHead>
              <TableHead className="text-right">Loss</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="pr-4 text-right">Valve</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_td:first-child]:pl-4 [&_td:last-child]:pr-4">
            {BRANCHES.map((b) => <BranchRow key={b} b={b} tel={tel} />)}
          </TableBody>
        </Table>
      </CardContent>
      <CardFooter className="flex flex-wrap items-center gap-2">
        <PumpButton />
        <ClearLeakButton />
        {mleak && <Badge variant="destructive">Leak before the branches</Badge>}
      </CardFooter>
    </Card>
  );
}
