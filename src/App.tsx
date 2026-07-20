import { Routes, Route, Navigate } from 'react-router-dom'
import { useApp } from '@/context/AppContext'
import { Layout } from '@/components/layout/Layout'
import { Login } from '@/pages/Login'
import { Dashboard } from '@/pages/Dashboard'
import { Leads } from '@/pages/Leads'
import { LeadDetailPage } from '@/pages/LeadDetailPage'
import { Users } from '@/pages/Users'
import { Calendar } from '@/pages/Calendar'
import { Orders } from '@/pages/Orders'
import { Renewals } from '@/pages/Renewals'
import { Medicines } from '@/pages/Medicines'
import { LoadingState } from '@/components/ui/LoadingState'
import { ToastContainer } from '@/components/ui/Toast'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { state } = useApp()
  if (state.booting) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f5f7fb] px-6">
        <div className="w-full max-w-sm">
          <LoadingState rows={4} />
        </div>
      </div>
    )
  }
  if (!state.currentUser) return <Navigate to="/login" replace />
  return <>{children}</>
}

export function App() {
  return (
    <>
      <ToastContainer />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route path="/" element={<Dashboard />} />
          <Route path="/leads" element={<Leads />} />
          <Route path="/leads/:id" element={<LeadDetailPage />} />
          <Route path="/users" element={<Users />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/renewals" element={<Renewals />} />
          <Route path="/medicines" element={<Medicines />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}
