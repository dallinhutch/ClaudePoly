export const dynamic = "force-dynamic";

/** Liveness only — returns no data. */
export function GET() {
  return Response.json({ ok: true });
}
