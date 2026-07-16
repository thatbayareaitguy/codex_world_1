import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createDatabase(connectionString = requiredDatabaseUrl()) {
  const client = postgres(connectionString, { max: 5 });
  return { db: drizzle(client, { schema }), client };
}

function requiredDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required");
  return value;
}

export type RadarDatabase = ReturnType<typeof createDatabase>["db"];
