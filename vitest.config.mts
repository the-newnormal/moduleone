import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Rubric files (rubrics/*.md) are imported as plain text, as Turbopack does in next.config.ts.
  plugins: [
    {
      name: "markdown-as-text",
      transform(code, id) {
        if (!id.endsWith(".md")) return null;
        return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `import "server-only"` throws outside React's server build; Next.js resolves it to an empty
      // module on the server, and tests run server code, so do the same here.
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
