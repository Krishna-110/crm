import { useState, useMemo, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useApp } from '@/context/AppContext'
import { leadsApi } from '@/api/leads'
import { medicinesApi } from '@/api/medicines'
import { ApiError } from '@/api/client'
import { emitToast } from '@/lib/toast'
import { formatIndianDate } from '@/lib/dateUtils'
import type { Lead, LeadStatus, LeadSource } from '@/types'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { SearchInput } from '@/components/ui/SearchInput'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import { PageHeader } from '@/components/ui/PageHeader'
import { Tabs } from '@/components/ui/Tabs'
import { EmptyState } from '@/components/ui/EmptyState'
import { LeadStatusBadge } from '@/components/ui/StatusBadge'
import {
  Plus,
  Eye,
  Edit2,
  Trash2,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Users,
  ShoppingCart,
} from 'lucide-react'

type SortField = 'customerName' | 'createdDate'
type SortDir = 'asc' | 'desc'

const statusFilterTabs: { key: string; label: string; match: LeadStatus | null }[] = [
  { key: 'all', label: 'All', match: null },
  { key: 'new', label: 'New', match: 'new' },
  { key: 'contacted', label: 'Contacted', match: 'contacted' },
  { key: 'follow_up', label: 'Follow-up', match: 'follow_up_pending' },
  { key: 'interested', label: 'Interested', match: 'interested' },
  { key: 'converted', label: 'Converted', match: 'converted' },
]

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

const leadSourceOptions: { value: LeadSource; label: string }[] = [
  { value: 'website', label: 'Website' },
  { value: 'referral', label: 'Referral' },
  { value: 'walk_in', label: 'Walk-in' },
  { value: 'phone', label: 'Phone' },
  { value: 'social_media', label: 'Social Media' },
  { value: 'advertisement', label: 'Advertisement' },
  { value: 'other', label: 'Other' },
]

type LeadMedicineRow = {
  id: string
  name: string
  days: string
}

type LeadForm = {
  customerName: string
  mobile: string
  alternateNumber: string
  address: string
  city: string
  state: string
  pincode: string
  disease: string
  medicines: LeadMedicineRow[]
  doctorName: string
  notes: string
  leadSource: LeadSource
  assignedCaller: string
  status: LeadStatus
  nextFollowUp: string
  paymentScreenshot: string
}

function emptyMedicineRow(): LeadMedicineRow {
  return { id: crypto.randomUUID(), name: '', days: '1' }
}

const emptyForm: LeadForm = {
  customerName: '',
  mobile: '',
  alternateNumber: '',
  address: '',
  city: '',
  state: '',
  pincode: '',
  disease: '',
  medicines: [{ id: 'new-medicine-1', name: '', days: '1' }],
  doctorName: '',
  notes: '',
  leadSource: 'phone',
  assignedCaller: '',
  status: 'new',
  nextFollowUp: '',
  paymentScreenshot: '',
}

