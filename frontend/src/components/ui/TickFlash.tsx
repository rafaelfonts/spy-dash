import { useEffect, useRef, useState, type ReactNode } from 'react'

interface TickFlashProps {
  value: number | null
  children: ReactNode
  className?: string
}

export function TickFlash({ value, children, className = '' }: TickFlashProps) {
  const prevRef = useRef<number | null>(null)
  const [flashClass, setFlashClass] = useState('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (value === null) return
    if (prevRef.current === null) {
      prevRef.current = value
      return
    }

    if (value !== prevRef.current) {
      const cls = value > prevRef.current ? 'tick-up' : 'tick-down'
      setFlashClass(cls)

      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setFlashClass(''), 400)
    }

    prevRef.current = value
  }, [value])

  return (
    <span
      className={`inline-block rounded transition-colors duration-0 ${flashClass} ${className}`}
    >
      {children}
    </span>
  )
}
