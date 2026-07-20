import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

type ErrorBoundaryProps = {
  children: ReactNode
}

type ErrorBoundaryState = {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled error in app tree:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-[#f5f7fb] px-6">
          <div className="w-full max-w-sm rounded-2xl border border-ink-200/80 bg-white p-8 text-center shadow-[var(--shadow-pop)]">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-danger-50 text-danger-600">
              <AlertTriangle size={24} />
            </div>
            <h1 className="mt-4 text-lg font-semibold text-ink-900">Something went wrong</h1>
            <p className="mt-1.5 text-sm text-ink-500">
              An unexpected error occurred. Reloading the page usually fixes this.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-6 w-full rounded-xl bg-primary-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-700"
            >
              Reload page
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
