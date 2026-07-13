// Hard-LIFO 3D loading oracle.
//
// For a fixed route timeline, find a placement where no later-delivered box
// blocks an earlier delivery's extraction path or support. The DFS keeps that
// invariant during placement instead of repairing the hold mid-route.
//
// Verdicts are intentionally three-valued: budget exhaustion is reported as
// unknown, never as proof of infeasibility.

import type { RoutePlan } from '../domain/types'
import type { PlannerLeg } from './pdp'
import type { PlacedBox } from './loadout'
import {
  type Compartment, type BlockingModel, type OpeningAxis,
  compartmentBlocking, compartmentOpeningAxis, compartmentAllowsBox, compartmentPriority, gridCapacity,
} from '../ships/grids'
import { decomposeToBoxes } from '../domain/cargo'
import { orientations, boxFits, fits as gridFits, fill as gridFill, supported as gridSupported, type Dims3 } from './packPrimitives'

/** A placed box plus its route timing, so any onboard interval can be reconstructed. */
export interface OraclePlacedBox extends PlacedBox {
  loadStop: number
  deliverStop: number
}

export type OracleVerdict =
  | { status: 'feasible'; boxes: OraclePlacedBox[] }
  | { status: 'infeasible-proven'; reason: string }
  | { status: 'unknown-budget' }

export interface OracleOptions {
  /** DFS node budget. Wall-clock caps stay outside the oracle so verdicts are deterministic. */
  nodeBudget?: number
  /** Bias candidate order toward fewer per-mission compartments; does not shrink the search set. */
  cluster?: boolean
  /** Restrict each delivery stop to assigned compartment zones; witness-quality only. */
  zoneByDeliverStop?: boolean
  /** Prefer dynamic in-compartment delivery bands without rejecting out-of-band candidates. */
  softZoneByDeliverStop?: boolean
  /** Prefer lower slide length for candidate placements without changing feasibility. */
  handlingBias?: boolean
}

export interface OracleItem {
  legId: string
  missionId: string
  commodity: string
  scu: number
  boxes: Dims3[]
  loadStop: number
  deliverStop: number
}

// Positions are compartment-local cells.
interface BoxJob {
  id: string
  item: OracleItem
  canon: Dims3
}
interface Box3 { lx: number; ly: number; lz: number; w: number; d: number; h: number }
interface Placed extends Box3 {
  id: string
  item: OracleItem
  ci: number
}

// Geometry of "f blocks r" (compartment-local).

const rangeOverlap = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1
const xyOverlap = (f: Box3, r: Box3) =>
  rangeOverlap(f.lx, f.lx + f.w, r.lx, r.lx + r.w) && rangeOverlap(f.ly, f.ly + f.d, r.ly, r.ly + r.d)
const xzOverlap = (f: Box3, r: Box3) =>
  rangeOverlap(f.lx, f.lx + f.w, r.lx, r.lx + r.w) && rangeOverlap(f.lz, f.lz + f.h, r.lz, r.lz + r.h)
const yzOverlap = (f: Box3, r: Box3) =>
  rangeOverlap(f.ly, f.ly + f.d, r.ly, r.ly + r.d) && rangeOverlap(f.lz, f.lz + f.h, r.lz, r.lz + r.h)

function depthBlocks(f: Box3, r: Box3, axis: OpeningAxis): boolean {
  switch (axis) {
    case '+y': return xzOverlap(f, r) && f.ly >= r.ly + r.d // f entirely beyond r toward +y door
    case '-y': return xzOverlap(f, r) && f.ly + f.d <= r.ly
    case '+x': return yzOverlap(f, r) && f.lx >= r.lx + r.w
    case '-x': return yzOverlap(f, r) && f.lx + f.w <= r.lx
  }
}

/** Does f block r's extraction under this compartment's model? (f, r in same compartment.) */
function blocks(f: Box3, r: Box3, model: BlockingModel, axis: OpeningAxis): boolean {
  if (model === 'none') return false
  const vertical = xyOverlap(f, r) && f.lz >= r.lz + r.h // f on top of r
  if (model === 'vertical') return vertical
  return vertical || depthBlocks(f, r, axis)
}

const legKey = (missionId: string, legId: string) => `${missionId}:${legId}`

/** Assign delivery stops to compartment zones for an already-feasible witness.
 *  Returns null when zoning is not useful or cannot cover the stop groups. */
