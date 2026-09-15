"use server";

import { redirect } from "next/navigation";
import { login, logout } from "@/lib/auth/session";

export type LoginState = { error?: string } | undefined;

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Email and password are required." };
  const result = await login(email, password);
  if (!result.ok) return { error: result.error };
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  await logout();
  redirect("/login");
}
