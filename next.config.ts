import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // Pin the workspace root. Without this, Turbopack walks up looking for a
    // lockfile, finds an unrelated pnpm-lock.yaml in the home directory, and
    // warns on every dev run and build.
    root: import.meta.dirname,
  },
};

export default nextConfig;