function assignZones(items: OracleItem[], compartments: Compartment[]): Map<number, number[]> | null {
  if (compartments.length < 2) return null
  interface Group { stops: number[]; scu: number; bigDims: Dims3; bigScu: number }
  const byStop = new Map<number, Group>()
  for (const it of items) {
    let g = byStop.get(it.deliverStop)
    if (!g) {
      g = { stops: [it.deliverStop], scu: 0, bigDims: [1, 1, 1], bigScu: 0 }
      byStop.set(it.deliverStop, g)
    }
    g.scu += it.scu
    for (const dims of it.boxes) {
      const scu = dims[0] * dims[1] * dims[2]
      if (scu > g.bigScu) {
        g.bigScu = scu
        g.bigDims = dims
      }
    }
  }
  let groups = [...byStop.values()]
  if (groups.length < 2) return null // one destination — zoning is meaningless

  const capOf = (ci: number) => compartments[ci].dims[0] * compartments[ci].dims[1] * compartments[ci].dims[2]
  const accepts = (ci: number, g: Group) =>
    compartmentAllowsBox(compartments[ci], g.bigScu) && boxFits(g.bigDims, compartments[ci].dims)

  const tryAssign = (gs: Group[]): Map<number, number[]> | null => {
    const used = new Set<number>()
    const result = new Map<number, number[]>()
    for (const g of [...gs].sort((a, b) => b.scu - a.scu)) {
      const cands = compartments
        .map((_, ci) => ci)
        .filter((ci) => !used.has(ci) && accepts(ci, g))
        .sort((a, b) => capOf(b) - capOf(a))
      const assigned: number[] = []
      let cap = 0
      for (const ci of cands) {
        if (cap >= g.scu) break
        assigned.push(ci)
        used.add(ci)
        cap += capOf(ci)
      }
      if (cap < g.scu) return null
      for (const s of g.stops) result.set(s, assigned)
    }
    return result
  }

  for (;;) {
    if (groups.length <= compartments.length) {
      const r = tryAssign(groups)
      if (r) return r
    }
    if (groups.length < 3) return null // merging further would zone everything together
    groups.sort((a, b) => a.scu - b.scu)
    const [g1, g2, ...rest] = groups
    groups = [
      {
        stops: [...g1.stops, ...g2.stops],
        scu: g1.scu + g2.scu,
        bigDims: g1.bigScu >= g2.bigScu ? g1.bigDims : g2.bigDims,
        bigScu: Math.max(g1.bigScu, g2.bigScu),
      },
      ...rest,
    ]
  }
}

interface SoftBand { start: number; end: number }
interface SoftZone { axis: 0 | 1; bands: Map<number, SoftBand> }

function softZoneAxis(model: BlockingModel, axis: OpeningAxis, singleCompartment: boolean): 0 | 1 | null {
  if (model !== 'vertical+depth') return null
  // A single wide hold benefits from delivery bands along the door-depth axis:
  // first stop near the door, later stops deeper in. Multi-bay ships already
  // get physical compartment zoning, so their soft bias stays cross-lane.
  if (singleCompartment) return axis === '+x' || axis === '-x' ? 0 : 1
  return axis === '+x' || axis === '-x' ? 1 : 0
}

function peakScu(items: OracleItem[]): number {
  const maxStop = Math.max(...items.map((i) => Math.max(i.loadStop, i.deliverStop)))
  let peak = 0
  for (let s = 0; s <= maxStop; s++) {
    let onboard = 0
    for (const it of items) if (it.loadStop <= s && it.deliverStop > s) onboard += it.scu
    peak = Math.max(peak, onboard)
  }
  return peak
}

/** Dynamic delivery bands inside each physical compartment. These bands are soft:
 * candidates outside the band are merely tried later, never rejected. */
