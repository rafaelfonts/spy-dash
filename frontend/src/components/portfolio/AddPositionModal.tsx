import { useState, useCallback } from 'react'
import { Modal } from '../ui/Modal'
import type { CreatePositionBody } from '../../hooks/usePortfolio'

/** Build OCC option symbol (Tradier): SYMBOL + YYMMDD + P + strike*1000 padded 8 digits */
function buildOccSymbol(symbol: string, expirationDate: string, strike: number): string {
  const s = symbol.trim().toUpperCase()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expirationDate)) return ''
  const [y, m, d] = expirationDate.split('-')
  const yy = y!.slice(2)
  const mm = m!
  const dd = d!
  const strikePart = String(Math.round(strike * 1000)).padStart(8, '0')
  return `${s}${yy}${mm}${dd}P${strikePart}`
}

const today = () => new Date().toISOString().slice(0, 10)

interface AddPositionModalProps {
  open: boolean
  onClose: () => void
  onSubmit: (body: CreatePositionBody) => Promise<{ ok: boolean; error?: string }>
  onSuccess: () => void
}

export function AddPositionModal({ open, onClose, onSubmit, onSuccess }: AddPositionModalProps) {
  const [symbol, setSymbol] = useState('SPY')
  const [openDate, setOpenDate] = useState(today())
  const [expirationDate, setExpirationDate] = useState('')
  const [shortStrike, setShortStrike] = useState<number | ''>('')
  const [longStrike, setLongStrike] = useState<number | ''>('')
  const [shortOptionSymbol, setShortOptionSymbol] = useState('')
  const [longOptionSymbol, setLongOptionSymbol] = useState('')
  const [creditReceived, setCreditReceived] = useState<number | ''>('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleGenerateSymbols = useCallback(() => {
    if (!expirationDate || shortStrike === '' || longStrike === '') return
    setShortOptionSymbol(buildOccSymbol(symbol, expirationDate, Number(shortStrike)))
    setLongOptionSymbol(buildOccSymbol(symbol, expirationDate, Number(longStrike)))
  }, [symbol, expirationDate, shortStrike, longStrike])

  const resetForm = useCallback(() => {
    setSymbol('SPY')
    setOpenDate(today())
    setExpirationDate('')
    setShortStrike('')
    setLongStrike('')
    setShortOptionSymbol('')
    setLongOptionSymbol('')
    setCreditReceived('')
    setSubmitError(null)
  }, [])

  const handleClose = useCallback(() => {
    resetForm()
    onClose()
  }, [onClose, resetForm])

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setSubmitError(null)
      if (
        expirationDate === '' ||
        shortStrike === '' ||
        longStrike === '' ||
        shortOptionSymbol === '' ||
        longOptionSymbol === '' ||
        creditReceived === ''
      ) {
        setSubmitError('Preencha todos os campos obrigatórios.')
        return
      }
      setSubmitting(true)
      const result = await onSubmit({
        symbol,
        strategy_type: 'PUT_SPREAD',
        open_date: openDate,
        expiration_date: expirationDate,
        short_strike: Number(shortStrike),
        long_strike: Number(longStrike),
        short_option_symbol: shortOptionSymbol,
        long_option_symbol: longOptionSymbol,
        credit_received: Number(creditReceived),
      })
      setSubmitting(false)
      if (result.ok) {
        resetForm()
        onSuccess()
        onClose()
      } else {
        setSubmitError(result.error ?? 'Falha ao cadastrar')
      }
    },
    [
      symbol,
      openDate,
      expirationDate,
      shortStrike,
      longStrike,
      shortOptionSymbol,
      longOptionSymbol,
      creditReceived,
      onSubmit,
      onSuccess,
      onClose,
      resetForm,
    ],
  )

  return (
    <Modal open={open} onClose={handleClose} title="Nova posição — Put Spread">
      <form onSubmit={handleSubmit} className="space-y-3">
        <p className="text-[10px] text-text-muted mb-2">
          Short = perna vendida (strike mais alto). Long = perna comprada (strike mais baixo).
        </p>
        <div>
          <label className="mb-1 block text-[10px] font-medium text-text-muted uppercase tracking-wider">
            Símbolo
          </label>
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="w-full rounded border border-border-subtle bg-bg-base px-2.5 py-1.5 text-sm text-text-primary"
            placeholder="SPY"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="mb-1 block text-[10px] font-medium text-text-muted uppercase tracking-wider">
              Data abertura
            </label>
            <input
              type="date"
              value={openDate}
              onChange={(e) => setOpenDate(e.target.value)}
              className="w-full rounded border border-border-subtle bg-bg-base px-2.5 py-1.5 text-sm text-text-primary"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-medium text-text-muted uppercase tracking-wider">
              Data vencimento *
            </label>
            <input
              type="date"
              value={expirationDate}
              onChange={(e) => setExpirationDate(e.target.value)}
              className="w-full rounded border border-border-subtle bg-bg-base px-2.5 py-1.5 text-sm text-text-primary"
              required
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="mb-1 block text-[10px] font-medium text-text-muted uppercase tracking-wider">
              Strike short *
            </label>
            <input
              type="number"
              step="0.5"
              min="0"
              value={shortStrike === '' ? '' : shortStrike}
              onChange={(e) => setShortStrike(e.target.value === '' ? '' : Number(e.target.value))}
              className="w-full rounded border border-border-subtle bg-bg-base px-2.5 py-1.5 text-sm text-text-primary"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-medium text-text-muted uppercase tracking-wider">
              Strike long *
            </label>
            <input
              type="number"
              step="0.5"
              min="0"
              value={longStrike === '' ? '' : longStrike}
              onChange={(e) => setLongStrike(e.target.value === '' ? '' : Number(e.target.value))}
              className="w-full rounded border border-border-subtle bg-bg-base px-2.5 py-1.5 text-sm text-text-primary"
            />
          </div>
        </div>
        <div>
          <button
            type="button"
            onClick={handleGenerateSymbols}
            className="mb-2 text-xs font-medium text-[#00ff88] hover:underline"
          >
            Gerar símbolos OCC
          </button>
          <div className="space-y-2">
            <div>
              <label className="mb-1 block text-[10px] font-medium text-text-muted uppercase tracking-wider">
                Símbolo opção short *
              </label>
              <input
                type="text"
                value={shortOptionSymbol}
                onChange={(e) => setShortOptionSymbol(e.target.value)}
                className="w-full rounded border border-border-subtle bg-bg-base px-2.5 py-1.5 text-sm text-text-primary font-mono"
                placeholder="SPY240419P00490000"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium text-text-muted uppercase tracking-wider">
                Símbolo opção long *
              </label>
              <input
                type="text"
                value={longOptionSymbol}
                onChange={(e) => setLongOptionSymbol(e.target.value)}
                className="w-full rounded border border-border-subtle bg-bg-base px-2.5 py-1.5 text-sm text-text-primary font-mono"
                placeholder="SPY240419P00480000"
              />
            </div>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-medium text-text-muted uppercase tracking-wider">
            Crédito recebido (prêmio × 100) *
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={creditReceived === '' ? '' : creditReceived}
            onChange={(e) => setCreditReceived(e.target.value === '' ? '' : Number(e.target.value))}
            className="w-full rounded border border-border-subtle bg-bg-base px-2.5 py-1.5 text-sm text-text-primary"
            placeholder="250 (ex.: 2.50 por contrato)"
          />
        </div>
        {submitError && <p className="text-xs text-red-400">{submitError}</p>}
        <div className="flex gap-2 pt-2">
          <button
            type="submit"
            disabled={submitting}
            className="flex-1 rounded py-2 text-xs font-medium bg-[#00ff88]/10 border border-[#00ff88]/30 text-[#00ff88] hover:bg-[#00ff88]/20 disabled:opacity-50"
          >
            {submitting ? 'Salvando…' : 'Salvar'}
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="rounded py-2 px-3 text-xs font-medium bg-bg-elevated border border-border-subtle text-text-secondary hover:bg-border-subtle"
          >
            Cancelar
          </button>
        </div>
      </form>
    </Modal>
  )
}
