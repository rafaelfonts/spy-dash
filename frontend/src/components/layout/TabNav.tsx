import { LayoutDashboard, BarChart2, Globe, Briefcase } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type TabId = 'dashboard' | 'mercado' | 'macro' | 'portfolio'

interface TabNavProps {
  active: TabId
  onChange: (tab: TabId) => void
}

const TABS: { id: TabId; label: string; Icon: LucideIcon }[] = [
  { id: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { id: 'mercado', label: 'Mercado', Icon: BarChart2 },
  { id: 'macro', label: 'Macro & News', Icon: Globe },
  { id: 'portfolio', label: 'Portfolio', Icon: Briefcase },
]

export function TabNav({ active, onChange }: TabNavProps) {
  return (
    <div className="hidden md:flex border-b border-border-subtle bg-[#0d0d0d]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 flex gap-0">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`flex items-center gap-[6px] px-5 py-[10px] text-[11px] font-bold tracking-[0.5px] border-b-2 transition-colors font-display whitespace-nowrap ${
              active === tab.id
                ? 'text-[#00ff88] border-[#00ff88]'
                : 'text-text-muted border-transparent hover:text-text-secondary'
            }`}
          >
            <tab.Icon size={13} strokeWidth={2.2} />
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  )
}
