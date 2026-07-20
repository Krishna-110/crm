import { Search } from 'lucide-react'

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search...',
  className = '',
}: {
  value: string
  onChange: (v: string) => void
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
        placeholder={placeholder}
        className="w-full pl-10 pr-4 py-2.5 bg-white border border-ink-200 rounded-xl text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none focus:border-primary-400 focus:ring-[3px] focus:ring-primary-500/15 transition-all shadow-sm"
      />
    </div>
  )
}
