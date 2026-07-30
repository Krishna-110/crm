import { useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  Users,
  CalendarDays,
  ShoppingCart,
  RefreshCw,
  Package,
  UserCog,
  Plus,
  X,
} from 'lucide-react'
import { useApp } from '@/context/AppContext'

type SidebarProps = {
  isOpen: boolean
  onClose: () => void
}

type NavItem = {
  to: string
  label: string
  icon: typeof LayoutDashboard
  end?: boolean
  adminOnly?: boolean
  badge?: 'leads' | 'renewals'
}

const mainItems: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/leads', label: 'Leads', icon: Users, badge: 'leads' },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
]

const workItems: NavItem[] = [
  { to: '/orders', label: 'Orders', icon: ShoppingCart },
  { to: '/renewals', label: 'Renewals', icon: RefreshCw, badge: 'renewals' },
  { to: '/stock', label: 'Stock', icon: Package },
]

const adminItems: NavItem[] = [
  { to: '/users', label: 'User Management', icon: UserCog, adminOnly: true },
]

function getInitials(name: string): string {
  return name.split(' ').map((p) => p[0]).join('').toUpperCase().slice(0, 2)
}

const roleLabel: Record<string, string> = {
  admin: 'Admin',
  caller: 'Caller',
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const { state } = useApp()
  const { currentUser } = state
  const canSeeAdmin = currentUser?.role === 'admin'

  const badgeCounts = {
    leads: state.leads.filter((l) => ['new', 'follow_up_pending'].includes(l.status)).length,
    renewals: state.renewals.filter((r) => r.status === 'due_today' || r.status === 'overdue').length,
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose])

  function renderItem(item: NavItem) {
    if (item.adminOnly && !canSeeAdmin) return null
    const count = item.badge ? badgeCounts[item.badge] : 0
    return (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.end}
        onClick={onClose}
        className={({ isActive }) =>
          `group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
            isActive
              ? 'bg-primary-50 text-primary-700'
              : 'text-ink-500 hover:bg-ink-50 hover:text-ink-900'
          }`
        }
      >
        {({ isActive }) => (
          <>
            {isActive && (
              <span className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-primary-600" />
            )}
            <item.icon
              className={`h-[18px] w-[18px] shrink-0 transition-colors ${
                isActive ? 'text-primary-600' : 'text-ink-400 group-hover:text-ink-600'
              }`}
            />
            <span className="flex-1">{item.label}</span>
            {count > 0 && (
              <span
                className={`inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold ${
                  isActive ? 'bg-primary-600 text-white' : 'bg-ink-200 text-ink-600'
                }`}
              >
                {count}
              </span>
            )}
          </>
        )}
      </NavLink>
    )
  }

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 z-40 bg-ink-900/40 backdrop-blur-[2px] lg:hidden" onClick={onClose} aria-hidden="true" />
      )}

      <aside
        className={`fixed top-0 left-0 z-50 flex h-full w-[264px] flex-col border-r border-ink-200/80 bg-white transition-transform duration-300 ease-in-out lg:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo */}
        <div className="flex h-16 items-center gap-2.5 px-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 shadow-sm shadow-primary-600/30">
            <Plus className="h-5 w-5 text-white" strokeWidth={3} />
          </div>
          <div className="leading-tight">
            <div className="text-[15px] font-bold text-ink-900">MediCRM</div>
            <div className="text-[11px] font-medium text-ink-400">Distribution Suite</div>
          </div>
          <button
            onClick={onClose}
            className="ml-auto rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700 lg:hidden"
            aria-label="Close sidebar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-2">
          <div className="mb-1 px-3 pb-1.5 pt-2 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
            Main
          </div>
          <div className="space-y-0.5">{mainItems.map(renderItem)}</div>

          <div className="mb-1 px-3 pb-1.5 pt-5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
            Operations
          </div>
          <div className="space-y-0.5">{workItems.map(renderItem)}</div>

          {canSeeAdmin && (
            <>
              <div className="mb-1 px-3 pb-1.5 pt-5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
                Administration
              </div>
              <div className="space-y-0.5">{adminItems.map(renderItem)}</div>
            </>
          )}
        </nav>

        {/* User card */}
        {currentUser && (
          <div className="border-t border-ink-100 p-3">
            <div className="flex items-center gap-3 rounded-xl bg-ink-50 px-3 py-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary-500 to-primary-700 text-sm font-semibold text-white">
                {getInitials(currentUser.name)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink-900">{currentUser.name}</p>
                <p className="truncate text-xs text-ink-500">{roleLabel[currentUser.role]}</p>
              </div>
            </div>
          </div>
        )}
      </aside>
    </>
  )
}