export function Leads() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState('all')
  const [showModal, setShowModal] = useState(false)
  const [editingLead, setEditingLead] = useState<Lead | null>(null)
  const [convertingLead, setConvertingLead] = useState<Lead | null>(null)
  const [form, setForm] = useState<LeadForm>(emptyForm)
  const [sortField, setSortField] = useState<SortField>('createdDate')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const callers = state.users.filter(u => u.role === 'caller')

  const medicineOptions = state.medicines
    .filter(m => m.isActive)
    .map(m => ({ id: m.id, label: m.name, sublabel: m.genericName }))

  function updateMedicineRow(rowId: string, updates: Partial<Pick<LeadMedicineRow, 'name' | 'days'>>) {
    setForm(f => ({
      ...f,
      medicines: f.medicines.map(row => (row.id === rowId ? { ...row, ...updates } : row)),
    }))
  }

  function addMedicineRow() {
    setForm(f => ({ ...f, medicines: [...f.medicines, emptyMedicineRow()] }))
  }

  function removeMedicineRow(rowId: string) {
    setForm(f => ({
      ...f,
      medicines: f.medicines.length > 1 ? f.medicines.filter(row => row.id !== rowId) : f.medicines,
    }))
  }

  async function createMedicineForRow(rowId: string, name: string) {
    try {
      const medicine = await medicinesApi.create({ name })
      dispatch({ type: 'ADD_MEDICINE', payload: { medicine } })
    } catch (err) {
      // Callers can't write to the catalog (403) — fall back to free text; the lead
      // still captures the medicine name, it just won't have a catalog product link.
      if (!(err instanceof ApiError && err.status === 403)) {
        emitToast(err instanceof Error ? err.message : 'Failed to create medicine')
      }
    }
    updateMedicineRow(rowId, { name })
  }

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = { all: state.leads.length }
    for (const tab of statusFilterTabs) {
      if (tab.match) {
        counts[tab.key] = state.leads.filter(l => l.status === tab.match).length
      }
    }
    return counts
  }, [state.leads])

  const filtered = useMemo(() => {
    let list = state.leads

    // status tab filter
    const tab = statusFilterTabs.find(t => t.key === activeTab)
    if (tab?.match) {
      list = list.filter(l => l.status === tab.match)
    }

    // search filter
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(
        l =>
          l.customerName.toLowerCase().includes(q) ||
          l.mobile.toLowerCase().includes(q) ||
          (l.disease ?? '').toLowerCase().includes(q),
      )
    }

    // sort
    const sorted = [...list].sort((a, b) => {
      let cmp = 0
      if (sortField === 'customerName') {
        cmp = a.customerName.localeCompare(b.customerName)
      } else if (sortField === 'createdDate') {
        cmp = a.createdDate.localeCompare(b.createdDate)
      }
      return sortDir === 'asc' ? cmp : -cmp
    })

    return sorted
  }, [state.leads, activeTab, search, sortField, sortDir])

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field) return <ChevronsUpDown size={14} className="text-ink-300" />
    return sortDir === 'asc' ? (
      <ChevronUp size={14} className="text-primary-600" />
    ) : (
      <ChevronDown size={14} className="text-primary-600" />
    )
  }

  function openCreate() {
    setEditingLead(null)
    setForm({ ...emptyForm, medicines: [emptyMedicineRow()] })
    setShowModal(true)
  }

  function openEdit(lead: Lead) {
    setEditingLead(lead)
    setForm({
      customerName: lead.customerName,
      mobile: lead.mobile,
      alternateNumber: lead.alternateNumber ?? '',
      address: lead.address,
      city: lead.city,
      state: lead.state,
      pincode: lead.pincode,
      disease: lead.disease ?? '',
      medicines: lead.medicines.length
        ? lead.medicines.map(m => ({ id: m.id, name: m.name, days: String(m.days) }))
        : [emptyMedicineRow()],
      doctorName: lead.doctorName ?? '',
      notes: lead.notes ?? '',
      leadSource: lead.leadSource,
      assignedCaller: lead.assignedCaller ?? '',
      status: lead.status,
      nextFollowUp: lead.nextFollowUp ?? '',
      paymentScreenshot: lead.paymentScreenshot ?? '',
    })
    setShowModal(true)
  }

  // Lead Detail's "Edit" button navigates here with the lead id in location state
  // (rather than duplicating this whole form on that page) — open its edit modal
  // automatically, then clear the state so it doesn't reopen on a later visit.
  useEffect(() => {
    const editLeadId = (location.state as { editLeadId?: string } | null)?.editLeadId
    if (!editLeadId) return
    const lead = state.leads.find(l => l.id === editLeadId)
    if (lead) openEdit(lead)
    navigate(location.pathname, { replace: true, state: null })
  }, [location.state])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const medicines = form.medicines
      .filter(row => row.name.trim())
      .map(row => ({ id: row.id, name: row.name.trim(), days: Number(row.days) || 1 }))
    if (!editingLead && medicines.length === 0) return

    if (editingLead && form.status === 'sold') {
      if (!form.address.trim()) {
        emitToast('Customer Address is required when Lead Status is Sold')
        return
      }
      if (!form.pincode.trim()) {
        emitToast('Pincode is required when Lead Status is Sold')
        return
      }
      if (!form.paymentScreenshot.trim()) {
        emitToast('Payment Screenshot is required when Lead Status is Sold')
        return
      }
    }

    const payload = {
      customerName: form.customerName,
      mobile: form.mobile,
      alternateNumber: form.alternateNumber || undefined,
      address: form.address,
      city: form.city,
      state: form.state,
      pincode: form.pincode,
      disease: form.disease,
      // Editing a lead with no medicines yet (added later via comments) shouldn't wipe
      // that out — only send this key when there's something to bulk-replace with, since
      // the backend treats a present `medicines` array as "replace all of them".
      ...(medicines.length > 0 ? { medicines } : {}),
      doctorName: form.doctorName || undefined,
      notes: form.notes || undefined,
      leadSource: form.leadSource,
      assignedCaller: form.assignedCaller || undefined,
      // Status/next follow-up only make sense to set once a lead already exists —
      // a new lead always starts at 'new' with no follow-up scheduled yet.
      ...(editingLead ? {
        status: form.status,
        nextFollowUp: form.nextFollowUp || undefined,
        paymentScreenshot: form.paymentScreenshot || undefined,
      } : {}),
    }

    try {
      if (editingLead) {
        const lead = await leadsApi.update(editingLead.id, payload)
        dispatch({ type: 'UPDATE_LEAD', payload: { id: lead.id, updates: lead } })
      } else {
        const lead = await leadsApi.create(payload)
        dispatch({ type: 'ADD_LEAD', payload: { lead } })
      }
      setShowModal(false)
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to save lead')
    }
  }

  async function deleteLead(id: string) {
    try {
      await leadsApi.remove(id)
      dispatch({ type: 'DELETE_LEAD', payload: { id } })
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to delete lead')
    }
  }

  async function handleConvertToOrder() {
    if (!convertingLead) return
    try {
      const { order, lead: updatedLead } = await leadsApi.convert(convertingLead.id)
      dispatch({ type: 'ADD_ORDER', payload: { order } })
      dispatch({ type: 'UPDATE_LEAD', payload: { id: updatedLead.id, updates: updatedLead } })
      emitToast(`Lead ${convertingLead.customerName} converted to order ${order.orderNumber}!`, 'success')
      setConvertingLead(null)
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to convert lead')
    }
  }

  function getCallerName(id?: string) {
    if (!id) return '-'
    return state.users.find(u => u.id === id)?.name ?? '-'
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Lead Management"
        description={`${state.leads.length} total leads`}
        actions={
          <Button icon={<Plus size={16} />} onClick={openCreate}>
            Add Lead
          </Button>
        }
      />

      {/* Search */}
      <SearchInput
        value={search}
        onChange={setSearch}
        ariaLabel="Filter leads"
        placeholder="Search by name, mobile, or disease..."
      />

      {/* Filter Tabs */}
      <Tabs
        tabs={statusFilterTabs.map(tab => ({
          id: tab.key,
          label: tab.label,
          count: tabCounts[tab.key] ?? 0,
        }))}
        activeTab={activeTab}
        onChange={setActiveTab}
      />

      {/* Table */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 bg-ink-50/50">
                <th
                  className="pl-5 pr-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400 cursor-pointer select-none"
                  onClick={() => handleSort('customerName')}
                >
                  <span className="inline-flex items-center gap-1">
                    Customer Name <SortIcon field="customerName" />
                  </span>
                </th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Mobile</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Disease</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Lead Status</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Assigned To</th>
                <th
                  className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400 cursor-pointer select-none"
                  onClick={() => handleSort('createdDate')}
                >
                  <span className="inline-flex items-center gap-1">
                    Next Follow-up <SortIcon field="createdDate" />
                  </span>
                </th>
                <th className="pl-3 pr-5 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(lead => (
                <tr
                  key={lead.id}
                  onClick={() => navigate(`/leads/${lead.id}`)}
                  className="cursor-pointer border-b border-ink-50 last:border-0 hover:bg-primary-50/30 transition-colors"
                >
                  <td className="pl-5 pr-3 py-3.5 font-medium text-ink-900">{lead.customerName}</td>
                  <td className="px-3 py-3.5 text-ink-600">{lead.mobile}</td>
                  <td className="px-3 py-3.5 text-ink-600">{lead.disease || '-'}</td>
                  <td className="px-3 py-3.5">
                    <LeadStatusBadge status={lead.status} />
                  </td>
                  <td className="px-3 py-3.5 text-ink-600">{getCallerName(lead.assignedCaller)}</td>
                  <td className="px-3 py-3.5 text-xs text-ink-500">{formatIndianDate(lead.nextFollowUp)}</td>
                  <td className="pl-3 pr-5 py-3.5 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => navigate(`/leads/${lead.id}`)}
                        className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700 transition-colors"
                        title="View"
                      >
                        <Eye size={15} />
                      </button>
                      <button
                        onClick={() => openEdit(lead)}
                        className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700 transition-colors"
                        title="Edit"
                      >
                        <Edit2 size={15} />
                      </button>
                      {lead.status !== 'converted' && (
                        <button
                          onClick={() => setConvertingLead(lead)}
                          className="rounded-lg p-1.5 text-success-600 hover:bg-success-50 hover:text-success-700 transition-colors"
                          title="Convert to Order"
                        >
                          <ShoppingCart size={15} />
                        </button>
                      )}
                      <button
                        onClick={() => deleteLead(lead.id)}
                        className="rounded-lg p-1.5 text-ink-400 hover:bg-danger-50 hover:text-danger-600 transition-colors"
                        title="Delete"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <EmptyState
              icon={<Users size={26} />}
              title="No leads found"
              description="Try adjusting your search or filters, or add a new lead to get started."
            />
          )}
        </div>
      </Card>

      {/* Add / Edit Modal */}
      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={editingLead ? 'Edit Lead' : 'Add New Lead'}
        size="xl"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Customer Info */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="field-label" htmlFor="leads-customer-name">Customer Name</label>
              <input
                id="leads-customer-name"
                type="text"
                required
                value={form.customerName}
                onChange={e => setForm(f => ({ ...f, customerName: e.target.value }))}
                className="field-input"
              />
            </div>
            <div>
              <label className="field-label" htmlFor="leads-mobile-number">Mobile Number</label>
              <input
                id="leads-mobile-number"
                type="tel"
                required
                value={form.mobile}
                onChange={e => setForm(f => ({ ...f, mobile: e.target.value }))}
                className="field-input"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="field-label" htmlFor="leads-alternate-number">Alternate Number</label>
              <input
                id="leads-alternate-number"
                type="tel"
                value={form.alternateNumber}
                onChange={e => setForm(f => ({ ...f, alternateNumber: e.target.value }))}
                className="field-input"
              />
            </div>
            <div>
              <label className="field-label" htmlFor="leads-address">Address</label>
              <input
                id="leads-address"
                type="text"
                required
                value={form.address}
                onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                className="field-input"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="field-label" htmlFor="leads-city">City</label>
              <input
                id="leads-city"
                type="text"
                required
                value={form.city}
                onChange={e => setForm(f => ({ ...f, city: e.target.value }))}
                className="field-input"
              />
            </div>
            <div>
              <label className="field-label" htmlFor="leads-state">State</label>
              <input
                id="leads-state"
                type="text"
                required
                value={form.state}
                onChange={e => setForm(f => ({ ...f, state: e.target.value }))}
                className="field-input"
              />
            </div>
            <div>
              <label className="field-label" htmlFor="leads-pincode">Pincode</label>
              <input
                id="leads-pincode"
                type="text"
                required
                value={form.pincode}
                onChange={e => setForm(f => ({ ...f, pincode: e.target.value }))}
                className="field-input"
              />
            </div>
          </div>

          {/* Disease */}
          <div>
            <label className="field-label" htmlFor="leads-disease">Disease</label>
            <input
              id="leads-disease"
              type="text"
              required={!editingLead}
              value={form.disease}
              onChange={e => setForm(f => ({ ...f, disease: e.target.value }))}
              className="field-input"
              placeholder="e.g. Diabetes Type 2"
            />
          </div>

          {/* Medicines Required */}
          <div>
            <span className="field-label" id="leads-medicines-label">Medicines Required</span>
            <div className="space-y-3" role="group" aria-labelledby="leads-medicines-label">
              {form.medicines.map((row, idx) => (
                <div key={row.id} className="flex items-start gap-2">
                  <div className="flex-1">
                    <SearchableSelect
                      value={row.name}
                      onChange={name => updateMedicineRow(row.id, { name })}
                      options={medicineOptions}
                      placeholder="Search medicines..."
                      ariaLabel={`Medicine ${idx + 1}`}
                      onCreateNew={name => createMedicineForRow(row.id, name)}
                      emptyText="No medicines found"
                      required={idx === 0 && !editingLead}
                    />
                  </div>
                  <div className="w-28">
                    <input
                      type="number"
                      min={1}
                      required={idx === 0 && !editingLead}
                      value={row.days}
                      onChange={e => updateMedicineRow(row.id, { days: e.target.value })}
                      placeholder="Days"
                      aria-label={`Days supply for medicine ${idx + 1}`}
                      className="field-input"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeMedicineRow(row.id)}
                    disabled={form.medicines.length === 1}
                    title="Remove medicine"
                    className="mt-0.5 shrink-0 rounded-lg p-2 text-ink-400 transition-colors hover:bg-danger-50 hover:text-danger-600 disabled:pointer-events-none disabled:opacity-30"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addMedicineRow}
              className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary-600 hover:text-primary-700"
            >
              <Plus size={15} /> Add Another Medicine
            </button>
          </div>

          <div>
            <label className="field-label" htmlFor="leads-doctor-name-optional">Doctor Name (optional)</label>
            <input
              id="leads-doctor-name-optional"
              type="text"
              value={form.doctorName}
              onChange={e => setForm(f => ({ ...f, doctorName: e.target.value }))}
              className="field-input"
            />
          </div>

          <div>
            <label className="field-label" htmlFor="leads-notes-optional">Notes (optional)</label>
            <textarea
              id="leads-notes-optional"
              rows={2}
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Any additional context about this lead..."
              className="field-input resize-none"
            />
          </div>

          {/* Lead Meta */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="field-label" htmlFor="leads-lead-source">Lead Source</label>
              <select
                id="leads-lead-source"
                value={form.leadSource}
                onChange={e => setForm(f => ({ ...f, leadSource: e.target.value as LeadSource }))}
                className="field-input"
              >
                {leadSourceOptions.map(o => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="leads-assigned-caller">Assigned Caller</label>
              <select
                id="leads-assigned-caller"
                value={form.assignedCaller}
                onChange={e => setForm(f => ({ ...f, assignedCaller: e.target.value }))}
                className="field-input"
              >
                <option value="">Unassigned</option>
                {callers.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {editingLead && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="field-label" htmlFor="leads-lead-status">Lead Status</label>
                  <select
                    id="leads-lead-status"
                    value={form.status}
                    onChange={e => setForm(f => ({ ...f, status: e.target.value as LeadStatus }))}
                    className="field-input"
                    disabled={form.status === 'converted'}
                  >
                    {form.status === 'converted' && <option value="converted">Converted</option>}
                    {editableStatusOptions.map(o => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="leads-next-follow-up">Next Follow-up</label>
                  <input
                    id="leads-next-follow-up"
                    type="date"
                    value={form.nextFollowUp}
                    onChange={e => setForm(f => ({ ...f, nextFollowUp: e.target.value }))}
                    className="field-input"
                  />
                </div>
              </div>

              <div>
                <label className="field-label">
                  Payment Screenshot {form.status === 'sold' && <span className="text-danger-500">*</span>}
                </label>
                <div className="space-y-2">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={e => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      if (file.size > 5 * 1024 * 1024) {
                        emitToast('Image size should be under 5MB')
                        return
                      }
                      const reader = new FileReader()
                      reader.onloadend = () => {
                        setForm(f => ({ ...f, paymentScreenshot: reader.result as string }))
                      }
                      reader.readAsDataURL(file)
                    }}
                    className="field-input py-1.5 text-xs text-ink-600 file:mr-3 file:rounded-lg file:border-0 file:bg-primary-50 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-primary-700 hover:file:bg-primary-100"
                  />
                  {form.paymentScreenshot && (
                    <div className="relative inline-block mt-2 rounded-xl border border-ink-200 overflow-hidden bg-ink-50 p-1">
                      <img src={form.paymentScreenshot} alt="Payment Screenshot" className="h-28 max-w-full object-contain rounded-lg" />
                      <button
                        type="button"
                        onClick={() => setForm(f => ({ ...f, paymentScreenshot: '' }))}
                        className="absolute top-2 right-2 rounded-full bg-danger-600 p-1 text-white shadow hover:bg-danger-700"
                        title="Remove image"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          <div className="flex justify-end gap-3 pt-4 border-t border-ink-200">
            <Button type="button" variant="secondary" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button type="submit">{editingLead ? 'Update' : 'Add'} Lead</Button>
          </div>
        </form>
      </Modal>

      {/* Convert to Order Confirmation Modal */}
      <Modal
        isOpen={!!convertingLead}
        onClose={() => setConvertingLead(null)}
        title="Convert Lead to Order"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-600">
            Are you sure you want to convert the lead for <span className="font-semibold text-ink-900">{convertingLead?.customerName}</span> into an order? This will create a new order, deduct stock, and update the lead status.
          </p>
          <div className="flex justify-end gap-3 pt-3 border-t border-ink-100">
            <Button type="button" variant="secondary" onClick={() => setConvertingLead(null)}>
              Cancel
            </Button>
            <Button type="button" variant="success" onClick={handleConvertToOrder}>
              Confirm Conversion
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
