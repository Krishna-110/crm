import { useState, useMemo } from 'react'
import {
  CalendarClock,
  Clock,
  AlertTriangle,
  CheckCircle2,
  Phone,
  RefreshCw,
  Eye,
  CalendarPlus,
  XCircle,
} from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { renewalsApi } from '@/api/renewals'
import { emitToast } from '@/lib/toast'
import { formatIndianDate } from '@/lib/dateUtils'
import { Card } from '@/components/ui/Card'
import { SearchInput } from '@/components/ui/SearchInput'
import { Tabs } from '@/components/ui/Tabs'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { RenewalStatusBadge } from '@/components/ui/StatusBadge'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import type { Renewal, RenewalStatus } from '@/types'

function getDaysRemainingPill(days: number) {
  if (days < 0) return 'bg-danger-50 text-danger-700'
  if (days <= 3) return 'bg-warning-50 text-warning-700'
  if (days <= 14) return 'bg-sky-50 text-sky-700'
  return 'bg-success-50 text-success-700'
}

const SUMMARY_CARDS: {
  key: RenewalStatus
  label: string
  icon: typeof CalendarClock
  tint: string
}[] = [
  { key: 'upcoming', label: 'Upcoming', icon: CalendarClock, tint: 'from-sky-500 to-sky-600' },
  { key: 'due_today', label: 'Due Today', icon: Clock, tint: 'from-warning-500 to-warning-600' },
  { key: 'overdue', label: 'Overdue', icon: AlertTriangle, tint: 'from-danger-500 to-danger-600' },
  { key: 'renewed', label: 'Renewed', icon: CheckCircle2, tint: 'from-success-500 to-success-600' },
]

