// Single-ship pickup-and-delivery optimizer.
//
// Gridless routes use a distinct-location PDTSP model: each stop is visited once,
// unloads happen before loads, and Held-Karp is exact while the stop count is
// small enough. Gridded routes cannot use that dominance relation because load
// order affects physical feasibility, so candidate routes are gated by the
// hard-LIFO oracle and may be compared against revisit-capable plans.

import type { Leg, Mission, Ship, RoutePlan, RouteStop, StopAction } from '../domain/types'
import type { DistanceResolver } from './distanceMatrix'
import { gridCapacity, type Compartment } from '../ships/grids'
import { decomposeToBoxes, shipMaxBoxScu } from '../domain/cargo'
import { oracle, clusteredWitness, zonedWitness, itemsFromPlan, type OracleItem, type OracleVerdict, type OraclePlacedBox } from './loadFeasibility'
import { computeOpOrder } from './stepOrder'
import { handlingCost, normalizeHandlingWeightMilli, planHandling } from './handlingCost'
import { optimizeRevisitRoute } from './pdpRevisit'
import { bestWitnessForItems } from './witnessOptimizer'

export type PlannerLeg = Leg & { missionId: string; splitParentId?: string }

export interface OptimizeOptions {
  /** Use heuristic search above this distinct-stop count. Pass Infinity to force exact. */
  exactLimit?: number
  /** Ship cargo grid. Presence switches from set-capacity routing to oracle-gated routing. */
  compartments?: Compartment[]
  /** Per-candidate oracle node budget. Node budgets keep verdicts deterministic. */
  oracleNodeBudget?: number
  /** Deterministic route-level candidate budget for heuristic seed/improvement work. */
  routeNodeBudget?: number
  /** Compatibility-only; route search is gated by routeNodeBudget, not wall clock. */
  timeBudgetMs?: number
  /** Handling weights in milli-Gm. Both zero preserves pure-distance routing. */
  alphaMilli?: number
  deltaMilli?: number
}

export function flattenMissions(missions: Mission[]): PlannerLeg[] {
  return missions.flatMap((m) => m.legs.map((l) => ({ ...l, missionId: m.id })))
}

