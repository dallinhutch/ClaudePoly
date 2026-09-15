"use client";

import type { ReactNode } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis,
} from "recharts";

/** Reference palette (dataviz skill), validated against the white card surface. */
const C = {
  surface: "#ffffff",
  ink: "#0b0b0b",
  ink2: "#52514e",
  muted: "#898781",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  series1: "#2a78d6",
  series2: "#eb6834",
  positive: "#2a78d6",
  negative: "#e34948",
};
const AXIS_TICK = { fill: C.muted, fontSize: 12 };

const fmtUsd = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 });
const fmtPct = (v: number) => `${(v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0)}%`;
const fmtDate = (t: string) => new Date(t).toISOString().slice(5, 10);

type TipRow = { label: string; value: string; color?: string };

function TooltipBox({ title, rows }: { title?: string; rows: TipRow[] }) {
  return (
    <div className="rounded-md border border-black/10 bg-white px-3 py-2 text-xs shadow-sm">
      {title && <div className="mb-1 text-zinc-500">{title}</div>}
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2">
          {r.color && <span className="inline-block h-0.5 w-3" style={{ background: r.color }} />}
          <span className="font-semibold text-zinc-950">{r.value}</span>
          <span className="text-zinc-600">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="grid h-48 place-items-center rounded-lg border border-dashed border-zinc-300 text-sm text-zinc-500">{children}</div>;
}

type TooltipArgs = { active?: boolean; payload?: ReadonlyArray<{ payload?: Record<string, unknown> }> };

/** Single-series time series: area wash + 2px line, crosshair tooltip, optional baseline. */
export function TimeSeriesChart({ data, format, baseline, label, invert = false }: {
  data: Array<{ t: string; v: number }>;
  format: "usd" | "pct";
  baseline?: number;
  label: string;
  invert?: boolean;
}) {
  if (data.length < 2) return <Empty>Not enough history yet: this fills in as hourly snapshots accumulate.</Empty>;
  const fmt = format === "usd" ? fmtUsd : fmtPct;
  const rows = data.map((d) => ({ t: d.t, v: invert ? -d.v : d.v }));
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <AreaChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={C.grid} strokeWidth={1} />
          <XAxis dataKey="t" tickFormatter={fmtDate} tick={AXIS_TICK} axisLine={{ stroke: C.axis }} tickLine={false} minTickGap={40} />
          <YAxis tickFormatter={(v: number) => fmt(invert ? -v : v)} tick={AXIS_TICK} axisLine={false} tickLine={false} width={68} domain={["auto", "auto"]} />
          {baseline !== undefined && <ReferenceLine y={invert ? -baseline : baseline} stroke={C.axis} strokeWidth={1} />}
          <Tooltip
            cursor={{ stroke: C.axis, strokeWidth: 1 }}
            content={(p: unknown) => {
              const { active, payload } = p as TooltipArgs;
              const row = payload?.[0]?.payload as { t: string; v: number } | undefined;
              if (!active || !row) return null;
              return <TooltipBox title={new Date(row.t).toISOString().replace("T", " ").slice(0, 16) + " UTC"} rows={[{ label, value: fmt(invert ? -row.v : row.v), color: C.series1 }]} />;
            }}
          />
          <Area type="monotone" dataKey="v" stroke={C.series1} strokeWidth={2} fill={C.series1} fillOpacity={0.1} dot={false}
            activeDot={{ r: 5, fill: C.series1, stroke: C.surface, strokeWidth: 2 }} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Bar with a 4px rounded data end and a square end at the zero baseline, for either sign. */
function DataEndBar(props: { x?: number; y?: number; width?: number; height?: number; fill?: string; value?: number | number[] }) {
  const { x = 0, y = 0, width = 0, height = 0, fill } = props;
  const w = Math.abs(width);
  const x0 = width < 0 ? x + width : x;
  if (w < 0.5 || height <= 0) return <g />;
  const r = Math.min(4, w, height / 2);
  const raw = Array.isArray(props.value) ? props.value[1] ?? 0 : props.value ?? 0;
  const d = raw >= 0
    ? `M${x0},${y} H${x0 + w - r} Q${x0 + w},${y} ${x0 + w},${y + r} V${y + height - r} Q${x0 + w},${y + height} ${x0 + w - r},${y + height} H${x0} Z`
    : `M${x0 + w},${y} H${x0 + r} Q${x0},${y} ${x0},${y + r} V${y + height - r} Q${x0},${y + height} ${x0 + r},${y + height} H${x0 + w} Z`;
  return <path d={d} fill={fill} />;
}

/** Horizontal diverging bars around zero (blue = profit, red = loss). */
export function PnlBars({ rows }: { rows: Array<{ key: string; pnl: number; count: number; roi: number | null }> }) {
  if (rows.length === 0) return <Empty>No closed trades yet.</Empty>;
  return (
    <div className="w-full" style={{ height: Math.max(120, rows.length * 36 + 40) }}>
      <ResponsiveContainer>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 0 }} barCategoryGap={8}>
          <CartesianGrid horizontal={false} stroke={C.grid} strokeWidth={1} />
          <XAxis type="number" tickFormatter={fmtUsd} tick={AXIS_TICK} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="key" tick={{ ...AXIS_TICK, fill: C.ink2 }} axisLine={false} tickLine={false} width={110} />
          <ReferenceLine x={0} stroke={C.axis} strokeWidth={1} />
          <Tooltip
            cursor={{ fill: "rgba(11,11,11,0.04)" }}
            content={(p: unknown) => {
              const { active, payload } = p as TooltipArgs;
              const row = payload?.[0]?.payload as { key: string; pnl: number; count: number; roi: number | null } | undefined;
              if (!active || !row) return null;
              return (
                <TooltipBox title={row.key} rows={[
                  { label: "realized P&L", value: `${row.pnl > 0 ? "+" : ""}${fmtUsd(row.pnl)}`, color: row.pnl >= 0 ? C.positive : C.negative },
                  { label: "ROI", value: row.roi == null ? "—" : `${(row.roi * 100).toFixed(1)}%` },
                  { label: "trades", value: String(row.count) },
                ]} />
              );
            }}
          />
          <Bar dataKey="pnl" barSize={20} shape={(p: unknown) => <DataEndBar {...(p as Parameters<typeof DataEndBar>[0])} />} isAnimationActive={false}>
            {rows.map((r) => <Cell key={r.key} fill={r.pnl >= 0 ? C.positive : C.negative} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface CalibrationSeries {
  name: string;
  buckets: Array<{ lower: number; upper: number; count: number; meanPredicted: number | null; observedYesRate: number | null }>;
}

/** Predicted vs observed YES rate per probability bucket; the diagonal is perfect calibration. */
export function CalibrationChart({ series }: { series: CalibrationSeries[] }) {
  const colors = [C.series1, C.series2];
  const plotted = series.map((s, i) => ({
    name: s.name,
    color: colors[i] ?? C.muted,
    points: s.buckets.filter((b) => b.count > 0 && b.meanPredicted != null && b.observedYesRate != null)
      .map((b) => ({ x: b.meanPredicted!, y: b.observedYesRate!, n: b.count, range: `${Math.round(b.lower * 100)}–${Math.round(b.upper * 100)}%` })),
  }));
  if (plotted.every((s) => s.points.length === 0)) {
    return <Empty>No resolved forecasts yet: calibration appears once researched markets resolve.</Empty>;
  }
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  return (
    <div>
      {plotted.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-4 text-xs text-zinc-600">
          {plotted.map((s) => (
            <span key={s.name} className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />{s.name}</span>
          ))}
          <span className="flex items-center gap-1.5"><span className="inline-block h-px w-4" style={{ background: C.axis }} />perfect calibration</span>
        </div>
      )}
      <div className="h-80 w-full max-w-xl">
        <ResponsiveContainer>
          <ScatterChart margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
            <CartesianGrid stroke={C.grid} strokeWidth={1} />
            <XAxis type="number" dataKey="x" domain={[0, 1]} ticks={ticks} tickFormatter={fmtPct} tick={AXIS_TICK} axisLine={{ stroke: C.axis }} tickLine={false}
              label={{ value: "Predicted P(YES)", position: "insideBottom", offset: -8, fill: C.ink2, fontSize: 12 }} />
            <YAxis type="number" dataKey="y" domain={[0, 1]} ticks={ticks} tickFormatter={fmtPct} tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} />
            <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke={C.axis} strokeWidth={1} />
            <Tooltip
              cursor={false}
              content={(p: unknown) => {
                const { active, payload } = p as TooltipArgs;
                const pt = payload?.[0]?.payload as { x: number; y: number; n: number; range: string; series?: string } | undefined;
                if (!active || !pt) return null;
                return <TooltipBox title={`${pt.series ?? ""} · bucket ${pt.range}`} rows={[
                  { label: "resolved YES", value: fmtPct(pt.y) },
                  { label: "avg predicted", value: fmtPct(pt.x) },
                  { label: "forecasts", value: String(pt.n) },
                ]} />;
              }}
            />
            {plotted.map((s) => (
              <Scatter key={s.name} name={s.name} data={s.points.map((pt) => ({ ...pt, series: s.name }))} isAnimationActive={false}
                shape={(p: unknown) => {
                  const { cx = 0, cy = 0 } = p as { cx?: number; cy?: number };
                  return (
                    <g>
                      <circle cx={cx} cy={cy} r={12} fill="transparent" />
                      <circle cx={cx} cy={cy} r={5} fill={s.color} stroke={C.surface} strokeWidth={2} />
                    </g>
                  );
                }}
              />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
