import { useState, useCallback } from 'react'
import { Modal } from '../ui/Modal'
import type { CreatePositionBody } from '../../hooks/usePortfolio'

export type StrategyType = 'PUT_SPREAD' | 'CALL_SPREAD' | 'IRON_CONDOR'

/** Build OCC option symbol (Tradier): SYMBOL + YYMMDD + P|C + strike*1000 padded 8 digits */
function buildOccSymbol(
  symbol: string,
  expirationDate: string,
  strike: number,
  putOrCall: 'P' | 'C',
): string {
  const s = symbol.trim().toUpperCase()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expirationDate)) return ''
  const [y, m, d] = expirationDate.split('-')
  const yy = y!.slice(2)
  const mm = m!
  const dd = d!
  const strikePart = String(Math.round(strike * 1000)).padStart(8, '0')
  return `${s}${yy}${mm}${dd}${putOrCall}${strikePart}`
}

const today = () => new Date().toISOString().slice(0, 10)

const STRATEGY_LABELS: Record<StrategyType, string> = {
  PUT_SPREAD: 'Put Spread',
  CALL_SPREAD: 'Call Spread',
  IRON_CONDOR: 'Iron Condor',
}

interface AddPositionModalProps {
  open: boolean
  onClose: () => void
  onSubmit: (body: CreatePositionBody) => Promise<{ ok: boolean; error?: string }>
  onSuccess: () => void
}

