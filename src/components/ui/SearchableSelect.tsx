/* oxlint-disable jsx-a11y/prefer-tag-over-role --
 * The rule suggests <select>/<option> instead of role="listbox"/"option". That does not
 * apply here: this is the ARIA 1.2 combobox pattern, which explicitly places those roles on
 * non-select elements. A native <select> cannot do type-to-filter with an "add as new"
 * affordance, which is the entire purpose of this component.
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, FocusEvent } from 'react'
import { Search, Plus, Check } from 'lucide-react'

type Option = { id: string; label: string; sublabel?: string }

type SearchableSelectProps = {
  value: string
  onChange: (value: string) => void
  options: Option[]
  placeholder?: string
  onCreateNew?: (query: string) => void
  createLabel?: (query: string) => string
  emptyText?: string
  required?: boolean
  /**
   * Accessible name for the combobox. Without it the only name available is the
   * placeholder, which is the last-resort source in the accessible-name algorithm and a
   * poor one: it reads as an instruction ("Search medicines...") rather than a field name,
   * and browsers may drop it once the field has a value. With several of these rendered in
   * a list, "combobox" with no distinguishing name is close to useless.
   */
  ariaLabel?: string
}

export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = 'Search...',
  onCreateNew,
  createLabel,
  emptyText = 'No matches found',
  required = false,
  ariaLabel,
}: SearchableSelectProps) {
  const [query, setQuery] = useState(value)
  const [isOpen, setIsOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  // Keep the displayed text in sync with the committed value when it changes
  // externally (e.g. switching from Add to Edit) and the dropdown isn't in use.
  useEffect(() => {
    if (!isOpen) setQuery(value)
  }, [value, isOpen])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        setQuery(value)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [value])

  useEffect(() => {
    setHighlighted(0)
  }, [query, isOpen])

  const trimmed = query.trim()
  const filtered = trimmed
    ? options.filter(o => o.label.toLowerCase().includes(trimmed.toLowerCase()))
    : options
  const exactMatch = options.some(o => o.label.toLowerCase() === trimmed.toLowerCase())
  const showCreateOption = !!onCreateNew && trimmed.length > 0 && !exactMatch
  const totalRows = filtered.length + (showCreateOption ? 1 : 0)

  function selectOption(option: Option) {
    onChange(option.label)
    setQuery(option.label)
    setIsOpen(false)
  }

  function selectCreateNew() {
    if (!onCreateNew || !trimmed) return
    onCreateNew(trimmed)
    setIsOpen(false)
  }

  function handleBlur(e: FocusEvent<HTMLDivElement>) {
    const next = e.relatedTarget as Node | null
    if (next && containerRef.current?.contains(next)) return
    window.setTimeout(() => {
      setIsOpen(false)
      setQuery(value)
    }, 120)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        setIsOpen(true)
        e.preventDefault()
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted(h => Math.min(h + 1, totalRows - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted(h => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (highlighted < filtered.length) {
        if (filtered[highlighted]) selectOption(filtered[highlighted])
      } else if (showCreateOption) {
        selectCreateNew()
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false)
      setQuery(value)
    }
  }

  // ARIA combobox wiring. The keyboard model already existed (arrows, Enter, Escape and a
  // `highlighted` index); what was missing was any way for assistive technology to know
  // about it. Without role="combobox"/"listbox"/"option" this renders as "a text box and
  // some buttons" — a screen reader never announces that a list opened, how many options
  // there are, or which one is active.
  const instanceId = useId()
  const listboxId = `${instanceId}-listbox`
  const optionId = (idx: number) => `${instanceId}-option-${idx}`
  const activeDescendant = isOpen
    ? highlighted < filtered.length
      ? optionId(highlighted)
      : showCreateOption
        ? optionId(filtered.length)
        : undefined
    : undefined

  return (
    <div className="relative" ref={containerRef} onBlur={handleBlur}>
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
        <input
          type="text"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeDescendant}
          value={query}
          onChange={e => {
            setQuery(e.target.value)
            setIsOpen(true)
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoComplete="off"
          required={required}
          className="field-input"
          style={{ paddingLeft: '2.25rem' }}
        />
      </div>

      {isOpen && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute z-20 mt-1.5 w-full max-h-64 overflow-y-auto rounded-xl border border-ink-200 bg-white py-1.5 shadow-[var(--shadow-pop)]"
        >
          {filtered.length === 0 && !showCreateOption && (
            <div className="px-3.5 py-3 text-center text-sm text-ink-400">{emptyText}</div>
          )}
          {filtered.map((option, idx) => (
            <button
              key={option.id}
              id={optionId(idx)}
              role="option"
              aria-selected={option.label === value}
              type="button"
              onClick={() => selectOption(option)}
              onMouseEnter={() => setHighlighted(idx)}
              className={`flex w-full items-center justify-between gap-3 px-3.5 py-2 text-left text-sm transition-colors ${
                idx === highlighted ? 'bg-primary-50 text-primary-700' : 'text-ink-700 hover:bg-ink-50'
              }`}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{option.label}</span>
                {option.sublabel && <span className="block truncate text-xs text-ink-400">{option.sublabel}</span>}
              </span>
              {option.label === value && <Check size={14} className="shrink-0 text-primary-600" />}
            </button>
          ))}
          {showCreateOption && (
            <button
              id={optionId(filtered.length)}
              role="option"
              aria-selected={false}
              type="button"
              onClick={selectCreateNew}
              onMouseEnter={() => setHighlighted(filtered.length)}
              className={`mt-1 flex w-full items-center gap-2 border-t border-ink-100 px-3.5 py-2 pt-2.5 text-left text-sm font-medium transition-colors ${
                highlighted === filtered.length ? 'bg-primary-50 text-primary-700' : 'text-primary-600 hover:bg-primary-50'
              }`}
            >
              <Plus size={14} />
              {createLabel ? createLabel(trimmed) : `Add "${trimmed}" as new medicine`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
