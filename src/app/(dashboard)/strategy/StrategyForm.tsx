"use client";

import { useActionState } from "react";
import { saveStrategyAction } from "./actions";

export function StrategyForm({ initialConfig }: { initialConfig: string }) {
  const [state, formAction, pending] = useActionState(saveStrategyAction, undefined);
  return (
    <form action={formAction} className="space-y-3">
      <textarea
        name="config"
        defaultValue={initialConfig}
        spellCheck={false}
        rows={32}
        className="w-full rounded-md border border-zinc-300 bg-white p-3 font-mono text-xs"
      />
      <label className="block text-sm">
        <span className="text-zinc-600">Change notes (required)</span>
        <input name="notes" required minLength={3} className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2" placeholder="e.g. raise minimum edge to 15pp after first 20 trades" />
      </label>
      {state?.error && <p className="text-sm text-red-700" role="alert">{state.error}</p>}
      {state?.ok && <p className="text-sm text-emerald-700" role="status">{state.ok}</p>}
      <button type="submit" disabled={pending} className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
        {pending ? "Saving…" : "Save as new strategy version"}
      </button>
    </form>
  );
}
