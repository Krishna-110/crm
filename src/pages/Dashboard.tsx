import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Users,
  Phone,
  Clock,
  ShoppingCart,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  ArrowUpRight,
  CalendarRange,
  IndianRupee,
  BarChart3,
} from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { LeadStatusBadge } from '@/components/ui/StatusBadge'
import { PageHeader } from '@/components/ui/PageHeader'
import type { LeadStatus } from '@/types'

function formatRupees(amount: number) {
  return `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

// Reused for both the Leads and Sales period breakdown cards below — same shape (Today /
// This Week / This Month), differing only in icon/tint/value-formatting.
function PeriodBreakdown({
  icon: Icon,
  tint,
  title,
  today,
  thisWeek,
  thisMonth,
  format = String,
}: {
  icon: typeof Users
  tint: string
  title: string
  today: number
  thisWeek: number
  thisMonth: number
  format?: (n: number) => string
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 pt-4">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br ${tint}`}>
          <Icon className="h-4 w-4 text-white" />
        </div>
        <h2 className="text-[15px] font-semibold text-ink-900">{title}</h2>
      </div>
      <div className="grid grid-cols-3 divide-x divide-ink-100 px-5 py-4">
        {[
          { label: 'Today', value: today },
          { label: 'This Week', value: thisWeek },
          { label: 'This Month', value: thisMonth },
        ].map((row) => (
          <div key={row.label} className="px-2 text-center first:pl-0 last:pr-0">
            <p className="truncate text-xl font-bold tracking-tight text-ink-900">{format(row.value)}</p>
            <p className="mt-0.5 text-[11px] text-ink-500">{row.label}</p>
          </div>
        ))}
      </div>
    </Card>
  )
}

const STATUS_BAR: Record<LeadStatus, string> = {
  new: 'bg-sky-500',
  contacted: 'bg-primary-500',
  follow_up_pending: 'bg-warning-500',
  interested: 'bg-teal-500',
  call_back_later: 'bg-amber-400',
  no_response: 'bg-ink-400',
  not_interested: 'bg-danger-500',
  converted: 'bg-success-500',
  sold: 'bg-emerald-600',
}

const STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  follow_up_pending: 'Follow-up Pending',
  interested: 'Interested',
  call_back_later: 'Call Back Later',
  no_response: 'No Response',
  not_interested: 'Not Interested',
  converted: 'Converted',
  sold: 'Sold',
}

