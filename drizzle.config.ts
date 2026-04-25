import { defineConfig } from "drizzle-kit";

const direct = process.env.DATABASE_URL;
const isFile = direct?.startsWith("file:");

export default defineConfig(
  isFile
    ? {
        schema: "./src/lib/db/schema.ts",
        out: "./drizzle",
        dialect: "sqlite",
        dbCredentials: { url: direct! },
      }
    : {
        schema: "./src/lib/db/schema.ts",
        out: "./drizzle",
        dialect: "turso",
        dbCredentials: {
          url: direct ?? process.env.TURSO_CONNECTION_URL!,
          authToken: process.env.TURSO_AUTH_TOKEN,
        },
      }
);
