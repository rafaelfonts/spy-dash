import { memo, useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import { usePortfolio } from '../../hooks/usePortfolio'
import type { EnrichedPosition } from '../../hooks/usePortfolio'
import { Skeleton } from '../ui/Skeleton'
import { Modal } from '../ui/Modal'
import { AddPositionModal } from './AddPositionModal'

function PositionRow({
  p,
  onRequestDelete,
}: {
  p: EnrichedPosition
  onRequestDelete: (id: string, strategy: string) => void
}) {
  const hit50 = p.profit_percentage >= 50
  const hit21dte = p.dte_current <= 21
  const isProfit = p.profit_percentage >= 0
  const isNegative = p.profit_percentage < 0

  const profitColor = hit50
    ? 'text-[#00ff88]'
    : isNegative
      ? 'text-red-400'
      : 'text-yellow-400'

  // Progress bar: 0% → 50% target (clamp 0–100 for display)
  const barFill = Math.min(100, Math.max(0, (p.profit_percentage / 50) * 100))

  const plDollars = p.profit_loss_dollars
  const plSign = plDollars != null && plDollars >= 0 ? '+' : ''
  const plColor = plDollars != null && plDollars >= 0 ? 'text-[#00ff88]' : 'text-red-400'

  const handleClickExcluir = useCallback(() => {
    onRequestDelete(p.id, p.strategy)
  }, [p.id, p.strategy, onRequestDelete])

  return (
    <tr className="border-b border-border-subtle last:border-0">
      <td className="py-3 pr-3">
        <p className="text-text-primary font-medium text-sm">{p.strategy}</p>
        {p.comments && (
          <p
            className="text-[10px] text-text-muted mt-0.5 line-clamp-2"
            title={p.comments}
          >
            {p.comments}
          </p>
        )}
      </td>
      <td className="py-3 pr-3 text-right">
        <span className={`text-xs font-num ${hit21dte ? 'text-yellow-400' : 'text-text-secondary'}`}>
          {p.dte_current} DTE
        </span>
        {hit21dte && (
          <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-yellow-500/20 text-yellow-400 border border-yellow-500/40">
            ≤21
          </span>
        )}
      </td>
      <td className="py-3 pr-3 text-right min-w-[110px]">
        <div className="flex flex-col items-end gap-0.5">
          <span className={`text-base font-bold font-num ${profitColor}`}>
            {isProfit && !isNegative ? '+' : ''}{p.profit_percentage.toFixed(1)}%
          </span>
          {plDollars != null && (
            <span className={`text-[11px] font-num ${plColor}`}>
              {plSign}${Math.abs(plDollars).toFixed(2)}
            </span>
          )}
          <div className="w-24 h-1 rounded-full bg-bg-elevated overflow-hidden mt-0.5">
            <div
              className={`h-full rounded-full transition-all ${hit50 ? 'bg-[#00ff88]' : isNegative ? 'bg-red-500' : 'bg-yellow-400'}`}
              style={{ width: `${barFill}%` }}
            />
          </div>
          <span className="text-[9px] text-text-muted">Alvo: 50%</span>
        </div>
      </td>
      <td className="py-3 pr-3 text-right text-xs font-num text-text-muted hidden sm:table-cell">
        ${p.credit_received.toFixed(2)}
      </td>
      <td className="py-3 pr-3 text-right text-xs font-num text-text-muted hidden sm:table-cell">
        ${p.current_cost_to_close.toFixed(2)}
      </td>
      <td className="py-3 text-right">
        <button
          type="button"
          onClick={handleClickExcluir}
          className="text-[10px] font-medium text-red-400 hover:text-red-300"
        >
          Excluir
        </button>
      </td>
    </tr>
  )
}

export const PortfolioPanel = memo(function PortfolioPanel() {
  const {
    positions,
    capturedAt,
    loading,
    error,
    refresh,
    createPosition,
    deletePosition,
    analyze,
    alerts,
    analyzing,
    alertsStale,
  } = usePortfolio()
  const [modalOpen, setModalOpen] = useState(false)
  const [deleteConfirmId, setDeleteConfirmId] = useState<{ id: string; strategy: string } | null>(null)
  const [deleting, setDeleting] = useState(false)

  const handleCreateSuccess = useCallback(() => {
    refresh()
  }, [refresh])

  const handleRequestDelete = useCallback((id: string, strategy: string) => {
    setDeleteConfirmId({ id, strategy })
  }, [])

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteConfirmId) return
    setDeleting(true)
    const result = await deletePosition(deleteConfirmId.id)
    setDeleting(false)
    if (result.ok) {
      setDeleteConfirmId(null)
      refresh()
    }
  }, [deleteConfirmId, deletePosition, refresh])

  const isEmpty = !loading && positions.length === 0

  return (
    <motion.section
      className="card"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-display font-bold text-text-primary tracking-wide">
            Carteira
          </h2>
          {capturedAt && (
            <span className="text-[10px] text-text-muted">
              <span className="sm:hidden">
                {new Date(capturedAt).toLocaleString('pt-BR', { timeStyle: 'short', timeZone: 'America/New_York' })} ET
              </span>
              <span className="hidden sm:inline">
                {new Date(capturedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/New_York' })} ET
              </span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="px-4 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all duration-200 bg-bg-elevated border border-border-subtle text-text-secondary hover:bg-border-subtle hover:text-text-primary"
          >
            Cadastrar
          </button>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="px-4 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all duration-200 bg-bg-elevated border border-border-subtle text-text-secondary hover:bg-border-subtle hover:text-text-primary disabled:opacity-50"
          >
            Atualizar
          </button>
          <button
            type="button"
            onClick={analyze}
            disabled={analyzing || positions.length === 0}
            className="px-4 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all duration-200 bg-[#00ff88]/10 border border-[#00ff88]/30 text-[#00ff88] hover:bg-[#00ff88]/20 hover:border-[#00ff88]/50 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {analyzing ? 'Analisando…' : 'Analisar'}
          </button>
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-400 mb-3">{error}</p>
      )}

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="w-full h-10" />
          <Skeleton className="w-full h-10" />
          <Skeleton className="w-full h-10" />
        </div>
      ) : isEmpty ? (
        <p className="text-xs text-text-muted py-6 text-center">
          Nenhuma operação ativa no momento. Clique em <strong>Cadastrar</strong> para registrar uma nova posição.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-left min-w-[360px]">
              <thead>
                <tr className="text-[10px] text-text-muted uppercase tracking-wider border-b border-border-subtle">
                  <th className="pb-2 pr-3 font-medium">Estratégia / Tese</th>
                  <th className="pb-2 pr-3 text-right">DTE</th>
                  <th className="pb-2 pr-3 text-right">Lucro / P&L $</th>
                  <th className="pb-2 pr-3 text-right hidden sm:table-cell">Crédito</th>
                  <th className="pb-2 pr-3 text-right hidden sm:table-cell">Custo fechar</th>
                  <th className="pb-2 w-16 text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <PositionRow key={p.id} p={p} onRequestDelete={handleRequestDelete} />
                ))}
              </tbody>
            </table>
          </div>

          {alerts.length > 0 && (
            <div className="mt-4 pt-4 border-t border-border-subtle">
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-xs font-semibold text-text-primary">Recomendações (Gestor de Risco)</h3>
                {alertsStale && (
                  <span className="text-[10px] font-semibold text-yellow-400 border border-yellow-400/30 bg-yellow-500/5 px-1.5 py-0.5 rounded">
                    ⚠ Re-analise para atualizar
                  </span>
                )}
              </div>
              <ul className="space-y-2">
                {alerts.map((a, i) => (
                  <li
                    key={i}
                    className={`text-xs rounded px-2.5 py-2 border ${
                      a.recommendation === 'FECHAR_LUCRO'
                        ? 'bg-[#00ff88]/10 border-[#00ff88]/30 text-text-primary'
                        : 'bg-yellow-500/10 border-yellow-500/30 text-text-primary'
                    }`}
                  >
                    <span className="font-semibold text-[10px] uppercase tracking-wider mr-2">
                      {a.recommendation.replace('_', ' ')}
                    </span>
                    {a.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <AddPositionModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSubmit={createPosition}
        onSuccess={handleCreateSuccess}
      />

      <Modal
        open={!!deleteConfirmId}
        onClose={() => { if (!deleting) setDeleteConfirmId(null) }}
        title="Excluir posição"
      >
        <p className="text-sm text-text-primary mb-4">
          Confirmar exclusão de <strong>{deleteConfirmId?.strategy}</strong>?
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => { if (!deleting) setDeleteConfirmId(null) }}
            disabled={deleting}
            className="px-3 py-1.5 rounded text-xs font-medium bg-bg-elevated border border-border-subtle text-text-secondary hover:bg-border-subtle disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleConfirmDelete}
            disabled={deleting}
            className="px-3 py-1.5 rounded text-xs font-medium bg-red-500/20 border border-red-500/40 text-red-400 hover:bg-red-500/30 disabled:opacity-50"
          >
            {deleting ? 'Excluindo…' : 'Confirmar'}
          </button>
        </div>
      </Modal>
    </motion.section>
  )
})
