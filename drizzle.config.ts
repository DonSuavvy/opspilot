import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Next loads .env.local automatically; drizzle-kit runs outside Next, so load it here.
config({ path: ".env.local" });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Only read when a command actually talks to the database. `drizzle-kit
    // generate` works offline, so a missing URL must not break codegen or CI.
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
