import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Native replacement for vite-tsconfig-paths; resolves the "@/*" alias.
    tsconfigPaths: true,
  },
  test: {
    // Day 1 has no component tests; jsdom would be pure overhead.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
