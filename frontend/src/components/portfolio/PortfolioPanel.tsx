import { memo } from 'react'
import { motion } from 'framer-motion'
import { usePortfolio } from '../../hooks/usePortfolio'
import type { EnrichedPosition } from '../../hooks/usePortfolio'
import { Skeleton } from '../ui/Skeleton'

function PositionRow({ p }: { p: EnrichedPosition }) {
  const hit50 = p.profit_percentage >= 50
  const hit21dte = p.dte_current <= 21
  return (
    <tr className="border-b border-border-subtle last:border-0">
      <td className="py-2 pr-3 text-text-primary font-medium text-sm">{p.strategy}</td>
      <td className="py-2 pr-3 text-right">
        <span className={`text-xs font-num ${hit21dte ? 'text-yellow-400' : 'text-text-secondary'}`}>
          {p.dte_current} DTE
        </span>
        {hit21dte && (
          <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-yellow-500/20 text-yellow-400 border border-yellow-500/40">
            ≤21
          </span>
        )}
      </td>
      <td className="py-2 pr-3 text-right">
        <span className={`text-sm font-num ${hit50 ? 'text-[#00ff88]' : 'text-text-secondary'}`}>
          {p.profit_percentage.toFixed(1)}%
        </span>
        {hit50 && (
          <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#00ff88]/20 text-[#00ff88] border border-[#00ff88]/40">
            50%
          </span>
        )}
      </td>
      <td className="py-2 pr-3 text-right text-xs font-num text-text-muted">
        ${p.credit_received.toFixed(2)}
      </td>
      <td className="py-2 text-right text-xs font-num text-text-muted">
        ${p.current_cost_to_close.toFixed(2)}
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
    analyze,
    alerts,
    analyzing,
  } = usePortfolio()

  const isEmpty = !loading && positions.length === 0

  return (
    <motion.section
      className="card mt-4"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
    >
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-display font-bold text-text-primary tracking-wide">
            Carteira — Put Spreads
          </h2>
          {capturedAt && (
            <p className="text-[10px] text-text-muted mt-0.5">
              Dados: {new Date(capturedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="px-3 py-1.5 rounded text-xs font-medium bg-bg-elevated border border-border-subtle text-text-secondary hover:bg-border-subtle hover:text-text-primary disabled:opacity-50"
          >
            Atualizar
          </button>
          <button
            type="button"
            onClick={analyze}
            disabled={analyzing || positions.length === 0}
            className="px-3 py-1.5 rounded text-xs font-medium bg-[#00ff88]/10 border border-[#00ff88]/30 text-[#00ff88] hover:bg-[#00ff88]/20 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {analyzing ? 'Analisando…' : 'Analisar carteira'}
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
          Nenhuma posição OPEN. Cadastre posições em <code className="text-text-secondary">portfolio_positions</code> no Supabase e clique em Atualizar.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-left min-w-[360px]">
              <thead>
                <tr className="text-[10px] text-text-muted uppercase tracking-wider border-b border-border-subtle">
                  <th className="pb-2 pr-3 font-medium">Estratégia</th>
                  <th className="pb-2 pr-3 text-right">DTE</th>
                  <th className="pb-2 pr-3 text-right">Lucro %</th>
                  <th className="pb-2 pr-3 text-right">Crédito</th>
                  <th className="pb-2 text-right">Custo fechar</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <PositionRow key={p.id} p={p} />
                ))}
              </tbody>
            </table>
          </div>

          {alerts.length > 0 && (
            <div className="mt-4 pt-4 border-t border-border-subtle">
              <h3 className="text-xs font-semibold text-text-primary mb-2">Recomendações (Gestor de Risco)</h3>
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
    </motion.section>
  )
})
