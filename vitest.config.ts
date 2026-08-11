import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    // Day 1 has no component tests; jsdom would be pure overhead.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
