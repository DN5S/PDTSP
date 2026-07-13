// Builds the per-box execution checklist for a fixed witness. Within one stop,
// unloads remove blockers first and loads insert deep/low boxes first. The order
// is a deterministic topological sort of blocking pairs; defective witnesses
// still produce a complete checklist so audits can report the real issue.

import type { Compartment, BlockingModel, OpeningAxis } from '../ships/grids'
import { compartmentBlocking, compartmentOpeningAxis } from '../ships/grids'
import type { LoadoutBox, PlanOp } from '../domain/types'

const overlap1 = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1
const ovl = (f: LoadoutBox, r: LoadoutBox, i: number, j: number) =>
  overlap1(f.pos[i], f.pos[i] + f.dims[i], r.pos[i], r.pos[i] + r.dims[i]) &&
  overlap1(f.pos[j], f.pos[j] + f.dims[j], r.pos[j], r.pos[j] + r.dims[j])

/** Does f block r's extraction path? Global cells; both boxes share a compartment. */
function blocksBox(f: LoadoutBox, r: LoadoutBox, model: BlockingModel, axis: OpeningAxis): boolean {
  if (model === 'none') return false
  const vertical = ovl(f, r, 0, 1) && f.pos[2] >= r.pos[2] + r.dims[2]
  if (model === 'vertical') return vertical
  if (vertical) return true
  switch (axis) {
    case '+y': return ovl(f, r, 0, 2) && f.pos[1] >= r.pos[1] + r.dims[1]
    case '-y': return ovl(f, r, 0, 2) && f.pos[1] + f.dims[1] <= r.pos[1]
    case '+x': return ovl(f, r, 1, 2) && f.pos[0] >= r.pos[0] + r.dims[0]
    case '-x': return ovl(f, r, 1, 2) && f.pos[0] + f.dims[0] <= r.pos[0]
  }
}

function compOf(b: LoadoutBox, comps: Compartment[]): number {
  return comps.findIndex((c) =>
    b.pos[0] >= c.offset[0] && b.pos[0] + b.dims[0] <= c.offset[0] + c.dims[0] &&
    b.pos[1] >= c.offset[1] && b.pos[1] + b.dims[1] <= c.offset[1] + c.dims[1] &&
    b.pos[2] >= c.offset[2] && b.pos[2] + b.dims[2] <= c.offset[2] + c.dims[2])
}

/** Door-facing distance, or 0 for non-horizontal openings. */
function doorDepth(b: LoadoutBox, ci: number, comps: Compartment[]): number {
  if (ci < 0) return 0
  const c = comps[ci]
  if (compartmentBlocking(c) !== 'vertical+depth') return 0
  switch (compartmentOpeningAxis(c)) {
    case '+x': return c.offset[0] + c.dims[0] - (b.pos[0] + b.dims[0])
    case '-x': return b.pos[0] - c.offset[0]
    case '+y': return c.offset[1] + c.dims[1] - (b.pos[1] + b.dims[1])
    case '-y': return b.pos[1] - c.offset[1]
  }
}

/** Topological order for one stop's loads or unloads. */
function phaseOrder(set: LoadoutBox[], comps: Compartment[], forInsert: boolean): LoadoutBox[] {
  const n = set.length
  if (n <= 1) return [...set]
  const ci = set.map((b) => compOf(b, comps))
  const dd = set.map((b, i) => doorDepth(b, ci[i], comps))

  // succ[i] contains boxes that must come after i.
  const succ: number[][] = Array.from({ length: n }, () => [])
  const indeg = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j || ci[i] < 0 || ci[i] !== ci[j]) continue
      const model = compartmentBlocking(comps[ci[i]])
      const axis = compartmentOpeningAxis(comps[ci[i]])
      if (!blocksBox(set[i], set[j], model, axis)) continue
      // Insertion reverses the extraction dependency.
      const [before, after] = forInsert ? [j, i] : [i, j]
      succ[before].push(after)
      indeg[after]++
    }
  }

  // Tie-break toward fewer mission/leg fragments, then geometry, then ids.
  let prev: LoadoutBox | null = null
  const key = (i: number): (string | number)[] => {
    const b = set[i]
    return [
      prev && b.missionId === prev.missionId ? 0 : 1,
      prev && b.missionId === prev.missionId && b.legId === prev.legId ? 0 : 1,
      forInsert ? -dd[i] : dd[i],
      forInsert ? b.pos[2] : -b.pos[2],
      b.pos[1], b.pos[0],
      b.missionId, b.legId, b.id,
    ]
  }
  const less = (a: (string | number)[], b: (string | number)[]): boolean => {
    for (let k = 0; k < a.length; k++) {
      if (a[k] === b[k]) continue
      return typeof a[k] === 'number' && typeof b[k] === 'number' ? (a[k] as number) < (b[k] as number) : String(a[k]) < String(b[k])
    }
    return false
  }

  const out: LoadoutBox[] = []
  const done = new Array<boolean>(n).fill(false)
  while (out.length < n) {
    let pick = -1
    let pickKey: (string | number)[] | null = null
    let anyReady = false
    for (let i = 0; i < n; i++) {
      if (done[i] || indeg[i] > 0) continue
      anyReady = true
      const k = key(i)
      if (pickKey === null || less(k, pickKey)) { pick = i; pickKey = k }
    }
    if (!anyReady) {
      // Defective witness: break the cycle deterministically and keep the list complete.
      for (let i = 0; i < n; i++) {
        if (done[i]) continue
        const k = key(i)
        if (pickKey === null || less(k, pickKey)) { pick = i; pickKey = k }
      }
    }
    done[pick] = true
    out.push(set[pick])
    prev = set[pick]
    for (const j of succ[pick]) indeg[j]--
  }
  return out
}

/** Full operation checklist over the witness boxes. */
export function computeOpOrder(boxes: LoadoutBox[], comps: Compartment[]): PlanOp[] {
  const ops: PlanOp[] = []
  if (!boxes.length) return ops
  const maxStop = Math.max(...boxes.map((b) => b.deliverStop))
  for (let s = 0; s <= maxStop; s++) {
    const unloads = boxes.filter((b) => b.deliverStop === s)
    const loads = boxes.filter((b) => b.loadStop === s)
    for (const b of phaseOrder(unloads, comps, false)) ops.push({ kind: 'unload', boxId: b.id })
    for (const b of phaseOrder(loads, comps, true)) ops.push({ kind: 'load', boxId: b.id })
  }
  return ops
}
