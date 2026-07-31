import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApp } from '@/context/AppContext'
import { leadsApi } from '@/api/leads'
import { emitToast } from '@/lib/toast'
import { formatIndianDate, formatIndianDateTime } from '@/lib/dateUtils'
import type { LeadActivity, LeadStatus } from '@/types'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { LeadStatusBadge } from '@/components/ui/StatusBadge'
import { EmptyState } from '@/components/ui/EmptyState'
import {
  ArrowLeft,
  Phone,
  MessageSquare,
  ArrowRight,
  Clock,
  UserPlus,
  Plus,
  Edit2,
  ShoppingCart,
  CalendarPlus,
  AlertCircle,
  Pill,
} from 'lucide-react'

const activityIconMap: Record<LeadActivity['type'], typeof Phone> = {
  call: Phone,
  comment: MessageSquare,
  status_change: ArrowRight,
  follow_up: Clock,
  assignment: UserPlus,
  created: Plus,
}

const activityColorMap: Record<LeadActivity['type'], string> = {
  call: 'bg-primary-50 text-primary-600',
  comment: 'bg-teal-50 text-teal-600',
  status_change: 'bg-warning-50 text-warning-600',
  follow_up: 'bg-sky-50 text-sky-600',
  assignment: 'bg-success-50 text-success-600',
  created: 'bg-ink-100 text-ink-600',
}

// 'converted' is deliberately excluded — that transition only happens through
// "Convert to Order" (which also creates the order), not a plain status edit.
const editableStatusOptions: { value: LeadStatus; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'follow_up_pending', label: 'Follow-up Pending' },
  { value: 'interested', label: 'Interested' },
  { value: 'call_back_later', label: 'Call Back Later' },
  { value: 'no_response', label: 'No Response' },
  { value: 'not_interested', label: 'Not Interested' },
  { value: 'sold', label: 'Sold' },
]

const sourceLabel: Record<string, string> = {
  website: 'Website',
  referral: 'Referral',
  walk_in: 'Walk-in',
  phone: 'Phone',
  social_media: 'Social Media',
  advertisement: 'Advertisement',
  other: 'Other',
}

