import { defineConfig } from "prisma/config";

// dotenv loaded conditionally -- not available during npm postinstall
try { require("dotenv/config"); } catch {}

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://localhost:5432/replystack",
  },
});
