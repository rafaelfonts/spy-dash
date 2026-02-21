import { useState, useEffect } from 'react'

function checkMarketOpen(): boolean {
  const now = new Date()
  const day = now.getDay() // 0=Sun, 6=Sat

  if (day === 0 || day === 6) return false

  // Convert to ET (UTC-5 or UTC-4 during DST)
  const utcOffset = now.getTimezoneOffset()
  const etOffset = isDST(now) ? -4 * 60 : -5 * 60
  const etMinutes =
    now.getHours() * 60 + now.getMinutes() + (utcOffset - Math.abs(etOffset)) * (etOffset < 0 ? -1 : 1)

  // Simpler: compute ET time directly
  const utcMs = now.getTime() + utcOffset * 60 * 1000
  const etMs = utcMs + etOffset * 60 * 1000
  const et = new Date(etMs)
  const etMins = et.getHours() * 60 + et.getMinutes()

  // NYSE: 9:30 AM – 4:00 PM ET
  return etMins >= 9 * 60 + 30 && etMins < 16 * 60
}

function isDST(date: Date): boolean {
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset()
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset()
  return Math.max(jan, jul) !== date.getTimezoneOffset()
}

export function useMarketOpen(): boolean {
  const [isOpen, setIsOpen] = useState(checkMarketOpen)

  useEffect(() => {
    const interval = setInterval(() => {
      setIsOpen(checkMarketOpen())
    }, 60_000) // re-check every minute

    return () => clearInterval(interval)
  }, [])

  return isOpen
}
