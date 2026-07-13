// Minimal searchable location picker (zero deps) over all UEX locations.

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { locations, locationsById } from '../data'
import type { Location, LocationType } from '../domain/types'

const TYPE_LABEL: Record<LocationType, string> = {
  station: 'Station',
  outpost: 'Outpost',
  city: 'City',
  poi: 'POI',
}

interface Props {
  value: string
  onChange: (id: string) => void
  placeholder?: string
}

export function LocationCombobox({ value, onChange, placeholder }: Props) {
  const selected = value ? locationsById.get(value) : undefined
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const listId = useId()

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return locations
      .filter((l) => l.name.toLowerCase().includes(q) || l.fullName.toLowerCase().includes(q))
      .slice(0, 40)
  }, [query])

  // Keep the keyboard highlight in range as the result set changes.
  useEffect(() => setActive(0), [query])

  const listOpen = open && results.length > 0
  const optionId = (id: string) => `${listId}-${id}`

  const select = (l: Location) => {
    onChange(l.id)
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((a) => Math.min(a + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      if (listOpen && results[active]) {
        e.preventDefault()
        select(results[active])
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div
      className="combo"
      ref={ref}
      // Close when focus leaves the component (Tab away): without this the input
      // keeps showing the stale query instead of the selected location, and the
      // dropdown floats over the next field until a stray mousedown. List clicks
      // preventDefault on mousedown, so focus never leaves during selection.
      onBlur={(e) => {
        if (!ref.current?.contains(e.relatedTarget as Node)) setOpen(false)
      }}
    >
      <input
        className="combo-input"
        role="combobox"
        aria-expanded={listOpen}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={listOpen && results[active] ? optionId(results[active].id) : undefined}
        value={open ? query : selected?.name ?? ''}
        placeholder={placeholder ?? 'Search location'}
        onFocus={() => {
          setOpen(true)
          setQuery('')
        }}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onKeyDown={onKeyDown}
      />
      {listOpen && (
        <ul className="combo-list" role="listbox" id={listId}>
          {results.map((l, i) => (
            <li
              key={l.id}
              id={optionId(l.id)}
              role="option"
              aria-selected={i === active}
              className={`combo-item ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                select(l)
              }}
            >
              <span className="combo-name">{l.name}</span>
              <span className="combo-meta">
                {TYPE_LABEL[l.type]} · {l.systemName}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
