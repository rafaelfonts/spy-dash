/**
 * signalLogger — Persists scheduled signals and fills outcomes for backtesting.
 *
 * Flow:
 *  1. saveSignal()      — called by scheduledSignalService after each analysis run.
 *                          Inserts one row per slot into signal_outcomes.
 *  2. fillSignalOutcome() — called at 16:30 ET. Fetches SPY EOD from Tradier,
 *                           computes change%, hypothetical P&L, and updates outcome.
 *  3. startOutcomeFiller()  — setInterval scheduler that triggers fillSignalOutcome at 16:30 ET.
 */

import { createClient } from '@supabase/supabase-js'
import { marketState } from './marketState'
import { getTradierClient } from '../lib/tradierClient'
import type { AnalysisStructuredOutput } from '../types/market'

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SignalOutcomeRow {
  id: string
  signal_date: string
  slot: string
  trade_signal: string
  regime_score: number
  no_trade_score: number | null
  bias: string | null
  suggested_strategy: object | null
  key_levels: object | null
  no_trade_reasons: string[]
  spy_price_at_signal: number | null
  vix_at_signal: number | null
  ivr_at_signal: number | null
  gex_total_at_signal: number | null
  spy_close: number | null
  spy_change_pct: number | null
  put_spread_pnl: number | null
  outcome: 'profit' | 'loss' | 'neutral' | 'pending' | null
  created_at: string
}

export interface SignalMetrics {
  totalSignals: number
  tradedSignals: number          // trade_signal = 'trade'
  overallWinRate: number | null  // % of 'trade' signals that ended in 'profit'
  avoidAccuracy: number | null   // % of 'avoid' signals where SPY dropped ≥0.5%
  avgRegimeScore: number | null  // avg regime_score of 'trade' signals
  byRegimeBand: {
    high:   { count: number; winRate: number | null }  // regime 7–10
    medium: { count: number; winRate: number | null }  // regime 4–6
    low:    { count: number; winRate: number | null }  // regime 0–3
  }
  recentSignals: Array<Pick<SignalOutcomeRow,
    'signal_date' | 'slot' | 'trade_signal' | 'regime_score' |
    'spy_price_at_signal' | 'spy_close' | 'spy_change_pct' | 'outcome'>>
}

// ---------------------------------------------------------------------------
// ET time helpers
// ---------------------------------------------------------------------------

function getETNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
}

