type Tab = { id: string; label: string; count?: number }

export function Tabs({ tabs, activeTab, onChange }: { tabs: Tab[]; activeTab: string; onChange: (id: string) => void }) {
  return (
    <div className="inline-flex flex-wrap items-center gap-1 rounded-xl border border-ink-200/80 bg-white p-1 shadow-sm">
      {tabs.map((tab) => {
        const active = activeTab === tab.id
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-all ${
              active ? 'bg-primary-600 text-white shadow-sm' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-800'
            }`}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={`inline-flex h-4.5 min-w-[18px] items-center justify-center rounded-full px-1 text-[11px] font-semibold ${
                  active ? 'bg-white/20 text-white' : 'bg-ink-100 text-ink-500'
                }`}
              >
                {tab.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
