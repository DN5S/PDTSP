// Converts oracle witnesses into the LoadoutPlan rendered by the 3D view.
// Step-based loadouts fill incrementally and stage boxes until their support is
// present, so the UI never draws unsupported cargo as loaded.

import type { Compartment } from '../ships/grids'
import { gridBounds, gridCapacity } from '../ships/grids'
import type { LoadoutBox, RoutePlan, StopAction } from '../domain/types'

export interface PlacedBox {
  id: string
  missionId: string
  legId: string
  commodity: string
  scu: number
  pos: [number, number, number]
  /** Placed cell dimensions after rotation. */
  dims: [number, number, number]
  loadStop?: number
  deliverStop?: number
}

export interface UnplacedBox {
  missionId: string
  legId: string
  commodity: string
  scu: number
}

export interface LoadoutPlan {
  grid: [number, number, number]
  compartments: Compartment[]
  boxes: PlacedBox[]
  /** Checked in but waiting for support before it can be drawn in-grid. */
  deferred: PlacedBox[]
  unplaced: UnplacedBox[]
  missionOrder: string[]
  usedScu: number
  capacityScu: number
}

/** Mission palette excludes the 3D warning red/amber hues. */
export const MISSION_COLORS = [
  '#5b8cff', '#46c08a', '#ecd64d', '#c879e0',
  '#ec6fd6', '#3ec9c9', '#d98a4a', '#9d7bff',
  '#b7d94a', '#ff78b7', '#7aa7ff', '#caa36a',
  // User-selectable overrides, still outside the warning hues.
  '#7d8cff', '#6f78e0', '#b98cff', '#ff8fd0',
  '#2fb0a0', '#8ce06a', '#5ec8e0', '#4a90d9',
  '#a0b84a', '#c0a0d8', '#66c9b0', '#d98cc0',
]
export const missionColor = (index: number) =>
  MISSION_COLORS[index] ?? `hsl(${Math.round((index * 137.508) % 360)} 72% 63%)`

/** Display the witness cargo onboard after a stop boundary; no repacking. */
export function loadoutFromWitness(
  witness: LoadoutBox[],
  compartments: Compartment[],
  completedStopCount: number,
): LoadoutPlan {
  const onboard = witness.filter(
    (b) => b.loadStop < completedStopCount && b.deliverStop >= completedStopCount,
  )
  const boxes: PlacedBox[] = onboard.map((b) => ({
    id: b.id, missionId: b.missionId, legId: b.legId, commodity: b.commodity, scu: b.scu,
    pos: [...b.pos] as [number, number, number],
    dims: [...b.dims] as [number, number, number],
    loadStop: b.loadStop, deliverStop: b.deliverStop,
  }))
  // Legend/focus order: soonest-delivered mission first.
  const firstDeliver = new Map<string, number>()
  for (const b of onboard) {
    firstDeliver.set(b.missionId, Math.min(firstDeliver.get(b.missionId) ?? Infinity, b.deliverStop))
  }
  const missionOrder = [...firstDeliver.keys()].sort((a, b) => firstDeliver.get(a)! - firstDeliver.get(b)!)
  return {
    grid: gridBounds(compartments),
    compartments,
    boxes,
    deferred: [],
    unplaced: [],
    missionOrder,
    usedScu: boxes.reduce((a, b) => a + b.scu, 0),
    capacityScu: gridCapacity(compartments),
  }
}

/** One executable checklist step: same stop, kind, and mission. */
export interface RouteStepView {
  stopIndex: number
  kind: 'load' | 'unload'
  missionId: string
  scu: number
  actions: StopAction[]
  boxIds?: string[]
}

function groupActionsByMission(actions: StopAction[], kind: 'load' | 'unload') {
  const by = new Map<string, StopAction[]>()
  for (const a of actions) {
    if (a.kind !== kind) continue
    const arr = by.get(a.missionId)
    if (arr) arr.push(a)
    else by.set(a.missionId, [a])
  }
  return [...by.entries()].map(([missionId, acts]) => ({
    missionId, actions: acts, scu: acts.reduce((s, a) => s + a.scu, 0),
  }))
}

/** Group opOrder into checklist steps; null means opOrder/loadout are stale. */
function stepsFromOpOrder(plan: RoutePlan): RouteStepView[] | null {
  const boxes = plan.loadout!
  const ops = plan.opOrder!
  if (ops.length !== boxes.length * 2) return null
  const byId = new Map(boxes.map((b) => [b.id, b]))
  const steps: RouteStepView[] = []
  for (const op of ops) {
    const b = byId.get(op.boxId)
    if (!b) return null
    const stopIndex = op.kind === 'load' ? b.loadStop : b.deliverStop
    const last = steps[steps.length - 1]
    if (last && last.stopIndex === stopIndex && last.kind === op.kind && last.missionId === b.missionId) {
      last.scu += b.scu
      last.boxIds!.push(b.id)
      const act = last.actions.find((a) => a.legId === b.legId)
      if (act) act.scu += b.scu
      else last.actions.push({ kind: op.kind, legId: b.legId, missionId: b.missionId, commodity: b.commodity, scu: b.scu })
    } else {
      steps.push({
        stopIndex, kind: op.kind, missionId: b.missionId, scu: b.scu,
        actions: [{ kind: op.kind, legId: b.legId, missionId: b.missionId, commodity: b.commodity, scu: b.scu }],
        boxIds: [b.id],
      })
    }
  }
  return steps
}