function getTodayDateET(): string {
  const et = getETNow()
  const y = et.getFullYear()
  const m = String(et.getMonth() + 1).padStart(2, '0')
  const d = String(et.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// ---------------------------------------------------------------------------
// 4.2a — Save a signal row immediately after analysis
// ---------------------------------------------------------------------------

/**
 * Inserts a new row in signal_outcomes when a scheduled analysis completes.
 * Captures all market context at signal time.
 * Uses upsert on (signal_date, slot) so a re-run replaces the previous result.
 *
 * @param structured  AnalysisStructuredOutput from the AI analysis
 * @param slot        '10:30' | '15:00'
 * @param noTradeScore  aggregated veto weight from computeNoTradeScore()
 * @param gexTotal    total net GEX in $M
 */
export async function saveSignal(
  structured: AnalysisStructuredOutput,
  slot: string,
  noTradeScore: number | null = null,
  gexTotal: number | null = null,
): Promise<string | null> {
  const today = getTodayDateET()
  const spy = marketState.spy.last ?? null
  const vix = marketState.vix.last ?? null
  const ivr = marketState.ivRank.value ?? null

  const row = {
    signal_date:          today,
    slot,
    trade_signal:         structured.trade_signal,
    regime_score:         structured.regime_score,
    no_trade_score:       noTradeScore,
    bias:                 structured.bias,
    suggested_strategy:   structured.suggested_strategy ?? null,
    key_levels:           structured.key_levels ?? null,
    no_trade_reasons:     structured.no_trade_reasons ?? [],
    spy_price_at_signal:  spy,
    vix_at_signal:        vix,
    ivr_at_signal:        ivr,
    gex_total_at_signal:  gexTotal,
    outcome:              'pending',
  }

  try {
    const { data, error } = await supabase
      .from('signal_outcomes')
      .upsert(row, { onConflict: 'signal_date,slot' })
      .select('id')
      .single()

    if (error) {
      console.error('[SignalLogger] saveSignal error:', error.message)
      return null
    }
    console.log(`[SignalLogger] Signal saved: ${today}/${slot} trade_signal=${structured.trade_signal} id=${data?.id}`)
    return data?.id ?? null
  } catch (err) {
    console.error('[SignalLogger] saveSignal exception:', (err as Error).message)
    return null
  }
}

// ---------------------------------------------------------------------------
// 4.2b — Fill outcome at 16:30 ET
// ---------------------------------------------------------------------------

/**
 * Determines the outcome of a 'trade' signal:
 *   profit  — SPY closed above short_strike (or ≥ signal_price − 0.5% when no strike info)
 *   loss    — SPY dropped more than 0.5% from signal price
 *   neutral — trade_signal was 'wait'; we record P&L but outcome is informational only
 *
 * For 'avoid' signals:
 *   profit  — SPY dropped ≥ 0.5% (correct avoidance)
 *   loss    — SPY rose ≥ 1.5% (missed a good day)
 *   neutral — move within ±0.5%
 */
function determineOutcome(
  tradeSignal: string,
  spyAtSignal: number,
  spyClose: number,
  shortStrike: number | null,
): 'profit' | 'loss' | 'neutral' {
  const changePct = ((spyClose - spyAtSignal) / spyAtSignal) * 100

  if (tradeSignal === 'trade') {
    // Short put spread: profit when SPY stays above short strike (or stays flat)
    if (shortStrike != null) {
      return spyClose > shortStrike ? 'profit' : 'loss'
    }
    // Fallback when no strike data: profit if SPY ≥ -0.5% from signal
    return changePct >= -0.5 ? 'profit' : 'loss'
  }

  if (tradeSignal === 'avoid') {
    if (changePct <= -0.5) return 'profit'   // correctly avoided a down day
    if (changePct >= 1.5) return 'loss'      // missed a strong bull day (incorrect avoid)
    return 'neutral'
  }

  // 'wait' — informational
  return 'neutral'
}

/**
 * Computes hypothetical P&L for a short put spread.
 * Returns $ per contract (100 shares). Positive = profit, negative = loss.
 * Returns null when insufficient data.
 */
function computeHypoPnL(
  strategy: { legs?: Array<{ type: string; action: string; strike: number }> } | null,
  spyAtSignal: number,
  spyClose: number,
  expectedCredit: number | null,
): number | null {
  if (!strategy?.legs || !expectedCredit || expectedCredit <= 0) return null

  const shortPut = strategy.legs.find((l) => l.type === 'put' && l.action === 'sell')
  const longPut  = strategy.legs.find((l) => l.type === 'put' && l.action === 'buy')

  if (!shortPut || !longPut) return null

  const spread  = shortPut.strike - longPut.strike
  const maxRisk = (spread - expectedCredit) * 100  // $ per contract

  if (spyClose >= shortPut.strike) {
    // Expired worthless — keep full credit
    return expectedCredit * 100
  }
  if (spyClose <= longPut.strike) {
    // Max loss
    return -maxRisk
  }
  // Partial: linear interpolation between strikes
  const intrinsic = shortPut.strike - spyClose
  const pnl = (expectedCredit - intrinsic) * 100
  return Math.max(pnl, -maxRisk)
}

/**
 * Fills outcome for all 'pending' signals from today.
 * Called at 16:30 ET by startOutcomeFiller().
 * Fetches SPY close from Tradier, then updates each pending row.
 */
export async function fillSignalOutcome(): Promise<void> {
  const today = getTodayDateET()
  console.log(`[SignalLogger] fillSignalOutcome for ${today}...`)

  // Fetch SPY close from Tradier
  let spyClose: number | null = null
  try {
    const quotes = await getTradierClient().getQuotes(['SPY'])
    const spy = quotes?.[0]
    spyClose = spy?.last ?? null
  } catch (err) {
    console.warn('[SignalLogger] Could not fetch SPY close:', (err as Error).message)
  }

  if (!spyClose) {
    console.warn('[SignalLogger] No SPY close — skipping outcome fill')
    return
  }

  // Fetch all pending rows for today
  const { data: rows, error } = await supabase
    .from('signal_outcomes')
    .select('*')
    .eq('signal_date', today)
    .eq('outcome', 'pending')

  if (error) {
    console.error('[SignalLogger] fetchPending error:', error.message)
    return
  }
  if (!rows || rows.length === 0) {
    console.log('[SignalLogger] No pending rows for today')
    return
  }

  for (const row of rows as SignalOutcomeRow[]) {
    const spyAtSignal = row.spy_price_at_signal
    if (!spyAtSignal) continue

    const changePct = ((spyClose - spyAtSignal) / spyAtSignal) * 100

    const strategy = row.suggested_strategy as {
      legs?: Array<{ type: string; action: string; strike: number }>
      expected_credit?: number
    } | null

    const shortStrike = strategy?.legs?.find((l) => l.type === 'put' && l.action === 'sell')?.strike ?? null
    const expectedCredit = (row.suggested_strategy as { expected_credit?: number } | null)?.expected_credit ?? null

    const outcome = determineOutcome(row.trade_signal, spyAtSignal, spyClose, shortStrike)
    const pnl = row.trade_signal === 'trade'
      ? computeHypoPnL(strategy, spyAtSignal, spyClose, expectedCredit)
      : null

    const { error: updateErr } = await supabase
      .from('signal_outcomes')
      .update({
        spy_close: spyClose,
        spy_change_pct: parseFloat(changePct.toFixed(3)),
        put_spread_pnl: pnl != null ? parseFloat(pnl.toFixed(2)) : null,
        outcome,
      })
      .eq('id', row.id)

    if (updateErr) {
      console.error(`[SignalLogger] update ${row.id} error:`, updateErr.message)
    } else {
      console.log(`[SignalLogger] Outcome filled: ${row.signal_date}/${row.slot} → ${outcome} (SPY ${spyAtSignal.toFixed(2)}→${spyClose.toFixed(2)}, ${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}%)`)
    }
  }
}

// ---------------------------------------------------------------------------
// 4.2c — Compute metrics for /api/signal-metrics
// ---------------------------------------------------------------------------

function winRate(rows: SignalOutcomeRow[]): number | null {
  const decided = rows.filter((r) => r.outcome === 'profit' || r.outcome === 'loss')
  if (decided.length === 0) return null
  return decided.filter((r) => r.outcome === 'profit').length / decided.length
}

/**
 * Aggregates signal_outcomes into performance metrics.
 * Returns null when < 3 resolved signals exist.
 */
export async function computeSignalMetrics(days = 30): Promise<SignalMetrics | null> {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const { data: rows, error } = await supabase
    .from('signal_outcomes')
    .select('*')
    .gte('signal_date', cutoffStr)
    .order('signal_date', { ascending: false })

  if (error) {
    console.error('[SignalLogger] computeSignalMetrics error:', error.message)
    return null
  }
  if (!rows || rows.length < 3) return null

  const all = rows as SignalOutcomeRow[]
  const traded = all.filter((r) => r.trade_signal === 'trade')
  const avoided = all.filter((r) => r.trade_signal === 'avoid')

  // Regime bands
  const high   = traded.filter((r) => r.regime_score >= 7)
  const medium = traded.filter((r) => r.regime_score >= 4 && r.regime_score < 7)
  const low    = traded.filter((r) => r.regime_score < 4)

  // Avoid accuracy: outcome = 'profit' means SPY dropped (correct avoid)
  const avoidResolved = avoided.filter((r) => r.outcome === 'profit' || r.outcome === 'loss')
  const avoidAcc = avoidResolved.length >= 2
    ? avoidResolved.filter((r) => r.outcome === 'profit').length / avoidResolved.length
    : null

  const avgRegime = traded.length > 0
    ? traded.reduce((s, r) => s + r.regime_score, 0) / traded.length
    : null

  const recent = all.slice(0, 10).map((r) => ({
    signal_date:         r.signal_date,
    slot:                r.slot,
    trade_signal:        r.trade_signal,
    regime_score:        r.regime_score,
    spy_price_at_signal: r.spy_price_at_signal,
    spy_close:           r.spy_close,
    spy_change_pct:      r.spy_change_pct,
    outcome:             r.outcome,
  }))

  return {
    totalSignals:   all.length,
    tradedSignals:  traded.length,
    overallWinRate: winRate(traded),
    avoidAccuracy:  avoidAcc,
    avgRegimeScore: avgRegime != null ? parseFloat(avgRegime.toFixed(1)) : null,
    byRegimeBand: {
      high:   { count: high.length,   winRate: winRate(high) },
      medium: { count: medium.length, winRate: winRate(medium) },
      low:    { count: low.length,    winRate: winRate(low) },
    },
    recentSignals: recent,
  }
}

// ---------------------------------------------------------------------------
// 5.3 — OLS calibration of regime score weights
// ---------------------------------------------------------------------------

export interface CalibrationResult {
  n: number
  regimeScoreCoeff: number        // β₁ — positive = predictive
  regimeScoreTStat: number        // |t| > 1.96 → significant at 95%
  r2: number                      // 0–1 model fit quality
  interpretation: string
  suggestedAdjustment: {
    direction: 'increase_threshold' | 'decrease_threshold' | 'ok'
    reason: string
  }
}

/** Multiply matrix A (m×k) by B (k×n) — returns m×n result. */
function matMul(A: number[][], B: number[][]): number[][] {
  const m = A.length, k = A[0].length, n = B[0].length
  const C = Array.from({ length: m }, () => new Array<number>(n).fill(0))
  for (let i = 0; i < m; i++)
    for (let j = 0; j < n; j++)
      for (let l = 0; l < k; l++)
        C[i][j] += A[i][l] * B[l][j]
  return C
}

/** Invert a square matrix via Gauss–Jordan elimination (partial pivoting). Returns null if singular. */
function matInv(M: number[][]): number[][] | null {
  const n = M.length
  // Augmented [M | I]
  const A = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))])
  for (let col = 0; col < n; col++) {
    // Partial pivot
    let maxRow = col
    for (let row = col + 1; row < n; row++)
      if (Math.abs(A[row][col]) > Math.abs(A[maxRow][col])) maxRow = row
    ;[A[col], A[maxRow]] = [A[maxRow], A[col]]
    if (Math.abs(A[col][col]) < 1e-12) return null  // singular
    const pivot = A[col][col]
    for (let j = 0; j < 2 * n; j++) A[col][j] /= pivot
    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const factor = A[row][col]
      for (let j = 0; j < 2 * n; j++) A[row][j] -= factor * A[col][j]
    }
  }
  return A.map((row) => row.slice(n))
}

