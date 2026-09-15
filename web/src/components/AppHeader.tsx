"use client";
import { useEffect, useState } from "react";
import { EllipsisIcon } from "lucide-react";
import { PhoneDialog } from "@/components/PhoneDialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { audio } from "@/lib/audio";
import { sendCmd, useRig } from "@/lib/store";
import { agoShort, fmtHm } from "@/components/status";

/** "Rig online, 2 s ago" / "Rig offline since 14:02"; while this browser has no server connection, says so instead. */
function RigStatus() {
  const conn = useRig((s) => s.conn);
  const online = useRig((s) => s.online);
  const lastSeen = useRig((s) => s.lastSeen);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (conn !== "open") {
    return <span className="text-sm text-muted-foreground">{conn === "connecting" ? "Connecting to server" : "Reconnecting to server"}</span>;
  }
  return (
    <span className="flex items-center gap-2 whitespace-nowrap text-sm">
      <span aria-hidden="true" className={`size-2 rounded-full ${online ? "bg-emerald-500" : "bg-muted-foreground"}`} />
      {online ? (
        <span>Rig online<span className="text-muted-foreground">, {agoShort(lastSeen, now)}</span></span>
      ) : lastSeen ? (
        <span>Rig offline<span className="text-muted-foreground"> since {fmtHm(lastSeen)}</span></span>
      ) : (
        <span className="text-muted-foreground">Waiting for the rig</span>
      )}
    </span>
  );
}

function HeaderMenu() {
  const showQr = useRig((s) => s.brand.showQr);
  const [qrOpen, setQrOpen] = useState(false);
  const [sound, setSound] = useState(false);
  useEffect(() => { setSound(!audio.muted); }, []);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="More options" />}>
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {showQr && <DropdownMenuItem onClick={() => setQrOpen(true)}>Open on phone</DropdownMenuItem>}
          {showQr && <DropdownMenuSeparator />}
          <DropdownMenuCheckboxItem
            checked={sound}
            onCheckedChange={(next) => {
              audio.unlock();
              audio.setMuted(!next);
              setSound(next);
            }}
          >
            Sound alerts
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {showQr && <PhoneDialog open={qrOpen} onOpenChange={setQrOpen} />}
    </>
  );
}

function AllOff() {
  const online = useRig((s) => s.online);
  const pending = useRig((s) => Object.values(s.pending).some((c) => c.act === "all_off"));
  return (
    <Button variant="destructive" size="sm" disabled={!online || pending} onClick={() => sendCmd({ act: "all_off" })}>
      All off
    </Button>
  );
}

export function AppHeader() {
  const name = useRig((s) => s.brand.name);
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b px-4 md:px-6">
      <span className="font-semibold">{name}</span>
      <div className="ml-auto flex items-center gap-2">
        <RigStatus />
        <HeaderMenu />
        <AllOff />
      </div>
    </header>
  );
}
