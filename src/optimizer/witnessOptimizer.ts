import { compartmentBlocking, compartmentOpeningAxis, type Compartment } from '../ships/grids'
import { handlingCost, normalizeHandlingWeightMilli } from './handlingCost'
import { oracle, type OracleItem, type OraclePlacedBox, type OracleOptions } from './loadFeasibility'

interface WitnessScore {
  layout: number
  handlingMilli: number
  signature: string
}

interface StopSpan {
  stop: number
  minX: number
  maxX: number
  minY: number
  maxY: number
  footprint: number
}

export interface BestWitnessOptions {
  seed?: OraclePlacedBox[]
  alphaMilli?: number
  deltaMilli?: number
  /** Per variant repack budget. */
  nodeBudget?: number
}

function compOf(b: OraclePlacedBox, comps: Compartment[]): number {
  return comps.findIndex((c) =>
    b.pos[0] >= c.offset[0] && b.pos[0] + b.dims[0] <= c.offset[0] + c.dims[0] &&
    b.pos[1] >= c.offset[1] && b.pos[1] + b.dims[1] <= c.offset[1] + c.dims[1] &&
    b.pos[2] >= c.offset[2] && b.pos[2] + b.dims[2] <= c.offset[2] + c.dims[2])
}

function xyOverlap(a: OraclePlacedBox, b: OraclePlacedBox): boolean {
  return a.pos[0] < b.pos[0] + b.dims[0] && b.pos[0] < a.pos[0] + a.dims[0] &&
    a.pos[1] < b.pos[1] + b.dims[1] && b.pos[1] < a.pos[1] + a.dims[1]
}

function crossAxis(c: Compartment): 0 | 1 {
  if (compartmentBlocking(c) !== 'vertical+depth') return 0
  const axis = compartmentOpeningAxis(c)
  return axis === '+x' || axis === '-x' ? 1 : 0
}

function gridCapacity(comps: Compartment[]): number {
  return comps.reduce((a, c) => a + c.dims[0] * c.dims[1] * c.dims[2], 0)
}

function peakLoad(boxes: OraclePlacedBox[]): number {
  if (boxes.length === 0) return 0
  const maxStop = Math.max(...boxes.map((b) => Math.max(b.loadStop, b.deliverStop)))
  let peak = 0
  for (let s = 0; s <= maxStop; s++) {
    let onboard = 0
    for (const b of boxes) if (b.loadStop <= s && b.deliverStop > s) onboard += b.scu
    peak = Math.max(peak, onboard)
  }
  return peak
}

function gap1(a0: number, a1: number, b0: number, b1: number): number {
  if (a1 <= b0) return b0 - a1
  if (b1 <= a0) return a0 - b1
  return 0
}