function buildSoftZones(
  items: OracleItem[], compartments: Compartment[], models: BlockingModel[], axes: OpeningAxis[],
): (SoftZone | null)[] | null {
  const byStop = new Map<number, number>()
  for (const it of items) byStop.set(it.deliverStop, (byStop.get(it.deliverStop) ?? 0) + it.scu)
  const stops = [...byStop.keys()].sort((a, b) => a - b)
  if (stops.length < 2) return null
  const fill = peakScu(items) / Math.max(gridCapacity(compartments), 1)
  const slack = Math.max(0, Math.min(1, (0.85 - fill) / 0.35))

  let useful = false
  const zones = compartments.map((c, ci): SoftZone | null => {
    const axis = softZoneAxis(models[ci], axes[ci], compartments.length === 1)
    if (axis === null) return null
    const span = c.dims[axis]
    if (span < 2) return null
    useful = true

    const bands = new Map<number, SoftBand>()
    let cursor = 0
    const gap = slack >= 0.75 ? 2 : slack >= 0.25 ? 1 : 0
    const totalGap = Math.min(span - stops.length, Math.max(0, stops.length - 1) * gap)
    const gapEach = totalGap > 0 && stops.length > 1 ? Math.floor(totalGap / (stops.length - 1)) : 0
    let remainingSpan = Math.max(stops.length, span - totalGap)
    let remainingVol = stops.reduce((a, s) => a + (byStop.get(s) ?? 0), 0)
    stops.forEach((s, i) => {
      const left = stops.length - i
      const vol = byStop.get(s) ?? 0
      const width = left === 1
        ? remainingSpan
        : Math.max(1, Math.min(remainingSpan - (left - 1), Math.round((vol / Math.max(remainingVol, 1)) * remainingSpan)))
      const start = cursor
      const end = cursor + width
      const positiveDepth = compartments.length === 1 && (axes[ci] === '+x' || axes[ci] === '+y')
      bands.set(s, positiveDepth ? { start: span - end, end: span - start } : { start, end })
      cursor += width
      if (i < stops.length - 1) cursor += gapEach
      remainingSpan -= width
      remainingVol -= vol
    })
    return { axis, bands }
  })
  return useful ? zones : null
}

/** Build oracle items from a route plan: each leg's load/deliver stop index + boxes. */
export function itemsFromPlan(legs: PlannerLeg[], plan: RoutePlan): OracleItem[] {
  const byKey = new Map<string, PlannerLeg>()
  for (const l of legs) byKey.set(legKey(l.missionId, l.id), l)
  const loadStop = new Map<string, number>()
  const deliverStop = new Map<string, number>()
  plan.stops.forEach((s, i) => {
    for (const a of s.actions) {
      const k = legKey(a.missionId, a.legId)
      if (a.kind === 'load') loadStop.set(k, i)
      else deliverStop.set(k, i)
    }
  })
  const items: OracleItem[] = []
  for (const [k, l] of byKey) {
    const ls = loadStop.get(k)
    const ds = deliverStop.get(k)
    if (ls === undefined || ds === undefined) continue
    items.push({
      legId: l.id, missionId: l.missionId, commodity: l.commodity, scu: l.scu,
      boxes: decomposeToBoxes(l.scu, l.maxBoxScu ?? 32).map((b) => b.dims),
      loadStop: ls, deliverStop: ds,
    })
  }
  return items
}

export function feasibilityForRoute(
  legs: PlannerLeg[], plan: RoutePlan, compartments: Compartment[], opts: OracleOptions = {},
): OracleVerdict {
  if (!plan.feasible) return { status: 'infeasible-proven', reason: 'route is not feasible' }
  return oracle(itemsFromPlan(legs, plan), compartments, opts)
}

