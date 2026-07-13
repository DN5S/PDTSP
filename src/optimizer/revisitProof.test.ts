// Revisit-route optimality-proof viability study — NOT part of the regular
// suite (guarded by VITE_VERIFY). Run with:
//   PowerShell:  $env:VITE_VERIFY='1'; npx vitest run src/optimizer/revisitProof.test.ts
//
// Question (user): if a revisit is unavoidable, the best revisit route is the
// true optimum — can we PROVE it the same way enumerateSolve proves the
// single-visit optimum?
//
// Method: uniform-cost (ascending-distance) enumeration over stop SEQUENCES
// with repeats. Deliveries/loads are assignments of each leg to a (pickup
// visit, delivery visit) pair; every assignment is oracle-gated. For a given
// heuristic answer H:
//   - if some sequence with distance < H has a feasible assignment → the
//     heuristic was SUBOPTIMAL and we found + proved a better route;
//   - if the enumeration exhausts all sequences with distance < H → H is the
//     PROVEN optimum (within the enumerated envelope: max length, visit caps).
// The measurement is whether this finishes within practical node/time caps.

import { describe, it, expect } from 'vitest'
import { optimizeRoute, type PlannerLeg } from './pdp'
import { oracle, type OracleItem } from './loadFeasibility'
import { SHIP_GRIDS, gridCapacity, type Compartment } from '../ships/grids'
import { decomposeToBoxes } from '../domain/cargo'
import type { Ship, RoutePlan } from '../domain/types'
import type { DistanceResolver } from './distanceMatrix'

const mulberry32 = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const f1 = (x: number) => Math.round(x * 10) / 10
const mkShip = (name: string, scu: number): Ship => ({ id: 1, name, scu, containerSizes: [1, 2, 4, 8, 16, 32] })

// --- tiny binary min-heap on dist ---
interface SeqNode { seq: number[]; dist: number }
class MinHeap {
  private a: SeqNode[] = []
  get size() { return this.a.length }
  push(n: SeqNode) {
    const a = this.a
    a.push(n)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p].dist <= a[i].dist) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }
  pop(): SeqNode {
    const a = this.a
    const top = a[0]
    const last = a.pop()!
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && a[l].dist < a[m].dist) m = l
        if (r < a.length && a[r].dist < a[m].dist) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top
  }
}

interface LegIdx { pick: number; drop: number; scu: number; boxes: [number, number, number][]; id: string; missionId: string; commodity: string }

interface ProofResult {
  status: 'proven-optimal' | 'improved' | 'capped'
  improvedDist?: number
  popped: number
  completeSequences: number
  assignments: number
  oracleCalls: number
  ms: number
}

/** Enumerate stop sequences (repeats allowed) with total distance strictly
 *  below `heurD`, ascending; oracle-gate every load/deliver assignment. */
