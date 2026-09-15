"use client";
import { useEffect } from "react";
import { start } from "@/lib/ws-client";

/** Starts the WebSocket client once per page. */
export function Boot() {
  useEffect(() => { start(); }, []);
  return null;
}
