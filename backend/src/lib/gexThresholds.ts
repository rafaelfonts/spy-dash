/**
 * gexThresholds — constantes canônicas para thresholds de GEX, VEX, CEX e Skew.
 *
 * Centraliza valores que antes apareciam inconsistentes entre regimeScorer.ts,
 * GEXPanel.tsx e comentários no código. Importar daqui em todos os contextos.
 */

export const GEX_THRESHOLDS = {
  // Vanna Exposure (VEX) — $M
  VEX_TAILWIND:   2.0,   // VEX > 2M + VIX < 20 → tailwind (dealers de-hedge via compra)
  VEX_HEADWIND:  -2.0,   // VEX < -2M → headwind (dealers de-hedge via venda)
  VEX_DANGER:    -5.0,   // VEX < -5M + VIX > 20 → veto compound (amplificação bearish severa)

  // Charm Exposure (CEX) — $M/dia
  CEX_SIGNIFICANT: 2.0,  // |CEX| > 2M/dia → charm pressure significativa (regime scorer)
  CEX_MODERATE:    0.5,  // |CEX| > 0.5M/dia → charm pressure moderada
  CEX_PANEL:       1.0,  // |CEX| > 1M/dia → "Pressão" no GEXPanel (UI threshold)

  // Skew (Risk Reversal 25-delta, em %)
  SKEW_NORMAL:    -2.5,  // RR25 < -2.5% → skew steep (puts caras, favorável)
  SKEW_FLAT:      -1.0,  // RR25 > -1.0% → skew flat (puts sem prêmio extra — VETO +2)
  SKEW_INVERTED:   0.0,  // RR25 > 0%    → skew invertido (calls mais caras — VETO +1 adicional)
} as const

export type GexThresholds = typeof GEX_THRESHOLDS
