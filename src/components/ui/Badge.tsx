import type { ReactNode } from 'react'

type BadgeVariant = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'teal'

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-ink-100 text-ink-600 ring-ink-200/60',
  primary: 'bg-primary-50 text-primary-700 ring-primary-200/60',
  success: 'bg-success-50 text-success-700 ring-success-100',
  warning: 'bg-warning-50 text-warning-700 ring-warning-100',
  danger: 'bg-danger-50 text-danger-700 ring-danger-100',
  info: 'bg-sky-50 text-sky-700 ring-sky-100',
  teal: 'bg-teal-50 text-teal-600 ring-teal-100',
}

export function Badge({
  children,
  variant = 'default',
  className = '',
  dot = false,
}: {
  children: ReactNode
  variant?: BadgeVariant
  className?: string
  dot?: boolean
}) {
  const dotColors: Record<BadgeVariant, string> = {
    default: 'bg-ink-400',
    primary: 'bg-primary-500',
    success: 'bg-success-500',
    warning: 'bg-warning-500',
    danger: 'bg-danger-500',
    info: 'bg-sky-500',
    teal: 'bg-teal-500',
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ring-1 ring-inset ${variantClasses[variant]} ${className}`}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${dotColors[variant]}`} />}
      {children}
    </span>
  )
}
