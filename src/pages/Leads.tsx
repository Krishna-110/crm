import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '@/context/AppContext'
import { leadsApi } from '@/api/leads'
import { medicinesApi } from '@/api/medicines'
import { ApiError } from '@/api/client'
import { emitToast } from '@/lib/toast'
import type { Lead, LeadStatus, LeadPriority, LeadSource, Medicine } from '@/types'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
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
} from 'lucide-react'

type SortField = 'customerName' | 'createdDate' | 'priority'
type SortDir = 'asc' | 'desc'

const priorityOrder: Record<LeadPriority, number> = { low: 0, medium: 1, high: 2, urgent: 3 }

const priorityBadgeVariant: Record<LeadPriority, 'default' | 'primary' | 'warning' | 'danger'> = {
  low: 'default',
  medium: 'primary',
  high: 'warning',
  urgent: 'danger',
}

const statusFilterTabs: { key: string; label: string; match: LeadStatus | null }[] = [
  { key: 'all', label: 'All', match: null },
  { key: 'new', label: 'New', match: 'new' },
  { key: 'contacted', label: 'Contacted', match: 'contacted' },
  { key: 'follow_up', label: 'Follow-up', match: 'follow_up_pending' },
  { key: 'interested', label: 'Interested', match: 'interested' },
  { key: 'converted', label: 'Converted', match: 'converted' },
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

const priorityOptions: { value: LeadPriority; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
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
  medicines: LeadMedicineRow[]
  doctorName: string
  leadSource: LeadSource
  priority: LeadPriority
  assignedCaller: string
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
  medicines: [{ id: 'new-medicine-1', name: '', days: '1' }],
  doctorName: '',
  leadSource: 'phone',
  priority: 'medium',
  assignedCaller: '',
}

export function Leads() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState('all')
  const [showModal, setShowModal] = useState(false)
  const [editingLead, setEditingLead] = useState<Lead | null>(null)
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
          l.medicines.some(m => m.name.toLowerCase().includes(q)),
      )
    }

    // sort
    const sorted = [...list].sort((a, b) => {
      let cmp = 0
      if (sortField === 'customerName') {
        cmp = a.customerName.localeCompare(b.customerName)
      } else if (sortField === 'createdDate') {
        cmp = a.createdDate.localeCompare(b.createdDate)
      } else if (sortField === 'priority') {
        cmp = priorityOrder[a.priority] - priorityOrder[b.priority]
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
      medicines: lead.medicines.length
        ? lead.medicines.map(m => ({ id: m.id, name: m.name, days: String(m.days) }))
        : [emptyMedicineRow()],
      doctorName: lead.doctorName ?? '',
      leadSource: lead.leadSource,
      priority: lead.priority,
      assignedCaller: lead.assignedCaller ?? '',
    })
    setShowModal(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const medicines = form.medicines
      .filter(row => row.name.trim())
      .map(row => ({ id: row.id, name: row.name.trim(), days: Number(row.days) || 1 }))
    if (medicines.length === 0) return

    const payload = {
      customerName: form.customerName,
      mobile: form.mobile,
      alternateNumber: form.alternateNumber || undefined,
      address: form.address,
      city: form.city,
      state: form.state,
      pincode: form.pincode,
      medicines,
      doctorName: form.doctorName || undefined,
      leadSource: form.leadSource,
      priority: form.priority,
      assignedCaller: form.assignedCaller || undefined,
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
        placeholder="Search by name, mobile, or medicine..."
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
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Medicines</th>
                <th
                  className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400 cursor-pointer select-none"
                  onClick={() => handleSort('priority')}
                >
                  <span className="inline-flex items-center gap-1">
                    Priority <SortIcon field="priority" />
                  </span>
                </th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Status</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Assigned To</th>
                <th
                  className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400 cursor-pointer select-none"
                  onClick={() => handleSort('createdDate')}
                >
                  <span className="inline-flex items-center gap-1">
                    Next Follow-up <SortIcon field="createdDate" />
                  </span>
                </th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Actions</th>
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
                  <td className="px-3 py-3.5 text-ink-600">
                    {lead.medicines[0] ? `${lead.medicines[0].name} · ${lead.medicines[0].days}d` : '-'}
                    {lead.medicines.length > 1 && (
                      <span className="ml-1 text-xs text-ink-500">+{lead.medicines.length - 1} more</span>
                    )}
                  </td>
                  <td className="px-3 py-3.5">
                    <Badge variant={priorityBadgeVariant[lead.priority]}>
                      {lead.priority.charAt(0).toUpperCase() + lead.priority.slice(1)}
                    </Badge>
                  </td>
                  <td className="px-3 py-3.5">
                    <LeadStatusBadge status={lead.status} />
                  </td>
                  <td className="px-3 py-3.5 text-ink-600">{getCallerName(lead.assignedCaller)}</td>
                  <td className="px-3 py-3.5 text-xs text-ink-500">{lead.nextFollowUp ?? '-'}</td>
                  <td className="px-3 py-3.5" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-1">
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
              <label className="field-label">Customer Name</label>
              <input
                type="text"
                required
                value={form.customerName}
                onChange={e => setForm(f => ({ ...f, customerName: e.target.value }))}
                className="field-input"
              />
            </div>
            <div>
              <label className="field-label">Mobile Number</label>
              <input
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
              <label className="field-label">Alternate Number</label>
              <input
                type="tel"
                value={form.alternateNumber}
                onChange={e => setForm(f => ({ ...f, alternateNumber: e.target.value }))}
                className="field-input"
              />
            </div>
            <div>
              <label className="field-label">Address</label>
              <input
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
              <label className="field-label">City</label>
              <input
                type="text"
                required
                value={form.city}
                onChange={e => setForm(f => ({ ...f, city: e.target.value }))}
                className="field-input"
              />
            </div>
            <div>
              <label className="field-label">State</label>
              <input
                type="text"
                required
                value={form.state}
                onChange={e => setForm(f => ({ ...f, state: e.target.value }))}
                className="field-input"
              />
            </div>
            <div>
              <label className="field-label">Pincode</label>
              <input
                type="text"
                required
                value={form.pincode}
                onChange={e => setForm(f => ({ ...f, pincode: e.target.value }))}
                className="field-input"
              />
            </div>
          </div>

          {/* Medicines Required */}
          <div>
            <label className="field-label">Medicines Required</label>
            <div className="space-y-3">
              {form.medicines.map((row, idx) => (
                <div key={row.id} className="flex items-start gap-2">
                  <div className="flex-1">
                    <SearchableSelect
                      value={row.name}
                      onChange={name => updateMedicineRow(row.id, { name })}
                      options={medicineOptions}
                      placeholder="Search medicines..."
                      onCreateNew={name => createMedicineForRow(row.id, name)}
                      emptyText="No medicines found"
                      required={idx === 0}
                    />
                  </div>
                  <div className="w-28">
                    <input
                      type="number"
                      min={1}
                      required={idx === 0}
                      value={row.days}
                      onChange={e => updateMedicineRow(row.id, { days: e.target.value })}
                      placeholder="Days"
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
            <label className="field-label">Doctor Name (optional)</label>
            <input
              type="text"
              value={form.doctorName}
              onChange={e => setForm(f => ({ ...f, doctorName: e.target.value }))}
              className="field-input"
            />
          </div>

          {/* Lead Meta */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="field-label">Lead Source</label>
              <select
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
              <label className="field-label">Priority</label>
              <select
                value={form.priority}
                onChange={e => setForm(f => ({ ...f, priority: e.target.value as LeadPriority }))}
                className="field-input"
              >
                {priorityOptions.map(o => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label">Assigned Caller</label>
              <select
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

          <div className="flex justify-end gap-3 pt-4 border-t border-ink-200">
            <Button type="button" variant="secondary" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button type="submit">{editingLead ? 'Update' : 'Add'} Lead</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
