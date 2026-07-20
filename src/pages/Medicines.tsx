import { useState } from 'react'
import { useApp } from '@/context/AppContext'
import { medicinesApi } from '@/api/medicines'
import { emitToast } from '@/lib/toast'
import type { Medicine, DosageForm } from '@/types'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { SearchInput } from '@/components/ui/SearchInput'
import { PageHeader } from '@/components/ui/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { Plus, Edit2, Trash2, Pill } from 'lucide-react'

const dosageFormOptions: { value: DosageForm; label: string }[] = [
  { value: 'tablet', label: 'Tablet' },
  { value: 'capsule', label: 'Capsule' },
  { value: 'syrup', label: 'Syrup' },
  { value: 'injection', label: 'Injection' },
  { value: 'other', label: 'Other' },
]

const dosageFormLabel: Record<DosageForm, string> = {
  tablet: 'Tablet',
  capsule: 'Capsule',
  syrup: 'Syrup',
  injection: 'Injection',
  other: 'Other',
}

function formatPrice(price: number) {
  return `₹${price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

type MedicineForm = {
  name: string
  genericName: string
  dosageForm: DosageForm
  unitPrice: string
}

const emptyForm: MedicineForm = {
  name: '',
  genericName: '',
  dosageForm: 'tablet',
  unitPrice: '',
}

export function Medicines() {
  const { state, dispatch } = useApp()
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [editingMedicine, setEditingMedicine] = useState<Medicine | null>(null)
  const [form, setForm] = useState<MedicineForm>(emptyForm)

  const filtered = state.medicines.filter(
    m =>
      m.name.toLowerCase().includes(search.toLowerCase()) ||
      (m.genericName ?? '').toLowerCase().includes(search.toLowerCase()),
  )

  const activeCount = state.medicines.filter(m => m.isActive).length

  function openCreate() {
    setEditingMedicine(null)
    setForm(emptyForm)
    setShowModal(true)
  }

  function openEdit(medicine: Medicine) {
    setEditingMedicine(medicine)
    setForm({
      name: medicine.name,
      genericName: medicine.genericName ?? '',
      dosageForm: medicine.dosageForm ?? 'tablet',
      unitPrice: String(medicine.unitPrice),
    })
    setShowModal(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const updates = {
      name: form.name,
      genericName: form.genericName || undefined,
      dosageForm: form.dosageForm,
      unitPrice: Number(form.unitPrice) || 0,
    }
    try {
      if (editingMedicine) {
        const medicine = await medicinesApi.update(editingMedicine.id, updates)
        dispatch({ type: 'UPDATE_MEDICINE', payload: { id: medicine.id, updates: medicine } })
      } else {
        const medicine = await medicinesApi.create(updates)
        dispatch({ type: 'ADD_MEDICINE', payload: { medicine } })
      }
      setShowModal(false)
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to save medicine')
    }
  }

  async function toggleStatus(medicine: Medicine) {
    try {
      const updated = await medicinesApi.update(medicine.id, { isActive: !medicine.isActive })
      dispatch({ type: 'UPDATE_MEDICINE', payload: { id: updated.id, updates: updated } })
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to update medicine status')
    }
  }

  async function deleteMedicine(id: string) {
    try {
      await medicinesApi.remove(id)
      dispatch({ type: 'DELETE_MEDICINE', payload: { id } })
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to delete medicine')
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Medicines"
        description={`${state.medicines.length} medicines · ${activeCount} active`}
        actions={<Button icon={<Plus size={16} />} onClick={openCreate}>Add Medicine</Button>}
      />

      <SearchInput value={search} onChange={setSearch} placeholder="Search by medicine or generic name..." className="max-w-md" />

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 bg-ink-50/50">
                {['Medicine', 'Generic Name', 'Dosage Form', 'Unit Price', 'Status', ''].map((h, i) => (
                  <th key={i} className={`py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400 ${i === 0 ? 'pl-5 pr-3' : 'px-3'}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(medicine => (
                <tr key={medicine.id} className="border-b border-ink-50 transition-colors last:border-0 hover:bg-primary-50/30">
                  <td className="py-3 pl-5 pr-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-teal-500 to-teal-600 text-white">
                        <Pill size={16} />
                      </div>
                      <div className="font-medium text-ink-900">{medicine.name}</div>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-ink-600">{medicine.genericName || '-'}</td>
                  <td className="px-3 py-3">
                    <Badge variant="default">{medicine.dosageForm ? dosageFormLabel[medicine.dosageForm] : '-'}</Badge>
                  </td>
                  <td className="px-3 py-3 font-medium text-ink-900">{formatPrice(medicine.unitPrice)}</td>
                  <td className="px-3 py-3">
                    <button onClick={() => toggleStatus(medicine)} title="Toggle status">
                      <Badge variant={medicine.isActive ? 'success' : 'default'} dot>
                        {medicine.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </button>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1">
                      <button onClick={() => openEdit(medicine)} className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-700"><Edit2 size={15} /></button>
                      <button onClick={() => deleteMedicine(medicine.id)} className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-danger-50 hover:text-danger-600"><Trash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <EmptyState icon={<Pill size={26} />} title="No medicines found" description="Try adjusting your search or add a new medicine to the catalog." />
          )}
        </div>
      </Card>

      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={editingMedicine ? 'Edit Medicine' : 'Add Medicine'}
        description={editingMedicine ? 'Update this medicine’s catalog details.' : 'Add a new medicine to the catalog.'}
        size="md"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="field-label">Medicine Name</label>
            <input type="text" required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="field-input" placeholder="e.g. Metformin 500mg" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="field-label">Generic Name</label>
              <input type="text" value={form.genericName} onChange={e => setForm(f => ({ ...f, genericName: e.target.value }))} className="field-input" placeholder="e.g. Metformin" />
            </div>
            <div>
              <label className="field-label">Dosage Form</label>
              <select value={form.dosageForm} onChange={e => setForm(f => ({ ...f, dosageForm: e.target.value as DosageForm }))} className="field-input">
                {dosageFormOptions.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="field-label">Unit Price (₹)</label>
            <input type="number" min={0} step="0.01" required value={form.unitPrice} onChange={e => setForm(f => ({ ...f, unitPrice: e.target.value }))} className="field-input" placeholder="0.00" />
          </div>
          <div className="flex justify-end gap-3 border-t border-ink-100 pt-4">
            <Button type="button" variant="secondary" onClick={() => setShowModal(false)}>Cancel</Button>
            <Button type="submit">{editingMedicine ? 'Save Changes' : 'Add Medicine'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