export function Renewals() {
  const { state, dispatch } = useApp()
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState('all')
  const [cancelingRenewal, setCancelingRenewal] = useState<Renewal | null>(null)

  const renewals = state.renewals ?? []

  const callerName = (id?: string) => {
    if (!id) return '—'
    return state.users.find((u) => u.id === id)?.name ?? id
  }

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: renewals.length }
    for (const r of renewals) {
      counts[r.status] = (counts[r.status] ?? 0) + 1
    }
    return counts
  }, [renewals])

  const filteredRenewals = useMemo(() => {
    let result = renewals
    if (activeTab !== 'all') {
      result = result.filter((r) => r.status === activeTab)
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter(
        (r) =>
          r.customerName.toLowerCase().includes(q) ||
          r.medicineName.toLowerCase().includes(q) ||
          (r.assignedCaller && r.assignedCaller.toLowerCase().includes(q)),
      )
    }
    return result
  }, [renewals, activeTab, search])

  const tabs = [
    { id: 'all', label: 'All', count: statusCounts.all },
    { id: 'upcoming', label: 'Upcoming', count: statusCounts.upcoming ?? 0 },
    { id: 'due_today', label: 'Due Today', count: statusCounts.due_today ?? 0 },
    { id: 'overdue', label: 'Overdue', count: statusCounts.overdue ?? 0 },
    { id: 'renewed', label: 'Renewed', count: statusCounts.renewed ?? 0 },
  ]

  async function handleRenew(renewal: Renewal) {
    try {
      const updated = await renewalsApi.renew(renewal.id)
      dispatch({ type: 'UPDATE_RENEWAL', payload: { id: updated.id, updates: updated } })
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to renew')
    }
  }

  async function handleScheduleReminder(renewal: Renewal) {
    try {
      const followUp = await renewalsApi.remind(renewal.id, {
        notes: `Renewal reminder call for ${renewal.medicineName}`,
      })
      dispatch({ type: 'ADD_FOLLOW_UP', payload: { followUp } })
      emitToast(`Reminder scheduled for ${renewal.customerName}`, 'success')
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to schedule reminder')
    }
  }

  async function handleCancelRenewal() {
    if (!cancelingRenewal) return
    try {
      await renewalsApi.cancel(cancelingRenewal.id)
      dispatch({ type: 'DELETE_RENEWAL', payload: { id: cancelingRenewal.id } })
      emitToast(`Renewal stopped for ${cancelingRenewal.customerName}`, 'info')
      setCancelingRenewal(null)
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to stop renewal')
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Renewals" description={`${renewals.length} total renewals`} />

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {SUMMARY_CARDS.map((card) => {
          const Icon = card.icon
          const count = statusCounts[card.key] ?? 0
          return (
            <button
              key={card.key}
              type="button"
              onClick={() => setActiveTab(card.key)}
              className="group relative overflow-hidden rounded-2xl border border-ink-200/80 bg-white p-5 text-left shadow-[var(--shadow-card)] transition-all duration-200 hover:shadow-[var(--shadow-card-hover)]"
            >
              <div className="flex items-center gap-3">
                <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${card.tint} shadow-sm`}>
                  <Icon className="h-[22px] w-[22px] text-white" />
                </div>
                <div>
                  <p className="text-2xl font-bold tracking-tight text-ink-900">{count}</p>
                  <p className="text-sm text-ink-500">{card.label}</p>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {/* Tabs and Search */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex-1 overflow-x-auto">
          <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />
        </div>
        <div className="w-full sm:w-72">
          <SearchInput value={search} onChange={setSearch} placeholder="Search renewals..." />
        </div>
      </div>

      {/* Renewals Table */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 bg-ink-50/50">
                <th className="pl-5 pr-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Customer</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Medicine</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Order Date</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Renewal Date</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Expiry Date</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Days Left</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Caller</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Status</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredRenewals.length === 0 ? (
                <tr>
                  <td colSpan={9}>
                    <EmptyState
                      icon={<CalendarClock size={26} />}
                      title="No renewals found"
                      description="Try adjusting your search or filters to find what you're looking for."
                    />
                  </td>
                </tr>
              ) : (
                filteredRenewals.map((renewal) => {
                  return (
                    <tr key={renewal.id} className="border-b border-ink-50 last:border-0 hover:bg-primary-50/30 transition-colors">
                      <td className="pl-5 pr-3 py-3.5 font-medium text-ink-900">{renewal.customerName}</td>
                      <td className="px-3 py-3.5 text-ink-600">{renewal.medicineName}</td>
                      <td className="px-3 py-3.5 whitespace-nowrap text-xs text-ink-500">
                        {formatIndianDate(renewal.orderDate)}
                      </td>
                      <td className="px-3 py-3.5 whitespace-nowrap text-xs text-ink-500">
                        {formatIndianDate(renewal.renewalDate)}
                      </td>
                      <td className="px-3 py-3.5 whitespace-nowrap text-xs text-ink-500">
                        {formatIndianDate(renewal.expiryDate)}
                      </td>
                      <td className="px-3 py-3.5">
                        <span
                          className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-semibold ${getDaysRemainingPill(renewal.daysRemaining)}`}
                        >
                          {renewal.daysRemaining}
                        </span>
                      </td>
                      <td className="px-3 py-3.5 text-ink-600">{callerName(renewal.assignedCaller)}</td>
                      <td className="px-3 py-3.5">
                        <RenewalStatusBadge status={renewal.status} />
                      </td>
                      <td className="px-3 py-3.5">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            title="Call customer"
                            className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700 transition-colors"
                          >
                            <Phone className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            title="Schedule reminder"
                            onClick={() => handleScheduleReminder(renewal)}
                            className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700 transition-colors"
                          >
                            <CalendarPlus className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            title="Renew order"
                            onClick={() => handleRenew(renewal)}
                            className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700 transition-colors"
                          >
                            <RefreshCw className="h-4 w-4" />
                          </button>
                          {renewal.status !== 'renewed' && (
                            <button
                              type="button"
                              title="Stop / Cancel renewal"
                              onClick={() => setCancelingRenewal(renewal)}
                              className="rounded-lg p-1.5 text-danger-500 hover:bg-danger-50 hover:text-danger-600 transition-colors"
                            >
                              <XCircle className="h-4 w-4" />
                            </button>
                          )}
                          <button
                            type="button"
                            title="View details"
                            className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700 transition-colors"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Stop / Cancel Renewal Confirmation Modal */}
      <Modal
        isOpen={!!cancelingRenewal}
        onClose={() => setCancelingRenewal(null)}
        title="Stop / Cancel Renewal"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-600">
            Are you sure you want to stop the renewal for <span className="font-semibold text-ink-900">{cancelingRenewal?.customerName}</span> ({cancelingRenewal?.medicineName})? This will cancel future reminder calls for this customer.
          </p>
          <div className="flex justify-end gap-3 pt-3 border-t border-ink-100">
            <Button type="button" variant="secondary" onClick={() => setCancelingRenewal(null)}>
              Keep Active
            </Button>
            <Button type="button" variant="danger" onClick={handleCancelRenewal}>
              Stop Renewal
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
