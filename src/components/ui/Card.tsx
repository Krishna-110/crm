import type { ReactNode } from 'react'

export function Card({
  children,
  className = '',
  onClick,
  hover = false,
}: {
  children: ReactNode
  className?: string
  onClick?: () => void
  hover?: boolean
}) {
  const interactive = onClick || hover
  return (
    <div
      className={`bg-white rounded-2xl border border-ink-200/80 shadow-[var(--shadow-card)] ${
        interactive ? 'cursor-pointer transition-all duration-200 hover:shadow-[var(--shadow-card-hover)] hover:border-ink-300/80' : ''
      } ${className}`}
      onClick={onClick}
    >
      {children}
    </div>
  )
}

export function CardHeader({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`px-5 py-4 border-b border-ink-100 ${className}`}>{children}</div>
}

export function CardBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`px-5 py-5 ${className}`}>{children}</div>
}

export function CardTitle({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <h2 className={`text-[15px] font-semibold text-ink-900 ${className}`}>{children}</h2>
}