/**
 * OLS calibration of regime score weights.
 * Returns null when < 30 resolved signals (profit or loss) are available.
 *
 * Model: P(profit) ≈ β₀ + β₁·regime_score + β₂·vix + β₃·ivr + β₄·gex_total
 *        where Y=1 (profit) or Y=0 (loss), trade_signal = 'trade' only.
 */
export async function calibrateRegimeWeights(): Promise<CalibrationResult | null> {
  const { data: rows, error } = await supabase
    .from('signal_outcomes')
    .select('regime_score,vix_at_signal,ivr_at_signal,gex_total_at_signal,outcome')
    .eq('trade_signal', 'trade')
    .in('outcome', ['profit', 'loss'])

  if (error) {
    console.error('[SignalLogger] calibrateRegimeWeights error:', error.message)
    return null
  }
  if (!rows || rows.length < 30) return null

  const valid = (rows as Array<{
    regime_score: number
    vix_at_signal: number | null
    ivr_at_signal: number | null
    gex_total_at_signal: number | null
    outcome: string
  }>).filter((r) =>
    r.regime_score != null &&
    r.vix_at_signal != null &&
    r.ivr_at_signal != null &&
    r.gex_total_at_signal != null,
  )

  if (valid.length < 30) return null

  const n = valid.length
  const k = 5  // intercept + 4 regressors

  // Build X (n×k) and y (n×1)
  const X: number[][] = valid.map((r) => [
    1,
    r.regime_score,
    r.vix_at_signal!,
    r.ivr_at_signal!,
    r.gex_total_at_signal!,
  ])
  const yVec: number[] = valid.map((r) => (r.outcome === 'profit' ? 1 : 0))

  // β = (X'X)⁻¹ X'y
  const Xt = X[0].map((_, j) => X.map((row) => row[j]))  // k×n transpose
  const XtX = matMul(Xt, X)  // k×k
  const inv = matInv(XtX)
  if (!inv) return null

  const yMat = yVec.map((v) => [v])      // n×1
  const Xty = matMul(Xt, yMat)           // k×1
  const beta = matMul(inv, Xty).map((r) => r[0])  // k

  // Residuals and R²
  const yHat = X.map((row) => row.reduce((s, x, j) => s + x * beta[j], 0))
  const yMean = yVec.reduce((s, v) => s + v, 0) / n
  const ssRes = yVec.reduce((s, y, i) => s + (y - yHat[i]) ** 2, 0)
  const ssTot = yVec.reduce((s, y) => s + (y - yMean) ** 2, 0)
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0

  // t-stat for β[1] (regime_score)
  const sigma2 = ssRes / Math.max(n - k, 1)
  const se1 = Math.sqrt(sigma2 * inv[1][1])
  const tStat = se1 > 0 ? beta[1] / se1 : 0

  const coeff = parseFloat(beta[1].toFixed(4))
  const tRound = parseFloat(tStat.toFixed(2))
  const r2Round = parseFloat(r2.toFixed(3))

  const significant = Math.abs(tStat) >= 1.96
  const predictive = coeff > 0.01

  const interpretation = significant && predictive
    ? `Regime score é preditivo (t=${tRound}, p<0.05) — pesos atuais validados empiricamente (n=${n})`
    : significant && !predictive
      ? `Regime score tem efeito negativo (t=${tRound}) — verificar lógica de veto (n=${n})`
      : `Regime score não significativo (t=${tRound}, p>0.05) — dados insuficientes ou pesos a calibrar (n=${n})`

  let direction: CalibrationResult['suggestedAdjustment']['direction'] = 'ok'
  let reason = 'Pesos atuais são preditivos — nenhum ajuste necessário.'
  if (!significant || coeff < 0.01) {
    direction = 'increase_threshold'
    reason = 'Considere elevar o limiar mínimo de regime_score para sinalizar trade (ex: ≥8 em vez de ≥7).'
  } else if (coeff > 0.15 && tRound > 2.5) {
    direction = 'decrease_threshold'
    reason = 'Regime score tem forte poder preditivo — pode-se considerar limiar levemente mais baixo (ex: ≥6).'
  }

  return { n, regimeScoreCoeff: coeff, regimeScoreTStat: tRound, r2: r2Round, interpretation, suggestedAdjustment: { direction, reason } }
}

// ---------------------------------------------------------------------------
// 4.2d — Outcome filler scheduler (16:30 ET)
// ---------------------------------------------------------------------------

let fillerStarted = false

/**
 * Starts the EOD outcome filler.
 * Checks once per minute if it's 16:30 ET on a weekday.
 * Runs fillSignalOutcome() once per day (guard via `filled` flag).
 */
export function startOutcomeFiller(): void {
  if (fillerStarted) return
  fillerStarted = true

  let lastFilledDate = ''

  setInterval(async () => {
    const et = getETNow()
    const dow = et.getDay()
    if (dow === 0 || dow === 6) return  // skip weekends

    const h = et.getHours()
    const m = et.getMinutes()
    const today = getTodayDateET()

    // Run at 16:30 ET once per day
    if (h === 16 && m === 30 && lastFilledDate !== today) {
      lastFilledDate = today
      fillSignalOutcome().catch((err) =>
        console.error('[SignalLogger] fillSignalOutcome error:', err),
      )
    }
  }, 60_000)

  console.log('[SignalLogger] Outcome filler scheduler started (16:30 ET, dias úteis)')
}
