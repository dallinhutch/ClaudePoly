import type { DbOrTx } from "@/db/client";
import { auditEvents } from "@/db/schema";

/**
 * Append an audit event. The database trigger fills prev_hash/hash (SHA-256
 * chain), so any later tampering with an event breaks every hash after it.
 * Decimal values serialize to strings via Decimal#toJSON.
 */
export async function recordAudit(
  db: DbOrTx,
  eventType: string,
  entityType: string,
  entityId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditEvents).values({
    eventType,
    entityType,
    entityId,
    payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
  });
}
