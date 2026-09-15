/**
 * Merge a partial JSON config into the active strategy and activate the result
 * as a new immutable version.
 *   npx tsx scripts/apply-strategy.ts strategies/short-term-8h.json "why this change"
 */
import { readFileSync } from "node:fs";
import { getDb, getPool } from "@/db/client";
import { activateStrategyConfig, getActiveStrategy } from "@/lib/strategy/service";

function deepMerge(base: unknown, patch: unknown): unknown {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (isObj(base) && isObj(patch)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(out[k], v);
    return out;
  }
  return patch === undefined ? base : patch;
}

async function main() {
  const [file, ...noteParts] = process.argv.slice(2);
  const notes = noteParts.join(" ").trim();
  if (!file || notes.length < 3) throw new Error('usage: npx tsx scripts/apply-strategy.ts <patch.json> "<notes>"');
  const patch = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const db = getDb();
  const active = await getActiveStrategy(db);
  const result = await db.transaction((tx) => activateStrategyConfig(tx, deepMerge(active.config, patch), notes));
  console.log(`${result.created ? "created" : "re-activated"} strategy v${result.version} (previously v${active.version})`);
  await getPool().end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
