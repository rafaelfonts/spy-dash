import { memo, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useMarketStore } from '../../store/marketStore'
import type { AlertToast } from '../../store/marketStore'

const LABEL: Record<string, string> = {
  support: 'Suporte',
  resistance: 'Resistência',
  gex_flip: 'GEX Flip',
}

function AlertToastItem({
  alert,
  onDismiss,
}: {
  alert: AlertToast
  onDismiss: (id: string) => void
}) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(alert.id), 8_000)
    return () => clearTimeout(t)
  }, [alert.id, onDismiss])

  const colorClass =
    alert.type === 'resistance'
      ? 'border-red-500/40 bg-red-500/10 text-red-400'
      : alert.type === 'gex_flip'
        ? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-400'
        : 'border-[#00ff88]/40 bg-[#00ff88]/10 text-[#00ff88]'

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 80 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 80 }}
      transition={{ duration: 0.25 }}
      className={`rounded border px-3 py-2 text-xs font-num w-56 shadow-lg cursor-pointer ${colorClass}`}
      onClick={() => onDismiss(alert.id)}
    >
      <div className="font-bold uppercase tracking-wide text-[10px] mb-0.5 opacity-80">
        {LABEL[alert.type]}{' '}
        {alert.alertType === 'testing' ? '— TESTANDO' : '— PRÓXIMO'}
      </div>
      <div>
        Nível:{' '}
        <span className="font-semibold">${alert.level.toFixed(2)}</span>
        {' · '}SPY:{' '}
        <span className="font-semibold">${alert.price.toFixed(2)}</span>
      </div>
    </motion.div>
  )
}

export const AlertOverlay = memo(function AlertOverlay() {
  const alerts = useMarketStore((s) => s.alerts)
  const dismissAlert = useMarketStore((s) => s.dismissAlert)

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      <AnimatePresence mode="popLayout">
        {alerts.map((alert) => (
          <div key={alert.id} className="pointer-events-auto">
            <AlertToastItem alert={alert} onDismiss={dismissAlert} />
          </div>
        ))}
      </AnimatePresence>
    </div>
  )
})
