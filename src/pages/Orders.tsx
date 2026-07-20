import { useState, useMemo } from 'react'
import {
  Package,
  Eye,
  ArrowRight,
  Check,
} from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { ordersApi } from '@/api/orders'
import { emitToast } from '@/lib/toast'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/Badge'
import { SearchInput } from '@/components/ui/SearchInput'
import { Tabs } from '@/components/ui/Tabs'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { OrderStageBadge } from '@/components/ui/StatusBadge'
import type { Order, OrderStage, PaymentStatus } from '@/types'

const STAGES: { key: OrderStage; label: string; dot: string; accent: string }[] = [
  { key: 'lead', label: 'Lead', dot: 'bg-ink-400', accent: 'bg-ink-400' },
  { key: 'confirmed', label: 'Confirmed', dot: 'bg-primary-500', accent: 'bg-primary-500' },
  { key: 'medicine_prepared', label: 'Medicine Prepared', dot: 'bg-sky-500', accent: 'bg-sky-500' },
  { key: 'packed', label: 'Packed', dot: 'bg-warning-500', accent: 'bg-warning-500' },
  { key: 'shipped', label: 'Shipped', dot: 'bg-teal-500', accent: 'bg-teal-500' },
  { key: 'delivered', label: 'Delivered', dot: 'bg-success-500', accent: 'bg-success-500' },
]

const STAGE_ORDER: OrderStage[] = ['lead', 'confirmed', 'medicine_prepared', 'packed', 'shipped', 'delivered']

