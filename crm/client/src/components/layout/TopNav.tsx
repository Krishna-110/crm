import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Bell, Menu, LogOut, Settings, User, ChevronDown } from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { logout } from '@/context/AppContext'
import { notificationsApi } from '@/api/notifications'
import { authApi } from '@/api/auth'
import { emitToast } from '@/lib/toast'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'

type TopNavProps = {
  title: string
  onMenuClick: () => void
}

function getInitials(name: string): string {
  return name.split(' ').map((p) => p[0]).join('').toUpperCase().slice(0, 2)
}

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const notifDot: Record<string, string> = {
  info: 'bg-primary-500',
  warning: 'bg-warning-500',
  success: 'bg-success-500',
  error: 'bg-danger-500',
}

export function TopNav({ title, onMenuClick }: TopNavProps) {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const { currentUser, notifications } = state

  const [showNotifications, setShowNotifications] = useState(false)
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const [showChangePassword, setShowChangePassword] = useState(false)
  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' })
  const [changingPassword, setChangingPassword] = useState(false)

  const notificationRef = useRef<HTMLDivElement>(null)
  const profileRef = useRef<HTMLDivElement>(null)

  const unreadCount = notifications.filter((n) => !n.read).length

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (notificationRef.current && !notificationRef.current.contains(e.target as Node)) {
        setShowNotifications(false)
      }
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setShowProfileMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  async function handleLogout() {
    await logout(dispatch)
    navigate('/login')
  }

  async function handleMarkRead(id: string) {
    try {
      await notificationsApi.markRead(id)
      dispatch({ type: 'MARK_NOTIFICATION_READ', payload: { id } })
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to mark notification read')
    }
  }

  function openChangePassword() {
    setShowProfileMenu(false)
    setPwForm({ current: '', next: '', confirm: '' })
    setShowChangePassword(true)
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault()
    if (pwForm.next !== pwForm.confirm) {
      emitToast('New password and confirmation do not match')
      return
    }
    setChangingPassword(true)
    try {
      await authApi.changePassword(pwForm.current, pwForm.next)
      emitToast('Password changed successfully', 'success')
      setShowChangePassword(false)
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to change password')
    } finally {
      setChangingPassword(false)
    }
  }

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-ink-200/80 bg-white/85 px-4 backdrop-blur-lg sm:px-6">
      <button
        onClick={onMenuClick}
        className="rounded-lg p-2 text-ink-500 hover:bg-ink-100 hover:text-ink-700 lg:hidden"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      <h1 className="text-lg font-semibold text-ink-900 lg:hidden">{title}</h1>

      {/* Global search */}
      <div className="mx-1 hidden max-w-md flex-1 md:block">
        <div className="group relative">
          <Search className="absolute left-3.5 top-1/2 h-[17px] w-[17px] -translate-y-1/2 text-ink-400 transition-colors group-focus-within:text-primary-500" />
          <input
            type="text"
            aria-label="Search leads, orders and customers"
            placeholder="Search leads, orders, customers..."
            value={state.searchQuery}
            onChange={(e) => dispatch({ type: 'SET_SEARCH_QUERY', payload: { query: e.target.value } })}
            className="w-full rounded-xl border border-transparent bg-ink-100/80 py-2.5 pl-10 pr-16 text-sm text-ink-800 placeholder-ink-400 outline-none transition-all focus:border-primary-300 focus:bg-white focus:ring-[3px] focus:ring-primary-500/15"
          />
          <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-md border border-ink-200 bg-white px-1.5 py-0.5 font-mono text-[10px] font-medium text-ink-400 lg:flex">
            ⌘K
          </kbd>
        </div>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        {/* Notifications */}
        <div className="relative" ref={notificationRef}>
          <button
            onClick={() => {
              setShowNotifications((p) => !p)
              setShowProfileMenu(false)
            }}
            className="relative rounded-lg p-2 text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-700"
            aria-label="Notifications"
          >
            <Bell className="h-[19px] w-[19px]" />
            {unreadCount > 0 && (
              <span className="absolute right-1.5 top-1.5 flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-danger-500 ring-2 ring-white" />
              </span>
            )}
          </button>

          {showNotifications && (
            <div className="absolute right-0 top-full z-50 mt-2 w-[340px] origin-top-right animate-pop-in overflow-hidden rounded-2xl border border-ink-200/80 bg-white shadow-[var(--shadow-pop)]">
              <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
                <h3 className="text-sm font-semibold text-ink-900">Notifications</h3>
                {unreadCount > 0 && (
                  <span className="rounded-full bg-primary-50 px-2 py-0.5 text-xs font-medium text-primary-700">
                    {unreadCount} new
                  </span>
                )}
              </div>
              <div className="max-h-[360px] overflow-y-auto">
                {notifications.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-ink-400">No notifications</p>
                ) : (
                  notifications.slice(0, 10).map((n) => (
                    <button
                      key={n.id}
                      onClick={() => handleMarkRead(n.id)}
                      className={`flex w-full gap-3 border-b border-ink-50 px-4 py-3 text-left transition-colors last:border-0 hover:bg-ink-50/70 ${
                        !n.read ? 'bg-primary-50/40' : ''
                      }`}
                    >
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${notifDot[n.type] ?? 'bg-ink-400'}`} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium text-ink-800">{n.title}</span>
                          <span className="shrink-0 text-[11px] text-ink-400">{formatTimeAgo(n.createdAt)}</span>
                        </span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">{n.message}</span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <div className="mx-1 h-6 w-px bg-ink-200" />

        {/* Profile menu */}
        <div className="relative" ref={profileRef}>
          <button
            onClick={() => {
              setShowProfileMenu((p) => !p)
              setShowNotifications(false)
            }}
            className="flex items-center gap-2 rounded-xl py-1.5 pl-1.5 pr-2 transition-colors hover:bg-ink-100"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-primary-500 to-primary-700 text-[13px] font-semibold text-white">
              {currentUser ? getInitials(currentUser.name) : '??'}
            </div>
            <span className="hidden text-sm font-medium text-ink-800 sm:block">{currentUser?.name ?? 'User'}</span>
            <ChevronDown className="hidden h-4 w-4 text-ink-400 sm:block" />
          </button>

          {showProfileMenu && (
            <div className="absolute right-0 top-full z-50 mt-2 w-56 origin-top-right animate-pop-in overflow-hidden rounded-2xl border border-ink-200/80 bg-white shadow-[var(--shadow-pop)]">
              <div className="border-b border-ink-100 px-4 py-3">
                <p className="text-sm font-semibold text-ink-900">{currentUser?.name}</p>
                <p className="truncate text-xs text-ink-500">{currentUser?.email}</p>
              </div>
              <div className="p-1.5">
                <button className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-700 transition-colors hover:bg-ink-50">
                  <User className="h-4 w-4 text-ink-400" />
                  Profile
                </button>
                <button
                  onClick={openChangePassword}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-700 transition-colors hover:bg-ink-50"
                >
                  <Settings className="h-4 w-4 text-ink-400" />
                  Change Password
                </button>
              </div>
              <div className="border-t border-ink-100 p-1.5">
                <button
                  onClick={handleLogout}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-danger-600 transition-colors hover:bg-danger-50"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <Modal
        isOpen={showChangePassword}
        onClose={() => setShowChangePassword(false)}
        title="Change Password"
        description="Enter your current password and choose a new one."
        size="sm"
      >
        <form onSubmit={handleChangePassword} className="space-y-4">
          <div>
            <label className="field-label" htmlFor="topnav-current-password">Current Password</label>
            <input
              id="topnav-current-password"
              type="password"
              required
              value={pwForm.current}
              onChange={(e) => setPwForm((f) => ({ ...f, current: e.target.value }))}
              className="field-input"
            />
          </div>
          <div>
            <label className="field-label" htmlFor="topnav-new-password">New Password</label>
            <input
              id="topnav-new-password"
              type="password"
              required
              minLength={6}
              value={pwForm.next}
              onChange={(e) => setPwForm((f) => ({ ...f, next: e.target.value }))}
              className="field-input"
              placeholder="Minimum 6 characters"
            />
          </div>
          <div>
            <label className="field-label" htmlFor="topnav-confirm-new-password">Confirm New Password</label>
            <input
              id="topnav-confirm-new-password"
              type="password"
              required
              minLength={6}
              value={pwForm.confirm}
              onChange={(e) => setPwForm((f) => ({ ...f, confirm: e.target.value }))}
              className="field-input"
            />
          </div>
          <div className="flex justify-end gap-3 border-t border-ink-100 pt-4">
            <Button type="button" variant="secondary" onClick={() => setShowChangePassword(false)}>Cancel</Button>
            <Button type="submit" loading={changingPassword}>Change Password</Button>
          </div>
        </form>
      </Modal>
    </header>
  )
}