export function oracle(
  items: OracleItem[], compartments: Compartment[], opts: OracleOptions = {},
): OracleVerdict {
  const nodeBudget = opts.nodeBudget ?? 3_000_000
  const clusterBias = opts.cluster ?? false

  if (items.length === 0) return { status: 'feasible', boxes: [] }

  // Fast global certificates: proven infeasible without DFS.
  const maxStop = Math.max(...items.map((i) => Math.max(i.loadStop, i.deliverStop)))
  const cap = gridCapacity(compartments)
  for (let s = 0; s <= maxStop; s++) {
    let onboard = 0
    for (const it of items) if (it.loadStop <= s && it.deliverStop > s) onboard += it.scu
    if (onboard > cap) {
      return { status: 'infeasible-proven', reason: `peak load ${onboard} SCU exceeds capacity ${cap} SCU` }
    }
  }
  const models = compartments.map(compartmentBlocking)
  const axes = compartments.map(compartmentOpeningAxis)
  for (const it of items) {
    for (const dims of it.boxes) {
      const scu = dims[0] * dims[1] * dims[2]
      const ok = compartments.some((c) => compartmentAllowsBox(c, scu) && boxFits(dims, c.dims))
      if (!ok) return { status: 'infeasible-proven', reason: `a ${scu}-SCU box of "${it.commodity}" fits no compartment` }
    }
  }

  // At a stop, unload first and then load that stop's boxes as one order-free batch.
  type Step = { kind: 'unload'; item: OracleItem } | { kind: 'loadBatch'; jobs: BoxJob[] }
  const vol = (d: Dims3) => d[0] * d[1] * d[2]
  const steps: Step[] = []
  for (let s = 0; s <= maxStop; s++) {
    for (const it of items) if (it.deliverStop === s) steps.push({ kind: 'unload', item: it })
    const loads: BoxJob[] = []
    for (const it of items) {
      if (it.loadStop !== s) continue
      it.boxes.forEach((canon, bi) => loads.push({ id: `${it.legId}-${bi}`, item: it, canon }))
    }
    // First-try order only; backtracking still explores other same-stop load orders.
    loads.sort((a, b) => b.item.deliverStop - a.item.deliverStop || vol(b.canon) - vol(a.canon))
    if (loads.length) steps.push({ kind: 'loadBatch', jobs: loads })
  }

  const occ = compartments.map((c) => new Uint8Array(c.dims[0] * c.dims[1] * c.dims[2]))
  const onboardByComp: Placed[][] = compartments.map(() => [])
  const committed = new Map<string, Placed>() // full witness, including boxes already unloaded
  let nodes = 0
  let budgetHit = false

  const place = (p: Placed) => {
    gridFill(compartments[p.ci].dims, occ[p.ci], p.lx, p.ly, p.lz, p.w, p.d, p.h, 1)
    onboardByComp[p.ci].push(p)
    committed.set(p.id, p)
  }
  const unplace = (p: Placed) => {
    gridFill(compartments[p.ci].dims, occ[p.ci], p.lx, p.ly, p.lz, p.w, p.d, p.h, 0)
    const arr = onboardByComp[p.ci]
    arr.splice(arr.lastIndexOf(p), 1)
    committed.delete(p.id)
  }

  // Delivery-side invariant: later cargo must not block earlier cargo.
  const lifoOk = (cand: Placed): boolean => {
    const model = models[cand.ci]
    if (model === 'none') return true
    const axis = axes[cand.ci]
    for (const a of onboardByComp[cand.ci]) {
      const ad = a.item.deliverStop
      const cd = cand.item.deliverStop
      if (cd === ad) continue
      if (cd > ad) { if (blocks(cand, a, model, axis)) return false } // later cand must not block earlier a
      else { if (blocks(a, cand, model, axis)) return false }         // later a must not block earlier cand
    }
    return true
  }

  // Insertion-side invariant: older onboard cargo must not occupy cand's path in.
  // Same-stop batches are exempt because their internal order is chosen later.
  const insertOk = (cand: Placed): boolean => {
    const model = models[cand.ci]
    if (model === 'none') return true
    const axis = axes[cand.ci]
    for (const a of onboardByComp[cand.ci]) {
      if (a.item.loadStop >= cand.item.loadStop) continue // same-stop batch: order-free
      if (blocks(a, cand, model, axis)) return false
    }
    return true
  }

  // Clustering changes trial order only: same mission, empty, then mixed.
  const compRank = (ci: number, missionId: string): number => {
    let same = false
    let other = false
    for (const p of onboardByComp[ci]) {
      if (p.item.missionId === missionId) same = true
      else other = true
    }
    return same ? 0 : other ? 2 : 1
  }

  // Null means no zoning filter.
  const zones = opts.zoneByDeliverStop ? assignZones(items, compartments) : null
  const softZones = opts.softZoneByDeliverStop ? buildSoftZones(items, compartments, models, axes) : null
  const handlingRankActive = opts.handlingBias === true && models.some((m) => m === 'vertical+depth')
  const rankCandidates = !!softZones || handlingRankActive

  // Compartment order is a search heuristic unless zoning is active; zoning is a
  // real filter and is therefore used only for witness-quality repacks.
  const compartmentOrder = (job: BoxJob): number[] => {
    const scu = job.canon[0] * job.canon[1] * job.canon[2]
    const zone = zones?.get(job.item.deliverStop)
    const order: number[] = []
    for (let ci = 0; ci < compartments.length; ci++) {
      if (!compartmentAllowsBox(compartments[ci], scu)) continue
      if (zone && !zone.includes(ci)) continue
      order.push(ci)
    }
    if (!clusterBias) return order
    const missionId = job.item.missionId
    return order.sort((a, b) =>
      compartmentPriority(compartments[a]) - compartmentPriority(compartments[b]) ||
      compRank(a, missionId) - compRank(b, missionId) ||
      a - b)
  }

  const slideLength = (p: Placed): number => {
    if (!handlingRankActive || models[p.ci] !== 'vertical+depth') return 0
    const c = compartments[p.ci]
    switch (axes[p.ci]) {
      case '+x': return c.dims[0] - (p.lx + p.w) + p.w
      case '-x': return p.lx + p.w
      case '+y': return c.dims[1] - (p.ly + p.d) + p.d
      case '-y': return p.ly + p.d
    }
  }

  const zoneMiss = (p: Placed): number => {
    const soft = softZones?.[p.ci]
    if (!soft) return 0
    const band = soft.bands.get(p.item.deliverStop)
    if (!band) return 0
    const start = soft.axis === 0 ? p.lx : p.ly
    const end = start + (soft.axis === 0 ? p.w : p.d)
    if (end <= band.start) return band.start - end
    if (start >= band.end) return start - band.end
    return 0
  }

  const candidateRank = (p: Placed): number =>
    zoneMiss(p) * 1_000 + slideLength(p)

  // Mirror sweeps for negative-axis doors so symmetric bays get symmetric search.
  const ascN = (n: number) => Array.from({ length: n }, (_, i) => i)
  const descN = (n: number) => Array.from({ length: n }, (_, i) => n - 1 - i)
  const sweeps = compartments.map((c, ci) => {
    const [cx, cy] = c.dims
    const flipX = models[ci] === 'vertical+depth' && axes[ci] === '-x'
    const flipY = models[ci] === 'vertical+depth' && axes[ci] === '-y'
    return { xs: flipX ? descN(cx) : ascN(cx), ys: flipY ? descN(cy) : ascN(cy) }
  })

  // Candidate placements across allowed compartments, bottom-up.
  const candidates = function* (job: BoxJob): Generator<Placed> {
    const ranked: Placed[] = []
    for (const ci of compartmentOrder(job)) {
      const c = compartments[ci]
      const cz = c.dims[2]
      const { xs, ys } = sweeps[ci]
      for (let lz = 0; lz < cz; lz++)
        for (const ly of ys)
          for (const lx of xs)
            for (const [w, d, h] of orientations(job.canon)) {
              if (!gridFits(c.dims, occ[ci], lx, ly, lz, w, d, h)) continue
              if (!gridSupported(c.dims, occ[ci], lx, ly, lz, w, d)) continue
              const cand = { id: job.id, item: job.item, ci, lx, ly, lz, w, d, h }
              if (rankCandidates) ranked.push(cand)
              else yield cand
            }
    }
    if (rankCandidates) {
      ranked.sort((a, b) => candidateRank(a) - candidateRank(b))
      for (const cand of ranked) yield cand
    }
  }

  const outOfBudget = () => ++nodes > nodeBudget

  function search(i: number): boolean {
    if (budgetHit) return false
    if (i === steps.length) return true
    if (outOfBudget()) { budgetHit = true; return false }
    const step = steps[i]
    if (step.kind === 'unload') {
      // Unloaded boxes leave occupancy, but stay in committed for the witness.
      const removed: Placed[] = []
      for (const arr of onboardByComp) {
        for (let k = arr.length - 1; k >= 0; k--) {
          if (arr[k].item === step.item) {
            const p = arr[k]
            gridFill(compartments[p.ci].dims, occ[p.ci], p.lx, p.ly, p.lz, p.w, p.d, p.h, 0)
            arr.splice(k, 1)
            removed.push(p)
          }
        }
      }
      const ok = search(i + 1)
      if (!ok) {
        for (const p of removed) {
          gridFill(compartments[p.ci].dims, occ[p.ci], p.lx, p.ly, p.lz, p.w, p.d, p.h, 1)
          onboardByComp[p.ci].push(p)
        }
      }
      return ok
    }
    // Batch order is part of the search so support providers can be placed first.
    return placeBatch(step.jobs, new Array<boolean>(step.jobs.length).fill(false), step.jobs.length, i)
  }

  function placeBatch(jobs: BoxJob[], placed: boolean[], remaining: number, i: number): boolean {
    if (budgetHit) return false
    if (remaining === 0) return search(i + 1)
    if (outOfBudget()) { budgetHit = true; return false }
    // Identical boxes of one leg are interchangeable at this depth.
    const triedHere = new Set<string>()
    for (let ji = 0; ji < jobs.length; ji++) {
      if (placed[ji]) continue
      const job = jobs[ji]
      const key = `${job.item.legId}|${job.canon.join('x')}`
      if (triedHere.has(key)) continue
      triedHere.add(key)
      placed[ji] = true
      for (const cand of candidates(job)) {
        if (!lifoOk(cand) || !insertOk(cand)) continue
        place(cand)
        if (placeBatch(jobs, placed, remaining - 1, i)) return true
        unplace(cand)
        if (budgetHit) { placed[ji] = false; return false }
      }
      placed[ji] = false
    }
    return false
  }

  const solved = search(0)
  if (solved) {
    const boxes: OraclePlacedBox[] = []
    for (const p of committed.values()) {
      const c = compartments[p.ci]
      boxes.push({
        id: p.id, missionId: p.item.missionId, legId: p.item.legId, commodity: p.item.commodity,
        scu: p.w * p.d * p.h,
        pos: [c.offset[0] + p.lx, c.offset[1] + p.ly, c.offset[2] + p.lz],
        dims: [p.w, p.d, p.h],
        loadStop: p.item.loadStop, deliverStop: p.item.deliverStop,
      })
    }
    return { status: 'feasible', boxes }
  }
  return budgetHit ? { status: 'unknown-budget' } : { status: 'infeasible-proven', reason: 'no LIFO-valid packing exists for this order' }
}

