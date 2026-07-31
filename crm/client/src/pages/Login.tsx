import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '@/context/AppContext'
import { login } from '@/context/AppContext'
import { takeFlashMessage } from '@/api/client'
import { emitToast } from '@/lib/toast'
import { Button } from '@/components/ui/Button'
import { Plus, Shield, Phone, ArrowRight, Activity, CheckCircle2, AlertCircle } from 'lucide-react'

const demoAccounts = [
  { email: 'aarav.sharma@medicrm.in', password: 'admin123', role: 'Admin', icon: Shield, color: 'bg-warning-50 text-warning-600' },
  { email: 'sneha.iyer@medicrm.in', password: 'caller123', role: 'Caller', icon: Phone, color: 'bg-primary-50 text-primary-600' },
]

export function Login() {
  const { dispatch } = useApp()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const flash = takeFlashMessage()
    if (flash) emitToast(flash, 'info')
  }, [])

  async function handleLogin(loginEmail: string, loginPassword: string) {
    setLoading(loginEmail)
    setError(null)
    try {
      await login(dispatch, loginEmail, loginPassword)
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(null)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (email && password) handleLogin(email, password)
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#f5f7fb] lg:flex-row">
      {/* Mobile hero band */}
      <div className="relative overflow-hidden bg-gradient-to-br from-primary-600 via-primary-700 to-primary-900 px-6 pb-16 pt-8 text-white lg:hidden">
        <div className="absolute -right-16 -top-20 h-64 w-64 rounded-full bg-primary-400/25 blur-3xl" />
        <div className="absolute -bottom-24 -left-10 h-56 w-56 rounded-full bg-teal-500/20 blur-3xl" />
        <div
          className="absolute inset-0 opacity-[0.08]"
          style={{
            backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
            backgroundSize: '24px 24px',
          }}
        />

        <div className="relative flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/15 backdrop-blur-sm">
            <Plus className="h-5 w-5 text-white" strokeWidth={3} />
          </div>
          <span className="text-lg font-bold">MediCRM</span>
        </div>

        <p className="relative mt-4 max-w-xs text-[15px] font-medium leading-snug text-primary-100">
          Every patient cared for. <span className="text-teal-300">Every follow-up on time.</span>
        </p>

        <div className="relative mt-5 flex items-center gap-5 text-xs text-primary-200">
          <div className="flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5 text-teal-300" />
            <span className="font-semibold text-white">2,400+</span> leads managed
          </div>
          <div className="h-3 w-px bg-white/20" />
          <div>
            <span className="font-semibold text-white">98%</span> follow-up rate
          </div>
        </div>
      </div>

      {/* Left brand panel */}
      <div className="relative hidden w-[46%] flex-col justify-between overflow-hidden bg-gradient-to-br from-primary-700 via-primary-800 to-primary-900 p-12 text-white lg:flex">
        {/* Photographic texture (gracefully hidden if it fails to load) */}
        <div
          className="absolute inset-0 bg-cover bg-center opacity-40"
          style={{
            backgroundImage:
              "url('https://images.unsplash.com/photo-1631549916768-4119b2e5f926?auto=format&fit=crop&w=1400&q=80')",
          }}
        />
        {/* Brand color overlay for readability */}
        <div className="absolute inset-0 bg-gradient-to-br from-primary-800/90 via-primary-800/80 to-primary-900/95" />
        {/* Soft glow accents */}
        <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-primary-400/20 blur-3xl" />
        <div className="absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-teal-500/15 blur-3xl" />
        {/* Dotted grid */}
        <div
          className="absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
            backgroundSize: '28px 28px',
          }}
        />

        <div className="relative flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 backdrop-blur-sm">
            <Plus className="h-6 w-6 text-white" strokeWidth={3} />
          </div>
          <span className="text-xl font-bold">MediCRM</span>
        </div>

        <div className="relative">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-primary-100 ring-1 ring-inset ring-white/15 backdrop-blur-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-teal-300" />
            Medical Distribution CRM
          </span>
          <h1 className="mt-5 text-[2.6rem] font-bold leading-[1.1] tracking-tight">
            Every patient cared for.<br />
            <span className="text-teal-300">Every follow-up on time.</span>
          </h1>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-primary-200">
            The calm, complete way to run medical distribution — leads, follow-ups, renewals and orders, all working together in one place.
          </p>
          <div className="mt-8 space-y-3">
            {['Track every lead from first call to delivery', 'Never let a follow-up or renewal slip', 'See your whole team, in real time'].map((f) => (
              <div key={f} className="flex items-center gap-3 text-sm text-primary-100">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-teal-300" />
                {f}
              </div>
            ))}
          </div>
        </div>

        <div className="relative flex items-center gap-6 text-sm">
          <div>
            <div className="flex items-center gap-1.5 text-2xl font-bold">
              <Activity className="h-5 w-5 text-teal-300" />2,400+
            </div>
            <div className="text-primary-300">Leads managed</div>
          </div>
          <div className="h-10 w-px bg-white/15" />
          <div>
            <div className="text-2xl font-bold">98%</div>
            <div className="text-primary-300">Follow-up rate</div>
          </div>
        </div>
      </div>

      {/* Right form panel */}
      <div className="relative -mt-8 flex flex-1 items-start justify-center px-4 pb-8 lg:mt-0 lg:items-center lg:p-6">
        <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-[var(--shadow-pop)] ring-1 ring-ink-900/5 sm:p-8 lg:rounded-none lg:bg-transparent lg:p-0 lg:shadow-none lg:ring-0">
          <h2 className="text-2xl font-bold tracking-tight text-ink-900">Welcome back</h2>
          <p className="mt-1.5 text-sm text-ink-500">Sign in to your account to continue</p>

          {error && (
            <div className="mt-5 flex items-start gap-2 rounded-xl border border-danger-200 bg-danger-50 px-3.5 py-3 text-sm text-danger-700">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-8 space-y-4">
            <div>
              <label className="field-label" htmlFor="login-email-address">Email address</label>
              <input
                id="login-email-address"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="field-input py-2.5"
              />
            </div>
            <div>
              <div className="flex items-center justify-between">
                <label className="field-label" htmlFor="login-password">Password</label>
                <button type="button" className="mb-1.5 text-xs font-medium text-primary-600 hover:text-primary-700">
                  Forgot?
                </button>
              </div>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="field-input py-2.5"
              />
            </div>
            <Button type="submit" size="lg" className="w-full" loading={loading === email && !!email}>
              Sign in <ArrowRight className="h-4 w-4" />
            </Button>
          </form>

          <div className="relative my-7">
            <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-ink-200" /></div>
            <div className="relative flex justify-center"><span className="bg-white px-3 text-xs font-medium uppercase tracking-wide text-ink-400 lg:bg-[#f5f7fb]">Or try a demo role</span></div>
          </div>

          <div className="space-y-2">
            {demoAccounts.map((account) => (
              <button
                key={account.email}
                onClick={() => handleLogin(account.email, account.password)}
                disabled={!!loading}
                className="group flex w-full items-center gap-3 rounded-xl border border-ink-200 bg-white px-4 py-3 text-left transition-all hover:border-primary-300 hover:shadow-sm disabled:opacity-60"
              >
                <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${account.color}`}>
                  <account.icon className="h-[18px] w-[18px]" />
                </div>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-ink-900">{account.role}</div>
                  <div className="text-xs text-ink-400">{account.email}</div>
                </div>
                {loading === account.email ? (
                  <svg className="h-4 w-4 animate-spin text-primary-500" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <ArrowRight className="h-4 w-4 text-ink-300 transition-transform group-hover:translate-x-0.5 group-hover:text-primary-500" />
                )}
              </button>
            ))}
          </div>

          <p className="mt-8 text-center text-xs text-ink-400">MediCRM v1.0 — Medical Distribution CRM</p>
        </div>
      </div>
    </div>
  )
}
