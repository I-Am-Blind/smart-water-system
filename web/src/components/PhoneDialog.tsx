"use client";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useRig } from "@/lib/store";

/** QR code to this server's LAN address so a visitor can open the dashboard on their phone. Opened from the header menu. */
export function PhoneDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const serverUrl = useRig((s) => s.serverUrl);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Open on your phone</DialogTitle>
          <DialogDescription>Join the same Wi-Fi as this laptop, then scan the code.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-md bg-white p-3">
            {/* The QR is generated server-side as SVG; a plain img is the right element for it. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/api/qr.svg" alt={`QR code for ${serverUrl || "this dashboard"}`} width={208} height={208} className="block" />
          </div>
          <p className="select-all text-sm text-muted-foreground">{serverUrl || "Address not known yet"}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