export function LeadDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { state, dispatch } = useApp()
  const [comment, setComment] = useState('')
  const [showConvertConfirm, setShowConvertConfirm] = useState(false)
  const [showMedicineFields, setShowMedicineFields] = useState(false)
  const [medicineName, setMedicineName] = useState('')
  const [medicineDays, setMedicineDays] = useState('30')

  const lead = state.leads.find(l => l.id === id)

  if (!lead) {
    return (
      <EmptyState
        icon={<AlertCircle size={28} />}
        title="Lead not found"
        description="The lead you are looking for does not exist or has been removed."
        action={
          <Button variant="secondary" onClick={() => navigate('/leads')}>
            Back to Leads
          </Button>
        }
      />
    )
  }

  function getCallerName(callerId?: string) {
    if (!callerId) return '-'
    return state.users.find(u => u.id === callerId)?.name ?? '-'
  }

  function resolveActor(actor: string) {
    return state.users.find(u => u.id === actor)?.name ?? actor
  }

  async function handleAddComment() {
    if (!comment.trim() || !lead) return

    let medicine: { name: string; days: number } | undefined
    if (showMedicineFields) {
      if (!medicineName.trim()) {
        emitToast('Enter a medicine name, or turn off "Add medicine"')
        return
      }
      const days = Number(medicineDays)
      if (!Number.isInteger(days) || days <= 0) {
        emitToast('Days must be a whole number greater than 0')
        return
      }
      medicine = { name: medicineName.trim(), days }
    }

    try {
      const result = await leadsApi.addActivity(lead.id, comment.trim(), medicine)
      dispatch({ type: 'ADD_LEAD_ACTIVITY', payload: { leadId: lead.id, activity: result.activity } })
      if (result.medicine) {
        dispatch({ type: 'ADD_LEAD_MEDICINE', payload: { leadId: lead.id, medicine: result.medicine } })
      }
      setComment('')
      setMedicineName('')
      setMedicineDays('30')
      setShowMedicineFields(false)
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to add comment')
    }
  }

  async function handleStatusChange(status: LeadStatus) {
    if (!lead || status === lead.status) return
    if (status === 'sold') {
      if (!lead.address?.trim() || !lead.pincode?.trim() || !lead.paymentScreenshot?.trim()) {
        emitToast('Address, Pincode, and Payment Screenshot are required when Lead Status is Sold. Redirecting to edit...', 'info')
        navigate('/leads', { state: { editLeadId: lead.id } })
        return
      }
    }
    try {
      const updated = await leadsApi.update(lead.id, { status })
      dispatch({ type: 'UPDATE_LEAD', payload: { id: updated.id, updates: updated } })
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to update status')
    }
  }

  async function handleConvertToOrder() {
    if (!lead) return
    try {
      const { order, lead: updatedLead } = await leadsApi.convert(lead.id)
      dispatch({ type: 'ADD_ORDER', payload: { order } })
      dispatch({ type: 'UPDATE_LEAD', payload: { id: updatedLead.id, updates: updatedLead } })
      setShowConvertConfirm(false)
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to convert lead')
    }
  }

  async function handleScheduleFollowUp() {
    if (!lead) return
    const nextDate = new Date()
    nextDate.setDate(nextDate.getDate() + 1)
    const dateStr = nextDate.toISOString().split('T')[0]
    try {
      const { followUp, lead: updatedLead } = await leadsApi.scheduleFollowUp(lead.id, {
        scheduledDate: dateStr,
        type: 'call',
      })
      dispatch({ type: 'ADD_FOLLOW_UP', payload: { followUp } })
      dispatch({ type: 'UPDATE_LEAD', payload: { id: updatedLead.id, updates: updatedLead } })
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to schedule follow-up')
    }
  }

  const sortedActivities = [...(lead.activities || [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div className="flex items-start gap-4">
          <button
            onClick={() => navigate('/leads')}
            aria-label="Back to leads"
            className="mt-1 rounded-lg border border-ink-200/80 bg-white p-2 text-ink-500 shadow-sm hover:bg-ink-50 hover:text-ink-700 transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="text-[22px] font-bold tracking-tight text-ink-900">{lead.customerName}</h1>
            <p className="text-sm text-ink-500 mt-1">{lead.mobile}</p>
            <div className="flex items-center gap-2 mt-2">
              {lead.status === 'converted' ? (
                <LeadStatusBadge status={lead.status} />
              ) : (
                <select
                  value={lead.status}
                  onChange={e => handleStatusChange(e.target.value as LeadStatus)}
                  className="rounded-full border border-ink-200 bg-white py-1 pl-3 pr-7 text-xs font-medium text-ink-700 outline-none transition-colors hover:border-ink-300 focus:border-primary-400"
                  title="Change Lead Status"
                >
                  {editableStatusOptions.map(o => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <Button
            variant="secondary"
            size="sm"
            icon={<Edit2 size={14} />}
            onClick={() => navigate('/leads', { state: { editLeadId: lead.id } })}
          >
            Edit
          </Button>
          {lead.status !== 'converted' && (
            <Button
              variant="success"
              size="sm"
              icon={<ShoppingCart size={14} />}
              onClick={() => setShowConvertConfirm(true)}
            >
              Convert to Order
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            icon={<CalendarPlus size={14} />}
            onClick={handleScheduleFollowUp}
          >
            Schedule Follow-up
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left / Center Column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Customer Information */}
          <Card>
            <CardHeader>
              <h2 className="text-[15px] font-semibold text-ink-900">Customer Information</h2>
            </CardHeader>
            <CardBody>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-4 gap-x-8">
                <InfoRow label="Name" value={lead.customerName} />
                <InfoRow label="Mobile" value={lead.mobile} />
                <InfoRow label="Alternate Number" value={lead.alternateNumber ?? '-'} />
                <InfoRow
                  label="Address"
                  value={`${lead.address}, ${lead.city}, ${lead.state} - ${lead.pincode}`}
                />
                <InfoRow label="Doctor Name" value={lead.doctorName ?? '-'} />
                <InfoRow label="Disease" value={lead.disease ?? '-'} />
                <InfoRow label="Lead Source" value={sourceLabel[lead.leadSource] ?? lead.leadSource} />
                <InfoRow label="Created Date" value={formatIndianDate(lead.createdDate)} />
              </div>
            </CardBody>
          </Card>

          {/* Payment Screenshot Card if available */}
          {lead.paymentScreenshot && (
            <Card>
              <CardHeader>
                <h2 className="text-[15px] font-semibold text-ink-900">Payment Screenshot</h2>
              </CardHeader>
              <CardBody>
                <div className="overflow-hidden rounded-xl border border-ink-200 bg-ink-50/50 p-2 max-w-sm">
                  <img
                    src={lead.paymentScreenshot}
                    alt="Payment Confirmation Screenshot"
                    className="max-h-64 rounded-lg object-contain w-full"
                  />
                </div>
              </CardBody>
            </Card>
          )}

          {/* Medicines Required */}
          <Card>
            <CardHeader>
              <h2 className="text-[15px] font-semibold text-ink-900">Medicines Required</h2>
            </CardHeader>
            <CardBody>
              <div className="space-y-2">
                {lead.medicines.map((medicine) => (
                  <div
                    key={medicine.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-ink-100 bg-ink-50/50 px-4 py-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-teal-500 to-teal-600 text-white">
                        <Pill size={14} />
                      </div>
                      <span className="truncate text-sm font-medium text-ink-900">{medicine.name}</span>
                    </div>
                    <Badge variant="primary">{medicine.days} days</Badge>
                  </div>
                ))}
                {lead.medicines.length === 0 && (
                  <p className="text-sm text-ink-400">No medicines listed for this lead.</p>
                )}
              </div>
            </CardBody>
          </Card>

          {/* Follow-up Card */}
          <Card>
            <CardHeader>
              <h2 className="text-[15px] font-semibold text-ink-900">Follow-up Details</h2>
            </CardHeader>
            <CardBody>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-4 gap-x-8">
                <InfoRow label="Last Follow-up" value={formatIndianDate(lead.lastFollowUp)} />
                <InfoRow label="Next Follow-up" value={formatIndianDate(lead.nextFollowUp)} />
                <InfoRow label="Assigned Caller" value={getCallerName(lead.assignedCaller)} />
              </div>
            </CardBody>
          </Card>

          {/* Notes */}
          <Card>
            <CardHeader>
              <h2 className="text-[15px] font-semibold text-ink-900">Notes</h2>
            </CardHeader>
            <CardBody>
              {lead.notes ? (
                <p className="text-sm text-ink-700 whitespace-pre-wrap">{lead.notes}</p>
              ) : (
                <p className="text-sm text-ink-400">No notes for this lead.</p>
              )}
            </CardBody>
          </Card>

          {/* Add Comment */}
          <Card>
            <CardHeader>
              <h2 className="text-[15px] font-semibold text-ink-900">Add Comment</h2>
            </CardHeader>
            <CardBody>
              <textarea
                rows={3}
                value={comment}
                onChange={e => setComment(e.target.value)}
                aria-label="Add a comment"
                placeholder="Write a comment about this lead..."
                className="field-input resize-none"
              />

              <button
                type="button"
                onClick={() => setShowMedicineFields(v => !v)}
                className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary-600 hover:text-primary-700"
              >
                <Plus size={15} className={`transition-transform ${showMedicineFields ? 'rotate-45' : ''}`} />
                {showMedicineFields ? 'Remove medicine' : 'Add medicine'}
              </button>

              {showMedicineFields && (
                <div className="mt-3 flex items-start gap-2 rounded-xl border border-ink-100 bg-ink-50/50 p-3">
                  <div className="flex-1">
                    <label className="field-label" htmlFor="leaddetailpage-medicine-name">Medicine Name</label>
                    <input
                      id="leaddetailpage-medicine-name"
                      type="text"
                      value={medicineName}
                      onChange={e => setMedicineName(e.target.value)}
                      placeholder="e.g. Metformin 500mg"
                      className="field-input"
                    />
                  </div>
                  <div className="w-28">
                    <label className="field-label" htmlFor="leaddetailpage-days">Days</label>
                    <input
                      id="leaddetailpage-days"
                      type="number"
                      min={1}
                      value={medicineDays}
                      onChange={e => setMedicineDays(e.target.value)}
                      className="field-input"
                    />
                  </div>
                </div>
              )}

              <div className="flex justify-end mt-3">
                <Button size="sm" onClick={handleAddComment} disabled={!comment.trim()}>
                  Add Comment
                </Button>
              </div>
            </CardBody>
          </Card>

          {/* Convert to Order (inline confirmation) */}
          {showConvertConfirm && lead.status !== 'converted' && (
            <Card className="border-success-500">
              <CardBody>
                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    <h3 className="font-semibold text-ink-900">Convert to Order?</h3>
                    <p className="text-sm text-ink-500 mt-1">
                      This will create a new order for {lead.customerName} and mark this lead as
                      converted.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setShowConvertConfirm(false)}
                    >
                      Cancel
                    </Button>
                    <Button variant="success" size="sm" onClick={handleConvertToOrder}>
                      Confirm
                    </Button>
                  </div>
                </div>
              </CardBody>
            </Card>
          )}
        </div>

        {/* Right Column - Timeline */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <h2 className="text-[15px] font-semibold text-ink-900">Activity Timeline</h2>
            </CardHeader>
            <CardBody className="px-6 py-4">
              {sortedActivities.length === 0 ? (
                <p className="text-sm text-ink-400 text-center py-8">No activity recorded yet</p>
              ) : (
                <div className="relative">
                  {/* Vertical line */}
                  <div className="absolute left-4 top-2 bottom-2 w-px bg-ink-100" />

                  <div className="space-y-6">
                    {sortedActivities.map(activity => {
                      const Icon = activityIconMap[activity.type] ?? MessageSquare
                      const colorClass = activityColorMap[activity.type] ?? 'bg-ink-100 text-ink-600'
                      return (
                        <div key={activity.id} className="relative flex gap-4 pl-0">
                          {/* Dot */}
                          <div
                            className={`relative z-10 flex items-center justify-center w-8 h-8 rounded-full shrink-0 ${colorClass}`}
                          >
                            <Icon size={14} />
                          </div>
                          {/* Content */}
                          <div className="flex-1 min-w-0 pt-0.5">
                            <p className="text-sm text-ink-700">{activity.description}</p>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-xs text-ink-400">
                                {formatTimestamp(activity.createdAt)}
                              </span>
                              <span className="text-xs text-ink-300">|</span>
                              <span className="text-xs text-ink-400">{resolveActor(activity.createdBy)}</span>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-400">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-ink-800">{value}</dd>
    </div>
  )
}

function formatTimestamp(iso: string): string {
  return formatIndianDateTime(iso)
}
