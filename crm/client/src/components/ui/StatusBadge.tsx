import type { LeadStatus, OrderStage, RenewalStatus } from '@/types'
import { Badge } from './Badge'

type Variant = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'teal'

const leadStatusConfig: Record<LeadStatus, { label: string; variant: Variant }> = {
  new: { label: 'New', variant: 'info' },
  contacted: { label: 'Contacted', variant: 'primary' },
  follow_up_pending: { label: 'Follow-up Pending', variant: 'warning' },
  interested: { label: 'Interested', variant: 'teal' },
  call_back_later: { label: 'Call Back Later', variant: 'warning' },
  no_response: { label: 'No Response', variant: 'default' },
  not_interested: { label: 'Not Interested', variant: 'danger' },
  converted: { label: 'Converted', variant: 'success' },
  sold: { label: 'Sold', variant: 'success' },
}

const orderStageConfig: Record<OrderStage, { label: string; variant: Variant }> = {
  lead: { label: 'Lead', variant: 'default' },
  confirmed: { label: 'Confirmed', variant: 'primary' },
  medicine_prepared: { label: 'Prepared', variant: 'info' },
  packed: { label: 'Packed', variant: 'warning' },
  shipped: { label: 'Shipped', variant: 'teal' },
  delivered: { label: 'Delivered', variant: 'success' },
}

const renewalStatusConfig: Record<RenewalStatus, { label: string; variant: Variant }> = {
  upcoming: { label: 'Upcoming', variant: 'info' },
  due_today: { label: 'Due Today', variant: 'warning' },
  overdue: { label: 'Overdue', variant: 'danger' },
  renewed: { label: 'Renewed', variant: 'success' },
}

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  const config = leadStatusConfig[status]
  return <Badge variant={config.variant} dot>{config.label}</Badge>
}

export function OrderStageBadge({ stage }: { stage: OrderStage }) {
  const config = orderStageConfig[stage]
  return <Badge variant={config.variant} dot>{config.label}</Badge>
}

export function RenewalStatusBadge({ status }: { status: RenewalStatus }) {
  const config = renewalStatusConfig[status]
  return <Badge variant={config.variant} dot>{config.label}</Badge>
}