/** Repack an already-feasible order with mission-clustering bias. */
export function clusteredWitness(
  items: OracleItem[], compartments: Compartment[], opts: OracleOptions = {},
): OraclePlacedBox[] | null {
  const v = oracle(items, compartments, { ...opts, cluster: true })
  return v.status === 'feasible' ? v.boxes : null
}

/** Repack an already-feasible order with destination zones; null keeps the prior witness. */
export function zonedWitness(
  items: OracleItem[], compartments: Compartment[], opts: OracleOptions = {},
): OraclePlacedBox[] | null {
  const v = oracle(items, compartments, { ...opts, zoneByDeliverStop: true, cluster: true })
  return v.status === 'feasible' ? v.boxes : null
}

/** Independent LIFO check for a returned witness. */
export function verifyWitness(boxes: OraclePlacedBox[], compartments: Compartment[]): boolean {
  const models = compartments.map(compartmentBlocking)
  const axes = compartments.map(compartmentOpeningAxis)
  const compOf = (b: OraclePlacedBox): number => {
    for (let ci = 0; ci < compartments.length; ci++) {
      const c = compartments[ci]
      if (
        b.pos[0] >= c.offset[0] && b.pos[0] + b.dims[0] <= c.offset[0] + c.dims[0] &&
        b.pos[1] >= c.offset[1] && b.pos[1] + b.dims[1] <= c.offset[1] + c.dims[1] &&
        b.pos[2] >= c.offset[2] && b.pos[2] + b.dims[2] <= c.offset[2] + c.dims[2]
      ) return ci
    }
    return -1
  }
  const local = (b: OraclePlacedBox, ci: number): Box3 => {
    const c = compartments[ci]
    return { lx: b.pos[0] - c.offset[0], ly: b.pos[1] - c.offset[1], lz: b.pos[2] - c.offset[2], w: b.dims[0], d: b.dims[1], h: b.dims[2] }
  }
  const stops = [...new Set(boxes.map((b) => b.deliverStop))].sort((a, b) => a - b)
  for (const s of stops) {
    const onboard = boxes.filter((b) => b.loadStop <= s && b.deliverStop >= s)
    for (const u of onboard) {
      if (u.deliverStop !== s) continue // only boxes coming off now
      const uci = compOf(u)
      if (uci < 0) return false
      const ul = local(u, uci)
      for (const o of onboard) {
        if (o.deliverStop <= s) continue // not later-delivered
        if (o.loadStop >= u.deliverStop) continue // loaded after this extraction (unload precedes load at a stop)
        if (compOf(o) !== uci) continue // independent compartment
        if (blocks(local(o, uci), ul, models[uci], axes[uci])) return false
      }
    }
  }
  return true
}
