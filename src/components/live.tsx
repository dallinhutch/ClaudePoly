"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

function ago(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)} h ${mins % 60} min ago`;
  return `${Math.floor(mins / 1440)} d ago`;
}

/** Timestamp in the viewer's own timezone plus a live-updating "x min ago". */
export function LiveTimestamp({ iso }: { iso: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const d = new Date(iso);
  return (
    <span title={d.toISOString()}>
      <time dateTime={iso} suppressHydrationWarning>
        {now === null ? d.toISOString().replace("T", " ").slice(0, 16) + " UTC" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
      </time>
      {now !== null && <span className="text-zinc-500"> · {ago(now - d.getTime())}</span>}
    </span>
  );
}

/** Re-fetches server data on an interval so the page stays live. */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}
