import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev` prints every server action call with its arguments, which include people's names
  // and the emails logins are given to. Logs carry codes and statuses only (CLAUDE.md), so not these.
  logging: {
    serverFunctions: false,
  },
  experimental: {
    // Build from scratch every time. Vercel restores .next/cache between deploys, and the restored
    // Turbopack cache shipped production CSS from before d5848cb (no status colours, so the heat-map
    // lost its R/Y/G). A cold build costs a few seconds.
    turbopackFileSystemCacheForBuild: false,
  },
  turbopack: {
    rules: {
      // The rubric files (rubrics/*.md) are imported as plain text: people edit them as documents,
      // and the grader's and coach's prompts are built from them. vitest.config.mts does the same.
      "*.md": {
        type: "text",
      },
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
