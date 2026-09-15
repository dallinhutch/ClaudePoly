import type { Dossier, QuickEstimate } from "./schemas";

export interface StoredDossier {
  stage: 2 | 3;
  quickEstimate?: QuickEstimate;
  dossier?: Dossier;
  analystFailures?: string[];
}

export interface ResearchSignals {
  clarity: "clear" | "mostly_clear" | "ambiguous";
  unresolvedContradictions: number;
  newestEvidenceAt: Date | null;
  summary: string;
}

export function parseIsoDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Pull the qualification-relevant signals out of a stored research dossier. */
export function researchSignals(stored: unknown): ResearchSignals {
  const d = (stored ?? {}) as StoredDossier;
  if (d.dossier) {
    return {
      clarity: d.dossier.resolution_analysis.clarity,
      unresolvedContradictions: d.dossier.contradictions.filter((c) => !c.resolved).length,
      newestEvidenceAt: parseIsoDate(d.dossier.newest_evidence_date),
      summary: d.dossier.summary,
    };
  }
  if (d.quickEstimate) {
    return {
      clarity: d.quickEstimate.resolution_clarity,
      unresolvedContradictions: 0,
      newestEvidenceAt: parseIsoDate(d.quickEstimate.newest_evidence_date),
      summary: d.quickEstimate.reasoning,
    };
  }
  return { clarity: "ambiguous", unresolvedContradictions: 0, newestEvidenceAt: null, summary: "" };
}