export function Dashboard() {
  const { state } = useApp()
  const navigate = useNavigate()

  const dashboard = state.dashboard

  const leadStatusCounts = useMemo(() => {
    const counts: Partial<Record<LeadStatus, number>> = {}
    for (const row of dashboard?.leadStatusBreakdown ?? []) counts[row.status] = row.count
    return counts
  }, [dashboard])

  const recentLeads = useMemo(() => state.leads.slice(0, 6), [state.leads])

  const callerPerformance = useMemo(
    () => [...(dashboard?.callerPerformance ?? [])].sort((a, b) => b.assignedCount - a.assignedCount),
    [dashboard],
  )

  const statusCountValues = Object.values(leadStatusCounts)
  const maxStatusCount = statusCountValues.length ? Math.max(...statusCountValues) : 1

  const salesByCaller = dashboard?.salesByCaller ?? []
  const maxCallerSales = Math.max(...salesByCaller.map((c) => c.totalSales), 1)

  const statCards = [
    { label: 'Total Leads', value: dashboard?.totalLeads ?? 0, icon: Users, tint: 'from-primary-500 to-primary-600', change: '+12%', positive: true },
    { label: "Today's Calls", value: dashboard?.todaysCalls ?? 0, icon: Phone, tint: 'from-teal-500 to-teal-600', change: '+8%', positive: true },
    { label: 'Pending Follow-ups', value: dashboard?.pendingFollowUps ?? 0, icon: Clock, tint: 'from-warning-500 to-warning-600', change: '-5%', positive: false },
    { label: 'Converted Orders', value: dashboard?.totalOrders ?? 0, icon: ShoppingCart, tint: 'from-success-500 to-success-600', change: '+18%', positive: true },
    { label: 'Renewals Due', value: dashboard?.renewalsDue ?? 0, icon: RefreshCw, tint: 'from-danger-500 to-danger-600', change: '+3%', positive: false },
  ]

  const getUserName = (userId?: string) => {
    if (!userId) return '—'
    return state.users.find((u) => u.id === userId)?.name ?? '—'
  }

  // Bar chart geometry — Sales by Caller
  const barChartW = 480
  const barChartH = 170
  const barGap = 12
  const barCount = Math.max(salesByCaller.length, 1)
  const barSlot = (barChartW - barGap * (barCount - 1)) / barCount
  const barWidth = Math.min(barSlot, 56)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Welcome back — here's what's happening across your pipeline today."
      />

      {/* Stat Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {statCards.map((card) => {
          const Icon = card.icon
          return (
            <div
              key={card.label}
              className="group relative overflow-hidden rounded-2xl border border-ink-200/80 bg-white p-5 shadow-[var(--shadow-card)] transition-all duration-200 hover:shadow-[var(--shadow-card-hover)]"
            >
              <div className="flex items-start justify-between">
                <div className={`flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br ${card.tint} shadow-sm`}>
                  <Icon className="h-[22px] w-[22px] text-white" />
                </div>
                <div className={`flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${card.positive ? 'bg-success-50 text-success-700' : 'bg-danger-50 text-danger-700'}`}>
                  {card.positive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                  {card.change}
                </div>
              </div>
              <p className="mt-4 text-3xl font-bold tracking-tight text-ink-900">{card.value}</p>
              <p className="mt-0.5 text-sm text-ink-500">{card.label}</p>
            </div>
          )
        })}
      </div>

      {/* Leads / Sales period breakdown */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <PeriodBreakdown
          icon={CalendarRange}
          tint="from-primary-500 to-primary-600"
          title="Leads"
          today={dashboard?.leadsByPeriod.today ?? 0}
          thisWeek={dashboard?.leadsByPeriod.thisWeek ?? 0}
          thisMonth={dashboard?.leadsByPeriod.thisMonth ?? 0}
        />
        <PeriodBreakdown
          icon={IndianRupee}
          tint="from-success-500 to-success-600"
          title="Sales"
          today={dashboard?.salesByPeriod.today ?? 0}
          thisWeek={dashboard?.salesByPeriod.thisWeek ?? 0}
          thisMonth={dashboard?.salesByPeriod.thisMonth ?? 0}
          format={formatRupees}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
        {/* Lead Status Breakdown */}
        <Card className="lg:col-span-3">
          <div className="flex items-center justify-between px-5 pt-5">
            <div>
              <h2 className="text-[15px] font-semibold text-ink-900">Lead Status Breakdown</h2>
              <p className="text-xs text-ink-500">Distribution across the pipeline</p>
            </div>
            <button onClick={() => navigate('/leads')} className="text-xs font-medium text-primary-600 hover:text-primary-700">
              View all
            </button>
          </div>
          <div className="space-y-2.5 px-5 pb-5 pt-4">
            {(Object.entries(leadStatusCounts) as [LeadStatus, number][])
              .sort((a, b) => b[1] - a[1])
              .map(([status, count]) => (
                <div key={status} className="flex items-center gap-3">
                  <span className="w-32 shrink-0 text-[13px] text-ink-600">{STATUS_LABELS[status]}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-ink-100">
                    <div
                      className={`h-full rounded-full ${STATUS_BAR[status]} transition-all duration-500`}
                      style={{ width: `${(count / maxStatusCount) * 100}%` }}
                    />
                  </div>
                  <span className="w-6 text-right text-[13px] font-semibold text-ink-700">{count}</span>
                </div>
              ))}
          </div>
        </Card>

        {/* Sales by Caller - SVG bar chart (admin only, mirrors Caller Performance's gating) */}
        <Card className="lg:col-span-2">
          <div className="flex items-center gap-2 px-5 pt-5">
            <BarChart3 className="h-4 w-4 text-ink-400" />
            <div>
              <h2 className="text-[15px] font-semibold text-ink-900">Sales by Caller</h2>
              <p className="text-xs text-ink-500">Total order value per caller</p>
            </div>
          </div>
          <div className="px-2 pb-3 pt-4">
            {salesByCaller.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-ink-400">
                {state.currentUser?.role === 'admin' ? 'No sales recorded yet' : 'Visible to admins only'}
              </p>
            ) : (
              <>
                <svg viewBox={`0 0 ${barChartW} ${barChartH}`} className="w-full" preserveAspectRatio="none" style={{ height: 180 }}>
                  {salesByCaller.map((caller, i) => {
                    const x = i * (barSlot + barGap) + (barSlot - barWidth) / 2
                    const height = (caller.totalSales / maxCallerSales) * (barChartH - 26)
                    const y = barChartH - height
                    const r = Math.min(4, barWidth / 2, height)
                    const path = height <= 0 ? '' : `M ${x} ${barChartH} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} L ${x + barWidth - r} ${y} Q ${x + barWidth} ${y} ${x + barWidth} ${y + r} L ${x + barWidth} ${barChartH} Z`
                    return (
                      <g key={caller.callerId}>
                        <title>{caller.callerName}: {formatRupees(caller.totalSales)}</title>
                        <path d={path} fill="#3b6df5" />
                        <text
                          x={x + barWidth / 2}
                          y={y - 6}
                          textAnchor="middle"
                          className="fill-ink-600"
                          style={{ fontSize: 10, fontWeight: 600 }}
                        >
                          {formatRupees(caller.totalSales)}
                        </text>
                      </g>
                    )
                  })}
                </svg>
                <div className="flex px-2">
                  {salesByCaller.map((caller, i) => (
                    <span
                      key={caller.callerId}
                      title={caller.callerName}
                      className="truncate text-center text-[11px] font-medium text-ink-400"
                      style={{ width: barSlot, marginRight: i === salesByCaller.length - 1 ? 0 : barGap }}
                    >
                      {caller.callerName.split(' ')[0]}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        </Card>
      </div>

      {/* Recent Leads + Caller Performance */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="overflow-hidden lg:col-span-2">
          <div className="flex items-center justify-between border-b border-ink-100 px-5 py-4">
            <h2 className="text-[15px] font-semibold text-ink-900">Recent Leads</h2>
            <button onClick={() => navigate('/leads')} className="flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700">
              View all <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-100 bg-ink-50/50">
                  <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Customer</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Medicine</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Status</th>
                  <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Assigned</th>
                </tr>
              </thead>
              <tbody>
                {recentLeads.map((lead) => (
                  <tr
                    key={lead.id}
                    onClick={() => navigate(`/leads/${lead.id}`)}
                    className="cursor-pointer border-b border-ink-50 transition-colors last:border-0 hover:bg-primary-50/30"
                  >
                    <td className="px-5 py-3 font-medium text-ink-900">{lead.customerName}</td>
                    <td className="px-3 py-3 text-ink-600">
                      {lead.medicines[0]?.name ?? '-'}
                      {lead.medicines.length > 1 && (
                        <span className="ml-1 text-xs text-ink-500">+{lead.medicines.length - 1} more</span>
                      )}
                    </td>
                    <td className="px-3 py-3"><LeadStatusBadge status={lead.status} /></td>
                    <td className="px-5 py-3 text-ink-600">{getUserName(lead.assignedCaller)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-ink-100 px-5 py-4">
            <h2 className="text-[15px] font-semibold text-ink-900">Caller Performance</h2>
          </div>
          <div className="divide-y divide-ink-50">
            {callerPerformance.map((caller) => (
              <div key={caller.id} className="flex items-center gap-3 px-5 py-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink-100 text-xs font-semibold text-ink-600">
                  {caller.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-900">{caller.name}</p>
                  <p className="text-xs text-ink-500">{caller.assignedCount} leads · {caller.convertedCount} converted</p>
                </div>
                <Badge variant={caller.conversionRate >= 50 ? 'success' : caller.conversionRate >= 25 ? 'warning' : 'default'}>
                  {caller.conversionRate}%
                </Badge>
              </div>
            ))}
            {callerPerformance.length === 0 && (
              <p className="px-5 py-8 text-center text-sm text-ink-400">No callers found</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}
