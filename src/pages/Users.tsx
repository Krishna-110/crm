import { useState } from 'react'
import { useApp } from '@/context/AppContext'
import { usersApi } from '@/api/users'
import { emitToast } from '@/lib/toast'
import type { User, UserRole } from '@/types'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { SearchInput } from '@/components/ui/SearchInput'
import { PageHeader } from '@/components/ui/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { Plus, Edit2, Trash2, Shield, Phone as PhoneIcon, UserCog } from 'lucide-react'

const roleBadgeVariant: Record<UserRole, 'warning' | 'info'> = {
  admin: 'warning',
  caller: 'info',
}

const roleLabel: Record<UserRole, string> = {
  admin: 'Admin',
  caller: 'Caller',
}

const avatarGradients = [
  'from-primary-500 to-primary-700',
  'from-teal-500 to-teal-600',
  'from-warning-500 to-warning-600',
  'from-danger-500 to-danger-600',
  'from-success-500 to-success-600',
]

export function Users() {
  const { state, dispatch } = useApp()
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [editingUser, setEditingUser] = useState<User | null>(null)
  const [form, setForm] = useState({ name: '', employeeId: '', phone: '', email: '', role: 'caller' as UserRole, password: '' })

  const filtered = state.users.filter(
    (u) =>
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      u.employeeId.toLowerCase().includes(search.toLowerCase())
  )

  const activeCount = state.users.filter((u) => u.status === 'active').length

  function openCreate() {
    setEditingUser(null)
    setForm({ name: '', employeeId: '', phone: '', email: '', role: 'caller', password: '' })
    setShowModal(true)
  }

  function openEdit(user: User) {
    setEditingUser(user)
    setForm({ name: user.name, employeeId: user.employeeId, phone: user.phone, email: user.email, role: user.role, password: '' })
    setShowModal(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    try {
      if (editingUser) {
        const user = await usersApi.update(editingUser.id, { ...form })
        dispatch({ type: 'UPDATE_USER', payload: { id: user.id, updates: user } })
      } else {
        const user = await usersApi.create({ ...form })
        dispatch({ type: 'ADD_USER', payload: { user } })
      }
      setShowModal(false)
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to save user')
    }
  }

  async function toggleStatus(user: User) {
    try {
      const updated = await usersApi.update(user.id, { status: user.status === 'active' ? 'inactive' : 'active' })
      dispatch({ type: 'UPDATE_USER', payload: { id: updated.id, updates: updated } })
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to update user status')
    }
  }

  async function deleteUser(id: string) {
    try {
      await usersApi.remove(id)
      dispatch({ type: 'DELETE_USER', payload: { id } })
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to delete user')
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="User Management"
        description={`${state.users.length} team members · ${activeCount} active`}
        actions={<Button icon={<Plus size={16} />} onClick={openCreate}>Add User</Button>}
      />

      <SearchInput value={search} onChange={setSearch} placeholder="Search by name, email, or employee ID..." className="max-w-md" />

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 bg-ink-50/50">
                {['User', 'Employee ID', 'Phone', 'Role', 'Leads', 'Status', 'Last Login', ''].map((h, i) => (
                  <th key={i} className={`py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400 ${i === 0 ? 'pl-5 pr-3' : 'px-3'}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((user, idx) => (
                <tr key={user.id} className="border-b border-ink-50 transition-colors last:border-0 hover:bg-primary-50/30">
                  <td className="py-3 pl-5 pr-3">
                    <div className="flex items-center gap-3">
                      <div className={`flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br ${avatarGradients[idx % avatarGradients.length]} text-xs font-semibold text-white`}>
                        {user.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                      </div>
                      <div>
                        <div className="font-medium text-ink-900">{user.name}</div>
                        <div className="text-xs text-ink-400">{user.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-ink-500">{user.employeeId}</td>
                  <td className="px-3 py-3 text-ink-600">
                    <div className="flex items-center gap-1.5"><PhoneIcon size={13} className="text-ink-400" />{user.phone}</div>
                  </td>
                  <td className="px-3 py-3">
                    <Badge variant={roleBadgeVariant[user.role]}>
                      <span className="flex items-center gap-1">
                        {user.role === 'admin' ? <Shield size={11} /> : null}
                        {roleLabel[user.role]}
                      </span>
                    </Badge>
                  </td>
                  <td className="px-3 py-3 text-ink-600">{user.assignedLeads}</td>
                  <td className="px-3 py-3">
                    <button onClick={() => toggleStatus(user)} title="Toggle status">
                      <Badge variant={user.status === 'active' ? 'success' : 'default'} dot>
                        {user.status === 'active' ? 'Active' : 'Inactive'}
                      </Badge>
                    </button>
                  </td>
                  <td className="px-3 py-3 text-xs text-ink-500">{user.lastLogin}</td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1">
                      <button onClick={() => openEdit(user)} className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-700"><Edit2 size={15} /></button>
                      <button onClick={() => deleteUser(user.id)} className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-danger-50 hover:text-danger-600"><Trash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <EmptyState icon={<UserCog size={26} />} title="No users found" description="Try adjusting your search or add a new team member." />
          )}
        </div>
      </Card>

      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={editingUser ? 'Edit User' : 'Create User'}
        description={editingUser ? 'Update this team member’s details.' : 'Add a new team member to your CRM.'}
        size="md"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="field-label">Full Name</label>
            <input type="text" required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="field-input" placeholder="e.g. Anjali Verma" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="field-label">Employee ID</label>
              <input type="text" required value={form.employeeId} onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))} className="field-input" placeholder="EMP009" />
            </div>
            <div>
              <label className="field-label">Phone</label>
              <input type="tel" required value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} className="field-input" placeholder="+91 98xxx xxxxx" />
            </div>
          </div>
          <div>
            <label className="field-label">Email</label>
            <input type="email" required value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className="field-input" placeholder="name@medcrm.in" />
          </div>
          <div>
            <label className="field-label">Role</label>
            <select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as UserRole }))} className="field-input">
              <option value="caller">Caller</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div>
            <label className="field-label">{editingUser ? 'Reset Password (optional)' : 'Password'}</label>
            <input
              type="password"
              required={!editingUser}
              minLength={6}
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              className="field-input"
              placeholder={editingUser ? 'Leave blank to keep current password' : 'Minimum 6 characters'}
            />
          </div>
          <div className="flex justify-end gap-3 border-t border-ink-100 pt-4">
            <Button type="button" variant="secondary" onClick={() => setShowModal(false)}>Cancel</Button>
            <Button type="submit">{editingUser ? 'Save Changes' : 'Create User'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
