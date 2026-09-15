type N = number | string | null | undefined;
const num = (v: N) => (v == null || v === "" ? null : Number(v));

export function usd(v: N, digits = 2): string {
  const n = num(v);
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function signedUsd(v: N): string {
  const n = num(v);
  if (n == null) return "—";
  return `${n > 0 ? "+" : ""}${usd(n)}`;
}

export function pct(v: N, digits = 1): string {
  const n = num(v);
  return n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(digits)}%`;
}

export function signedPct(v: N, digits = 1): string {
  const n = num(v);
  return n == null ? "—" : `${n > 0 ? "+" : ""}${(n * 100).toFixed(digits)}%`;
}

/** Probability points, e.g. +12.3pp */
export function pp(v: N): string {
  const n = num(v);
  return n == null ? "—" : `${n > 0 ? "+" : ""}${(n * 100).toFixed(1)}pp`;
}

export function cents(v: N): string {
  const n = num(v);
  return n == null ? "—" : `${(n * 100).toFixed(1)}¢`;
}

export function compactUsd(v: N): string {
  const n = num(v);
  if (n == null) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
}

export function dateTime(v: Date | string | null | undefined): string {
  if (!v) return "—";
  return `${new Date(v).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

export function pnlClass(v: N): string {
  const n = num(v);
  return n == null || n === 0 ? "" : n > 0 ? "text-emerald-700" : "text-red-700";
}
