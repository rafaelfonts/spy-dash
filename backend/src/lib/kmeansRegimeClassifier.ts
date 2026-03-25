/**
 * kmeansRegimeClassifier — rolling K-means (k=3) regime validation.
 *
 * Purpose: validate and cross-check the deterministic composite score (Phase 2).
 * When K-means disagrees with the rule-based label → "regime in transition" — the
 * highest-risk scenario for premium sellers (boundaries are where losses concentrate).
 *
 * Algorithm:
 *   1. Maintain a circular buffer of up to BUFFER_SIZE normalized feature vectors.
 *   2. Re-cluster every tick using k=3 with warm-start from previous centroids
 *      for temporal stability (prevents label flipping between ticks).
 *   3. Map cluster IDs to labels by sorting centroids on the VIX dimension:
 *      lowest VIX centroid → 'low', middle → 'medium', highest → 'high'.
 *   4. Assign the current tick's cluster to a label.
 *   5. Transition detected when K-means label ≠ rule-based tier.
 *
 * Feature vector (d=4, chosen for stability over PCR / IV Percentile):
 *   [0] vix_comp       — normalized VIX component (0–1)
 *   [1] term_slope_comp — normalized term structure slope component (0–1)
 *   [2] iv_rank_comp   — normalized IV Rank component (0–1)
 *   [3] gex_comp       — normalized GEX component (0–1)
 *
 * Performance: O(n×k×d) = 252×3×4 = 3,024 ops per iteration, 5–15 iterations.
 * Wall time: <5ms. Memory: <100KB.
 *
 * Buffer size = 252 = one year of trading days at 1 record/day, or ~4 hours
 * of market data at 1 record/minute. Fills gradually after server restart.
 */

import { kmeans } from 'ml-kmeans'
import type { CompositeRegimeComponents } from './compositeRegimeScorer'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const K           = 3          // Low / Medium / High regimes
const BUFFER_SIZE = 252        // circular buffer capacity
const DIM         = 4          // VIX, term_slope, iv_rank, gex
const MIN_POINTS  = 15         // minimum points before K-means runs (avoid degenerate results)

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type KMeansRegimeLabel = 'low' | 'medium' | 'high'

export interface KMeansRegimeResult {
  /** Regime label assigned to the current tick: 'low' | 'medium' | 'high'. */
  label: KMeansRegimeLabel
  /** Raw cluster ID (0–2) before label mapping. */
  clusterId: number
  /** K centroids sorted by VIX dimension (centroid[0] = lowest VIX → 'low'). */
  centroids: number[][]
  /** Number of points in each cluster: [low_count, medium_count, high_count]. */
  pointsPerCluster: [number, number, number]
  /** Number of points in the buffer at the time of clustering. */
  bufferSize: number
  /** Whether K-means converged within maxIterations. */
  converged: boolean
}

// ---------------------------------------------------------------------------
// Circular buffer state (module-level singleton)
// ---------------------------------------------------------------------------

interface BufferEntry {
  vector: [number, number, number, number]
  capturedAt: number  // epoch ms
}

let buffer: BufferEntry[] = []
let previousCentroids: number[][] | null = null

// ---------------------------------------------------------------------------
// Feature vector extraction
// ---------------------------------------------------------------------------

/**
 * Extracts a 4-D normalized feature vector from composite regime components.
 * Returns null if critical dimensions (VIX, IV Rank) are unavailable.
 */
export function extractFeatureVector(
  components: CompositeRegimeComponents,
): [number, number, number, number] | null {
  const vix      = components.vix
  const termSlope = components.termSlope
  const ivRank   = components.ivRank
  const gex      = components.gex

  // Require VIX and IV Rank for a meaningful vector
  if (vix == null || ivRank == null) return null

  return [
    vix      / 100,                       // [0] VIX component (0–1)
    (termSlope ?? 50) / 100,              // [1] Term slope (0–1, default=neutral)
    ivRank   / 100,                       // [2] IV Rank component (0–1)
    (gex     ?? 50) / 100,               // [3] GEX component (0–1)
  ]
}

// ---------------------------------------------------------------------------
// Buffer management
// ---------------------------------------------------------------------------

/**
 * Adds a new feature vector to the circular buffer.
 * Oldest entry is evicted when buffer reaches BUFFER_SIZE.
 */
