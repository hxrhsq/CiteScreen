import type { Metadata } from "next";
import localFont from "next/font/local";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

// Self-hosted rather than next/font/google: that loader fails the whole build
// with "Module not found" when fonts.googleapis.com is unreachable.
const outfit = localFont({
  src: "./fonts/outfit-latin-wght-normal.woff2",
  weight: "100 900",
  variable: "--font-outfit",
});

const fraunces = localFont({
  src: "./fonts/fraunces-latin-wght-normal.woff2",
  weight: "100 900",
  variable: "--font-fraunces",
});

const plex = localFont({
  src: [
    {
      path: "./fonts/ibm-plex-mono-latin-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/ibm-plex-mono-latin-500-normal.woff2",
      weight: "500",
      style: "normal",
    },
  ],
  variable: "--font-plex",
});

export const metadata: Metadata = {
  title: "CiteScreen — evidence-based resume pre-screening",
  description:
    "A recruiter workbench that scores resumes only from verbatim evidence, records human decisions, and re-scores a redacted copy.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${outfit.variable} ${fraunces.variable} ${plex.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
