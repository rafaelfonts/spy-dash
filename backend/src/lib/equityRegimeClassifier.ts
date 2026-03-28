// backend/src/lib/equityRegimeClassifier.ts
import type { VIXRegime, EquityCategory, EquityRegimeState } from '../types/market.js'

export function classifyVIXRegime(vix: number): VIXRegime {
  if (vix < 18) return 'calm'
  if (vix < 28) return 'elevated'
  return 'crisis'
}

// Score thresholds per category x regime (from institutional spec table)
function getScoreThreshold(vixRegime: VIXRegime, category: EquityCategory): number {
  const base: Record<VIXRegime, number> = { calm: 60, elevated: 65, crisis: 72 }
  const adj: Record<EquityCategory, number> = { defensive: -5, aggressive: +5, etf: 0 }
  return base[vixRegime] + adj[category]
}

export function classifyEquityRegime(params: {
  vix: number
  vtsSlope: number          // normalized: VIXTermStructureResult.steepness / 100
  gexRegime: 'positive' | 'negative'
  spyAlignment: 'bullish' | 'bearish' | 'neutral'
  geoRiskScore: number
  noTradeAvoid: boolean
}): EquityRegimeState {
  const { vix, vtsSlope, gexRegime, geoRiskScore, noTradeAvoid } = params

  const vixRegime = classifyVIXRegime(vix)

  // VTS backwardation (slope < -0.05) elevates risk: treat as one VIX regime step higher
  const backwardation = vtsSlope < -0.05
  // GEX negative: amplified moves — restrict aggressive plays
  const gexNegative = gexRegime === 'negative'

  let activeCategories: EquityCategory[] = []
  let mode: EquityRegimeState['mode'] = 'full'
  let suspendedReason: string | undefined

  // Suspended if noTrade=avoid OR geoRisk extreme
  if (noTradeAvoid || geoRiskScore >= 76) {
    mode = 'suspended'
    suspendedReason = noTradeAvoid
      ? 'Regime SPY adverso (noTrade=avoid)'
      : `Risco geopolitico extremo (geoRisk=${geoRiskScore})`
    activeCategories = []
  } else if (vixRegime === 'crisis' || geoRiskScore >= 56 || (backwardation && vixRegime === 'elevated')) {
    mode = 'defensive_only'
    activeCategories = ['defensive', 'etf']
  } else if (vixRegime === 'elevated' || gexNegative) {
    // Elevated VIX or negative GEX: conditional aggressive
    mode = 'full'
    activeCategories = ['defensive', 'etf', 'aggressive'] // aggressive allowed but with higher threshold
  } else {
    mode = 'full'
    activeCategories = ['defensive', 'aggressive', 'etf']
  }

  const maxCandidates = vixRegime === 'calm' ? 15 : vixRegime === 'elevated' ? 8 : 4

  const scoreThresholds: Record<EquityCategory, number> = {
    defensive: getScoreThreshold(vixRegime, 'defensive'),
    aggressive: getScoreThreshold(vixRegime, 'aggressive'),
    etf: getScoreThreshold(vixRegime, 'etf'),
  }

  return {
    vixRegime,
    vtsSlope,
    geoRiskScore,
    activeCategories,
    scoreThresholds,
    maxCandidates,
    mode,
    suspendedReason,
    updatedAt: Date.now(),
  }
}
