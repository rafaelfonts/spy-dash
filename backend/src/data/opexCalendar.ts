/**
 * opexCalendar — pure calendar arithmetic for monthly/weekly OPEX dates.
 *
 * No external API, no state, no timers. Call getOpexStatus() directly
 * wherever needed (e.g., openai.ts prompt builders).
 *
 * Monthly OPEX = 3rd Friday of each month (standard US equity options expiration).
 * Weekly OPEX  = every Friday (SPY has weekly expirations).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OpexStatus {
  /** Next monthly OPEX date (3rd Friday of current or next month). */
  nextMonthlyOpex: Date
  /** Calendar days to next monthly OPEX. 0 = today is OPEX. */
  daysToMonthlyOpex: number
  /** True if today is the 3rd Friday (monthly OPEX day). */
  isOpexDay: boolean
  /** True if today falls in the same Mon–Sun week as the next monthly OPEX. */
  isOpexWeek: boolean
  /** True if today is the Monday immediately following a monthly OPEX Friday. */
  isPostOpex: boolean
  /** Next weekly OPEX (any Friday), inclusive of today if Friday. */
  nextWeeklyOpex: Date
  /** Calendar days to next weekly OPEX. 0 = today is Friday. */
  daysToWeeklyOpex: number
  /** Human-readable label describing the current OPEX context. */
  opexLabel: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the 3rd Friday of the given month as a UTC midnight Date. */
function getMonthlyOpex(year: number, month: number): Date {
  // month is 0-indexed (0 = January)
  const firstDay = new Date(Date.UTC(year, month, 1))
  const firstDayOfWeek = firstDay.getUTCDay() // 0=Sun, 5=Fri
  const daysToFirstFriday = (5 - firstDayOfWeek + 7) % 7
  const thirdFriday = 1 + daysToFirstFriday + 14
  return new Date(Date.UTC(year, month, thirdFriday))
}

/** Returns UTC midnight timestamp for a Date (strips time component). */
function utcMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/** Format a Date as DD/MM/YYYY. */
function fmtDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const yyyy = d.getUTCFullYear()
  return `${dd}/${mm}/${yyyy}`
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function getOpexStatus(today?: Date): OpexStatus {
  const now = today ?? new Date()
  const todayTs = utcMidnight(now)
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()

  // --- Monthly OPEX ---
  const opexThisMonth = getMonthlyOpex(year, month)
  const opexNextMonth = getMonthlyOpex(month === 11 ? year + 1 : year, (month + 1) % 12)
  const opexPrevMonth = getMonthlyOpex(month === 0 ? year - 1 : year, (month - 1 + 12) % 12)

  const nextMonthlyOpex = todayTs <= opexThisMonth.getTime() ? opexThisMonth : opexNextMonth
  const daysToMonthlyOpex = Math.round((nextMonthlyOpex.getTime() - todayTs) / 86_400_000)

  const isOpexDay = daysToMonthlyOpex === 0

  // isOpexWeek: today is in the Mon–Sun week that contains nextMonthlyOpex
  // Find Monday of nextMonthlyOpex week (OPEX is always Friday = day 5)
  const mondayOfOpexWeekTs = nextMonthlyOpex.getTime() - 4 * 86_400_000 // Fri - 4 days = Mon
  const isOpexWeek = todayTs >= mondayOfOpexWeekTs && todayTs <= nextMonthlyOpex.getTime()

  // isPostOpex: today is the Monday (UTC day = 1) immediately after a monthly OPEX Friday
  // The Monday after OPEX Friday is exactly 3 days later (Fri→Sat→Sun→Mon)
  const dayOfWeek = now.getUTCDay() // 0=Sun, 1=Mon
  const prevFridayTs = todayTs - ((dayOfWeek === 0 ? 2 : dayOfWeek === 1 ? 3 : dayOfWeek - 5 + 7) * 86_400_000)
  // For Monday: prevFriday is 3 days ago
  const isPostOpex =
    dayOfWeek === 1 &&
    (prevFridayTs === opexThisMonth.getTime() || prevFridayTs === opexPrevMonth.getTime())

  // --- Weekly OPEX ---
  const dayOffset = (5 - now.getUTCDay() + 7) % 7 // days to next Friday, 0 if today is Friday
  const nextWeeklyOpex = new Date(todayTs + dayOffset * 86_400_000)
  const daysToWeeklyOpex = dayOffset

  // --- Label ---
  let opexLabel: string
  if (isPostOpex) {
    opexLabel = 'Pós-OPEX Mensal — GEX resetado'
  } else if (isOpexDay) {
    opexLabel = `OPEX Mensal hoje (${fmtDate(nextMonthlyOpex)})`
  } else if (isOpexWeek) {
    opexLabel = `Semana OPEX Mensal (${fmtDate(nextMonthlyOpex)}, em ${daysToMonthlyOpex} dia${daysToMonthlyOpex !== 1 ? 's' : ''})`
  } else {
    opexLabel = `Próximo OPEX Mensal: ${fmtDate(nextMonthlyOpex)} (em ${daysToMonthlyOpex} dias)`
  }

  return {
    nextMonthlyOpex,
    daysToMonthlyOpex,
    isOpexDay,
    isOpexWeek,
    isPostOpex,
    nextWeeklyOpex,
    daysToWeeklyOpex,
    opexLabel,
  }
}
