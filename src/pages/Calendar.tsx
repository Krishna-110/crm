import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Phone, Bell, RotateCcw, Eye, CheckCircle2, Clock, CalendarDays } from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { followUpsApi } from '@/api/followUps'
import { emitToast } from '@/lib/toast'
import { PageHeader } from '@/components/ui/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import type { FollowUp } from '@/types'

const TODAY = new Date().toISOString().slice(0, 10)
const DAYS_OF_WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

type ViewMode = 'daily' | 'weekly' | 'monthly'

function formatDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseDate(dateStr: string): { year: number; month: number; day: number } {
  const [y, m, d] = dateStr.split('-').map(Number)
  return { year: y, month: m - 1, day: d }
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

function getFirstDayOfMonth(year: number, month: number): number {
  const day = new Date(year, month, 1).getDay()
  // Convert Sunday=0 to Monday-based (Mon=0 ... Sun=6)
  return day === 0 ? 6 : day - 1
}

function isToday(dateStr: string): boolean {
  return dateStr === TODAY
}

function isSameDay(a: string, b: string): boolean {
  return a === b
}

function getMonthName(month: number): string {
  return ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'][month]
}

function getFollowUpStatus(f: FollowUp): 'overdue' | 'completed' | 'upcoming' | 'today' {
  if (f.status === 'completed') return 'completed'
  if (isToday(f.scheduledDate) && f.status === 'pending') return 'today'
  if (f.scheduledDate < TODAY && (f.status === 'pending' || f.status === 'missed')) return 'overdue'
  return 'upcoming'
}

function getWeekDates(dateStr: string): string[] {
  const { year, month, day } = parseDate(dateStr)
  const d = new Date(year, month, day)
  const dow = d.getDay()
  const mondayOffset = dow === 0 ? -6 : 1 - dow
  const monday = new Date(year, month, day + mondayOffset)
  const dates: string[] = []
  for (let i = 0; i < 7; i++) {
    const current = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)
    dates.push(formatDate(current.getFullYear(), current.getMonth(), current.getDate()))
  }
  return dates
}

const TYPE_ICON: Record<FollowUp['type'], typeof Phone> = {
  call: Phone,
  reminder: Bell,
  callback: RotateCcw,
}

const TYPE_BADGE_VARIANT: Record<FollowUp['type'], 'primary' | 'info' | 'warning'> = {
  call: 'primary',
  reminder: 'info',
  callback: 'warning',
}

