"use client";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { ViewerCmd } from "@proto/types";
import { getState, subscribe } from "@/lib/store";
import { describeAckError } from "@/components/status";

const FRESH_MS = 15_000;

/** Turns command failures and leak events into short toasts. Subscribes outside React rendering. */
export function Toasts() {
  const lastCmd = useRef<ViewerCmd | null>(null);
  const lastError = useRef<string | null>(null);
  const seenEvent = useRef<number>(0);
  useEffect(() => {
    seenEvent.current = getState().events[0]?.at ?? 0;
    return subscribe(() => {
      const s = getState();
      // Remember the most recent command so an error can name what failed.
      const cmds = Object.values(s.pending);
      if (cmds.length) lastCmd.current = cmds[cmds.length - 1];
      if (s.lastError !== lastError.current) {
        lastError.current = s.lastError;
        if (s.lastError) {
          const cmd = lastCmd.current;
          const branchName = cmd?.b ? s.brand.branches[cmd.b - 1] : undefined;
          const text = describeAckError(s.lastError, cmd?.act, branchName);
          if (s.lastError === "server connection lost") toast.warning(text, { id: "conn" });
          else toast.error(text);
        }
      }
      const newest = s.events[0];
      if (newest && newest.at > seenEvent.current) {
        seenEvent.current = newest.at;
        if (Date.now() - newest.at > FRESH_MS) return;
        const names = s.brand.branches;
        if (newest.ev === "leak") {
          const where = newest.b ? names[newest.b - 1] : "a branch";
          toast.error(`${newest.kind === "burst" ? "Burst" : "Drip leak"} on ${where}. Its valve was closed.`, { duration: 8000 });
        } else if (newest.ev === "mleak") {
          toast.error("Leak before the branches. The pump was stopped.", { duration: 8000 });
        }
      }
    });
  }, []);
  return null;
}
