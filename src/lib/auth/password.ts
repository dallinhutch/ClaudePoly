import { hash, verify } from "@node-rs/argon2";

// Argon2id (library default) with OWASP-recommended minimum parameters.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

export const MIN_PASSWORD_LENGTH = 12;

export function hashPassword(password: string, opts: { minLength?: number } = {}): Promise<string> {
  const minLength = opts.minLength ?? MIN_PASSWORD_LENGTH;
  if (password.length < minLength) throw new Error(`password must be at least ${minLength} characters`);
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** Verified against when the email is unknown, so response time doesn't reveal which emails exist. */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hash("dummy-password-for-timing-only", OPTIONS);
  return dummyHash;
}