export function Calendar() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const [viewMode, setViewMode] = useState<ViewMode>('monthly')
  const [currentDate, setCurrentDate] = useState(TODAY)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  const { year, month, day } = parseDate(currentDate)

  const followUpsByDate = useMemo(() => {
    const map: Record<string, FollowUp[]> = {}
    for (const f of state.followUps) {
      if (!map[f.scheduledDate]) map[f.scheduledDate] = []
      map[f.scheduledDate].push(f)
    }
    return map
  }, [state.followUps])

  // Calendar grid for monthly view
  const calendarGrid = useMemo(() => {
    const daysInMonth = getDaysInMonth(year, month)
    const firstDay = getFirstDayOfMonth(year, month)
    const cells: (string | null)[] = []

    // Leading empty cells
    for (let i = 0; i < firstDay; i++) cells.push(null)
    // Day cells
    for (let d = 1; d <= daysInMonth; d++) cells.push(formatDate(year, month, d))
    // Trailing empty cells to fill 6 rows
    while (cells.length < 42) cells.push(null)

    return cells
  }, [year, month])

  const weekDates = useMemo(() => getWeekDates(currentDate), [currentDate])

  // Summary stats
  const todayFollowUps = followUpsByDate[TODAY] ?? []
  const overdueFollowUps = useMemo(
    () => state.followUps.filter(f => f.scheduledDate < TODAY && (f.status === 'pending' || f.status === 'missed')),
    [state.followUps]
  )
  const upcomingFollowUps = useMemo(() => {
    const { year: ty, month: tm, day: td } = parseDate(TODAY)
    const todayDate = new Date(ty, tm, td)
    const nextWeek = new Date(ty, tm, td + 7)
    const nextWeekStr = formatDate(nextWeek.getFullYear(), nextWeek.getMonth(), nextWeek.getDate())
    return state.followUps.filter(f => f.scheduledDate > TODAY && f.scheduledDate <= nextWeekStr && f.status === 'pending')
  }, [state.followUps])

  function navigateMonth(offset: number) {
    const d = new Date(year, month + offset, 1)
    setCurrentDate(formatDate(d.getFullYear(), d.getMonth(), 1))
    setSelectedDay(null)
  }

  function navigateWeek(offset: number) {
    const { year: y, month: m, day: d } = parseDate(currentDate)
    const newDate = new Date(y, m, d + offset * 7)
    setCurrentDate(formatDate(newDate.getFullYear(), newDate.getMonth(), newDate.getDate()))
  }

  function navigateDay(offset: number) {
    const { year: y, month: m, day: d } = parseDate(currentDate)
    const newDate = new Date(y, m, d + offset)
    setCurrentDate(formatDate(newDate.getFullYear(), newDate.getMonth(), newDate.getDate()))
  }

  function goToToday() {
    setCurrentDate(TODAY)
    setSelectedDay(null)
  }

  async function markComplete(id: string) {
    try {
      const { followUp, lead } = await followUpsApi.updateStatus(id, 'completed')
      dispatch({ type: 'UPDATE_FOLLOW_UP', payload: { id: followUp.id, updates: followUp } })
      if (lead) dispatch({ type: 'UPDATE_LEAD', payload: { id: lead.id, updates: lead } })
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to mark follow-up complete')
    }
  }

  function getDotColor(f: FollowUp): string {
    const s = getFollowUpStatus(f)
    if (s === 'overdue') return 'bg-danger-500'
    if (s === 'completed') return 'bg-success-500'
    if (s === 'today') return 'bg-warning-500'
    return 'bg-primary-500'
  }

  function getChipClasses(f: FollowUp): string {
    const s = getFollowUpStatus(f)
    if (s === 'overdue') return 'bg-danger-50 text-danger-700'
    if (s === 'completed') return 'bg-success-50 text-success-700'
    if (s === 'today') return 'bg-warning-50 text-warning-700'
    return 'bg-primary-50 text-primary-700'
  }

  function getStatusBadgeVariant(f: FollowUp): 'danger' | 'success' | 'warning' | 'info' {
    const s = getFollowUpStatus(f)
    if (s === 'overdue') return 'danger'
    if (s === 'completed') return 'success'
    if (s === 'today') return 'warning'
    return 'info'
  }

  // ---- Render helpers ----

  function renderTypeBadge(type: FollowUp['type']) {
    return <Badge variant={TYPE_BADGE_VARIANT[type]}>{type}</Badge>
  }

  function renderFollowUpCard(f: FollowUp, showActions = false) {
    const status = getFollowUpStatus(f)
    const borderColor =
      status === 'overdue' ? 'border-l-danger-500' :
      status === 'completed' ? 'border-l-success-500' :
      status === 'today' ? 'border-l-warning-500' :
      'border-l-primary-500'

    return (
      <div
        key={f.id}
        className={`border-l-4 ${borderColor} rounded-lg border border-ink-100 bg-white p-3 shadow-sm space-y-2`}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-ink-900">{f.customerName}</span>
          {renderTypeBadge(f.type)}
        </div>
        {f.notes && (
          <p className="text-xs text-ink-500 line-clamp-2">{f.notes}</p>
        )}
        <div className="flex items-center gap-1">
          <Badge variant={getStatusBadgeVariant(f)}>
            {status}
          </Badge>
        </div>
        {showActions && f.status !== 'completed' && (
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" variant="soft" icon={<CheckCircle2 className="w-3.5 h-3.5" />} onClick={() => markComplete(f.id)}>
              Complete
            </Button>
            {f.leadId && (
              <Button size="sm" variant="secondary" icon={<Eye className="w-3.5 h-3.5" />} onClick={() => navigate(`/leads/${f.leadId}`)}>
                View Lead
              </Button>
            )}
          </div>
        )}
      </div>
    )
  }

  // ---- Views ----

  function renderMonthlyView() {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Calendar Grid */}
        <div className="lg:col-span-3">
          <Card>
            <CardBody className="p-3 sm:p-4">
              {/* Day headers */}
              <div className="grid grid-cols-7">
                {DAYS_OF_WEEK.map(d => (
                  <div key={d} className="py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-ink-400">
                    {d}
                  </div>
                ))}
              </div>
              {/* Day cells */}
              <div className="grid grid-cols-7 gap-1.5">
                {calendarGrid.map((dateStr, i) => {
                  if (!dateStr) {
                    return <div key={`empty-${i}`} className="min-h-[104px] rounded-lg border border-ink-100 bg-ink-50/30" />
                  }
                  const dayNum = parseDate(dateStr).day
                  const dayFollowUps = followUpsByDate[dateStr] ?? []
                  const today = isToday(dateStr)
                  const selected = selectedDay === dateStr

                  return (
                    <div
                      key={dateStr}
                      onClick={() => setSelectedDay(dateStr)}
                      className={`min-h-[104px] rounded-lg border border-ink-100 p-2 cursor-pointer transition-colors hover:bg-ink-50 hover:border-ink-200
                        ${today ? 'ring-2 ring-primary-500/40 bg-primary-50/40' : ''}
                        ${selected ? 'ring-2 ring-primary-500' : ''}`}
                    >
                      <span className={`text-sm font-medium
                        ${today ? 'text-primary-700' : 'text-ink-700'}`}>
                        {dayNum}
                      </span>
                      {dayFollowUps.length > 0 && (
                        <div className="mt-1.5 space-y-1">
                          {dayFollowUps.slice(0, 3).map(f => (
                            <div
                              key={f.id}
                              title={f.customerName}
                              className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium truncate ${getChipClasses(f)}`}
                            >
                              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${getDotColor(f)}`} />
                              <span className="truncate">{f.customerName}</span>
                            </div>
                          ))}
                          {dayFollowUps.length > 3 && (
                            <span className="block px-1.5 text-[10px] text-ink-400">+{dayFollowUps.length - 3} more</span>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </CardBody>
          </Card>

          {/* Selected day detail */}
          {selectedDay && (
            <div className="mt-4">
              <Card>
                <CardBody>
                  <h3 className="text-sm font-semibold text-ink-900 mb-3">
                    Follow-ups for {selectedDay}
                  </h3>
                  {(followUpsByDate[selectedDay] ?? []).length === 0 ? (
                    <EmptyState
                      icon={<CalendarDays size={26} />}
                      title="No follow-ups"
                      description="Nothing scheduled for this day."
                    />
                  ) : (
                    <div className="space-y-3">
                      {(followUpsByDate[selectedDay] ?? []).map(f => renderFollowUpCard(f, true))}
                    </div>
                  )}
                </CardBody>
              </Card>
            </div>
          )}
        </div>

        {/* Right Sidebar */}
        <div className="space-y-4">
          <Card>
            <CardBody>
              <h3 className="text-sm font-semibold text-ink-900 mb-4">Summary</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-ink-600">Today</span>
                  <span className="inline-flex min-w-7 items-center justify-center rounded-full bg-warning-50 px-2 py-0.5 text-sm font-semibold text-warning-700">{todayFollowUps.length}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-ink-600">Upcoming (7d)</span>
                  <span className="inline-flex min-w-7 items-center justify-center rounded-full bg-primary-50 px-2 py-0.5 text-sm font-semibold text-primary-700">{upcomingFollowUps.length}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-ink-600">Overdue</span>
                  <span className="inline-flex min-w-7 items-center justify-center rounded-full bg-danger-50 px-2 py-0.5 text-sm font-semibold text-danger-700">{overdueFollowUps.length}</span>
                </div>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <h3 className="text-sm font-semibold text-ink-900 mb-3">Today's Follow-ups</h3>
              {todayFollowUps.length === 0 ? (
                <EmptyState
                  icon={<Clock size={26} />}
                  title="All clear"
                  description="No follow-ups scheduled for today."
                />
              ) : (
                <div className="space-y-2">
                  {todayFollowUps.map(f => (
                    <div key={f.id} className="flex items-center justify-between gap-2 rounded-lg border border-ink-100 p-3 transition-colors hover:border-ink-200">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink-900 truncate">{f.customerName}</p>
                        <div className="flex items-center gap-1 mt-1">
                          {renderTypeBadge(f.type)}
                        </div>
                      </div>
                      {f.status !== 'completed' ? (
                        <Button size="sm" variant="soft" icon={<CheckCircle2 className="w-3.5 h-3.5" />} onClick={() => markComplete(f.id)} />
                      ) : (
                        <Badge variant="success">done</Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    )
  }

  function renderWeeklyView() {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {weekDates.map((dateStr, i) => {
          const dayFollowUps = followUpsByDate[dateStr] ?? []
          const today = isToday(dateStr)
          const { day: d } = parseDate(dateStr)

          return (
            <div key={dateStr} className="min-w-0 rounded-xl border border-ink-100 bg-white">
              <div className={`flex items-center justify-between rounded-t-xl border-b border-ink-100 px-3 py-2
                ${today ? 'bg-primary-50/50' : ''}`}>
                <span className={`text-[11px] font-semibold uppercase tracking-wider ${today ? 'text-primary-600' : 'text-ink-400'}`}>{DAYS_OF_WEEK[i]}</span>
                <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-sm font-semibold
                  ${today ? 'bg-primary-600 text-white' : 'text-ink-700'}`}>{d}</span>
              </div>
              <div className="min-h-48 space-y-1.5 p-2">
                {dayFollowUps.length === 0 && (
                  <p className="mt-4 text-center text-[11px] text-ink-300">No events</p>
                )}
                {dayFollowUps.map(f => (
                  <div
                    key={f.id}
                    className={`rounded-md p-2 text-xs cursor-pointer transition-shadow hover:shadow-sm ${getChipClasses(f)}`}
                    onClick={() => { setCurrentDate(dateStr); setViewMode('daily') }}
                  >
                    <p className="font-medium truncate">{f.customerName}</p>
                    <div className="mt-1">{renderTypeBadge(f.type)}</div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  function renderDailyView() {
    const dayFollowUps = followUpsByDate[currentDate] ?? []
    const today = isToday(currentDate)

    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <div className={`rounded-xl border p-4 text-center
          ${today ? 'border-primary-200 bg-primary-50/50' : 'border-ink-200 bg-ink-50/50'}`}>
          <p className="text-lg font-semibold text-ink-900">{currentDate}</p>
          <p className="text-sm text-ink-500">{dayFollowUps.length} follow-up{dayFollowUps.length !== 1 ? 's' : ''}</p>
        </div>

        {dayFollowUps.length === 0 ? (
          <Card>
            <CardBody>
              <EmptyState
                icon={<Clock size={26} />}
                title="No follow-ups"
                description="No follow-ups scheduled for this day."
              />
            </CardBody>
          </Card>
        ) : (
          <div className="space-y-3">
            {dayFollowUps.map(f => {
              const status = getFollowUpStatus(f)
              const accentBorder =
                status === 'overdue' ? 'border-l-danger-500' :
                status === 'completed' ? 'border-l-success-500' :
                status === 'today' ? 'border-l-warning-500' :
                'border-l-primary-500'
              return (
                <Card key={f.id} className={`border-l-4 ${accentBorder}`}>
                  <CardBody>
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex items-center gap-2">
                          {(() => { const Icon = TYPE_ICON[f.type]; return <Icon className="w-4 h-4 text-ink-400" /> })()}
                          <span className="text-base font-semibold text-ink-900">{f.customerName}</span>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                          {renderTypeBadge(f.type)}
                          <Badge variant={getStatusBadgeVariant(f)}>
                            {status}
                          </Badge>
                        </div>
                        {f.notes && (
                          <p className="text-sm text-ink-500">{f.notes}</p>
                        )}
                        <p className="text-xs text-ink-400">Scheduled: {f.scheduledDate}</p>
                      </div>
                    </div>
                    {f.status !== 'completed' && (
                      <div className="flex items-center gap-2 mt-4 pt-3 border-t border-ink-100">
                        <Button size="sm" variant="soft" icon={<CheckCircle2 className="w-3.5 h-3.5" />} onClick={() => markComplete(f.id)}>
                          Mark Complete
                        </Button>
                        {f.leadId && (
                          <Button size="sm" variant="secondary" icon={<Eye className="w-3.5 h-3.5" />} onClick={() => navigate(`/leads/${f.leadId}`)}>
                            View Lead
                          </Button>
                        )}
                      </div>
                    )}
                  </CardBody>
                </Card>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  // ---- Main Layout ----

  const monthLabel = `${getMonthName(month)} ${year}`

  const viewSwitcher = (
    <div className="inline-flex items-center gap-1 rounded-xl border border-ink-200 bg-white p-1 shadow-sm">
      {(['daily', 'weekly', 'monthly'] as const).map(mode => (
        <button
          key={mode}
          onClick={() => setViewMode(mode)}
          className={`rounded-lg px-3 py-1.5 text-[13px] font-medium capitalize transition-colors
            ${viewMode === mode
              ? 'bg-primary-600 text-white shadow-sm'
              : 'text-ink-500 hover:bg-ink-100'}`}
        >
          {mode}
        </button>
      ))}
    </div>
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Calendar"
        description="Manage and track follow-ups"
        actions={viewSwitcher}
      />

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            className="rounded-lg border border-ink-200 p-2 text-ink-500 transition-colors hover:bg-ink-100"
            onClick={() =>
              viewMode === 'monthly' ? navigateMonth(-1) :
              viewMode === 'weekly' ? navigateWeek(-1) :
              navigateDay(-1)
            }
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <h2 className="min-w-48 text-center text-lg font-semibold text-ink-900">
            {viewMode === 'monthly' ? monthLabel :
             viewMode === 'weekly' ? `Week of ${weekDates[0]}` :
             currentDate}
          </h2>
          <button
            className="rounded-lg border border-ink-200 p-2 text-ink-500 transition-colors hover:bg-ink-100"
            onClick={() =>
              viewMode === 'monthly' ? navigateMonth(1) :
              viewMode === 'weekly' ? navigateWeek(1) :
              navigateDay(1)
            }
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <Button size="sm" variant="secondary" onClick={goToToday}>
          Today
        </Button>
      </div>

      {/* View Content */}
      {viewMode === 'monthly' && renderMonthlyView()}
      {viewMode === 'weekly' && renderWeeklyView()}
      {viewMode === 'daily' && renderDailyView()}
    </div>
  )
}