export function addToBuffer(vector: [number, number, number, number]): void {
  buffer.push({ vector, capturedAt: Date.now() })
  if (buffer.length > BUFFER_SIZE) buffer.shift()
}

export function getBufferSize(): number {
  return buffer.length
}

export function clearBuffer(): void {
  buffer = []
  previousCentroids = null
}

// ---------------------------------------------------------------------------
// Label mapping — stable via VIX dimension ordering
// ---------------------------------------------------------------------------

/**
 * Maps raw K-means centroid array to ordered labels ['low','medium','high']
 * by sorting on the VIX dimension (index 0).
 *
 * Returns a mapping: centroidIndex → label
 * e.g. { 2: 'low', 0: 'medium', 1: 'high' }
 */
function buildLabelMap(centroids: number[][]): Map<number, KMeansRegimeLabel> {
  const indexed = centroids.map((c, i) => ({ i, vixComp: c[0] }))
  indexed.sort((a, b) => a.vixComp - b.vixComp)  // ascending VIX

  const map = new Map<number, KMeansRegimeLabel>()
  map.set(indexed[0].i, 'low')
  map.set(indexed[1].i, 'medium')
  map.set(indexed[2].i, 'high')
  return map
}

// ---------------------------------------------------------------------------
// Main K-means execution
// ---------------------------------------------------------------------------

/**
 * Runs K-means on the current buffer and returns the regime for the latest point.
 *
 * Returns null when:
 *  - Buffer has fewer than MIN_POINTS entries (not enough history)
 *  - Feature vectors are degenerate (all identical — K-means would fail)
 */
export function classifyCurrentRegime(): KMeansRegimeResult | null {
  if (buffer.length < MIN_POINTS) return null

  const data = buffer.map((e) => [...e.vector] as number[])

  // Warm-start: use previous centroids if available for temporal stability
  const initOption = previousCentroids != null
    ? previousCentroids
    : ('kmeans++' as const)

  let result
  try {
    result = kmeans(data, K, {
      initialization: initOption,
      maxIterations: 100,
      tolerance: 1e-6,
    })
  } catch {
    // Degenerate data (e.g. all points identical) — clear warm-start and retry
    previousCentroids = null
    try {
      result = kmeans(data, K, { initialization: 'kmeans++', maxIterations: 100 })
    } catch {
      return null
    }
  }

  // Store centroids for next tick's warm-start
  previousCentroids = result.centroids

  // Build label map from centroid VIX ordering
  const labelMap = buildLabelMap(result.centroids)

  // Current tick = last point in buffer
  const currentCluster = result.clusters[result.clusters.length - 1]
  const currentLabel   = labelMap.get(currentCluster) ?? 'medium'

  // Count points per cluster in label order
  const counts: [number, number, number] = [0, 0, 0]
  for (const clusterId of result.clusters) {
    const label = labelMap.get(clusterId)
    if (label === 'low')    counts[0]++
    if (label === 'medium') counts[1]++
    if (label === 'high')   counts[2]++
  }

  return {
    label:           currentLabel,
    clusterId:       currentCluster,
    centroids:       result.centroids,
    pointsPerCluster: counts,
    bufferSize:      buffer.length,
    converged:       result.converged,
  }
}

// ---------------------------------------------------------------------------
// Transition detection — compare K-means with rule-based composite score
// ---------------------------------------------------------------------------

/**
 * Maps composite score (0–100) to the same 3-tier scale as K-means labels.
 * LOW_VOL (<33) → 'low', NORMAL/ELEVATED (33–66) → 'medium', HIGH_VOL (>66) → 'high'
 *
 * Using equal-width thirds maps cleanly to K-means' 3 clusters.
 */
export function compositeScoreToTier(compositeScore: number): KMeansRegimeLabel {
  if (compositeScore < 33) return 'low'
  if (compositeScore < 67) return 'medium'
  return 'high'
}

/**
 * Returns true when K-means and rule-based composite disagree on regime tier.
 * This is the "regime in transition" signal — highest risk for premium sellers.
 */
export function isTransitionDetected(
  kmeansLabel: KMeansRegimeLabel,
  compositeScore: number,
): boolean {
  return kmeansLabel !== compositeScoreToTier(compositeScore)
}
