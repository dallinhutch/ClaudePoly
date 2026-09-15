import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { and, eq, gt, gte, lt, sql } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { loginAttempts, sessions, users } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { getDummyHash, verifyPassword } from "./password";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const isProd = process.env.NODE_ENV === "production";
/** __Host- prefix: Secure, Path=/, no Domain — cannot be set or overridden by subdomains. */
export const SESSION_COOKIE = isProd ? "__Host-pt_session" : "pt_session";

const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_PER_EMAIL = 10;

function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set (32+ chars)");
  return s;
}

/** Only an HMAC of the token is stored, so a database leak can't be replayed as a session. */
function sessionIdFor(token: string): string {
  return createHmac("sha256", sessionSecret()).update(token).digest("hex");
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

export type LoginResult = { ok: true } | { ok: false; error: string };

export async function login(emailInput: string, password: string): Promise<LoginResult> {
  const db = getDb();
  const email = emailInput.trim().toLowerCase();
  const ip = await clientIp();
  const since = new Date(Date.now() - RATE_WINDOW_MS);

  const [ipFails] = await db.select({ n: sql<number>`count(*)::int` }).from(loginAttempts)
    .where(and(eq(loginAttempts.ip, ip), eq(loginAttempts.success, false), gte(loginAttempts.createdAt, since)));
  const [emailFails] = await db.select({ n: sql<number>`count(*)::int` }).from(loginAttempts)
    .where(and(eq(loginAttempts.email, email), eq(loginAttempts.success, false), gte(loginAttempts.createdAt, since)));
  if ((ipFails?.n ?? 0) >= MAX_FAILS_PER_IP || (emailFails?.n ?? 0) >= MAX_FAILS_PER_EMAIL) {
    return { ok: false, error: "Too many failed attempts. Try again in 15 minutes." };
  }

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const valid = user ? await verifyPassword(user.passwordHash, password) : (await verifyPassword(await getDummyHash(), password), false);
  await db.insert(loginAttempts).values({ email, ip, success: valid });
  if (!user || !valid) return { ok: false, error: "Invalid email or password." };

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const h = await headers();
  await db.insert(sessions).values({ id: sessionIdFor(token), userId: user.id, expiresAt, ip, userAgent: h.get("user-agent")?.slice(0, 300) ?? null });
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, secure: isProd, sameSite: "strict", path: "/", expires: expiresAt });
  await recordAudit(db, "auth.login", "user", user.id, { ip });
  return { ok: true };
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await getDb().delete(sessions).where(eq(sessions.id, sessionIdFor(token)));
  jar.delete(SESSION_COOKIE);
}

export async function getCurrentUser(): Promise<{ id: string; email: string } | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const [row] = await getDb()
    .select({ id: users.id, email: users.email })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, sessionIdFor(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

/** Call at the top of every protected page, route handler and server action. */
export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
