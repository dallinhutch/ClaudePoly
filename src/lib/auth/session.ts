import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { and, asc, eq, gt, gte, lt, sql } from "drizzle-orm";
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
/** Account-wide lock: makes guessing a short password impractical even from many IPs. */
const MAX_FAILS_GLOBAL = 30;

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

/** Single-owner app: sign in with the password only (the admin account is ADMIN_EMAIL, or the first user). */
export async function login(password: string): Promise<LoginResult> {
  const db = getDb();
  const ip = await clientIp();
  const since = new Date(Date.now() - RATE_WINDOW_MS);

  const [ipFails] = await db.select({ n: sql<number>`count(*)::int` }).from(loginAttempts)
    .where(and(eq(loginAttempts.ip, ip), eq(loginAttempts.success, false), gte(loginAttempts.createdAt, since)));
  if ((ipFails?.n ?? 0) >= MAX_FAILS_PER_IP) return { ok: false, error: "Too many failed attempts. Try again in 15 minutes." };
  const [allFails] = await db.select({ n: sql<number>`count(*)::int` }).from(loginAttempts)
    .where(and(eq(loginAttempts.success, false), gte(loginAttempts.createdAt, since)));
  if ((allFails?.n ?? 0) >= MAX_FAILS_GLOBAL) return { ok: false, error: "Sign-in is temporarily locked after repeated failed attempts. Try again in 15 minutes." };

  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const [user] = adminEmail
    ? await db.select().from(users).where(eq(users.email, adminEmail)).limit(1)
    : await db.select().from(users).orderBy(asc(users.createdAt)).limit(1);
  const valid = user ? await verifyPassword(user.passwordHash, password) : (await verifyPassword(await getDummyHash(), password), false);
  await db.insert(loginAttempts).values({ email: user?.email ?? null, ip, success: valid });
  if (!user || !valid) return { ok: false, error: "Incorrect password." };

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
