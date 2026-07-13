import { useEffect, useRef, useState } from 'react'
import type { Mission, Leg } from '../domain/types'
import { BOX_SIZES, decomposeToBoxes } from '../domain/cargo'
import { MISSION_COLORS } from '../optimizer/loadout'
import { emptyLeg, emptyMission, duplicateMission } from '../state/store'
import { LocationCombobox } from './LocationCombobox'

interface Props {
  missions: Mission[]
  setMissions: (m: Mission[]) => void
  /** Effective color for a mission id (auto index color, or its override). */
  colorFor: (id: string) => string
}

const parseScu = (value: string) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0
}
const parseBoxScu = (value: string) => {
  const n = Number(value)
  return BOX_SIZES.some((b) => b.scu === n) ? n : 32
}

export function MissionEditor({ missions, setMissions, colorFor }: Props) {
  const updateMission = (id: string, patch: Partial<Mission>) =>
    setMissions(missions.map((m) => (m.id === id ? { ...m, ...patch } : m)))

  const updateLeg = (mId: string, legId: string, patch: Partial<Leg>) =>
    setMissions(
      missions.map((m) =>
        m.id === mId
          ? { ...m, legs: m.legs.map((l) => (l.id === legId ? { ...l, ...patch } : l)) }
          : m,
      ),
    )

  // A leg only routes when all four fields are set (App's validLegs gate); a
  // PARTIALLY filled one is silently dropped, so surface what it still needs.
  const legMissing = (l: Leg): string[] | null => {
    const filled = [!!l.commodity.trim(), l.scu > 0, !!l.pickupId, !!l.dropoffId]
    if (!filled.some(Boolean) || filled.every(Boolean)) return null
    return (['commodity', 'SCU', 'pickup', 'dropoff'] as const).filter((_, i) => !filled[i])
  }

  // The physical cargo a mission becomes: each leg's SCU decomposed into standard
  // containers (exactly how the packer sees it), grouped by size and kept PER LEG
  // — a mission delivered to two stops shows two stacks, mirroring the in-game
  // freight elevator.
  const missionContainers = (m: Mission): { scu: number; count: number }[] =>
    m.legs.flatMap((l) => {
      if (l.scu <= 0) return []
      const counts = new Map<number, number>()
      for (const b of decomposeToBoxes(l.scu, l.maxBoxScu ?? 32)) counts.set(b.scu, (counts.get(b.scu) ?? 0) + 1)
      return [...counts.entries()].map(([scu, count]) => ({ scu, count }))
    })

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Missions</h2>
        <span className="muted">{missions.length} active</span>
      </div>

      {missions.map((m) => {
        const containers = missionContainers(m)
        return (
        <div className="card" key={m.id}>
          <div className="card-head">
            <MissionColorSwatch
              color={colorFor(m.id)}
              custom={!!m.color}
              onPick={(c) => updateMission(m.id, { color: c })}
              onAuto={() => updateMission(m.id, { color: undefined })}
            />
            <input
              className="mission-label"
              value={m.label}
              onChange={(e) => updateMission(m.id, { label: e.target.value })}
            />
            <div className="card-head-right">
              <input
                className="reward-input"
                type="number"
                min={0}
                placeholder="reward"
                value={m.reward ?? ''}
                onChange={(e) =>
                  updateMission(m.id, { reward: e.target.value ? Number(e.target.value) : undefined })
                }
              />
              <button
                className="icon-btn"
                aria-label="duplicate mission"
                title="Duplicate mission"
                onClick={() => setMissions([...missions, duplicateMission(m)])}
              >
                ⧉
              </button>
              <button
                className="icon-btn"
                aria-label="remove mission"
                title="Double-click to delete"
                onDoubleClick={() => setMissions(missions.filter((x) => x.id !== m.id))}
              >
                ✕
              </button>
            </div>
          </div>

          {containers.length > 0 && (
            <div className="mission-manifest">
              {containers.map((c, i) => (
                <span className="container-badge" key={i}>
                  {c.scu} SCU <b>×{c.count}</b>
                </span>
              ))}
            </div>
          )}

          {m.legs.map((l) => (
            <div className="leg" key={l.id}>
              <div className="leg-top">
                <input
                  className="commodity-input"
                  placeholder="Commodity"
                  value={l.commodity}
                  onChange={(e) => updateLeg(m.id, l.id, { commodity: e.target.value })}
                />
                <input
                  className="scu-input"
                  type="number"
                  min={0}
                  step={1}
                  placeholder="SCU"
                  value={l.scu || ''}
                  onChange={(e) => updateLeg(m.id, l.id, { scu: parseScu(e.target.value) })}
                />
                <select
                  aria-label="max container size"
                  className="box-size-select"
                  value={l.maxBoxScu ?? 32}
                  onChange={(e) => updateLeg(m.id, l.id, { maxBoxScu: parseBoxScu(e.target.value) })}
                >
                  {BOX_SIZES.map((b) => (
                    <option key={b.scu} value={b.scu}>
                      {b.scu} SCU
                    </option>
                  ))}
                </select>
                <label
                  className="split-toggle"
                  title="Allow split delivery: if this cargo can't fit in the ship in one go, haul it over multiple trips (it is never split when it fits whole)."
                >
                  <input
                    type="checkbox"
                    checked={!!l.allowSplit}
                    onChange={(e) => updateLeg(m.id, l.id, { allowSplit: e.currentTarget.checked || undefined })}
                  />
                  <span>split</span>
                </label>
                <button
                  className="icon-btn"
                  aria-label="remove leg"
                  title="Double-click to delete"
                  onDoubleClick={() =>
                    updateMission(m.id, { legs: m.legs.filter((x) => x.id !== l.id) })
                  }
                >
                  ✕
                </button>
              </div>
              <div className="leg-locs">
                <LocationCombobox
                  value={l.pickupId}
                  placeholder="Pickup location"
                  onChange={(id) => updateLeg(m.id, l.id, { pickupId: id })}
                />
                <span className="arrow">→</span>
                <LocationCombobox
                  value={l.dropoffId}
                  placeholder="Dropoff location"
                  onChange={(id) => updateLeg(m.id, l.id, { dropoffId: id })}
                />
              </div>
              {legMissing(l) && (
                <p className="warn small">Incomplete — needs {legMissing(l)?.join(', ')} · not routed</p>
              )}
            </div>
          ))}

          <button
            className="ghost-btn"
            onClick={() => updateMission(m.id, { legs: [...m.legs, emptyLeg()] })}
          >
            + Add cargo leg
          </button>
        </div>
        )
      })}

      <button className="ghost-btn block" onClick={() => setMissions([...missions, emptyMission(missions.length)])}>
        + Add mission
      </button>
    </section>
  )
}

/** Mission color: a swatch that auto-fills from the palette index, click to
 *  override from the 24-color palette (or "Auto" to clear back to the default). */
function MissionColorSwatch({
  color,
  custom,
  onPick,
  onAuto,
}: {
  color: string
  custom: boolean
  onPick: (color: string) => void
  onAuto: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  return (
    <div className="mission-color" ref={ref}>
      <button
        type="button"
        className="mission-color-dot"
        style={{ background: color }}
        aria-label="Mission color"
        title="Mission color"
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="mission-color-pop">
          <div className="mission-color-grid">
            {MISSION_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                className={`mission-color-opt ${custom && c === color ? 'active' : ''}`}
                style={{ background: c }}
                title={c}
                onClick={() => {
                  onPick(c)
                  setOpen(false)
                }}
              />
            ))}
          </div>
          <button
            type="button"
            className={`mission-color-auto ${custom ? '' : 'active'}`}
            onClick={() => {
              onAuto()
              setOpen(false)
            }}
          >
            Auto
          </button>
        </div>
      )}
    </div>
  )
}
