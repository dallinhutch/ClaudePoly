import fs from "node:fs/promises";
import path from "node:path";
import { requireUser } from "@/lib/auth/session";
import { renderDashboard } from "@/lib/rewards/dashboard";
import type { RobotState } from "@/lib/rewards/robot";

export const dynamic = "force-dynamic";

/**
 * The paper reward robot runs in its own container and saves its state to a
 * volume this container mounts read-only. Same login as the rest of the dashboard.
 */
export async function GET() {
  await requireUser();
  // A runtime location, not a source file: keep the bundler from tracing it.
  const file = path.join(path.resolve(/*turbopackIgnore: true*/ process.env.REWARD_ROBOT_DIR ?? "data/reward-robot"), "state.json");
  let state: RobotState;
  try {
    state = JSON.parse(await fs.readFile(file, "utf8")) as RobotState;
  } catch {
    return new Response("The reward robot has not saved anything yet. Check back in a minute.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  return new Response(renderDashboard(state, new Date(), { backHref: "/" }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
