import { setTimeout as sleep } from 'node:timers/promises'
import type { Sec8KEvent, Sec13FPositionSummary, SecFilingBase } from '../types/market'

const SEC_BASE = 'https://data.sec.gov'
const USER_AGENT = 'SPYDash/1.0 (https://spy-dash-frontend.vercel.app)'

// Cache em memória (TTL ~15min)
const CACHE_TTL_MS = 15 * 60 * 1000
interface CacheEntry<T> {
  data: T
  expiresAt: number
}
const cache = new Map<string, CacheEntry<unknown>>()

// Throttling simples: no máximo N requisições/segundo
const MAX_REQ_PER_SECOND = 5
let currentWindowStart = 0
let requestsThisWindow = 0

async function throttledFetch(input: string | URL): Promise<Response> {
  const now = Date.now()
  if (now - currentWindowStart > 1000) {
    currentWindowStart = now
    requestsThisWindow = 0
  }
  if (requestsThisWindow >= MAX_REQ_PER_SECOND) {
    const waitMs = 1000 - (now - currentWindowStart)
    if (waitMs > 0) await sleep(waitMs)
    currentWindowStart = Date.now()
    requestsThisWindow = 0
  }
  requestsThisWindow += 1

  return fetch(input.toString(), {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
  })
}

function getFromCache<T>(key: string): T | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    cache.delete(key)
    return null
  }
  return entry.data
}

function setCache<T>(key: string, value: T): void {
  cache.set(key, { data: value, expiresAt: Date.now() + CACHE_TTL_MS })
}

// ---------------------------------------------------------------------------
// CIKs de interesse — pequena lista fixa para manter o serviço simples
// ---------------------------------------------------------------------------

// Alguns componentes grandes de SPY (CIKs zero-padded)
const SPY_COMPONENT_CIKS: { cik: string; symbol: string }[] = [
  { cik: '0000320193', symbol: 'AAPL' },
  { cik: '0000789019', symbol: 'MSFT' },
  { cik: '0001018724', symbol: 'AMZN' },
]

// Alguns fundos/ETFs macro relevantes para SPY
const SPY_FUND_CIKS: { cik: string; managerName: string }[] = [
  { cik: '0000884394', managerName: 'SPDR S&P 500 ETF Trust' }, // SPY
]

// ---------------------------------------------------------------------------
// Helpers de parsing
// ---------------------------------------------------------------------------

interface SecSubmissions {
  filings?: {
    recent?: {
      accessionNumber?: string[]
      filingDate?: string[]
      form?: string[]
      primaryDocDescription?: string[]
    }
  }
  tickers?: string[]
  name?: string
}

async function fetchSubmissions(cik: string): Promise<SecSubmissions | null> {
  const padded = cik.padStart(10, '0')
  const url = `${SEC_BASE}/submissions/CIK${padded}.json`
  const res = await throttledFetch(url)
  if (!res.ok) {
    const text = await res.text()
    console.warn(`[secEdgarService] CIK ${cik} HTTP ${res.status}: ${text.slice(0, 120)}`)
    return null
  }
  return (await res.json()) as SecSubmissions
}

function buildBaseFromSubmissions(
  cik: string,
  symbol: string | undefined,
  idx: number,
  sub: SecSubmissions,
): SecFilingBase | null {
  const recent = sub.filings?.recent
  if (!recent) return null
  const form = recent.form?.[idx]
  const filedAt = recent.filingDate?.[idx]
  const accession = recent.accessionNumber?.[idx]
  if (!form || !filedAt || !accession) return null
  const title = recent.primaryDocDescription?.[idx]
  return {
    cik: cik.padStart(10, '0'),
    symbol,
    formType: form,
    filedAt: new Date(filedAt).toISOString(),
    accession,
    title: title && title !== '' ? title : undefined,
  }
}

// ---------------------------------------------------------------------------
// 8-K para componentes SPY
// ---------------------------------------------------------------------------

export async function fetchRecent8KForSPYComponents(limit: number): Promise<Sec8KEvent[]> {
  const cacheKey = `sec_8k_components_${limit}`
  const cached = getFromCache<Sec8KEvent[]>(cacheKey)
  if (cached) return cached

  const results: Sec8KEvent[] = []

  for (const { cik, symbol } of SPY_COMPONENT_CIKS) {
    const sub = await fetchSubmissions(cik)
    if (!sub?.filings?.recent) continue
    const recent = sub.filings.recent
    const forms = recent.form ?? []
    for (let i = 0; i < forms.length && results.length < limit; i++) {
      if (forms[i] !== '8-K') continue
      const base = buildBaseFromSubmissions(cik, symbol, i, sub)
      if (!base) continue
      const event: Sec8KEvent = {
        ...base,
        itemNumbers: undefined,
        isEarningsRelated: base.title?.toLowerCase().includes('earnings') ?? false,
        isGuidanceRelated:
          base.title?.toLowerCase().includes('guidance') ||
          base.title?.toLowerCase().includes('outlook') ||
          false,
      }
      results.push(event)
    }
  }

  // Ordenar por filedAt desc e cortar
  results.sort((a, b) => (a.filedAt < b.filedAt ? 1 : -1))
  const final = results.slice(0, limit)
  setCache(cacheKey, final)
  return final
}

// ---------------------------------------------------------------------------
// 13F para fundos selecionados
// ---------------------------------------------------------------------------

export async function fetchRecent13FForSelectedFunds(
  limit: number,
): Promise<Sec13FPositionSummary[]> {
  const cacheKey = `sec_13f_funds_${limit}`
  const cached = getFromCache<Sec13FPositionSummary[]>(cacheKey)
  if (cached) return cached

  const results: Sec13FPositionSummary[] = []

  for (const { cik, managerName } of SPY_FUND_CIKS) {
    const sub = await fetchSubmissions(cik)
    if (!sub?.filings?.recent) continue
    const recent = sub.filings.recent
    const forms = recent.form ?? []
    for (let i = 0; i < forms.length && results.length < limit; i++) {
      if (!forms[i]?.startsWith('13F')) continue
      const filedAt = recent.filingDate?.[i]
      if (!filedAt) continue
      const summary: Sec13FPositionSummary = {
        managerName,
        cik: cik.padStart(10, '0'),
        reportDate: filedAt,
        spyExposureUsd: null,
        spyShares: null,
        changeVsPrev: undefined,
      }
      results.push(summary)
    }
  }

  results.sort((a, b) => (a.reportDate < b.reportDate ? 1 : -1))
  const final = results.slice(0, limit)
  setCache(cacheKey, final)
  return final
}

