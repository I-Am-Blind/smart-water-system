import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { Boot } from "@/components/Boot";
import { BrandVars } from "@/components/BrandVars";
import { Toasts } from "@/components/Toasts";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { readBrandFromDisk } from "@/lib/branding-file";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  const b = readBrandFromDisk();
  return { title: b.name, applicationName: b.name };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const brand = readBrandFromDisk();
  return (
    <html lang="en" className={`dark ${geist.variable}`} style={{ "--brand-accent": brand.colors.accent } as React.CSSProperties}>
      <body className="min-h-dvh">
        <TooltipProvider>
          <Boot />
          <BrandVars />
          {children}
          <Toasts />
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </body>
    </html>
  );
}
