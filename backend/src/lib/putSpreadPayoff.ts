/**
 * Put Spread Payoff — Math engine for Bull Put Spread (credit spread).
 * All dollar amounts are per contract (100 shares).
 */

export interface PutSpreadPayoff {
  strike_width: number
  max_profit: number
  max_loss: number
  risk_reward_ratio: number
  breakeven: number
  margin_required: number
}

/**
 * Calculates payoff profile for a Bull Put Spread.
 * @param shortStrike - Strike of the short put (higher strike)
 * @param longStrike - Strike of the long put (lower strike)
 * @param creditReceived - Net credit per share (e.g. 2.50 for $2.50)
 * @returns Payoff object or throws if invalid
 */
export function calculatePutSpreadPayoff(
  shortStrike: number,
  longStrike: number,
  creditReceived: number,
): PutSpreadPayoff {
  if (shortStrike <= longStrike) {
    throw new Error('shortStrike must be greater than longStrike')
  }
  if (creditReceived < 0) {
    throw new Error('creditReceived must be non-negative')
  }

  const strike_width = shortStrike - longStrike
  if (creditReceived > strike_width) {
    throw new Error('creditReceived cannot exceed strike width (invalid payoff)')
  }

  const max_profit = Math.round(creditReceived * 100 * 100) / 100
  const max_loss = Math.round((strike_width - creditReceived) * 100 * 100) / 100
  const margin_required = max_loss
  const risk_reward_ratio = max_loss > 0 ? Math.round((max_profit / max_loss) * 100) / 100 : 0
  const breakeven = Math.round((shortStrike - creditReceived) * 100) / 100

  return {
    strike_width,
    max_profit,
    max_loss,
    risk_reward_ratio,
    breakeven,
    margin_required,
  }
}
