import type { ReactNode } from 'react'
import { InboxIcon } from 'lucide-react'

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 animate-fade-in">
      <div className="relative mb-5">
        <div className="absolute inset-0 bg-primary-100/50 blur-xl rounded-full" />
        <div className="relative w-16 h-16 rounded-2xl bg-gradient-to-br from-ink-50 to-ink-100 border border-ink-200/80 flex items-center justify-center text-ink-400 shadow-sm">
          {icon || <InboxIcon size={26} />}
        </div>
      </div>
      <h3 className="text-base font-semibold text-ink-900 mb-1">{title}</h3>
      {description && <p className="text-sm text-ink-500 mb-5 text-center max-w-sm leading-relaxed">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
