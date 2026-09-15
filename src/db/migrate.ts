import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb, getPool } from "./client";
import { ensureBootstrap } from "./bootstrap";

async function main() {
  const db = getDb();
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("migrations applied");
  const result = await ensureBootstrap(db);
  console.log("bootstrap:", result);
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
