import type { RewardMarket } from "./api";

export interface SelectionConfig {
  /** Ignore pools smaller than this many dollars a day. */
  minDailyRate: number;
  /** Ignore markets whose minimum qualifying order is bigger than this many shares. */
  maxMinSize: number;
  /** Ignore markets this close to their end: the outcome is nearly known and resting orders get picked off. */
  minHoursLeft: number;
  minPrice: number;
  maxPrice: number;
  /** Kinds of market to stay out of (matched against the question and event). */
  exclude: RegExp;
  /** Markets on the same event move together, so limit how many are held at once. */
  maxPerEvent: number;
}

/**
 * Replaying a 20-share quote over historical trades, weather markets cost
 * about ten times as much in bad fills as other quiet markets.
 */
export const WEATHER = /temperature|precipitation|rainfall|snowfall|hurricane|weather/i;

export function hoursLeft(endDate: string | null, now: Date): number {
  if (!endDate) return Infinity;
  const end = Date.parse(endDate);
  return Number.isFinite(end) ? (end - now.getTime()) / 3_600_000 : Infinity;
}

export function isEligible(m: RewardMarket, cfg: SelectionConfig, now: Date): boolean {
  if (m.dailyRate < cfg.minDailyRate || m.minSize > cfg.maxMinSize || m.minSize <= 0 || m.maxSpread <= 0) return false;
  if (hoursLeft(m.endDate, now) <= cfg.minHoursLeft) return false;
  if (m.yesPrice == null || m.yesPrice < cfg.minPrice || m.yesPrice > cfg.maxPrice) return false;
  return !cfg.exclude.test(`${m.question} ${m.eventSlug ?? ""}`);
}

export interface Candidate {
  market: RewardMarket;
  /** Share of the pool our quote would take against the book as it is now. */
  share: number;
  expectedDailyReward: number;
  /** Dollars the two resting orders tie up. */
  capital: number;
}

/** Best first: expected reward, less what fills are assumed to cost, per dollar tied up. */
export function rankCandidates(candidates: Candidate[], assumedDailyCost: number): Candidate[] {
  const value = (c: Candidate) => (c.expectedDailyReward - assumedDailyCost) / Math.max(c.capital, 1);
  return [...candidates].sort((a, b) => value(b) - value(a));
}
