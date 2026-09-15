import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
/** A transaction handle. Functions that take advisory locks require one. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** A db handle or a transaction — read helpers accept either. */
export type DbOrTx = Db | Tx;

declare global {
  // eslint-disable-next-line no-var
  var __polytraderPool: pg.Pool | undefined;
}

export function getPool(): pg.Pool {
  if (!globalThis.__polytraderPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    globalThis.__polytraderPool = new pg.Pool({ connectionString, max: 10 });
  }
  return globalThis.__polytraderPool;
}

let dbInstance: Db | undefined;
export function getDb(): Db {
  dbInstance ??= drizzle(getPool(), { schema });
  return dbInstance;
}

export { schema };
