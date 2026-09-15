import type { NextConfig } from "next";
import path from "node:path";

// The app imports ../packages/protocol and ../branding.json, which live above web/,
// so the bundler root must be the repository root.
const repoRoot = path.resolve(import.meta.dirname, "..");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: { root: repoRoot },
  // The custom server (server/index.ts) owns HTTP; no standalone output, no `next start`.
};

export default nextConfig;