function formatIndianCurrency(amount: number): string {
  const formatted = amount.toLocaleString('en-IN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })
  return `₹${formatted}`
}

function getPaymentBadgeVariant(status: PaymentStatus) {
  switch (status) {
    case 'pending':
      return 'warning' as const
    case 'partial':
      return 'info' as const
    case 'paid':
      return 'success' as const
    case 'refunded':
      return 'danger' as const
    default:
      return 'default' as const
  }
}

function getNextStage(current: OrderStage): OrderStage | null {
  const idx = STAGE_ORDER.indexOf(current)
  if (idx < 0 || idx >= STAGE_ORDER.length - 1) return null
  return STAGE_ORDER[idx + 1]
}

export function Orders() {
  const { state, dispatch } = useApp()
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState('all')
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  const orders = state.orders ?? []

  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = { all: orders.length }
    for (const stage of STAGE_ORDER) {
      counts[stage] = orders.filter((o) => o.stage === stage).length
    }
    return counts
  }, [orders])

  const filteredOrders = useMemo(() => {
    let result = orders
    if (activeTab !== 'all') {
      result = result.filter((o) => o.stage === activeTab)
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter(
        (o) =>
          o.orderNumber.toLowerCase().includes(q) ||
          o.customerName.toLowerCase().includes(q) ||
          o.medicines.some((m) => m.name.toLowerCase().includes(q)),
      )
    }
    return result
  }, [orders, activeTab, search])

  const tabs = [
    { id: 'all', label: 'All', count: stageCounts.all },
    { id: 'confirmed', label: 'Confirmed', count: stageCounts.confirmed },
    { id: 'medicine_prepared', label: 'Prepared', count: stageCounts.medicine_prepared },
    { id: 'packed', label: 'Packed', count: stageCounts.packed },
    { id: 'shipped', label: 'Shipped', count: stageCounts.shipped },
    { id: 'delivered', label: 'Delivered', count: stageCounts.delivered },
  ]

  async function handleAdvanceStage(order: Order) {
    const next = getNextStage(order.stage)
    if (!next) return
    try {
      const updated = await ordersApi.update(order.id, { stage: next })
      dispatch({ type: 'UPDATE_ORDER', payload: { id: updated.id, updates: updated } })
      if (selectedOrder?.id === order.id) setSelectedOrder(updated)
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to advance order stage')
    }
  }

  async function handlePaymentChange(order: Order, status: PaymentStatus) {
    try {
      const updated = await ordersApi.update(order.id, { paymentStatus: status })
      dispatch({ type: 'UPDATE_ORDER', payload: { id: updated.id, updates: updated } })
      if (selectedOrder?.id === order.id) setSelectedOrder(updated)
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to update payment status')
    }
  }

  function openDetail(order: Order) {
    setSelectedOrder(order)
    setDetailOpen(true)
  }

  function closeDetail() {
    setDetailOpen(false)
    setSelectedOrder(null)
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Orders" description={`${orders.length} total orders`} />

      {/* Pipeline */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {STAGES.map((stage) => {
          const count = stageCounts[stage.key] ?? 0
          const isActive = activeTab === stage.key
          return (
            <button
              key={stage.key}
              type="button"
              onClick={() => setActiveTab(stage.key)}
              className={`relative overflow-hidden rounded-xl border bg-white p-4 text-left transition-all ${
                isActive
                  ? 'border-primary-300 ring-2 ring-primary-100'
                  : 'border-ink-200 hover:border-ink-300 hover:shadow-[var(--shadow-card)]'
              }`}
            >
              <div className={`absolute inset-x-0 top-0 h-1 ${stage.accent}`} />
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${stage.dot}`} />
                <span className="truncate text-sm font-medium text-ink-700">{stage.label}</span>
              </div>
              <div className="mt-2 text-2xl font-bold text-ink-900">{count}</div>
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
          <SearchInput value={search} onChange={setSearch} placeholder="Search orders..." />
        </div>
      </div>

      {/* Orders Table */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 bg-ink-50/50">
                <th className="pl-5 pr-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Order #</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Customer</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Medicines</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Total</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Payment</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Stage</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Created</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <EmptyState
                      icon={<Package size={26} />}
                      title="No orders found"
                      description="Try adjusting your search or filters to find what you're looking for."
                    />
                  </td>
                </tr>
              ) : (
                filteredOrders.map((order) => {
                  const firstMed = order.medicines[0]
                  const extraCount = order.medicines.length - 1
                  const nextStage = getNextStage(order.stage)
                  return (
                    <tr key={order.id} className="border-b border-ink-50 last:border-0 hover:bg-primary-50/30 transition-colors">
                      <td className="pl-5 pr-3 py-3.5">
                        <span className="font-mono text-xs font-medium text-ink-900">{order.orderNumber}</span>
                      </td>
                      <td className="px-3 py-3.5 font-medium text-ink-900">{order.customerName}</td>
                      <td className="px-3 py-3.5 text-ink-600">
                        {firstMed ? (
                          <span>
                            {firstMed.name}
                            {extraCount > 0 && (
                              <span className="ml-1 text-xs text-ink-500">+{extraCount} more</span>
                            )}
                          </span>
                        ) : (
                          <span className="text-ink-400">--</span>
                        )}
                      </td>
                      <td className="px-3 py-3.5 whitespace-nowrap font-semibold text-ink-900">
                        {formatIndianCurrency(order.totalAmount)}
                      </td>
                      <td className="px-3 py-3.5">
                        <Badge variant={getPaymentBadgeVariant(order.paymentStatus)}>
                          {order.paymentStatus.charAt(0).toUpperCase() + order.paymentStatus.slice(1)}
                        </Badge>
                      </td>
                      <td className="px-3 py-3.5">
                        <OrderStageBadge stage={order.stage} />
                      </td>
                      <td className="px-3 py-3.5 whitespace-nowrap text-xs text-ink-500">
                        {new Date(order.createdDate).toLocaleDateString('en-IN', {
                          day: '2-digit',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </td>
                      <td className="px-3 py-3.5">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            title="View details"
                            onClick={() => openDetail(order)}
                            className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700 transition-colors"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                          {nextStage && (
                            <button
                              type="button"
                              title="Advance to next stage"
                              onClick={() => handleAdvanceStage(order)}
                              className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700 transition-colors"
                            >
                              <ArrowRight className="h-4 w-4" />
                            </button>
                          )}
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

      {/* Order Detail Modal */}
      <Modal isOpen={detailOpen} onClose={closeDetail} title={`Order ${selectedOrder?.orderNumber ?? ''}`} size="lg">
        {selectedOrder && (
          <div className="space-y-6">
            {/* Customer Info */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-500">Customer</p>
                <p className="mt-1 text-sm font-medium text-ink-900">{selectedOrder.customerName}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-500">Address</p>
                <p className="mt-1 text-sm text-ink-700">{selectedOrder.address || '--'}</p>
              </div>
            </div>

            {/* Stage Stepper */}
            <div>
              <p className="mb-4 text-xs uppercase tracking-wide text-ink-500">Order Progress</p>
              <div className="flex items-start">
                {STAGES.map((stage, i) => {
                  const currentIdx = STAGE_ORDER.indexOf(selectedOrder.stage)
                  const isCompleted = i < currentIdx
                  const isCurrent = i === currentIdx
                  const isLast = i === STAGES.length - 1
                  const reached = i <= currentIdx
                  const circleClass = isCompleted || (isCurrent && isLast)
                    ? 'bg-primary-500 text-white'
                    : isCurrent
                      ? 'bg-primary-500 text-white ring-4 ring-primary-100'
                      : 'bg-ink-100 text-ink-400'
                  return (
                    <div key={stage.key} className="flex flex-1 items-center last:flex-none">
                      <div className="flex flex-col items-center">
                        <div
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors ${circleClass}`}
                        >
                          {isCompleted || (isCurrent && isLast) ? <Check className="h-4 w-4" /> : i + 1}
                        </div>
                        <p
                          className={`mt-1.5 w-16 text-center text-[10px] leading-tight ${
                            isCurrent ? 'font-bold text-primary-700' : reached ? 'text-primary-600' : 'text-ink-400'
                          }`}
                        >
                          {stage.label}
                        </p>
                      </div>
                      {!isLast && (
                        <div className={`mx-1 mb-6 h-0.5 flex-1 rounded-full ${i < currentIdx ? 'bg-primary-500' : 'bg-ink-200'}`} />
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Medicines Table */}
            <div>
              <p className="mb-2 text-xs uppercase tracking-wide text-ink-500">Medicines</p>
              <div className="overflow-x-auto rounded-xl border border-ink-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-ink-100 bg-ink-50/50">
                      <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Name</th>
                      <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-400">Qty</th>
                      <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-400">Price</th>
                      <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-400">Subtotal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedOrder.medicines.map((med, i) => (
                      <tr key={i} className="border-b border-ink-50 last:border-0">
                        <td className="px-3 py-2.5 font-medium text-ink-900">{med.name}</td>
                        <td className="px-3 py-2.5 text-right text-ink-600">{med.quantity}</td>
                        <td className="px-3 py-2.5 text-right text-ink-600">{formatIndianCurrency(med.price)}</td>
                        <td className="px-3 py-2.5 text-right font-semibold text-ink-900">
                          {formatIndianCurrency(med.quantity * med.price)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-ink-200 bg-ink-50/50">
                      <td colSpan={3} className="px-3 py-2.5 text-right font-medium text-ink-700">
                        Total
                      </td>
                      <td className="px-3 py-2.5 text-right font-bold text-ink-900">
                        {formatIndianCurrency(selectedOrder.totalAmount)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Payment + Advance */}
            <div className="flex flex-col items-start gap-4 border-t border-ink-200 pt-4 sm:flex-row sm:items-center">
              <div className="flex items-center gap-2">
                <label className="text-sm text-ink-600">Payment:</label>
                <select
                  value={selectedOrder.paymentStatus}
                  onChange={(e) => handlePaymentChange(selectedOrder, e.target.value as PaymentStatus)}
                  className="field-input w-auto"
                >
                  <option value="pending">Pending</option>
                  <option value="partial">Partial</option>
                  <option value="paid">Paid</option>
                  <option value="refunded">Refunded</option>
                </select>
              </div>
              <div className="flex-1" />
              {getNextStage(selectedOrder.stage) && (
                <Button
                  variant="primary"
                  icon={<ArrowRight className="h-4 w-4" />}
                  onClick={() => handleAdvanceStage(selectedOrder)}
                >
                  Advance to {STAGES.find((s) => s.key === getNextStage(selectedOrder.stage))?.label}
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
