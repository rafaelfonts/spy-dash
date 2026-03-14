// frontend/src/components/equity/EquityAIAnalysis.tsx
// Stub — full implementation in a future task
interface Props { onRegisterTrade: () => void }

export function EquityAIAnalysis({ onRegisterTrade }: Props) {
  return (
    <div id="equity-ai-analysis" className="bg-[#111] border border-[#222] rounded-xl p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">Análise IA</div>
      <div className="text-sm text-gray-600 text-center py-6">Em construção</div>
      <button onClick={onRegisterTrade} className="hidden" />
    </div>
  )
}
