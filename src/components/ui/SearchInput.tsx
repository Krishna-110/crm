import { Search } from 'lucide-react'

export function SearchInput({
  value,
  onChange,
  ariaLabel,
  placeholder = 'Search...',
  className = '',
}: {
  value: string
  onChange: (v: string) => void
  /**
   * Accessible name. REQUIRED on purpose — without it the only name available is the
   * placeholder, which is the last-resort source in the accessible-name algorithm. Making it
   * mandatory means a new search box cannot be added unnamed. It should also distinguish
   * this box from the global search in the top bar, since both are present on every page.
   */
  ariaLabel: string
  placeholder?: string
  className?: string
}) {
  return (
    <div className={`relative ${className}`}>
      <Search size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400" />
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        aria-label={ariaLabel}
        placeholder={placeholder}
        className="w-full pl-10 pr-4 py-2.5 bg-white border border-ink-200 rounded-xl text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none focus:border-primary-400 focus:ring-[3px] focus:ring-primary-500/15 transition-all shadow-sm"
      />
    </div>
  )
}
