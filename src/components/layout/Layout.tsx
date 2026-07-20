import { useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { TopNav } from './TopNav'

const routeTitles: Record<string, string> = {
  '/': 'Dashboard',
  '/leads': 'Leads',
  '/calendar': 'Calendar',
  '/orders': 'Orders',
  '/renewals': 'Renewals',
  '/medicines': 'Medicines',
  '/users': 'User Management',
}

function getPageTitle(pathname: string): string {
  if (routeTitles[pathname]) return routeTitles[pathname]
  const basePath = '/' + pathname.split('/').filter(Boolean).slice(0, 1).join('/')
  if (routeTitles[basePath]) return routeTitles[basePath]
  return 'Dashboard'
}

export function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const location = useLocation()
  const pageTitle = getPageTitle(location.pathname)

  return (
    <div className="min-h-screen bg-[#f5f7fb]">
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex min-h-screen flex-col lg:pl-[264px]">
        <TopNav title={pageTitle} onMenuClick={() => setSidebarOpen(true)} />

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-[1440px]">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
