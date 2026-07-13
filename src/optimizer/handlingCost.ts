// Handling measurement for F = distance + sum(alpha * L + delta * G).
//
// L is slide length to fully exit the door/rim. G is lateral cargo-cell contact
// accumulated at each slide step. Occupancy is reconstructed from onboard
// intervals using the same same-stop convention as the oracle.

import type { Compartment } from '../ships/grids'
import { compartmentBlocking, compartmentOpeningAxis } from '../ships/grids'
import type { LoadoutBox } from '../domain/types'

export interface OpHandling {
  L: number
  G: number
}

export interface BoxHandling {
  id: string
  load: OpHandling
  unload: OpHandling
}

export interface HandlingCost {
  perBox: BoxHandling[]
  totalL: number
  totalG: number
}

type Vec = [number, number, number]

/** Handling weights are non-negative fixed-point costs; invalid input disables that term. */
export function normalizeHandlingWeightMilli(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}

function compOf(b: LoadoutBox, comps: Compartment[]): number {
  return comps.findIndex((c) =>
    b.pos[0] >= c.offset[0] && b.pos[0] + b.dims[0] <= c.offset[0] + c.dims[0] &&
    b.pos[1] >= c.offset[1] && b.pos[1] + b.dims[1] <= c.offset[1] + c.dims[1] &&
    b.pos[2] >= c.offset[2] && b.pos[2] + b.dims[2] <= c.offset[2] + c.dims[2])
}

/** Slide direction and travel to full exit for a box's compartment. */
function slideOf(b: LoadoutBox, c: Compartment): { dir: Vec; L: number } | null {
  const model = compartmentBlocking(c)
  if (model === 'none') return null // independent access — no priced slide
  if (model === 'vertical') {
    const rim = c.offset[2] + c.dims[2]
    return { dir: [0, 0, 1], L: rim - (b.pos[2] + b.dims[2]) + b.dims[2] }
  }
  switch (compartmentOpeningAxis(c)) {
    case '+x': return { dir: [1, 0, 0], L: c.offset[0] + c.dims[0] - (b.pos[0] + b.dims[0]) + b.dims[0] }
    case '-x': return { dir: [-1, 0, 0], L: b.pos[0] - c.offset[0] + b.dims[0] }
    case '+y': return { dir: [0, 1, 0], L: c.offset[1] + c.dims[1] - (b.pos[1] + b.dims[1]) + b.dims[1] }
    case '-y': return { dir: [0, -1, 0], L: b.pos[1] - c.offset[1] + b.dims[1] }
  }
}

/** L and G for one box move against obstacle cells in the same compartment. */
function opHandling(b: LoadoutBox, c: Compartment, obstacleCells: Set<string>): OpHandling {
  const slide = slideOf(b, c)
  if (!slide) return { L: 0, G: 0 }
  const { dir, L } = slide
  if (!obstacleCells.size) return { L, G: 0 }
  // Four lateral directions perpendicular to the slide axis.
  const lat: Vec[] = dir[0] !== 0
    ? [[0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    : dir[1] !== 0
      ? [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
      : [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]
  let G = 0
  for (let s = 1; s <= L; s++) {
    for (let z = 0; z < b.dims[2]; z++)
      for (let y = 0; y < b.dims[1]; y++)
        for (let x = 0; x < b.dims[0]; x++) {
          const cx = b.pos[0] + x + dir[0] * s
          const cy = b.pos[1] + y + dir[1] * s
          const cz = b.pos[2] + z + dir[2] * s
          for (const d of lat) {
            // A neighbor inside the moving box itself is not a contact.
            const nx = cx + d[0], ny = cy + d[1], nz = cz + d[2]
            const inSelf =
              nx >= b.pos[0] + dir[0] * s && nx < b.pos[0] + b.dims[0] + dir[0] * s &&
              ny >= b.pos[1] + dir[1] * s && ny < b.pos[1] + b.dims[1] + dir[1] * s &&
              nz >= b.pos[2] + dir[2] * s && nz < b.pos[2] + b.dims[2] + dir[2] * s
            if (!inSelf && obstacleCells.has(`${nx},${ny},${nz}`)) G++
          }
        }
  }
  return { L, G }
}

const addCells = (b: LoadoutBox, cells: Set<string>) => {
  for (let z = b.pos[2]; z < b.pos[2] + b.dims[2]; z++)
    for (let y = b.pos[1]; y < b.pos[1] + b.dims[1]; y++)
      for (let x = b.pos[0]; x < b.pos[0] + b.dims[0]; x++) cells.add(`${x},${y},${z}`)
}

/** Witness totals plus per-stop load/unload aggregation. */
export function planHandling(
  boxes: LoadoutBox[], comps: Compartment[], stopCount: number,
): { totalL: number; totalG: number; perStop: { L: number; G: number }[] } {
  const h = handlingCost(boxes, comps)
  const perStop = Array.from({ length: stopCount }, () => ({ L: 0, G: 0 }))
  boxes.forEach((b, i) => {
    const p = h.perBox[i]
    const load = perStop[b.loadStop]
    if (load) { load.L += p.load.L; load.G += p.load.G }
    const unload = perStop[b.deliverStop]
    if (unload) { unload.L += p.unload.L; unload.G += p.unload.G }
  })
  return { totalL: h.totalL, totalG: h.totalG, perStop }
}

/** Post-hoc handling measurement of a whole witness. */
export function handlingCost(boxes: LoadoutBox[], comps: Compartment[]): HandlingCost {
  const perBox: BoxHandling[] = []
  let totalL = 0
  let totalG = 0
  const ci = boxes.map((b) => compOf(b, comps))
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]
    if (ci[i] < 0) {
      perBox.push({ id: b.id, load: { L: 0, G: 0 }, unload: { L: 0, G: 0 } })
      continue
    }
    const c = comps[ci[i]]
    // Obstacles are cargo already onboard for this load/unload moment.
    const loadCells = new Set<string>()
    const unloadCells = new Set<string>()
    for (let j = 0; j < boxes.length; j++) {
      if (j === i || ci[j] !== ci[i]) continue
      const a = boxes[j]
      if (a.loadStop < b.loadStop && a.deliverStop > b.loadStop) addCells(a, loadCells)
      if (a.loadStop < b.deliverStop && a.deliverStop > b.deliverStop) addCells(a, unloadCells)
    }
    const load = opHandling(b, c, loadCells)
    const unload = opHandling(b, c, unloadCells)
    perBox.push({ id: b.id, load, unload })
    totalL += load.L + unload.L
    totalG += load.G + unload.G
  }
  return { perBox, totalL, totalG }
}
