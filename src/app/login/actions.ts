"use server";

import { redirect } from "next/navigation";
import { login, logout } from "@/lib/auth/session";

export type LoginState = { error?: string } | undefined;

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const password = String(formData.get("password") ?? "");
  if (!password) return { error: "Enter the password." };
  const result = await login(password);
  if (!result.ok) return { error: result.error };
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  await logout();
  redirect("/login");
}
