// Revisit-capable search over pickup/delivery events. Candidates must pass cheap
// precedence/capacity checks and then the hard-LIFO oracle. The objective is
// travel distance plus optional handling cost; revisits carry no separate penalty.

import type { Ship, RoutePlan, RouteStop, StopAction } from '../domain/types'
import type { PlannerLeg } from './pdp'
import type { DistanceResolver } from './distanceMatrix'
import { gridCapacity, type Compartment } from '../ships/grids'
import { decomposeToBoxes } from '../domain/cargo'
import { oracle, type OracleItem, type OracleVerdict, type OraclePlacedBox } from './loadFeasibility'
import { computeOpOrder } from './stepOrder'
import { handlingCost, normalizeHandlingWeightMilli, planHandling } from './handlingCost'
import { bestWitnessForItems } from './witnessOptimizer'

interface Ev {
  leg: number
  /** 0 = pickup, 1 = delivery. */
  kind: 0 | 1
  loc: string
}

export interface RevisitOptions {
  /** Per-candidate oracle node budget. */
  oracleNodeBudget?: number
  /** Deterministic route-level candidate budget for heuristic seed/improvement work. */
  routeNodeBudget?: number
  /** Compatibility-only; route search is gated by routeNodeBudget, not wall clock. */
  timeBudgetMs?: number
  /** Handling weights in fixed-point milli-Gm. */
  alphaMilli?: number
  deltaMilli?: number
}

