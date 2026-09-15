import { dec, D, ONE, ZERO, type Dec } from "@/lib/decimal";

export interface AnalystInput {
  analystKey: string;
  /** Analyst's P(YES), 0..1. */
  probabilityYes: number;
  /** Analyst's self-rated reliability of their own estimate, 0..1. */
  confidence: number;
  /** Analyst's rating of the evidence available to them, 0..1. */
  evidenceQuality: number;
}

export interface AggregateOptions {
  /** Analysts below this evidence quality are dropped, unless every analyst is below it. */
  minAnalystEvidenceQuality: number;
  /** confidence *= exp(-(stdev / disagreementScale)^2) */
  disagreementScale: number;
}

export interface AggregateResult {
  count: number;
  usedCount: number;
  excluded: string[];
  mean: Dec;
  median: Dec;
  /** Population standard deviation of the used analysts' probabilities. */
  stdev: Dec;
  /** Final P(YES): quality-weighted mean in log-odds space. */
  probabilityYes: Dec;
  /** 0..1 reliability of `probabilityYes` (NOT a probability of YES). */
  confidence: Dec;
  evidenceQuality: Dec;
  disagreementFactor: Dec;
}

// Keep analyst probabilities off 0/1 so log-odds stay finite.
const EPS = new D("0.005");

function logit(p: Dec): Dec {
  const c = D.max(EPS, D.min(ONE.minus(EPS), p));
  return c.div(ONE.minus(c)).ln();
}

function sigmoid(x: Dec): Dec {
  return ONE.div(ONE.plus(x.neg().exp()));
}

function median(values: Dec[]): Dec {
  const s = [...values].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : s[mid - 1]!.plus(s[mid]!).div(2);
}

/**
 * Combine independent analyst estimates.
 *
 * - Weak analyses (low evidence quality) are excluded rather than averaged in.
 * - Each remaining analyst is weighted by confidence * evidenceQuality.
 * - Probabilities are pooled in log-odds space (no extremizing; conservative).
 * - Confidence is penalized by analyst disagreement and by weak evidence.
 */
export function aggregateAnalysts(inputs: AnalystInput[], opts: AggregateOptions): AggregateResult {
  if (inputs.length === 0) throw new Error("aggregateAnalysts: no analyst inputs");
  for (const a of inputs) {
    for (const [k, v] of [["probabilityYes", a.probabilityYes], ["confidence", a.confidence], ["evidenceQuality", a.evidenceQuality]] as const) {
      if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error(`aggregateAnalysts: ${a.analystKey}.${k} out of range: ${v}`);
    }
  }

  const strong = inputs.filter((a) => a.evidenceQuality >= opts.minAnalystEvidenceQuality);
  const used = strong.length > 0 ? strong : inputs;
  const excluded = strong.length > 0 ? inputs.filter((a) => !strong.includes(a)).map((a) => a.analystKey) : [];

  const probs = used.map((a) => dec(a.probabilityYes));
  const n = new D(used.length);
  const mean = probs.reduce((s, p) => s.plus(p), ZERO).div(n);
  const variance = probs.reduce((s, p) => s.plus(p.minus(mean).pow(2)), ZERO).div(n);
  const stdev = variance.sqrt();

  const weights = used.map((a) => {
    const w = dec(a.confidence).times(a.evidenceQuality);
    return w.gt(0) ? w : new D("0.0001");
  });
  const weightSum = weights.reduce((s, w) => s.plus(w), ZERO);
  const pooledLogit = used.reduce((s, a, i) => s.plus(logit(dec(a.probabilityYes)).times(weights[i]!)), ZERO).div(weightSum);
  const probabilityYes = sigmoid(pooledLogit);

  const evidenceQuality = used.reduce((s, a, i) => s.plus(dec(a.evidenceQuality).times(weights[i]!)), ZERO).div(weightSum);
  const meanConfidence = used.reduce((s, a) => s.plus(a.confidence), ZERO).div(n);
  const disagreementFactor = stdev.div(opts.disagreementScale).pow(2).neg().exp();
  const confidence = meanConfidence.times(disagreementFactor).times(new D("0.5").plus(evidenceQuality.div(2)));

  return {
    count: inputs.length,
    usedCount: used.length,
    excluded,
    mean,
    median: median(probs),
    stdev,
    probabilityYes,
    confidence,
    evidenceQuality,
    disagreementFactor,
  };
}
