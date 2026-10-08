import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Build from scratch every time. Vercel restores .next/cache between deploys, and the restored
    // Turbopack cache shipped production CSS from before d5848cb (no status colours, so the heat-map
    // lost its R/Y/G). A cold build costs a few seconds.
    turbopackFileSystemCacheForBuild: false,
  },
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