/** Lazy-worker layout score. Lower means fewer visually mixed delivery groups. */
function layoutPenalty(boxes: OraclePlacedBox[], comps: Compartment[]): number {
  const byStop = new Map<number, Map<number, StopSpan>>()
  const spansByComp = new Map<number, StopSpan[]>()
  const stopsByComp = new Map<number, Set<number>>()
  const boxesByComp = new Map<number, OraclePlacedBox[]>()
  const fill = peakLoad(boxes) / Math.max(gridCapacity(comps), 1)
  const slack = Math.max(0, Math.min(1, (0.85 - fill) / 0.35))
  for (const b of boxes) {
    const ci = compOf(b, comps)
    if (ci < 0) continue
    const stopSet = stopsByComp.get(ci) ?? new Set<number>()
    stopSet.add(b.deliverStop)
    stopsByComp.set(ci, stopSet)
    const compBoxes = boxesByComp.get(ci) ?? []
    compBoxes.push(b)
    boxesByComp.set(ci, compBoxes)

    let byComp = byStop.get(b.deliverStop)
    if (!byComp) {
      byComp = new Map()
      byStop.set(b.deliverStop, byComp)
    }
    const local = byComp.get(ci)
    const x0 = b.pos[0] - comps[ci].offset[0]
    const x1 = x0 + b.dims[0]
    const y0 = b.pos[1] - comps[ci].offset[1]
    const y1 = y0 + b.dims[1]
    const footprint = b.dims[0] * b.dims[1]
    if (local) {
      local.minX = Math.min(local.minX, x0)
      local.maxX = Math.max(local.maxX, x1)
      local.minY = Math.min(local.minY, y0)
      local.maxY = Math.max(local.maxY, y1)
      local.footprint += footprint
    } else {
      const span = { stop: b.deliverStop, minX: x0, maxX: x1, minY: y0, maxY: y1, footprint }
      byComp.set(ci, span)
      const compSpans = spansByComp.get(ci) ?? []
      compSpans.push(span)
      spansByComp.set(ci, compSpans)
    }
  }
  let penalty = 0
  for (const byComp of byStop.values()) {
    // Prefer "one delivery stop = one visible zone/compartment" when capacity allows.
    penalty += Math.max(0, byComp.size - 1) * 20_000
  }
  for (const stopSet of stopsByComp.values()) {
    // Conversely, avoid mixing multiple delivery stops in one physical hold.
    penalty += Math.max(0, stopSet.size - 1) * 12_000
  }
  for (const [ci, byComp] of spansByComp) {
    const axis = crossAxis(comps[ci])
    for (let i = 0; i < byComp.length; i++) {
      const area = Math.max(1, (byComp[i].maxX - byComp[i].minX) * (byComp[i].maxY - byComp[i].minY))
      const targetDensity = 1 - 0.35 * slack
      const targetArea = byComp[i].footprint / Math.max(targetDensity, 0.5)
      if (area < targetArea) penalty += Math.ceil((targetArea - area) * slack * 180)
      for (let j = i + 1; j < byComp.length; j++) {
        const a0 = axis === 0 ? byComp[i].minX : byComp[i].minY
        const a1 = axis === 0 ? byComp[i].maxX : byComp[i].maxY
        const b0 = axis === 0 ? byComp[j].minX : byComp[j].minY
        const b1 = axis === 0 ? byComp[j].maxX : byComp[j].maxY
        const overlap = Math.min(a1, b1) - Math.max(a0, b0)
        if (overlap > 0) penalty += 3000 + overlap * 250
        const gapX = gap1(byComp[i].minX, byComp[i].maxX, byComp[j].minX, byComp[j].maxX)
        const gapY = gap1(byComp[i].minY, byComp[i].maxY, byComp[j].minY, byComp[j].maxY)
        const visibleGap = Math.max(gapX, gapY)
        const targetGap = slack >= 0.75 ? 2 : slack >= 0.25 ? 1 : 0
        if (visibleGap < targetGap) penalty += Math.ceil((targetGap - visibleGap) * slack * 2500)
      }
    }
  }
  for (const compBoxes of boxesByComp.values()) {
    for (const top of compBoxes) {
      for (const below of compBoxes) {
        if (top === below || top.deliverStop === below.deliverStop) continue
        if (below.pos[2] + below.dims[2] === top.pos[2] && xyOverlap(top, below)) {
          penalty += 1000
        }
      }
    }
  }
  return penalty
}

function signature(boxes: OraclePlacedBox[]): string {
  return [...boxes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((b) => `${b.id}@${b.pos.join(',')}/${b.dims.join('x')}`)
    .join('|')
}

export function witnessHandlingMilli(
  boxes: OraclePlacedBox[], comps: Compartment[], alphaMilli: number | undefined, deltaMilli: number | undefined,
): number {
  const alpha = normalizeHandlingWeightMilli(alphaMilli)
  const delta = normalizeHandlingWeightMilli(deltaMilli)
  const h = handlingCost(boxes, comps)
  return alpha * h.totalL + delta * h.totalG
}

function scoreWitness(boxes: OraclePlacedBox[], comps: Compartment[], opts: BestWitnessOptions): WitnessScore {
  return {
    layout: layoutPenalty(boxes, comps),
    handlingMilli: witnessHandlingMilli(boxes, comps, opts.alphaMilli, opts.deltaMilli),
    signature: signature(boxes),
  }
}

function better(a: WitnessScore, b: WitnessScore): boolean {
  if (a.layout !== b.layout) return a.layout < b.layout
  if (a.handlingMilli !== b.handlingMilli) return a.handlingMilli < b.handlingMilli
  return a.signature < b.signature
}

/** Best-effort witness optimizer for a fixed route timeline.
 *
 * Every candidate comes from the same hard oracle and is valid under the real
 * compartments. Soft-zone variants only change candidate order; they never add
 * a wall or reject an otherwise feasible placement.
 */
export function bestWitnessForItems(
  items: OracleItem[], compartments: Compartment[], opts: BestWitnessOptions = {},
): OraclePlacedBox[] | null {
  const nodeBudget = opts.nodeBudget ?? 8000
  const variants: OracleOptions[] = [
    { nodeBudget, cluster: true },
    { nodeBudget, zoneByDeliverStop: true, cluster: true },
    { nodeBudget, softZoneByDeliverStop: true, handlingBias: true, cluster: true },
    { nodeBudget, softZoneByDeliverStop: true, handlingBias: true },
  ]
  let best = opts.seed ?? null
  let bestScore = best ? scoreWitness(best, compartments, opts) : null

  const consider = (boxes: OraclePlacedBox[]) => {
    const s = scoreWitness(boxes, compartments, opts)
    if (!bestScore || better(s, bestScore)) {
      best = boxes
      bestScore = s
    }
  }

  if (!best) {
    const v = oracle(items, compartments, { nodeBudget })
    if (v.status === 'feasible') consider(v.boxes)
  }
  for (const variant of variants) {
    const v = oracle(items, compartments, variant)
    if (v.status === 'feasible') consider(v.boxes)
  }
  return best
}