export function optimizeRevisitRoute(
  legs: PlannerLeg[],
  ship: Ship,
  resolver: DistanceResolver,
  compartments: Compartment[],
  opts: RevisitOptions = {},
): RoutePlan {
  const cap = gridCapacity(compartments)
  const base = { estimatedLegs: 0, method: 'heuristic' as const, algorithm: 'pdtsp-l' as const, revisits: 0 }
  const infeasible = (reason: string): RoutePlan => ({ stops: [], totalDistance: 0, feasible: false, reason, ...base })

  if (legs.length === 0) return { stops: [], totalDistance: 0, feasible: true, ...base }
  const sameStop = legs.find((l) => l.pickupId === l.dropoffId)
  if (sameStop) return infeasible(`Leg "${sameStop.commodity}" has the same pickup and dropoff location.`)
  const tooBig = legs.find((l) => l.scu > cap)
  if (tooBig) return infeasible(`Leg "${tooBig.commodity}" (${tooBig.scu} SCU) exceeds ${ship.name} capacity (${cap} SCU).`)

  const oracleNodeBudget = opts.oracleNodeBudget ?? 50_000
  const routeNodeBudget = opts.routeNodeBudget ?? 200_000
  const alphaMilli = normalizeHandlingWeightMilli(opts.alphaMilli)
  const deltaMilli = normalizeHandlingWeightMilli(opts.deltaMilli)
  const priced = alphaMilli !== 0 || deltaMilli !== 0
  let routeNodes = 0
  const L = legs.length
  const legScu = legs.map((l) => l.scu)
  const splitParent = legs.map((l) => l.splitParentId)
  const boxesByLeg = legs.map((l) => decomposeToBoxes(l.scu, l.maxBoxScu ?? 32).map((b) => b.dims))

  const events: Ev[] = []
  for (let i = 0; i < L; i++) {
    events.push({ leg: i, kind: 0, loc: legs[i].pickupId })
    events.push({ leg: i, kind: 1, loc: legs[i].dropoffId })
  }

  const distCache = new Map<string, { gm: number; est: boolean }>()
  const distLoc = (a: string | null, b: string): { gm: number; est: boolean } => {
    if (a === null || a === b) return { gm: 0, est: false }
    const key = `${a}|${b}`
    const cached = distCache.get(key)
    if (cached) return cached
    const d = resolver.between(a, b)
    const val = { gm: d.gm, est: d.estimated }
    distCache.set(key, val)
    return val
  }

  // Consecutive same-location events share one physical stop.
  const stopIndices = (seq: Ev[]): { loadStop: number[]; deliverStop: number[] } => {
    const loadStop = new Array<number>(L)
    const deliverStop = new Array<number>(L)
    let stop = -1
    let prev: string | null = null
    for (const e of seq) {
      if (e.loc !== prev) { stop++; prev = e.loc }
      if (e.kind === 0) loadStop[e.leg] = stop
      else deliverStop[e.leg] = stop
    }
    return { loadStop, deliverStop }
  }

  const oracleMemo = new Map<string, OracleVerdict>()
  const oracleVerdict = (seq: Ev[]): OracleVerdict => {
    const { loadStop, deliverStop } = stopIndices(seq)
    const key = `${loadStop.join(',')}|${deliverStop.join(',')}`
    const cached = oracleMemo.get(key)
    if (cached) return cached
    const items: OracleItem[] = legs.map((l, i) => ({
      legId: l.id, missionId: l.missionId, commodity: l.commodity, scu: l.scu,
      boxes: boxesByLeg[i], loadStop: loadStop[i], deliverStop: deliverStop[i],
    }))
    const v = oracle(items, compartments, { nodeBudget: oracleNodeBudget })
    oracleMemo.set(key, v)
    return v
  }
  const oracleOk = (seq: Ev[]) => oracleVerdict(seq).status === 'feasible'

  // Handling is priced from the candidate's oracle witness.
  const hMilliOf = (boxes: OraclePlacedBox[]): number => {
    const h = handlingCost(boxes, compartments)
    return alphaMilli * h.totalL + deltaMilli * h.totalG
  }
  const handlingMemo = new Map<string, number>()
  const hMilliFor = (seq: Ev[]): number => {
    if (!priced) return 0
    const { loadStop, deliverStop } = stopIndices(seq)
    const key = `${loadStop.join(',')}|${deliverStop.join(',')}`
    const cached = handlingMemo.get(key)
    if (cached !== undefined) return cached
    const v = oracleVerdict(seq)
    const h = v.status === 'feasible' ? hMilliOf(v.boxes) : Infinity
    handlingMemo.set(key, h)
    return h
  }
  const scoreOf = (seq: Ev[], dist: number): number => (priced ? dist + hMilliFor(seq) / 1000 : dist)

  const precCapOk = (seq: Ev[]): boolean => {
    if (seq.length !== events.length) return false
    const picked = new Array<boolean>(L).fill(false)
    const dropped = new Array<boolean>(L).fill(false)
    const onboardSplitParents = new Set<string>()
    let load = 0
    for (const e of seq) {
      const parent = splitParent[e.leg]
      if (e.kind === 0) {
        if (picked[e.leg]) return false
        if (parent && onboardSplitParents.has(parent)) return false
        picked[e.leg] = true
        if (parent) onboardSplitParents.add(parent)
        load += legScu[e.leg]
        if (load > cap) return false
      } else {
        if (!picked[e.leg] || dropped[e.leg]) return false
        dropped[e.leg] = true
        if (parent) onboardSplitParents.delete(parent)
        load -= legScu[e.leg]
      }
    }
    return true
  }

  const seqDistance = (seq: Ev[]): number => {
    let total = 0
    let prev: string | null = null
    for (const e of seq) {
      if (e.loc !== prev) { total += distLoc(prev, e.loc).gm; prev = e.loc }
    }
    return total
  }

  // Distance-only greedy seed from a chosen first pickup.
  const greedyFrom = (firstLeg: number): Ev[] | null => {
    const seq: Ev[] = []
    const picked = new Array<boolean>(L).fill(false)
    const dropped = new Array<boolean>(L).fill(false)
    const onboardSplitParents = new Set<string>()
    let load = 0
    let cur: string | null = null
    const apply = (e: Ev) => {
      seq.push(e); cur = e.loc
      const parent = splitParent[e.leg]
      if (e.kind === 0) {
        picked[e.leg] = true
        if (parent) onboardSplitParents.add(parent)
        load += legScu[e.leg]
      } else {
        dropped[e.leg] = true
        if (parent) onboardSplitParents.delete(parent)
        load -= legScu[e.leg]
      }
    }
    apply({ leg: firstLeg, kind: 0, loc: legs[firstLeg].pickupId })
    while (seq.length < events.length) {
      let best: Ev | null = null
      let bestCost = Infinity
      for (let i = 0; i < L; i++) {
        const parent = splitParent[i]
        if (!picked[i] && load + legScu[i] <= cap && !(parent && onboardSplitParents.has(parent))) {
          const c = distLoc(cur, legs[i].pickupId).gm
          if (c < bestCost) { bestCost = c; best = { leg: i, kind: 0, loc: legs[i].pickupId } }
        }
        if (picked[i] && !dropped[i]) {
          const c = distLoc(cur, legs[i].dropoffId).gm
          if (c < bestCost) { bestCost = c; best = { leg: i, kind: 1, loc: legs[i].dropoffId } }
        }
      }
      if (!best) return null
      apply(best)
    }
    return seq
  }

  // Local search consults the oracle only after cheap checks and distance pruning.
  const localSearch = (init: Ev[]): Ev[] => {
    let route = init
    let bestF = scoreOf(route, seqDistance(route))
    let improved = true
    while (improved && routeNodes < routeNodeBudget) {
      improved = false
      for (let from = 0; from < route.length && routeNodes < routeNodeBudget; from++) {
        for (let to = 0; to < route.length; to++) {
          if (to === from) continue
          if (routeNodes >= routeNodeBudget) return route
          routeNodes++
          const cand = route.slice()
          const [moved] = cand.splice(from, 1)
          cand.splice(to, 0, moved)
          if (!precCapOk(cand)) continue
          const d = seqDistance(cand)
          if (d < bestF - 1e-9 && oracleOk(cand)) {
            const F = scoreOf(cand, d)
            if (F < bestF - 1e-9) {
              route = cand; bestF = F; improved = true
            }
          }
        }
      }
    }
    return route
  }

  // Keep trying starts until at least one oracle-feasible seed exists.
  let best: Ev[] | null = null
  let bestF = Infinity
  for (let i = 0; i < L; i++) {
    if (best && routeNodes >= routeNodeBudget) break
    const g = greedyFrom(i)
    if (!g || !precCapOk(g)) continue
    routeNodes++
    const d = seqDistance(g)
    if (d < bestF && oracleOk(g)) {
      const F = scoreOf(g, d)
      if (F < bestF) { bestF = F; best = g }
    }
  }
  if (!best) return infeasible(`No dig-free route found for ${ship.name} (${cap} SCU) even with revisits.`)
  best = localSearch(best)

  return buildPlan(best)

  function buildPlan(seq: Ev[]): RoutePlan {
    const groups: { loc: string; evs: Ev[] }[] = []
    for (const e of seq) {
      const last = groups[groups.length - 1]
      if (last && last.loc === e.loc) last.evs.push(e)
      else groups.push({ loc: e.loc, evs: [e] })
    }
    const visits: RouteStop[] = []
    const seen = new Set<string>()
    let prev: string | null = null
    let load = 0
    let totalDistance = 0
    let estimatedLegs = 0
    for (const g of groups) {
      const d = distLoc(prev, g.loc)
      totalDistance += d.gm
      const estimated = prev !== null && d.est
      if (estimated) estimatedLegs++
      // Same-stop unloads happen before loads, matching the oracle timeline.
      const ordered = [...g.evs.filter((e) => e.kind === 1), ...g.evs.filter((e) => e.kind === 0)]
      const actions: StopAction[] = ordered.map((e) => {
        const leg = legs[e.leg]
        load += e.kind === 0 ? leg.scu : -leg.scu
        return { kind: e.kind === 0 ? 'load' : 'unload', legId: leg.id, missionId: leg.missionId, commodity: leg.commodity, scu: leg.scu }
      })
      visits.push({ locationId: g.loc, actions, loadAfter: load, legDistance: d.gm, estimated })
      seen.add(g.loc)
      prev = g.loc
    }
    const plan: RoutePlan = {
      stops: visits,
      totalDistance: Math.round(totalDistance),
      feasible: true,
      estimatedLegs,
      method: 'heuristic',
      algorithm: 'pdtsp-l',
      revisits: groups.length - seen.size,
    }
    const v = oracleVerdict(seq)
    if (v.status === 'feasible') {
      const { loadStop, deliverStop } = stopIndices(seq)
      const items: OracleItem[] = legs.map((l, i) => ({
        legId: l.id, missionId: l.missionId, commodity: l.commodity, scu: l.scu,
        boxes: boxesByLeg[i], loadStop: loadStop[i], deliverStop: deliverStop[i],
      }))
      plan.loadout = priced
        ? bestWitnessForItems(items, compartments, {
            seed: v.boxes,
            alphaMilli,
            deltaMilli,
            nodeBudget: 8000,
          }) ?? v.boxes
        : v.boxes
      // optimizeRoute may later replace this witness and recompute these fields.
      plan.opOrder = computeOpOrder(plan.loadout, compartments)
      plan.handling = planHandling(plan.loadout, compartments, plan.stops.length)
    }
    return plan
  }
}