function proveBelow(
  legs: LegIdx[], N: number, D: number[][], comps: Compartment[], heurD: number,
  caps: { nodeCap: number; wallMs: number; maxLen: number; assignCap: number; oracleNodeBudget: number },
): ProofResult {
  const t0 = performance.now()
  const stats = { popped: 0, completeSequences: 0, assignments: 0, oracleCalls: 0 }
  const done = (status: ProofResult['status'], improvedDist?: number): ProofResult =>
    ({ status, improvedDist, ...stats, ms: performance.now() - t0 })

  const pickLocs = [...new Set(legs.map((l) => l.pick))]
  const requiredLocs = new Set<number>()
  for (const l of legs) { requiredLocs.add(l.pick); requiredLocs.add(l.drop) }
  // Admissible remaining-distance bound: the cheapest way to ever reach each
  // still-unvisited required location (max over them of min in-edge).
  const minInEdge = Array.from({ length: N }, (_, v) => {
    let m = Infinity
    for (let u = 0; u < N; u++) if (u !== v) m = Math.min(m, D[u][v])
    return m
  })
  const hBound = (seq: number[]): number => {
    const seen = new Set(seq)
    let h = 0
    for (const v of requiredLocs) if (!seen.has(v)) h = Math.max(h, minInEdge[v])
    return h
  }

  const isComplete = (seq: number[]): boolean =>
    legs.every((l) => {
      let picked = false
      for (const s of seq) {
        if (s === l.pick) picked = true
        else if (picked && s === l.drop) return true
      }
      return false
    })

  // A visit is (optimistically) useful if it could unload something already
  // pickable, or load some leg. Loose on purpose — pruning must stay sound.
  const useful = (seq: number[], v: number): boolean => {
    for (const l of legs) {
      if (l.pick === v) return true
      if (l.drop === v && seq.includes(l.pick)) return true
    }
    return false
  }

  const gateMemo = new Map<string, boolean>()
  const gateSequence = (seq: number[]): boolean => {
    // Per leg: all (pickup-visit i, delivery-visit j>i) pairs.
    const pairsPerLeg: [number, number][][] = legs.map((l) => {
      const pairs: [number, number][] = []
      for (let i = 0; i < seq.length; i++) {
        if (seq[i] !== l.pick) continue
        for (let j = i + 1; j < seq.length; j++) if (seq[j] === l.drop) pairs.push([i, j])
      }
      return pairs
    })
    if (pairsPerLeg.some((p) => p.length === 0)) return false
    const combos = pairsPerLeg.reduce((a, p) => a * p.length, 1)
    const idx = new Array<number>(legs.length).fill(0)
    const cap = gridCapacity(comps)
    for (let c = 0; c < Math.min(combos, caps.assignCap); c++) {
      const loadStop = idx.map((k, li) => pairsPerLeg[li][k][0])
      const deliverStop = idx.map((k, li) => pairsPerLeg[li][k][1])
      stats.assignments++
      // cheap capacity peak
      let feasibleCap = true
      for (let s = 0; s < seq.length && feasibleCap; s++) {
        let on = 0
        for (let li = 0; li < legs.length; li++) if (loadStop[li] <= s && deliverStop[li] > s) on += legs[li].scu
        if (on > cap) feasibleCap = false
      }
      if (feasibleCap) {
        const key = `${loadStop.join(',')}|${deliverStop.join(',')}`
        let ok = gateMemo.get(key)
        if (ok === undefined) {
          const items: OracleItem[] = legs.map((l, li) => ({
            legId: l.id, missionId: l.missionId, commodity: l.commodity, scu: l.scu,
            boxes: l.boxes, loadStop: loadStop[li], deliverStop: deliverStop[li],
          }))
          stats.oracleCalls++
          ok = oracle(items, comps, { nodeBudget: caps.oracleNodeBudget }).status === 'feasible'
          gateMemo.set(key, ok)
        }
        if (ok) return true
      }
      // advance mixed-radix index
      let li = 0
      while (li < legs.length) {
        if (++idx[li] < pairsPerLeg[li].length) break
        idx[li] = 0
        li++
      }
      if (li === legs.length) break
    }
    return false
  }

  const pq = new MinHeap()
  for (const s of pickLocs) pq.push({ seq: [s], dist: 0 })
  while (pq.size) {
    if (++stats.popped > caps.nodeCap || performance.now() - t0 > caps.wallMs) return done('capped')
    const node = pq.pop()
    if (node.dist + hBound(node.seq) >= heurD) continue // nothing strictly shorter reachable from here
    if (isComplete(node.seq)) {
      stats.completeSequences++
      if (gateSequence(node.seq)) return done('improved', node.dist)
    }
    if (node.seq.length >= caps.maxLen) continue
    const last = node.seq[node.seq.length - 1]
    for (let v = 0; v < N; v++) {
      if (v === last) continue
      if (!useful(node.seq, v)) continue
      const nd = node.dist + D[last][v]
      if (nd >= heurD) continue
      pq.push({ seq: [...node.seq, v], dist: nd })
    }
  }
  return done('proven-optimal')
}

// --- instance plumbing ---

function toLegIdx(legs: PlannerLeg[]): { legsIdx: LegIdx[]; N: number } {
  const locs = new Set<string>()
  for (const l of legs) { locs.add(l.pickupId); locs.add(l.dropoffId) }
  const N = Math.max(...[...locs].map((s) => Number(s.slice(1)))) + 1
  const legsIdx: LegIdx[] = legs.map((l) => ({
    pick: Number(l.pickupId.slice(1)),
    drop: Number(l.dropoffId.slice(1)),
    scu: l.scu,
    boxes: decomposeToBoxes(l.scu, l.maxBoxScu ?? 32).map((b) => b.dims),
    id: l.id, missionId: l.missionId, commodity: l.commodity,
  }))
  return { legsIdx, N }
}

const exactPlanDist = (plan: RoutePlan, resolver: DistanceResolver): number => {
  let d = 0
  for (let i = 1; i < plan.stops.length; i++) d += resolver.between(plan.stops[i - 1].locationId, plan.stops[i].locationId).gm
  return d
}

function planeResolver(pts: [number, number][]): DistanceResolver {
  return {
    between(a, b) {
      if (a === b) return { gm: 0, estimated: false, unreachable: false }
      const pa = pts[Number(a.slice(1))]
      const pb = pts[Number(b.slice(1))]
      return { gm: Math.round(Math.hypot(pa[0] - pb[0], pa[1] - pb[1])), estimated: false, unreachable: false }
    },
  }
}

const RUN = import.meta.env.VITE_VERIFY === '1'
const d = RUN ? describe : describe.skip

