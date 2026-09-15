"use client";

import { useActionState } from "react";
import { loginAction } from "./actions";

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, undefined);
  return (
    <form action={formAction} className="space-y-4">
      {/* Lets password managers associate the saved password with this site. */}
      <input type="text" name="username" autoComplete="username" value="owner" readOnly hidden />
      <label className="block text-sm">
        <span className="text-zinc-600">Password</span>
        <input name="password" type="password" autoComplete="current-password" required autoFocus className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2" />
      </label>
      {state?.error && <p className="text-sm text-red-700" role="alert">{state.error}</p>}
      <button type="submit" disabled={pending} className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
