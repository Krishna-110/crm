import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { TOAST_EVENT, type ToastEventDetail, type ToastType } from '@/lib/toast'

type ToastItem = ToastEventDetail & { id: number }

const AUTO_DISMISS_MS: Record<ToastType, number> = {
  error: 6000,
  success: 4000,
  info: 4500,
}

const ICON: Record<ToastType, typeof AlertCircle> = {
  error: AlertCircle,
  success: CheckCircle2,
  info: Info,
}

const ACCENT: Record<ToastType, string> = {
  error: 'border-l-danger-500 text-danger-600',
  success: 'border-l-success-500 text-success-600',
  info: 'border-l-sky-500 text-sky-600',
}

let nextId = 1

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((item) => item.id !== id))
  }, [])

  useEffect(() => {
    function handle(e: Event) {
      const { message, type } = (e as CustomEvent<ToastEventDetail>).detail
      const id = nextId++
      setToasts((t) => [...t, { id, message, type }])
      window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS[type])
    }
    window.addEventListener(TOAST_EVENT, handle)
    return () => window.removeEventListener(TOAST_EVENT, handle)
  }, [dismiss])

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2 sm:top-5 sm:right-5">
      {toasts.map((toast) => {
        const Icon = ICON[toast.type]
        return (
          <div
            key={toast.id}
            role="alert"
            className={`animate-slide-up flex items-start gap-3 rounded-xl border-l-4 bg-white px-4 py-3 shadow-[var(--shadow-pop)] ring-1 ring-ink-900/5 ${ACCENT[toast.type]}`}
          >
            <Icon size={18} className="mt-0.5 shrink-0" />
            <p className="min-w-0 flex-1 text-sm leading-snug text-ink-800">{toast.message}</p>
            <button
              onClick={() => dismiss(toast.id)}
              className="shrink-0 rounded-lg p-1 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-600"
              aria-label="Dismiss"
            >
              <X size={15} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