/** Flatten a route into ordered checklist steps: unloads first, then loads. */
export function buildRouteSteps(plan: RoutePlan): RouteStepView[] {
  if (plan.opOrder && plan.loadout?.length) {
    const steps = stepsFromOpOrder(plan)
    if (steps) return steps
  }
  const depth = new Map<string, number>() // `${stop}:${mission}` -> min z
  if (plan.loadout) {
    for (const b of plan.loadout) {
      const k = `${b.loadStop}:${b.missionId}`
      const cur = depth.get(k)
      if (cur === undefined || b.pos[2] < cur) depth.set(k, b.pos[2])
    }
  }
  const steps: RouteStepView[] = []
  plan.stops.forEach((s, i) => {
    for (const g of groupActionsByMission(s.actions, 'unload')) {
      steps.push({ stopIndex: i, kind: 'unload', missionId: g.missionId, scu: g.scu, actions: g.actions })
    }
    const loads = groupActionsByMission(s.actions, 'load')
    if (plan.loadout) {
      loads.sort((a, b) => (depth.get(`${i}:${a.missionId}`) ?? 0) - (depth.get(`${i}:${b.missionId}`) ?? 0))
    }
    for (const g of loads) {
      steps.push({ stopIndex: i, kind: 'load', missionId: g.missionId, scu: g.scu, actions: g.actions })
    }
  })
  return steps
}

/** Step-by-step loadout at witness positions, staging boxes until supported. */
export function loadoutFromSteps(
  plan: RoutePlan,
  compartments: Compartment[],
  completedStepCount: number,
): LoadoutPlan {
  const steps = buildRouteSteps(plan)
  const boxesByLeg = new Map<string, LoadoutBox[]>()
  for (const b of plan.loadout ?? []) {
    const key = `${b.missionId}:${b.legId}`
    const arr = boxesByLeg.get(key)
    if (arr) arr.push(b)
    else boxesByLeg.set(key, [b])
  }

  const floorZOf = (b: LoadoutBox): number => {
    for (const c of compartments) {
      if (
        b.pos[0] >= c.offset[0] && b.pos[0] + b.dims[0] <= c.offset[0] + c.dims[0] &&
        b.pos[1] >= c.offset[1] && b.pos[1] + b.dims[1] <= c.offset[1] + c.dims[1] &&
        b.pos[2] >= c.offset[2] && b.pos[2] + b.dims[2] <= c.offset[2] + c.dims[2]
      ) return c.offset[2]
    }
    return 0
  }
  const filled = new Set<string>()
  const eachCell = (b: LoadoutBox, visit: (cell: string) => void) => {
    for (let z = b.pos[2]; z < b.pos[2] + b.dims[2]; z++)
      for (let y = b.pos[1]; y < b.pos[1] + b.dims[1]; y++)
        for (let x = b.pos[0]; x < b.pos[0] + b.dims[0]; x++) visit(`${x},${y},${z}`)
  }
  const rests = (b: LoadoutBox): boolean => {
    if (b.pos[2] === floorZOf(b)) return true
    for (let y = b.pos[1]; y < b.pos[1] + b.dims[1]; y++)
      for (let x = b.pos[0]; x < b.pos[0] + b.dims[0]; x++)
        if (!filled.has(`${x},${y},${b.pos[2] - 1}`)) return false
    return true
  }

  const placed = new Map<string, LoadoutBox>()
  const waiting = new Map<string, LoadoutBox>()
  const settle = () => {
    let changed = true
    while (changed) {
      changed = false
      for (const [id, b] of waiting) {
        if (!rests(b)) continue
        waiting.delete(id)
        placed.set(id, b)
        eachCell(b, (cell) => filled.add(cell))
        changed = true
      }
    }
  }

  const boxById = new Map<string, LoadoutBox>()
  for (const b of plan.loadout ?? []) boxById.set(b.id, b)
  for (let i = 0; i < completedStepCount && i < steps.length; i++) {
    const step = steps[i]
    // boxIds pin exact split-leg boxes; legacy steps move boxes by leg.
    const stepBoxes = step.boxIds
      ? step.boxIds.flatMap((id) => boxById.get(id) ?? [])
      : step.actions.flatMap((a) => boxesByLeg.get(`${a.missionId}:${a.legId}`) ?? [])
    if (step.kind === 'load') {
      for (const b of stepBoxes) waiting.set(b.id, b)
    } else {
      for (const b of stepBoxes) {
        waiting.delete(b.id)
        if (placed.delete(b.id)) eachCell(b, (cell) => filled.delete(cell))
      }
    }
    settle()
  }

  const toPlaced = (b: LoadoutBox): PlacedBox => ({
    id: b.id, missionId: b.missionId, legId: b.legId, commodity: b.commodity, scu: b.scu,
    pos: [...b.pos] as [number, number, number],
    dims: [...b.dims] as [number, number, number],
    loadStop: b.loadStop, deliverStop: b.deliverStop,
  })
  const onboardBoxes = [...placed.values()]
  const boxes = onboardBoxes.map(toPlaced)
  const deferred = [...waiting.values()].map(toPlaced)
  const firstDeliver = new Map<string, number>()
  for (const b of onboardBoxes) {
    firstDeliver.set(b.missionId, Math.min(firstDeliver.get(b.missionId) ?? Infinity, b.deliverStop))
  }
  const missionOrder = [...firstDeliver.keys()].sort((a, b) => firstDeliver.get(a)! - firstDeliver.get(b)!)
  return {
    grid: gridBounds(compartments),
    compartments,
    boxes,
    deferred,
    unplaced: [],
    missionOrder,
    usedScu: boxes.reduce((a, b) => a + b.scu, 0),
    capacityScu: gridCapacity(compartments),
  }
}
