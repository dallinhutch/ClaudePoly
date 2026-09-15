import { z } from "zod";

/**
 * Structured outputs the research agents must submit via a strict tool call.
 * Schemas avoid numeric min/max keywords (not all are supported by strict tool
 * schemas); ranges are enforced in code after parsing.
 */

export const SOURCE_TYPES = [
  "official_government", "company_filing", "primary_document", "official_statistics", "polling",
  "financial_data", "news", "academic", "historical_data", "expert", "other",
] as const;

export const SourceSchema = z.strictObject({
  url: z.string(),
  title: z.string(),
  publisher: z.string(),
  source_type: z.enum(SOURCE_TYPES),
  quality_tier: z.number().int().describe("1 = official/primary data ... 5 = weak or unverified"),
  published_date: z.string().nullable().describe("ISO date if known"),
  used_for: z.string().describe("What this source established"),
});

const EvidenceSchema = z.strictObject({
  claim: z.string(),
  source_urls: z.array(z.string()),
  strength: z.enum(["strong", "moderate", "weak"]),
  as_of: z.string().nullable().describe("Date the evidence reflects (ISO), if known"),
});

export const ResolutionClarity = z.enum(["clear", "mostly_clear", "ambiguous"]);

export const DossierSchema = z.strictObject({
  resolution_analysis: z.strictObject({
    clarity: ResolutionClarity,
    what_must_happen_for_yes: z.string(),
    resolution_source: z.string(),
    edge_cases: z.array(z.string()),
  }),
  timeline: z.string().describe("Key dates and deadlines relevant to resolution"),
  base_rate: z.strictObject({
    reference_class: z.string(),
    rate: z.number().nullable().describe("Historical frequency 0..1 if a sensible base rate exists"),
    notes: z.string(),
  }),
  evidence_for_yes: z.array(EvidenceSchema),
  evidence_for_no: z.array(EvidenceSchema),
  contradictions: z.array(z.strictObject({ description: z.string(), resolved: z.boolean(), notes: z.string() })),
  current_trends: z.string(),
  possibly_underweighted: z.array(z.string()).describe("Information the broader public may be under- or over-weighting"),
  newest_evidence_date: z.string().nullable().describe("ISO date of the most recent relevant evidence found"),
  data_quality: z.strictObject({ score: z.number().describe("0..1"), notes: z.string() }),
  summary: z.string(),
  sources: z.array(SourceSchema),
});
export type Dossier = z.infer<typeof DossierSchema>;

export const QuickEstimateSchema = z.strictObject({
  probability_yes: z.number().describe("0..1"),
  confidence: z.number().describe("0..1 reliability of this estimate"),
  evidence_quality: z.number().describe("0..1"),
  resolution_clarity: ResolutionClarity,
  key_points: z.array(z.string()),
  reasoning: z.string(),
  newest_evidence_date: z.string().nullable(),
  sources: z.array(SourceSchema),
});
export type QuickEstimate = z.infer<typeof QuickEstimateSchema>;

export const AnalystEstimateSchema = z.strictObject({
  probability_yes: z.number().describe("0..1"),
  confidence: z.number().describe("0..1 reliability of this estimate"),
  evidence_quality: z.number().describe("0..1"),
  base_rate_used: z.number().nullable(),
  key_factors: z.array(z.strictObject({ factor: z.string(), favors: z.enum(["yes", "no"]), weight: z.enum(["high", "medium", "low"]) })),
  main_uncertainties: z.array(z.string()),
  disagreements_with_dossier: z.array(z.string()),
  reasoning: z.string(),
  additional_sources: z.array(SourceSchema),
});
export type AnalystEstimate = z.infer<typeof AnalystEstimateSchema>;

export const PositionReviewSchema = z.strictObject({
  thesis_changed: z.boolean(),
  new_information: z.array(z.string()),
  risk_change: z.enum(["lower", "unchanged", "higher"]),
  notes: z.string(),
});

/** JSON Schema for a strict tool definition (drops the $schema key). */
export function toolInputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return json;
}

const unit = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;

/** Range checks the JSON schema can't express. Returns problems (empty = valid). */
export function probabilityProblems(v: { probability_yes: number; confidence: number; evidence_quality: number }): string[] {
  const problems: string[] = [];
  for (const k of ["probability_yes", "confidence", "evidence_quality"] as const) if (!unit(v[k])) problems.push(`${k} must be within 0..1 (got ${v[k]})`);
  return problems;
}

export function clampTier(t: number): number {
  return Math.min(5, Math.max(1, Math.round(t)));
}
