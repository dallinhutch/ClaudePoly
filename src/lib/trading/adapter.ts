import { simulateBuy, simulateSell, type BookLevelInput, type FeeModel, type FillResult } from "./execution";

export interface BuyRequest {
  asks: BookLevelInput[];
  budgetUsd: string;
  limitPrice: string;
  minOrderShares: string;
  fee: FeeModel;
}

export interface SellRequest {
  bids: BookLevelInput[];
  shares: string;
  limitPrice: string;
  minOrderShares: string;
  fee: FeeModel;
}

/**
 * Execution boundary. Everything upstream (research, qualification, sizing,
 * accounting) is adapter-agnostic, so a live adapter could be added later
 * without touching strategy code.
 *
 * THIS BUILD IS PAPER-TRADING ONLY. There is no live adapter, no wallet, no
 * signing key, and the database rejects any order whose adapter isn't 'paper'.
 */
export interface ExecutionAdapter {
  readonly name: "paper";
  buy(req: BuyRequest): Promise<FillResult>;
  sell(req: SellRequest): Promise<FillResult>;
}

export class PaperTradingExecutionAdapter implements ExecutionAdapter {
  readonly name = "paper" as const;

  async buy(req: BuyRequest): Promise<FillResult> {
    return simulateBuy({ asks: req.asks, budgetUsd: req.budgetUsd, limitPrice: req.limitPrice, minOrderShares: req.minOrderShares, fee: req.fee });
  }

  async sell(req: SellRequest): Promise<FillResult> {
    return simulateSell({ bids: req.bids, shares: req.shares, limitPrice: req.limitPrice, minOrderShares: req.minOrderShares, fee: req.fee });
  }
}

export function getExecutionAdapter(): ExecutionAdapter {
  return new PaperTradingExecutionAdapter();
}