export function optimizeRoute(
  legs: PlannerLeg[],
  ship: Ship,
  resolver: DistanceResolver,
  opts: OptimizeOptions = {},
): RoutePlan {
  const exactLimit = opts.exactLimit ?? 18
  const routeNodeBudget = opts.routeNodeBudget ?? 200_000
  // Grid geometry is authoritative when present; UEX SCU can be stale.
  const cap = opts.compartments && opts.compartments.length ? gridCapacity(opts.compartments) : ship.scu

  if (legs.length === 0) {
    return { stops: [], totalDistance: 0, feasible: true, estimatedLegs: 0, method: 'exact', algorithm: 'pdtsp' }
  }

  const sameStop = legs.find((l) => l.pickupId === l.dropoffId)
  if (sameStop) {
    return {
      stops: [],
      totalDistance: 0,
      feasible: false,
      reason: `Leg "${sameStop.commodity}" has the same pickup and dropoff location.`,
      estimatedLegs: 0,
      method: 'exact',
      algorithm: 'pdtsp',
    }
  }

  // Split delivery is an input transform for empty-grid-infeasible gridded legs;
  // the planner still receives atomic sub-legs.
  if (opts.compartments && opts.compartments.length) {
    const processed: PlannerLeg[] = []
    const packsEmpty = (l: PlannerLeg, scu: number): boolean => {
      if (!opts.compartments || !opts.compartments.length) return true // capacity-only ships
      const v = oracle(
        [{
          legId: l.id, missionId: l.missionId, commodity: l.commodity, scu,
          boxes: decomposeToBoxes(scu, l.maxBoxScu ?? 32).map((b) => b.dims),
          loadStop: 0, deliverStop: 1,
        }],
        opts.compartments,
        { nodeBudget: 200_000 },
      )
      return v.status === 'feasible'
    }
    for (const l of legs) {
      if (!l.allowSplit || packsEmpty(l, l.scu)) {
        processed.push(l)
        continue
      }
      const chunkScus: number[] = []
      let remaining = l.scu
      while (remaining > 0) {
        const boxes = decomposeToBoxes(remaining, l.maxBoxScu ?? 32)
        // Fill largest-first up to capacity, then shrink until it packs.
        let count = 0
        let take = 0
        for (const b of boxes) {
          if (take + b.scu > cap) break
          take += b.scu
          count++
        }
        while (count > 0 && !packsEmpty(l, take)) {
          count--
          take -= boxes[count].scu
        }
        if (count === 0) {
          return {
            stops: [],
            totalDistance: 0,
            feasible: false,
            reason: `Leg "${l.commodity}" (${l.scu} SCU): even split delivery cannot fit a ${boxes[0].scu}-SCU container into ${ship.name} — lower the leg's max container size or use another ship.`,
            estimatedLegs: 0,
            method: 'exact',
            algorithm: 'pdtsp',
          }
        }
        chunkScus.push(take)
        remaining -= take
      }
      const splitParentId = `${l.missionId}:${l.id}`
      chunkScus.forEach((scu, k) => processed.push({ ...l, id: `${l.id}#${k + 1}`, scu, splitParentId }))
    }
    legs = processed
  }

  // Atomic oversized legs need split delivery, which requires a gridded ship.
  const tooBig = legs.find((l) => l.scu > cap)
  if (tooBig) {
    const splitHint = opts.compartments && opts.compartments.length
      ? ' Allow split delivery on this leg to haul it over multiple trips.'
      : ` Draw a cargo grid for ${ship.name} to unlock split delivery across multiple trips.`
    return {
      stops: [],
      totalDistance: 0,
      feasible: false,
      reason: `Leg "${tooBig.commodity}" (${tooBig.scu} SCU) exceeds ${ship.name} capacity (${cap} SCU).${splitHint}`,
      estimatedLegs: 0,
      method: 'exact',
      algorithm: 'pdtsp',
    }
  }

  // Container size limits are real cargo constraints; do not silently re-box.
  const shipBoxCap = shipMaxBoxScu(ship.containerSizes)
  const oversize = legs.find((l) => decomposeToBoxes(l.scu, l.maxBoxScu ?? 32).some((b) => b.scu > shipBoxCap))
  if (oversize) {
    return {
      stops: [],
      totalDistance: 0,
      feasible: false,
      reason: `Leg "${oversize.commodity}": mission containers exceed what ${ship.name} accepts (max ${shipBoxCap} SCU) — lower the leg's max container size or use another ship.`,
      estimatedLegs: 0,
      method: 'exact',
      algorithm: 'pdtsp',
    }
  }

  const stops: string[] = []
  const stopIndex = new Map<string, number>()
  const addStop = (id: string) => {
    if (!stopIndex.has(id)) {
      stopIndex.set(id, stops.length)
      stops.push(id)
    }
  }
  for (const l of legs) {
    addStop(l.pickupId)
    addStop(l.dropoffId)
  }
  const N = stops.length

  // BigInt masks avoid JS's 32-bit bitwise limit on larger routes.
  const pickIndex = legs.map((l) => stopIndex.get(l.pickupId)!)
  const dropIndex = legs.map((l) => stopIndex.get(l.dropoffId)!)
  const splitParent = legs.map((l) => l.splitParentId)
  const stopBits = Array.from({ length: N }, (_, i) => 1n << BigInt(i))
  const pickMask = pickIndex.map((i) => stopBits[i])
  const dropMask = dropIndex.map((i) => stopBits[i])

  const deliveredAt: number[][] = Array.from({ length: N }, () => [])
  legs.forEach((_, li) => deliveredAt[dropIndex[li]].push(li))

  const Dgm = new Float64Array(N * N)
  const Dest = new Uint8Array(N * N)
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i === j) continue
      const d = resolver.between(stops[i], stops[j])
      Dgm[i * N + j] = d.gm
      Dest[i * N + j] = d.estimated ? 1 : 0
    }
  }

  const loadCache = new Map<bigint, number>()
  const loadOfSet = (S: bigint): number => {
    const cached = loadCache.get(S)
    if (cached !== undefined) return cached
    let load = 0
    for (let li = 0; li < legs.length; li++) {
      if ((S & pickMask[li]) !== 0n && (S & dropMask[li]) === 0n) load += legs[li].scu
    }
    loadCache.set(S, load)
    return load
  }
  const addable = (S: bigint, k: number): boolean => {
    for (const li of deliveredAt[k]) {
      if ((S & pickMask[li]) === 0n) return false
    }
    return true
  }
  const splitParentsOk = (S: bigint): boolean => {
    const onboard = new Set<string>()
    for (let li = 0; li < legs.length; li++) {
      const parent = splitParent[li]
      if (!parent || (S & pickMask[li]) === 0n || (S & dropMask[li]) !== 0n) continue
      if (onboard.has(parent)) return false
      onboard.add(parent)
    }
    return true
  }

  // Oracle verdicts are memoized by stop order; 'unknown' remains distinct from
  // proven infeasible.
  const useOracle = !!(opts.compartments && opts.compartments.length)
  const oracleNodeBudget = opts.oracleNodeBudget ?? 50_000
  const alphaMilli = normalizeHandlingWeightMilli(opts.alphaMilli)
  const deltaMilli = normalizeHandlingWeightMilli(opts.deltaMilli)
  const priced = useOracle && (alphaMilli !== 0 || deltaMilli !== 0)
  const boxesByLeg = useOracle
    ? legs.map((l) => decomposeToBoxes(l.scu, l.maxBoxScu ?? 32).map((b) => b.dims))
    : []
  const oracleMemo = new Map<string, OracleVerdict>()
  const oracleVerdictFor = (seq: number[]): OracleVerdict => {
    const key = seq.join(',')
    const cached = oracleMemo.get(key)
    if (cached) return cached
    const pos = new Array<number>(N)
    seq.forEach((s, i) => (pos[s] = i))
    const oitems: OracleItem[] = legs.map((l, li) => ({
      legId: l.id,
      missionId: l.missionId,
      commodity: l.commodity,
      scu: l.scu,
      boxes: boxesByLeg[li],
      loadStop: pos[pickIndex[li]],
      deliverStop: pos[dropIndex[li]],
    }))
    const v = oracle(oitems, opts.compartments!, { nodeBudget: oracleNodeBudget })
    oracleMemo.set(key, v)
    return v
  }
  const oracleOrderOk = (seq: number[]) => oracleVerdictFor(seq).status === 'feasible'

  // Handling is priced only when a physical witness exists.
  const hMilliOf = (boxes: OraclePlacedBox[]): number => {
    const h = handlingCost(boxes, opts.compartments!)
    return alphaMilli * h.totalL + deltaMilli * h.totalG
  }
  const handlingMemo = new Map<string, number>()
  const hMilliFor = (seq: number[]): number => {
    if (!priced) return 0
    const key = seq.join(',')
    const cached = handlingMemo.get(key)
    if (cached !== undefined) return cached
    const v = oracleVerdictFor(seq)
    const h = v.status === 'feasible' ? hMilliOf(v.boxes) : Infinity
    handlingMemo.set(key, h)
    return h
  }
  const scoreOf = (seq: number[], dist: number): number =>
    priced ? dist + hMilliFor(seq) / 1000 : dist

  const method: 'exact' | 'heuristic' = !useOracle && N <= exactLimit ? 'exact' : 'heuristic'

  if (!useOracle) {
    const order = method === 'exact' ? exactSolve() : heuristicSolve()
    if (!order) {
      // Heuristic failure is not proof; exact failure is.
      const reason = method === 'exact'
        ? `Cargo can't be sequenced within ${ship.name} (${cap} SCU) in one trip. Draw a cargo grid for ${ship.name} to unlock multi-trip planning with revisits, or reduce missions / use a larger ship.`
        : `No valid stop order found for ${ship.name} (${cap} SCU) at this route size — the search gave up, but a route may still exist. Draw a cargo grid for ${ship.name} to unlock multi-trip planning with revisits, or try fewer missions per trip.`
      return {
        stops: [],
        totalDistance: 0,
        feasible: false,
        reason,
        estimatedLegs: 0,
        method,
        algorithm: 'pdtsp',
      }
    }
    return buildPlan(order, method)
  }

  // Compare the best single-visit and revisit-capable dig-free candidates on
  // the same objective.
  const candidates: RoutePlan[] = []
  const svOrder = heuristicSolve()
  if (svOrder) {
    const sv = buildPlan(svOrder, 'heuristic')
    const v = oracleVerdictFor(svOrder)
    if (v.status === 'feasible') { sv.loadout = v.boxes; candidates.push(sv) }
  }
  const rv = optimizeRevisitRoute(legs, ship, resolver, opts.compartments!, { oracleNodeBudget, routeNodeBudget, alphaMilli, deltaMilli })
  if (rv.feasible) candidates.push(rv)

  if (candidates.length === 0) {
    return {
      stops: [],
      totalDistance: 0,
      feasible: false,
      reason: `No dig-free loading order found for ${ship.name} (${cap} SCU) - reduce missions or use a larger/wider hold.`,
      estimatedLegs: 0,
      method: 'heuristic',
      algorithm: 'pdtsp',
    }
  }
  const improvePricedWitness = (p: RoutePlan) => {
    if (!priced || !p.loadout) return
    const best = bestWitnessForItems(itemsFromPlan(legs, p), opts.compartments!, {
      seed: p.loadout,
      alphaMilli,
      deltaMilli,
      nodeBudget: 8000,
    })
    if (best) p.loadout = best
  }
  candidates.forEach(improvePricedWitness)
  const planF = (p: RoutePlan): number =>
    priced && p.loadout ? p.totalDistance + hMilliOf(p.loadout) / 1000 : p.totalDistance
  const winner = candidates.reduce((a, b) => (planF(b) < planF(a) ? b : a))
  // Witness-quality repacks run only after a route is chosen. With pricing on,
  // keep the cheapest available witness so post-processing cannot worsen F.
  if (winner.loadout) {
    if (priced) {
      // Already optimized before the single-visit/revisit race so planF and the
      // final witness refer to the same placement.
    } else {
      const witnessItems = itemsFromPlan(legs, winner)
      const zoned = zonedWitness(witnessItems, opts.compartments!, { nodeBudget: 8000 })
      if (zoned) {
        winner.loadout = zoned
      } else {
        const clustered = clusteredWitness(witnessItems, opts.compartments!, { nodeBudget: 4000 })
        if (clustered) winner.loadout = clustered
      }
    }
    // Checklist and handling must match the final witness, not the gate witness.
    winner.opOrder = computeOpOrder(winner.loadout, opts.compartments!)
    winner.handling = planHandling(winner.loadout, opts.compartments!, winner.stops.length)
  }
  return winner

  // Exact sparse Held-Karp over distinct stops.
  function exactSolve(): number[] | null {
    const full = stopBits.reduce((mask, bit) => mask | bit, 0n)
    const parent = new Map<string, number>()
    let frontier = new Map<bigint, Map<number, number>>()

    const stateKey = (mask: bigint, last: number) => `${mask.toString()}:${last}`
    const setCost = (
      layer: Map<bigint, Map<number, number>>,
      mask: bigint,
      last: number,
      cost: number,
      prev: number,
    ) => {
      let byLast = layer.get(mask)
      if (!byLast) {
        byLast = new Map<number, number>()
        layer.set(mask, byLast)
      }
      const old = byLast.get(last)
      if (old === undefined || cost < old) {
        byLast.set(last, cost)
        parent.set(stateKey(mask, last), prev)
      }
    }

    for (let j = 0; j < N; j++) {
      const mask = stopBits[j]
      if (!addable(0n, j)) continue
      if (loadOfSet(mask) > cap) continue
      if (!splitParentsOk(mask)) continue
      setCost(frontier, mask, j, 0, -1)
    }

    for (let step = 1; step < N; step++) {
      const next = new Map<bigint, Map<number, number>>()
      for (const [mask, byLast] of frontier) {
        for (const [last, cost] of byLast) {
          if (cost === Infinity) continue
          for (let k = 0; k < N; k++) {
            const bit = stopBits[k]
            if ((mask & bit) !== 0n) continue
            if (!addable(mask, k)) continue
            const nextMask = mask | bit
            if (loadOfSet(nextMask) > cap) continue
            if (!splitParentsOk(nextMask)) continue
            setCost(next, nextMask, k, cost + Dgm[last * N + k], last)
          }
        }
      }
      if (next.size === 0) return null
      frontier = next
    }

    const finals = frontier.get(full)
    if (!finals) return null

    let best = Infinity
    let bestLast = -1
    for (const [last, cost] of finals) {
      if (cost < best) {
        best = cost
        bestLast = last
      }
    }
    if (bestLast === -1) return null

    const out: number[] = []
    let mask = full
    let cur = bestLast
    while (cur !== -1) {
      out.push(cur)
      const prev = parent.get(stateKey(mask, cur)) ?? -1
      mask &= ~stopBits[cur]
      cur = prev
    }
    return out.reverse()
  }

  // Heuristic route search uses cheap precedence/capacity first, then the oracle
  // only for candidates that can improve the objective.
  function precCapOk(seq: number[]): boolean {
    if (seq.length !== N) return false
    const pos = new Array<number>(N).fill(-1)
    seq.forEach((s, i) => (pos[s] = i))
    for (let li = 0; li < legs.length; li++) {
      if (pos[pickIndex[li]] >= pos[dropIndex[li]]) return false
    }
    let S = 0n
    for (const s of seq) {
      S |= stopBits[s]
      if (loadOfSet(S) > cap) return false
      if (!splitParentsOk(S)) return false
    }
    return true
  }
  function seqDistance(seq: number[]): number {
    let total = 0
    for (let i = 1; i < seq.length; i++) total += Dgm[seq[i - 1] * N + seq[i]]
    return total
  }
  function nearestNeighbourFrom(start: number): number[] | null {
    const startMask = stopBits[start]
    if (!addable(0n, start) || loadOfSet(startMask) > cap) return null
    if (!splitParentsOk(startMask)) return null
    const seq = [start]
    let S = startMask
    while (seq.length < N) {
      let best = -1
      let bestD = Infinity
      const last = seq[seq.length - 1]
      for (let k = 0; k < N; k++) {
        const bit = stopBits[k]
        if ((S & bit) !== 0n) continue
        if (!addable(S, k)) continue
        if (loadOfSet(S | bit) > cap) continue
        if (!splitParentsOk(S | bit)) continue
        const d = Dgm[last * N + k]
        if (d < bestD) {
          bestD = d
          best = k
        }
      }
      if (best === -1) return null
      seq.push(best)
      S |= stopBits[best]
    }
    return seq
  }
  function heuristicSolve(): number[] | null {
    let routeNodes = 0
    let best: number[] | null = null
    let bestF = Infinity
    for (let s = 0; s < N; s++) {
      if (best && routeNodes >= routeNodeBudget) break
      const seq = nearestNeighbourFrom(s)
      if (!seq || !precCapOk(seq)) continue
      routeNodes++
      // Distance lower-bounds F, so it can prune before oracle work.
      const d = seqDistance(seq)
      if (d < bestF && (!useOracle || oracleOrderOk(seq))) {
        const F = scoreOf(seq, d)
        if (F < bestF) {
          bestF = F
          best = seq
        }
      }
    }
    if (!best) return null
    // Relocation and 2-opt cover different route-shape fixes; precCapOk rejects
    // any move that breaks pickup-before-delivery or capacity.
    let route: number[] = best
    // All neighbours pass the same gate chain: cheap checks, distance prescreen,
    // oracle when needed, then full objective.
    const tryNeighbour = (cand: number[]): boolean => {
      if (routeNodes >= routeNodeBudget) return false
      routeNodes++
      if (!precCapOk(cand)) return false
      const d = seqDistance(cand)
      if (d >= bestF - 1e-9) return false
      if (useOracle && !oracleOrderOk(cand)) return false
      const F = scoreOf(cand, d)
      if (F >= bestF - 1e-9) return false
      route = cand
      bestF = F
      return true
    }
    let improved = true
    let guard = 0
    while (improved && guard++ < 1000 && routeNodes < routeNodeBudget) {
      improved = false
      for (let from = 0; from < N && routeNodes < routeNodeBudget; from++) {
        for (let to = 0; to < N; to++) {
          if (to === from) continue
          const cand = route.slice()
          const [moved] = cand.splice(from, 1)
          cand.splice(to, 0, moved)
          if (tryNeighbour(cand)) improved = true
        }
      }
      for (let i = 0; i < N - 1 && routeNodes < routeNodeBudget; i++) {
        for (let j = i + 1; j < N; j++) {
          const cand = route.slice()
          for (let lo = i, hi = j; lo < hi; lo++, hi--) {
            const t = cand[lo]
            cand[lo] = cand[hi]
            cand[hi] = t
          }
          if (tryNeighbour(cand)) improved = true
        }
      }
    }
    return route
  }

  // Materialize the ordered stops into a RoutePlan.
  function buildPlan(seq: number[], method: 'exact' | 'heuristic'): RoutePlan {
    const routeStops: RouteStop[] = []
    let load = 0
    let totalDistance = 0
    let estimatedLegs = 0

    seq.forEach((stop, i) => {
      const actions: StopAction[] = []
      legs.forEach((l, li) => {
        if (dropIndex[li] === stop) {
          actions.push({ kind: 'unload', legId: l.id, missionId: l.missionId, commodity: l.commodity, scu: l.scu })
          load -= l.scu
        }
      })
      legs.forEach((l, li) => {
        if (pickIndex[li] === stop) {
          actions.push({ kind: 'load', legId: l.id, missionId: l.missionId, commodity: l.commodity, scu: l.scu })
          load += l.scu
        }
      })
      let legDistance = 0
      let estimated = false
      if (i > 0) {
        const prev = seq[i - 1]
        legDistance = Dgm[prev * N + stop]
        estimated = Dest[prev * N + stop] === 1
        totalDistance += legDistance
        if (estimated) estimatedLegs++
      }
      routeStops.push({ locationId: stops[stop], actions, loadAfter: load, legDistance, estimated })
    })

    return {
      stops: routeStops,
      totalDistance: Math.round(totalDistance),
      feasible: true,
      estimatedLegs,
      method,
      algorithm: 'pdtsp',
    }
  }
}