d('revisit-route optimality proof: viability study', () => {
  it('enumerates all routes shorter than the heuristic answer and gates them', { timeout: 600_000 }, () => {
    const railen = SHIP_GRIDS.find((g) => g.match === 'Railen')!.compartments
    const ship = mkShip('Gatac Railen', 640)
    const caps = { nodeCap: 2_000_000, wallMs: 60_000, maxLen: 12, assignCap: 64, oracleNodeBudget: 50_000 }
    const rows: string[] = []
    let provenOrImproved = 0
    let total = 0

    const study = (label: string, legs: PlannerLeg[], resolver: DistanceResolver) => {
      total++
      const plan = optimizeRoute(legs, ship, resolver, { compartments: railen, oracleNodeBudget: 10_000, timeBudgetMs: 6000 })
      if (!plan.feasible) {
        rows.push(`  ${label}: heuristic found no route — skipped`)
        return
      }
      const heurD = exactPlanDist(plan, resolver)
      const { legsIdx, N } = toLegIdx(legs)
      const D: number[][] = Array.from({ length: N }, (_, i) =>
        Array.from({ length: N }, (_, j) => resolver.between(`S${i}`, `S${j}`).gm),
      )
      const r = proveBelow(legsIdx, N, D, railen, heurD, caps)
      if (r.status !== 'capped') provenOrImproved++
      const verdict =
        r.status === 'proven-optimal'
          ? `PROVEN optimal at ${heurD} Gm`
          : r.status === 'improved'
            ? `IMPROVED: ${heurD} → ${r.improvedDist} Gm (heuristic was suboptimal)`
            : `capped (undecided)`
      rows.push(
        `  ${label}: heur ${heurD} Gm (revisits ${plan.revisits ?? 0}) → ${verdict}` +
          ` | popped ${r.popped}, complete seqs ${r.completeSequences}, assignments ${r.assignments},` +
          ` oracle ${r.oracleCalls}, ${f1(r.ms)}ms`,
      )
    }

    // 1) railenSample Phase-3 fixture (11 legs, forced Ruin revisit).
    {
      const loc = ['Ruin', 'Stanton Gateway', 'Starlight', 'Megumi', "Rat's Nest", 'Checkmate', "Rod's Fuel"]
      const idx = (name: string) => `S${loc.indexOf(name)}`
      const resolver: DistanceResolver = {
        between: (a, b) => (a === b ? { gm: 0, estimated: false, unreachable: false }
          : { gm: Math.abs(Number(a.slice(1)) - Number(b.slice(1))) * 15, estimated: false, unreachable: false }),
      }
      const L = (id: string, m: string, c: string, scu: number, from: string, to: string): PlannerLeg =>
        ({ id, missionId: m, commodity: c, scu, maxBoxScu: 8, pickupId: idx(from), dropoffId: idx(to) })
      const legs: PlannerLeg[] = [
        L('m1a', 'M1', 'Waste', 72, 'Ruin', 'Stanton Gateway'), L('m1b', 'M1', 'Waste', 67, 'Ruin', 'Starlight'),
        L('m2a', 'M2', 'Waste', 59, 'Ruin', 'Megumi'), L('m2b', 'M2', 'Waste', 41, 'Ruin', "Rat's Nest"), L('m2c', 'M2', 'Waste', 58, 'Ruin', 'Starlight'),
        L('m3a', 'M3', 'Potassium', 61, "Rod's Fuel", 'Ruin'),
        L('m4a', 'M4', 'Waste', 43, 'Ruin', 'Checkmate'), L('m4b', 'M4', 'Waste', 23, 'Ruin', "Rod's Fuel"), L('m4c', 'M4', 'Waste', 94, 'Ruin', 'Stanton Gateway'),
        L('m5a', 'M5', 'Waste', 88, 'Ruin', 'Stanton Gateway'), L('m5b', 'M5', 'Waste', 78, 'Ruin', 'Starlight'),
      ]
      study('Railen fixture (11 legs, 5 missions)', legs, resolver)
      // 2) The user's actual 4-mission run from the app (fixture minus M5).
      study('User run (9 legs, 4 missions)', legs.filter((l) => l.missionId !== 'M5'), resolver)
    }

    // 3) Random backhaul instances (hub + backward leg, ~70% fill).
    for (let k = 0; k < 6; k++) {
      const seed = 80_000 + k
      const rng = mulberry32(seed)
      const S = 5
      const pts: [number, number][] = Array.from({ length: S }, () => [rng() * 400, rng() * 400])
      const resolver = planeResolver(pts)
      const b = 2 + Math.floor(rng() * 3)
      const legs: PlannerLeg[] = []
      for (let v = 1; v < S; v++)
        legs.push({ id: `h${v}`, missionId: `m${v}`, commodity: 'Waste', scu: 80 + Math.floor(rng() * 31), maxBoxScu: 8, pickupId: 'S0', dropoffId: `S${v}` })
      legs.push({ id: 'back', missionId: 'mB', commodity: 'Ore', scu: 40 + Math.floor(rng() * 21), maxBoxScu: 8, pickupId: `S${b}`, dropoffId: 'S0' })
      study(`random backhaul seed=${seed}`, legs, resolver)
    }

    console.log('\n=== revisit optimality proof viability (Railen, caps: 2M pops / 60s / len 12) ===')
    for (const r of rows) console.log(r)
    console.log(`  decided (proven or improved): ${provenOrImproved}/${total}\n`)
    expect(total).toBeGreaterThan(0)
  })
})
