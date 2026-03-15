import { getAdvancedMetricsSnapshot } from '../data/advancedMetricsState.js'
import type { EquityTechnicals, EquityRegimeComponents } from '../types/market.js'

export interface ScoreInput {
  technicals: EquityTechnicals
  tavilyConfirmed: boolean   // true = Tavily returned ≥1 result for this symbol
  hasCatalyst: boolean       // true = Finnhub returned news for this symbol
}

export interface EquityRegimeResult {
  score: number                          // integer 0–10, clamped
  components: EquityRegimeComponents
}

export function scoreEquityRegime(input: ScoreInput): EquityRegimeResult {
  const { technicals, tavilyConfirmed, hasCatalyst } = input

  // --- RSI component (0-2) ---
  // oversold (<30) = 2 points (potential bounce)
  // neutral AND rsi < 50 = 1 point (not overbought)
  // otherwise (overbought zone) = 0
  let rsiScore = 0
  if (technicals.rsiZone === 'oversold') {
    rsiScore = 2
  } else if (technicals.rsiZone === 'neutral' && technicals.rsi !== null && technicals.rsi < 50) {
    rsiScore = 1
  }

  // --- MACD component (0-2) ---
  // bullish crossover (histogram just turned positive) = 2
  // histogram > 0 (already positive, no fresh cross) = 1
  // histogram <= 0 (bearish) = 0
  let macdScore = 0
  if (technicals.macdCross === 'bullish') {
    macdScore = 2
  } else if (technicals.macd !== null && technicals.macd.histogram > 0) {
    macdScore = 1
  }

  // --- BB %B component (0-2) ---
  // %B < 0.2 (near/below lower band) = 2 (oversold extension)
  // %B < 0.5 (lower half of bands) = 1
  // %B >= 0.5 (upper half) = 0
  let bbScore = 0
  if (technicals.bbPercentB !== null) {
    if (technicals.bbPercentB < 0.2) {
      bbScore = 2
    } else if (technicals.bbPercentB < 0.5) {
      bbScore = 1
    }
  }

  // --- Catalyst component (0-2) ---
  // Tavily confirmed (web search found live news) = 2
  // Finnhub only = 1
  // no catalyst = 0
  const catalystScore = tavilyConfirmed ? 2 : hasCatalyst ? 1 : 0

  // --- SPY alignment component (0-2) ---
  // Use the server-side regime score already computed by regimeScorer
  // score >= 6 (bullish macro) = 2
  // score <= 3 (bearish macro) = 0
  // otherwise neutral = 1
  let spyAlignmentScore = 1  // default neutral
  try {
    const snapshot = getAdvancedMetricsSnapshot()
    const spyRegime = snapshot?.regimePreview?.score ?? null
    if (spyRegime !== null) {
      if (spyRegime >= 6) spyAlignmentScore = 2
      else if (spyRegime <= 3) spyAlignmentScore = 0
    }
  } catch {
    // advancedMetrics not yet populated → neutral
  }

  const raw = rsiScore + macdScore + bbScore + catalystScore + spyAlignmentScore
  const score = Math.max(0, Math.min(10, raw))

  const components: EquityRegimeComponents = {
    rsi: rsiScore,
    macd: macdScore,
    bb: bbScore,
    catalyst: catalystScore,
    spyAlignment: spyAlignmentScore,
  }

  return { score, components }
}