export function AddPositionModal({ open, onClose, onSubmit, onSuccess }: AddPositionModalProps) {
  const [strategyType, setStrategyType] = useState<StrategyType>('PUT_SPREAD')
  const [symbol, setSymbol] = useState('SPY')
  const [openDate, setOpenDate] = useState(today())
  const [expirationDate, setExpirationDate] = useState('')
  // 2-leg
  const [shortStrike, setShortStrike] = useState<number | ''>('')
  const [longStrike, setLongStrike] = useState<number | ''>('')
  const [shortOptionSymbol, setShortOptionSymbol] = useState('')
  const [longOptionSymbol, setLongOptionSymbol] = useState('')
  // Iron Condor
  const [putShortStrike, setPutShortStrike] = useState<number | ''>('')
  const [putLongStrike, setPutLongStrike] = useState<number | ''>('')
  const [putShortOptionSymbol, setPutShortOptionSymbol] = useState('')
  const [putLongOptionSymbol, setPutLongOptionSymbol] = useState('')
  const [callShortStrike, setCallShortStrike] = useState<number | ''>('')
  const [callLongStrike, setCallLongStrike] = useState<number | ''>('')
  const [callShortOptionSymbol, setCallShortOptionSymbol] = useState('')
  const [callLongOptionSymbol, setCallLongOptionSymbol] = useState('')
  const [creditReceived, setCreditReceived] = useState<number | ''>('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const isTwoLeg = strategyType === 'PUT_SPREAD' || strategyType === 'CALL_SPREAD'
  const putOrCall: 'P' | 'C' = strategyType === 'CALL_SPREAD' ? 'C' : 'P'

  const handleGenerateSymbolsTwoLeg = useCallback(() => {
    if (!expirationDate || shortStrike === '' || longStrike === '') return
    setShortOptionSymbol(buildOccSymbol(symbol, expirationDate, Number(shortStrike), putOrCall))
    setLongOptionSymbol(buildOccSymbol(symbol, expirationDate, Number(longStrike), putOrCall))
  }, [symbol, expirationDate, shortStrike, longStrike, putOrCall])

  const handleGeneratePutSymbols = useCallback(() => {
    if (!expirationDate || putShortStrike === '' || putLongStrike === '') return
    setPutShortOptionSymbol(buildOccSymbol(symbol, expirationDate, Number(putShortStrike), 'P'))
    setPutLongOptionSymbol(buildOccSymbol(symbol, expirationDate, Number(putLongStrike), 'P'))
  }, [symbol, expirationDate, putShortStrike, putLongStrike])

  const handleGenerateCallSymbols = useCallback(() => {
    if (!expirationDate || callShortStrike === '' || callLongStrike === '') return
    setCallShortOptionSymbol(buildOccSymbol(symbol, expirationDate, Number(callShortStrike), 'C'))
    setCallLongOptionSymbol(buildOccSymbol(symbol, expirationDate, Number(callLongStrike), 'C'))
  }, [symbol, expirationDate, callShortStrike, callLongStrike])

  const resetForm = useCallback(() => {
    setStrategyType('PUT_SPREAD')
    setSymbol('SPY')
    setOpenDate(today())
    setExpirationDate('')
    setShortStrike('')
    setLongStrike('')
    setShortOptionSymbol('')
    setLongOptionSymbol('')
    setPutShortStrike('')
    setPutLongStrike('')
    setPutShortOptionSymbol('')
    setPutLongOptionSymbol('')
    setCallShortStrike('')
    setCallLongStrike('')
    setCallShortOptionSymbol('')
    setCallLongOptionSymbol('')
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

      if (isTwoLeg) {
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
          strategy_type: strategyType,
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
        return
      }

      // Iron Condor
      if (
        expirationDate === '' ||
        putShortStrike === '' ||
        putLongStrike === '' ||
        putShortOptionSymbol === '' ||
        putLongOptionSymbol === '' ||
        callShortStrike === '' ||
        callLongStrike === '' ||
        callShortOptionSymbol === '' ||
        callLongOptionSymbol === '' ||
        creditReceived === ''
      ) {
        setSubmitError('Preencha todos os campos obrigatórios.')
        return
      }
      setSubmitting(true)
      const result = await onSubmit({
        symbol,
        strategy_type: 'IRON_CONDOR',
        open_date: openDate,
        expiration_date: expirationDate,
        put_short_strike: Number(putShortStrike),
        put_long_strike: Number(putLongStrike),
        put_short_option_symbol: putShortOptionSymbol,
        put_long_option_symbol: putLongOptionSymbol,
        call_short_strike: Number(callShortStrike),
        call_long_strike: Number(callLongStrike),
        call_short_option_symbol: callShortOptionSymbol,
        call_long_option_symbol: callLongOptionSymbol,
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
      isTwoLeg,
      strategyType,
      symbol,
      openDate,
      expirationDate,
      shortStrike,
      longStrike,
      shortOptionSymbol,
      longOptionSymbol,
      putShortStrike,
      putLongStrike,
      putShortOptionSymbol,
      putLongOptionSymbol,
      callShortStrike,
      callLongStrike,
      callShortOptionSymbol,
      callLongOptionSymbol,
      creditReceived,
      onSubmit,
      onSuccess,
      onClose,
      resetForm,
    ],
  )

  const title = `Nova posição — ${STRATEGY_LABELS[strategyType]}`

  return (
    <Modal open={open} onClose={handleClose} title={title}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="mb-1 block text-[10px] font-medium text-text-muted uppercase tracking-wider">
            Estratégia
          </label>
          <select
            value={strategyType}
            onChange={(e) => setStrategyType(e.target.value as StrategyType)}
            className="w-full rounded border border-border-subtle bg-bg-base px-2.5 py-1.5 text-sm text-text-primary"
          >
            <option value="PUT_SPREAD">{STRATEGY_LABELS.PUT_SPREAD}</option>
            <option value="CALL_SPREAD">{STRATEGY_LABELS.CALL_SPREAD}</option>
            <option value="IRON_CONDOR">{STRATEGY_LABELS.IRON_CONDOR}</option>
          </select>
        </div>

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

        {isTwoLeg ? (
          <>
            <p className="text-[10px] text-text-muted mb-2">
              Short = perna vendida (strike mais alto em put, mais baixo em call). Long = perna comprada.
            </p>
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
                onClick={handleGenerateSymbolsTwoLeg}
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
                    placeholder={strategyType === 'CALL_SPREAD' ? 'SPY240419C00570000' : 'SPY240419P00490000'}
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
                    placeholder={strategyType === 'CALL_SPREAD' ? 'SPY240419C00580000' : 'SPY240419P00480000'}
                  />
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            <p className="text-[10px] text-text-muted mb-2">
              Put: short (venda) strike mais alto, long (compra) mais baixo. Call: short mais baixo, long mais alto.
            </p>
            <div className="space-y-4">
              <div>
                <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Perna Put</span>
                <div className="grid grid-cols-2 gap-2 mt-1">
                  <div>
                    <label className="mb-0.5 block text-[10px] text-text-muted">Strike short *</label>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      value={putShortStrike === '' ? '' : putShortStrike}
                      onChange={(e) => setPutShortStrike(e.target.value === '' ? '' : Number(e.target.value))}
                      className="w-full rounded border border-border-subtle bg-bg-base px-2 py-1 text-sm text-text-primary"
                    />
                  </div>
                  <div>
                    <label className="mb-0.5 block text-[10px] text-text-muted">Strike long *</label>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      value={putLongStrike === '' ? '' : putLongStrike}
                      onChange={(e) => setPutLongStrike(e.target.value === '' ? '' : Number(e.target.value))}
                      className="w-full rounded border border-border-subtle bg-bg-base px-2 py-1 text-sm text-text-primary"
                    />
                  </div>
                </div>
                <div className="mt-1 space-y-1">
                  <input
                    type="text"
                    value={putShortOptionSymbol}
                    onChange={(e) => setPutShortOptionSymbol(e.target.value)}
                    placeholder="Símbolo put short"
                    className="w-full rounded border border-border-subtle bg-bg-base px-2 py-1 text-xs font-mono text-text-primary"
                  />
                  <input
                    type="text"
                    value={putLongOptionSymbol}
                    onChange={(e) => setPutLongOptionSymbol(e.target.value)}
                    placeholder="Símbolo put long"
                    className="w-full rounded border border-border-subtle bg-bg-base px-2 py-1 text-xs font-mono text-text-primary"
                  />
                </div>
                <button type="button" onClick={handleGeneratePutSymbols} className="mt-1 text-[10px] font-medium text-[#00ff88] hover:underline">
                  Gerar símbolos Put
                </button>
              </div>
              <div>
                <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Perna Call</span>
                <div className="grid grid-cols-2 gap-2 mt-1">
                  <div>
                    <label className="mb-0.5 block text-[10px] text-text-muted">Strike short *</label>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      value={callShortStrike === '' ? '' : callShortStrike}
                      onChange={(e) => setCallShortStrike(e.target.value === '' ? '' : Number(e.target.value))}
                      className="w-full rounded border border-border-subtle bg-bg-base px-2 py-1 text-sm text-text-primary"
                    />
                  </div>
                  <div>
                    <label className="mb-0.5 block text-[10px] text-text-muted">Strike long *</label>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      value={callLongStrike === '' ? '' : callLongStrike}
                      onChange={(e) => setCallLongStrike(e.target.value === '' ? '' : Number(e.target.value))}
                      className="w-full rounded border border-border-subtle bg-bg-base px-2 py-1 text-sm text-text-primary"
                    />
                  </div>
                </div>
                <div className="mt-1 space-y-1">
                  <input
                    type="text"
                    value={callShortOptionSymbol}
                    onChange={(e) => setCallShortOptionSymbol(e.target.value)}
                    placeholder="Símbolo call short"
                    className="w-full rounded border border-border-subtle bg-bg-base px-2 py-1 text-xs font-mono text-text-primary"
                  />
                  <input
                    type="text"
                    value={callLongOptionSymbol}
                    onChange={(e) => setCallLongOptionSymbol(e.target.value)}
                    placeholder="Símbolo call long"
                    className="w-full rounded border border-border-subtle bg-bg-base px-2 py-1 text-xs font-mono text-text-primary"
                  />
                </div>
                <button type="button" onClick={handleGenerateCallSymbols} className="mt-1 text-[10px] font-medium text-[#00ff88] hover:underline">
                  Gerar símbolos Call
                </button>
              </div>
            </div>
          </>
        )}

        <div>
          <label className="mb-1 block text-[10px] font-medium text-text-muted uppercase tracking-wider">
            {strategyType === 'IRON_CONDOR' ? 'Crédito recebido total (prêmio × 100) *' : 'Crédito recebido (prêmio × 100) *'}
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
