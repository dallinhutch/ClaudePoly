/**
 * Create the admin user, or reset its password (which also signs out all sessions).
 *   ADMIN_PASSWORD='...' npm run create-admin -- you@example.com
 * Without ADMIN_PASSWORD a strong password is generated and printed once.
 * Passwords shorter than 12 characters require ALLOW_SHORT_PASSWORD=1.
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, getPool } from "@/db/client";
import { sessions, users } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { hashPassword, MIN_PASSWORD_LENGTH } from "@/lib/auth/password";

async function main() {
  const email = (process.argv[2] ?? process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (!email.includes("@")) throw new Error("usage: npm run create-admin -- <email>  (or set ADMIN_EMAIL)");
  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD ?? randomBytes(18).toString("base64url");
  const allowShort = process.env.ALLOW_SHORT_PASSWORD === "1";
  const passwordHash = await hashPassword(password, { minLength: allowShort ? 4 : MIN_PASSWORD_LENGTH });
  if (password.length < MIN_PASSWORD_LENGTH) console.warn("WARNING: short password — protected only by login rate limits and the global lockout.");

  const db = getDb();
  const [user] = await db.insert(users).values({ email, passwordHash })
    .onConflictDoUpdate({ target: users.email, set: { passwordHash } })
    .returning({ id: users.id });
  await db.delete(sessions).where(eq(sessions.userId, user!.id));
  await recordAudit(db, "auth.admin_password_set", "user", user!.id, { email });

  console.log(`Admin user ready: ${email}`);
  if (generated) console.log(`Generated password (shown once): ${password}`);
  await getPool().end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
