"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import { requireUser } from "@/lib/auth/session";
import { StrategyConfigSchema } from "@/lib/strategy/config";
import { activateStrategyConfig, getActiveStrategy } from "@/lib/strategy/service";

export type StrategyFormState = { ok?: string; error?: string } | undefined;

export async function saveStrategyAction(_prev: StrategyFormState, formData: FormData): Promise<StrategyFormState> {
  await requireUser();
  const notes = String(formData.get("notes") ?? "").trim();
  if (notes.length < 3) return { error: "Describe what changed and why (it is stored with the version)." };

  let json: unknown;
  try {
    json = JSON.parse(String(formData.get("config") ?? ""));
  } catch (err) {
    return { error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = StrategyConfigSchema.safeParse(json);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }

  const db = getDb();
  const active = await getActiveStrategy(db);
  if (parsed.data.sizing.startingBankrollUsd !== active.config.sizing.startingBankrollUsd) {
    return { error: "The starting bankroll is fixed once the account exists; it cannot be changed." };
  }
  const result = await db.transaction((tx) => activateStrategyConfig(tx, parsed.data, notes));
  revalidatePath("/strategy");
  return {
    ok: result.created
      ? `Created and activated strategy v${result.version}. Future decisions use it; past trades keep their original version.`
      : `That configuration already exists as v${result.version}; it has been re-activated.`,
  };
}
