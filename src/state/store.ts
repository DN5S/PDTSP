// App state with localStorage persistence (no backend).

import { useEffect, useRef, useState } from 'react'
import type { Mission, Leg } from '../domain/types'
import type { Compartment } from '../ships/grids'

const KEY = 'hauling-sc:v1'

/** User-authored cargo grids, keyed by String(shipId). A browser SPA can't write
 *  the built-in src/ships/grids.ts, so grids the user draws live here and override
 *  the built-in geometry for that ship. */
type GridOverrides = Record<string, Compartment[]>

/** Handling-cost weights in fixed-point milli-Gm (integers — exact ties, no
 *  float drift): the route objective is F = distance + Σ(α·L + δ·G) over every
 *  box move of the loadout witness. Defaults are calibrated so Σh lands around
 *  10–30% of total travel on the golden Railen fixture (α ≈ 0.2·D̄/(2n·L̄));
 *  δ a single-digit multiple of α — handling must inform routing, never drown
 *  it. 0/0 turns the pricing off (pure distance, the legacy objective). */
export const DEFAULT_ALPHA_MILLI = 40
export const DEFAULT_DELTA_MILLI = 160

interface Persisted {
  shipId: number | null
  missions: Mission[]
  gridOverrides: GridOverrides
  handlingAlphaMilli: number
  handlingDeltaMilli: number
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Persisted>
      return {
        shipId: parsed.shipId ?? null,
        missions: parsed.missions ?? [],
        gridOverrides: parsed.gridOverrides ?? {},
        handlingAlphaMilli: parsed.handlingAlphaMilli ?? DEFAULT_ALPHA_MILLI,
        handlingDeltaMilli: parsed.handlingDeltaMilli ?? DEFAULT_DELTA_MILLI,
      }
    }
  } catch {
    /* ignore corrupt storage */
  }
  return {
    shipId: null, missions: [], gridOverrides: {},
    handlingAlphaMilli: DEFAULT_ALPHA_MILLI, handlingDeltaMilli: DEFAULT_DELTA_MILLI,
  }
}

function save(p: Persisted) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* storage unavailable or full — run without persistence rather than crash */
  }
}

const uid = () => crypto.randomUUID()

export function emptyLeg(): Leg {
  return { id: uid(), commodity: '', scu: 0, maxBoxScu: 32, pickupId: '', dropoffId: '' }
}

export function emptyMission(index: number): Mission {
  return { id: uid(), label: `Mission ${index + 1}`, legs: [emptyLeg()] }
}

/** Deep-copy a mission with fresh ids (mission + every leg) so the clone is a
 *  fully independent entry; the label gets a "copy" suffix to stay distinct. */
export function duplicateMission(m: Mission): Mission {
  return { ...m, id: uid(), label: `${m.label} copy`, legs: m.legs.map((l) => ({ ...l, id: uid() })) }
}

export function useHaulingState() {
  // Parse persisted state exactly once (lazy initializer) — not on every render.
  const [initial] = useState(load)
  const [shipId, setShipId] = useState<number | null>(initial.shipId)
  const [missions, setMissions] = useState<Mission[]>(initial.missions)
  const [gridOverrides, setGridOverrides] = useState<GridOverrides>(initial.gridOverrides)
  const [handlingAlphaMilli, setHandlingAlphaMilli] = useState<number>(initial.handlingAlphaMilli)
  const [handlingDeltaMilli, setHandlingDeltaMilli] = useState<number>(initial.handlingDeltaMilli)

  // Persistence: debounced so per-keystroke edits don't each pay a synchronous
  // stringify + storage write; flushed on pagehide so the trailing edit isn't
  // lost when the tab closes inside the debounce window.
  const latest = useRef<Persisted>(initial)
  useEffect(() => {
    latest.current = { shipId, missions, gridOverrides, handlingAlphaMilli, handlingDeltaMilli }
    const t = setTimeout(() => save(latest.current), 250)
    return () => clearTimeout(t)
  }, [shipId, missions, gridOverrides, handlingAlphaMilli, handlingDeltaMilli])
  useEffect(() => {
    const flush = () => save(latest.current)
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [])

  /** Save (or clear, with null/empty) a user-authored grid for a ship. */
  const setGridOverride = (id: number, compartments: Compartment[] | null) => {
    setGridOverrides((cur) => {
      const next = { ...cur }
      if (compartments && compartments.length) next[String(id)] = compartments
      else delete next[String(id)]
      return next
    })
  }

  return {
    shipId, setShipId, missions, setMissions, gridOverrides, setGridOverride,
    handlingAlphaMilli, setHandlingAlphaMilli, handlingDeltaMilli, setHandlingDeltaMilli,
  }
}
