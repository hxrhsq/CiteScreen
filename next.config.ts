import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingIncludes: {
    "/api/samples": ["./data/**/*"],
    "/api/requirements": ["./data/**/*"],
    "/api/screen": ["./data/**/*"],
  },
  serverExternalPackages: ["unpdf", "mammoth", "pdfjs-dist"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
