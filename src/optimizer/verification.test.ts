// Logic-verification harness — NOT part of the regular suite (guarded by
// VITE_VERIFY). Run with:
//   PowerShell:  $env:VITE_VERIFY='1'; npx vitest run src/optimizer/verification.test.ts
//
// Purpose: measure, with seeded random instances, (A) how far the heuristic
// lands from the exact optimum on gridless routes, (B) how the oracle-gated
// grid search compares against a brute-force optimal reference on small
// instances, (C) where wall-clock actually goes on grid ships (oracle share),
// and (D) that every feasible oracle witness passes the independent
// geometry/dig-free audits. No product code is modified; the oracle is
// wrapped via vi.mock purely to count calls and time.

import { describe, it, expect, vi } from 'vitest'
import { optimizeRoute, type PlannerLeg } from './pdp'
import { oracle, clusteredWitness, verifyWitness, type OracleItem } from './loadFeasibility'
import { validateGeometry, auditDigFree } from './witnessAudit'
import { SHIP_GRIDS, gridCapacity, type Compartment } from '../ships/grids'
import { decomposeToBoxes } from '../domain/cargo'
import type { Ship, RoutePlan } from '../domain/types'
import type { DistanceResolver } from './distanceMatrix'

// --- oracle instrumentation (wraps the real oracle; behaviour unchanged) ---

const oracleStats = vi.hoisted(() => ({
  calls: 0,
  ms: 0,
  maxMs: 0,
  verdicts: {} as Record<string, number>,
  reset() {
    this.calls = 0
    this.ms = 0
    this.maxMs = 0
    this.verdicts = {}
  },
}))

vi.mock('./loadFeasibility', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./loadFeasibility')>()
  const wrapped: typeof mod.oracle = (items, compartments, opts) => {
    const t0 = performance.now()
    const v = mod.oracle(items, compartments, opts)
    const dt = performance.now() - t0
    oracleStats.calls++
    oracleStats.ms += dt
    if (dt > oracleStats.maxMs) oracleStats.maxMs = dt
    oracleStats.verdicts[v.status] = (oracleStats.verdicts[v.status] ?? 0) + 1
    return v
  }
  return { ...mod, oracle: wrapped }
})

// --- seeded helpers ---

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

const shuffle = <T,>(arr: T[], rng: () => number): T[] => {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const pct = (xs: number[], p: number): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const f1 = (x: number) => Math.round(x * 10) / 10

/** Euclidean-plane resolver over points named S0..Sn-1; integer Gm. */
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

const mkShip = (name: string, scu: number): Ship => ({ id: 1, name, scu, containerSizes: [1, 2, 4, 8, 16, 32] })

const RUN = import.meta.env.VITE_VERIFY === '1'
const d = RUN ? describe : describe.skip

// =====================================================================
// A. Gridless routing: heuristic vs exact (N ≤ 16, both tractable)
// =====================================================================

interface GridlessInstance {
  legs: PlannerLeg[]
  resolver: DistanceResolver
  cap: number
  kind: 'hub' | 'scattered'
}

function genGridless(rng: () => number, N: number): GridlessInstance {
  const pts: [number, number][] = Array.from({ length: N }, () => [rng() * 300, rng() * 300])
  const resolver = planeResolver(pts)
  const legs: PlannerLeg[] = []
  let id = 0
  const add = (p: number, q: number) =>
    legs.push({
      id: `l${id++}`,
      missionId: `m${1 + (id % 4)}`,
      commodity: 'Cargo',
      scu: 10 + Math.floor(rng() * 71),
      pickupId: `S${p}`,
      dropoffId: `S${q}`,
    })
  const kind: 'hub' | 'scattered' = rng() < 0.5 ? 'hub' : 'scattered'
  if (kind === 'hub') {
    for (let i = 1; i < N; i++) add(0, i)
    const extras = Math.floor(rng() * 3)
    for (let e = 0; e < extras; e++) {
      const i = 1 + Math.floor(rng() * (N - 1))
      let j = Math.floor(rng() * N)
      if (j === i) j = (j + 1) % N
      add(i, j)
    }
  } else {
    const order = shuffle([...Array(N).keys()], rng)
    for (let i = 0; i + 1 < N; i += 2) add(order[i], order[i + 1])
    if (N % 2 === 1) add(order[N - 1], order[0] === order[N - 1] ? order[1] : order[0])
    const extras = 1 + Math.floor(rng() * 3)
    for (let e = 0; e < extras; e++) {
      const i = Math.floor(rng() * N)
      let j = Math.floor(rng() * N)
      if (j === i) j = (j + 1) % N
      add(i, j)
    }
  }
  const total = legs.reduce((a, l) => a + l.scu, 0)
  const maxLeg = Math.max(...legs.map((l) => l.scu))
  const cap = rng() < 0.4 ? Math.max(maxLeg, Math.ceil(total * (0.5 + 0.4 * rng()))) : total * 2
  return { legs, resolver, cap, kind }
}

d('A. gridless: heuristic vs exact optimality gap', () => {
  it('measures the gap and cross-checks solver consistency', { timeout: 600_000 }, () => {
    const SIZES = [8, 10, 12, 14, 16]
    const PER = 20
    const violations: string[] = []
    const rows: string[] = []
    const allGaps: number[] = []
    const gapsByKind: Record<string, number[]> = { hub: [], scattered: [] }
    let gaveUp = 0
    let bothInfeasible = 0

    for (const N of SIZES) {
      const gaps: number[] = []
      const exactMs: number[] = []
      const heurMs: number[] = []
      let feas = 0
      for (let k = 0; k < PER; k++) {
        const seed = 1000 * N + k
        const inst = genGridless(mulberry32(seed), N)
        const ship = mkShip('Bench', inst.cap)
        let t = performance.now()
        const exact = optimizeRoute(inst.legs, ship, inst.resolver, { exactLimit: Infinity })
        exactMs.push(performance.now() - t)
        t = performance.now()
        const heur = optimizeRoute(inst.legs, ship, inst.resolver, { exactLimit: 0 })
        heurMs.push(performance.now() - t)

        if (!exact.feasible && heur.feasible) {
          violations.push(`N=${N} seed=${seed}: exact says INFEASIBLE but heuristic found a route — exact solver bug`)
          continue
        }
        if (!exact.feasible) {
          bothInfeasible++
          continue
        }
        if (!heur.feasible) {
          gaveUp++
          continue
        }
        feas++
        if (heur.totalDistance < exact.totalDistance - 1) {
          violations.push(
            `N=${N} seed=${seed}: heuristic (${heur.totalDistance}) beat exact (${exact.totalDistance}) — exact not optimal`,
          )
        }
        const gap = ((heur.totalDistance - exact.totalDistance) / Math.max(exact.totalDistance, 1)) * 100
        gaps.push(gap)
        allGaps.push(gap)
        gapsByKind[inst.kind].push(gap)
      }
      rows.push(
        `  N=${String(N).padStart(2)}  feasible ${String(feas).padStart(2)}/${PER}` +
          `  gap avg ${f1(avg(gaps))}%  p95 ${f1(pct(gaps, 95))}%  max ${f1(Math.max(0, ...gaps))}%` +
          `  | exact avg ${f1(avg(exactMs))}ms max ${f1(Math.max(...exactMs))}ms  heur avg ${f1(avg(heurMs))}ms`,
      )
    }

    const zero = allGaps.filter((g) => g < 0.5).length
    console.log('\n=== A. gridless heuristic vs exact ===')
    for (const r of rows) console.log(r)
    console.log(
      `  overall: ${allGaps.length} compared | optimal(<0.5%) ${zero} (${f1((zero / Math.max(allGaps.length, 1)) * 100)}%)` +
        ` | avg gap ${f1(avg(allGaps))}% | p95 ${f1(pct(allGaps, 95))}% | max ${f1(Math.max(0, ...allGaps))}%`,
    )
    console.log(
      `  by shape: hub avg ${f1(avg(gapsByKind.hub))}% (n=${gapsByKind.hub.length})` +
        `  scattered avg ${f1(avg(gapsByKind.scattered))}% (n=${gapsByKind.scattered.length})`,
    )
    console.log(`  heuristic gave up on exact-feasible instances: ${gaveUp} | both infeasible: ${bothInfeasible}\n`)
    expect(violations).toEqual([])
  })
})

// =====================================================================
// B. Grid ships (RAFT): oracle-gated search vs brute-force reference
// =====================================================================

function genGridB(rng: () => number, N: number): { legs: PlannerLeg[]; resolver: DistanceResolver } {
  const pts: [number, number][] = Array.from({ length: N }, () => [rng() * 200, rng() * 200])
  const resolver = planeResolver(pts)
  const legs: PlannerLeg[] = []
  let id = 0
  const add = (p: number, q: number, scu: number) =>
    legs.push({
      id: `l${id++}`,
      missionId: `m${1 + (id % 3)}`,
      commodity: 'Waste',
      scu,
      maxBoxScu: 8,
      pickupId: `S${p}`,
      dropoffId: `S${q}`,
    })
  for (let i = 1; i < N; i++) add(0, i, 8 + Math.floor(rng() * 33))
  const extras = Math.floor(rng() * 2)
  for (let e = 0; e < extras; e++) {
    const p = Math.floor(rng() * N)
    let q = Math.floor(rng() * N)
    if (q === p) q = (q + 1) % N
    add(p, q, 8 + Math.floor(rng() * 25))
  }
  // Keep the hub peak under ~83% of the RAFT's 192 SCU so instances stay packable
  // but tight enough that delivery order matters.
  const total = legs.reduce((a, l) => a + l.scu, 0)
  if (total > 160) {
    const f = 160 / total
    for (const l of legs) l.scu = Math.max(4, Math.floor(l.scu * f))
  }
  return { legs, resolver }
}

type BruteRef =
  | { status: 'found'; best: number; oracleCalls: number; unknownsBeforeBest: number }
  | { status: 'none'; unknowns: number }
  | { status: 'capped' }

/** Enumerate all precedence/capacity-valid single-visit orders (ascending
 *  distance), oracle-check until the first feasible one — that is the optimal
 *  single-visit route for this instance. */
function bruteReference(legs: PlannerLeg[], N: number, resolver: DistanceResolver, comps: Compartment[]): BruteRef {
  const pick = legs.map((l) => Number(l.pickupId.slice(1)))
  const drop = legs.map((l) => Number(l.dropoffId.slice(1)))
  const cap = gridCapacity(comps)
  const deliveredAt: number[][] = Array.from({ length: N }, () => [])
  legs.forEach((_, li) => deliveredAt[drop[li]].push(li))
  const D: number[][] = Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => resolver.between(`S${i}`, `S${j}`).gm),
  )

  const orders: { seq: number[]; d: number }[] = []
  const inSet = new Array<boolean>(N).fill(false)
  const seq: number[] = []
  const dfs = (dist: number) => {
    if (seq.length === N) {
      orders.push({ seq: seq.slice(), d: dist })
      return
    }
    for (let k = 0; k < N; k++) {
      if (inSet[k]) continue
      if (!deliveredAt[k].every((li) => inSet[pick[li]])) continue
      inSet[k] = true
      seq.push(k)
      let load = 0
      for (let li = 0; li < legs.length; li++) if (inSet[pick[li]] && !inSet[drop[li]]) load += legs[li].scu
      if (load <= cap) dfs(dist + (seq.length > 1 ? D[seq[seq.length - 2]][k] : 0))
      seq.pop()
      inSet[k] = false
    }
  }
  dfs(0)
  orders.sort((a, b) => a.d - b.d)

  let calls = 0
  let unknowns = 0
  const t0 = performance.now()
  for (const o of orders) {
    if (calls >= 150 || performance.now() - t0 > 20_000) return { status: 'capped' }
    const pos = new Array<number>(N)
    o.seq.forEach((s, i) => (pos[s] = i))
    const items: OracleItem[] = legs.map((l, li) => ({
      legId: l.id,
      missionId: l.missionId,
      commodity: l.commodity,
      scu: l.scu,
      boxes: decomposeToBoxes(l.scu, l.maxBoxScu ?? 32).map((b) => b.dims),
      loadStop: pos[pick[li]],
      deliverStop: pos[drop[li]],
    }))
    calls++
    const v = oracle(items, comps, { nodeBudget: 5_000 })
    if (v.status === 'feasible') return { status: 'found', best: Math.round(o.d), oracleCalls: calls, unknownsBeforeBest: unknowns }
    if (v.status === 'unknown-budget') unknowns++
  }
  return { status: unknowns ? ('none' as const) : ('none' as const), unknowns }
}

d('B. grid (RAFT): optimizeRoute vs brute-force single-visit optimum', () => {
  it('measures the gap, missed-feasible rate, and audits every returned loadout', { timeout: 600_000 }, () => {
    const raft = SHIP_GRIDS.find((g) => g.match === 'RAFT')!.compartments
    const ship = mkShip('Argo RAFT bench', gridCapacity(raft))
    const violations: string[] = []
    const gaps: number[] = []
    let refFound = 0
    let optimal = 0
    let revisitWins = 0
    let missedFeasible = 0
    let capped = 0
    let noneRef = 0
    const refCalls: number[] = []

    const CASES: [number, number][] = []
    for (let k = 0; k < 10; k++) CASES.push([5, 50_000 + k])
    for (let k = 0; k < 10; k++) CASES.push([6, 60_000 + k])

    for (const [N, seed] of CASES) {
      const { legs, resolver } = genGridB(mulberry32(seed), N)
      const ref = bruteReference(legs, N, resolver, raft)
      if (ref.status === 'capped') {
        capped++
        continue
      }
      if (ref.status === 'none') noneRef++
      else {
        refFound++
        refCalls.push(ref.oracleCalls)
      }

      const plan: RoutePlan = optimizeRoute(legs, ship, resolver, {
        compartments: raft,
        timeBudgetMs: 4000,
      })

      if (plan.feasible && plan.loadout) {
        const geo = validateGeometry(plan.loadout, raft)
        const dig = auditDigFree(plan.loadout, raft)
        const lifo = verifyWitness(plan.loadout, raft)
        const boxCount = legs.reduce((a, l) => a + decomposeToBoxes(l.scu, l.maxBoxScu ?? 32).length, 0)
        if (!geo.ok || !dig.ok || !lifo)
          violations.push(`N=${N} seed=${seed}: returned loadout fails audits (geo=${geo.ok} dig=${dig.ok} lifo=${lifo})`)
        if (plan.loadout.length !== boxCount)
          violations.push(`N=${N} seed=${seed}: loadout has ${plan.loadout.length} boxes, expected ${boxCount}`)
      }

      if (ref.status === 'found') {
        if (!plan.feasible) {
          missedFeasible++
          continue
        }
        const singleVisit = (plan.revisits ?? 0) === 0
        if (singleVisit && plan.totalDistance < ref.best - 1 && ref.unknownsBeforeBest === 0) {
          violations.push(
            `N=${N} seed=${seed}: plan (${plan.totalDistance}) beat a clean brute-force optimum (${ref.best})`,
          )
        }
        const gap = ((plan.totalDistance - ref.best) / Math.max(ref.best, 1)) * 100
        if (gap < -0.5) revisitWins++
        else {
          gaps.push(gap)
          if (gap < 0.5) optimal++
        }
      } else if (ref.status === 'none' && ref.unknowns === 0 && plan.feasible && (plan.revisits ?? 0) === 0) {
        violations.push(`N=${N} seed=${seed}: no order is oracle-feasible yet plan claims a single-visit route`)
      }
    }

    console.log('\n=== B. grid (RAFT) vs brute-force single-visit optimum ===')
    console.log(
      `  ${CASES.length} instances | reference found ${refFound}, none ${noneRef}, capped ${capped}` +
        ` | avg oracle calls to prove optimum ${f1(avg(refCalls))}`,
    )
    console.log(
      `  optimizeRoute: optimal(<0.5%) ${optimal}/${gaps.length} | avg gap ${f1(avg(gaps))}%` +
        ` | max gap ${f1(Math.max(0, ...gaps))}% | revisit shorter than single-visit optimum: ${revisitWins}`,
    )
    console.log(`  missed-feasible (brute found a route, optimizeRoute gave up): ${missedFeasible}\n`)
    expect(violations).toEqual([])
  })
})

// =====================================================================
// C. Where does grid-ship wall-clock go? (oracle share)
// =====================================================================

function genRailenScale(rng: () => number): { legs: PlannerLeg[]; resolver: DistanceResolver } {
  const N = 6 + Math.floor(rng() * 3) // 6..8 stops
  const pts: [number, number][] = Array.from({ length: N }, () => [rng() * 400, rng() * 400])
  const resolver = planeResolver(pts)
  const legs: PlannerLeg[] = []
  let id = 0
  const add = (p: number, q: number, scu: number) =>
    legs.push({
      id: `l${id++}`,
      missionId: `m${1 + Math.floor(id / 2.5)}`,
      commodity: 'Waste',
      scu,
      maxBoxScu: 8,
      pickupId: `S${p}`,
      dropoffId: `S${q}`,
    })
  const L = 8 + Math.floor(rng() * 4) // 8..11 legs
  for (let i = 0; i < L; i++) {
    const scatter = rng() < 0.2
    const p = scatter ? 1 + Math.floor(rng() * (N - 1)) : 0
    let q = 1 + Math.floor(rng() * (N - 1))
    if (q === p) q = p === N - 1 ? 1 : p + 1
    add(p, q, 20 + Math.floor(rng() * 76))
  }
  const total = legs.reduce((a, l) => a + l.scu, 0)
  if (total > 580) {
    const f = 580 / total
    for (const l of legs) l.scu = Math.max(8, Math.floor(l.scu * f))
  }
  return { legs, resolver }
}

d('C. grid-ship wall-clock: oracle share', () => {
  it('profiles the Railen fixture and random Railen-scale instances', { timeout: 600_000 }, () => {
    const railen = SHIP_GRIDS.find((g) => g.match === 'Railen')!.compartments
    const ship = mkShip('Gatac Railen', 640)

    const profile = (
      label: string,
      legs: PlannerLeg[],
      resolver: DistanceResolver,
      opts: { oracleNodeBudget: number; timeBudgetMs: number },
    ) => {
      oracleStats.reset()
      const t0 = performance.now()
      const plan = optimizeRoute(legs, ship, resolver, { compartments: railen, ...opts })
      const total = performance.now() - t0
      const share = total > 0 ? (oracleStats.ms / total) * 100 : 0
      const verdicts = Object.entries(oracleStats.verdicts)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')
      console.log(
        `  ${label}: total ${f1(total)}ms | oracle ${f1(oracleStats.ms)}ms (${f1(share)}%)` +
          ` in ${oracleStats.calls} calls (avg ${f1(oracleStats.ms / Math.max(oracleStats.calls, 1))}ms, max ${f1(oracleStats.maxMs)}ms)` +
          ` | verdicts: ${verdicts || '-'}` +
          ` | ${plan.feasible ? `algo ${plan.algorithm}, method ${plan.method}, revisits ${plan.revisits ?? 0}, dist ${plan.totalDistance}` : 'INFEASIBLE'}`,
      )
      return { total, share }
    }

    console.log('\n=== C. oracle wall-clock share on grid ships ===')

    // The real Railen Pyro fixture (railenSample.test.ts Phase 3).
    const loc = ['Ruin', 'Stanton Gateway', 'Starlight', 'Megumi', "Rat's Nest", 'Checkmate', "Rod's Fuel"]
    const idx = (name: string) => `S${loc.indexOf(name)}`
    const fixtureResolver: DistanceResolver = {
      between: (a, b) =>
        a === b
          ? { gm: 0, estimated: false, unreachable: false }
          : { gm: Math.abs(Number(a.slice(1)) - Number(b.slice(1))) * 15, estimated: false, unreachable: false },
    }
    const L = (id: string, m: string, c: string, scu: number, from: string, to: string): PlannerLeg =>
      ({ id, missionId: m, commodity: c, scu, maxBoxScu: 8, pickupId: idx(from), dropoffId: idx(to) })
    const fixtureLegs: PlannerLeg[] = [
      L('m1a', 'M1', 'Waste', 72, 'Ruin', 'Stanton Gateway'), L('m1b', 'M1', 'Waste', 67, 'Ruin', 'Starlight'),
      L('m2a', 'M2', 'Waste', 59, 'Ruin', 'Megumi'), L('m2b', 'M2', 'Waste', 41, 'Ruin', "Rat's Nest"), L('m2c', 'M2', 'Waste', 58, 'Ruin', 'Starlight'),
      L('m3a', 'M3', 'Potassium', 61, "Rod's Fuel", 'Ruin'),
      L('m4a', 'M4', 'Waste', 43, 'Ruin', 'Checkmate'), L('m4b', 'M4', 'Waste', 23, 'Ruin', "Rod's Fuel"), L('m4c', 'M4', 'Waste', 94, 'Ruin', 'Stanton Gateway'),
      L('m5a', 'M5', 'Waste', 88, 'Ruin', 'Stanton Gateway'), L('m5b', 'M5', 'Waste', 78, 'Ruin', 'Starlight'),
    ]
    profile('Railen Pyro fixture (11 legs)', fixtureLegs, fixtureResolver, { oracleNodeBudget: 200_000, timeBudgetMs: 6000 })

    const shares: number[] = []
    for (let k = 0; k < 6; k++) {
      const seed = 90_000 + k
      const { legs, resolver } = genRailenScale(mulberry32(seed))
      const r = profile(`random Railen-scale seed=${seed} (${legs.length} legs)`, legs, resolver, {
        oracleNodeBudget: 50_000,
        timeBudgetMs: 4000,
      })
      shares.push(r.share)
    }
    console.log(`  random instances: oracle share avg ${f1(avg(shares))}% (min ${f1(Math.min(...shares))}%, max ${f1(Math.max(...shares))}%)\n`)
    expect(shares.length).toBe(6)
  })
})

// =====================================================================
// D. Oracle soundness: random-instance audits
// =====================================================================

d('D. oracle soundness: every feasible witness passes independent audits', () => {
  it('runs seeded random instances across RAFT / Prowler / Railen', { timeout: 600_000 }, () => {
    const grids = [
      { name: 'RAFT', comps: SHIP_GRIDS.find((g) => g.match === 'RAFT')!.compartments, scu: [4, 40] as const, maxBox: [8, 16] },
      { name: 'Prowler', comps: SHIP_GRIDS.find((g) => g.match === 'Prowler Utility')!.compartments, scu: [2, 10] as const, maxBox: [8, 16] },
      { name: 'Railen', comps: SHIP_GRIDS.find((g) => g.match === 'Railen')!.compartments, scu: [8, 80] as const, maxBox: [8, 32] },
    ]
    const verdictCount: Record<string, number> = {}
    const violations: string[] = []
    let audited = 0
    let clusteredOk = 0
    let clusteredNull = 0

    for (const g of grids) {
      const capTotal = gridCapacity(g.comps)
      for (let k = 0; k < 100; k++) {
        const seed = g.name.charCodeAt(0) * 10_000 + k
        const rng = mulberry32(seed)
        const S = 3 + Math.floor(rng() * 6) // 3..8 stops
        const nLegs = 2 + Math.floor(rng() * 7) // 2..8 legs
        const items: OracleItem[] = []
        for (let li = 0; li < nLegs; li++) {
          const ls = Math.floor(rng() * (S - 1))
          const ds = ls + 1 + Math.floor(rng() * (S - 1 - ls))
          const scu = g.scu[0] + Math.floor(rng() * (g.scu[1] - g.scu[0] + 1))
          const maxBox = g.maxBox[Math.floor(rng() * g.maxBox.length)]
          items.push({
            legId: `l${li}`,
            missionId: `m${1 + (li % 3)}`,
            commodity: 'Cargo',
            scu,
            boxes: decomposeToBoxes(scu, maxBox).map((b) => b.dims),
            loadStop: ls,
            deliverStop: ds,
          })
        }
        // Trim to ~80% of capacity so most instances are genuinely packable.
        const peakOf = (its: OracleItem[]) => {
          let m = 0
          const maxStop = Math.max(...its.map((i) => i.deliverStop))
          for (let s = 0; s <= maxStop; s++) {
            let on = 0
            for (const it of its) if (it.loadStop <= s && it.deliverStop > s) on += it.scu
            if (on > m) m = on
          }
          return m
        }
        while (items.length > 1 && peakOf(items) > capTotal * 0.8) items.pop()

        const v = oracle(items, g.comps, { nodeBudget: 20_000 })
        verdictCount[v.status] = (verdictCount[v.status] ?? 0) + 1
        if (v.status !== 'feasible') continue

        audited++
        const expectBoxes = items.reduce((a, i) => a + i.boxes.length, 0)
        const geo = validateGeometry(v.boxes, g.comps)
        const dig = auditDigFree(v.boxes, g.comps)
        const lifo = verifyWitness(v.boxes, g.comps)
        if (v.boxes.length !== expectBoxes)
          violations.push(`${g.name} seed=${seed}: witness has ${v.boxes.length} boxes, expected ${expectBoxes}`)
        if (!geo.ok) violations.push(`${g.name} seed=${seed}: geometry — ${geo.reason}`)
        if (!dig.ok) violations.push(`${g.name} seed=${seed}: dig-free — ${dig.reason}`)
        if (!lifo) violations.push(`${g.name} seed=${seed}: verifyWitness failed`)

        const c = clusteredWitness(items, g.comps, { nodeBudget: 4000 })
        if (!c) {
          clusteredNull++
        } else {
          clusteredOk++
          const geoC = validateGeometry(c, g.comps)
          const digC = auditDigFree(c, g.comps)
          const lifoC = verifyWitness(c, g.comps)
          if (c.length !== expectBoxes)
            violations.push(`${g.name} seed=${seed} CLUSTERED: ${c.length} boxes, expected ${expectBoxes}`)
          if (!geoC.ok) violations.push(`${g.name} seed=${seed} CLUSTERED: geometry — ${geoC.reason}`)
          if (!digC.ok) violations.push(`${g.name} seed=${seed} CLUSTERED: dig-free — ${digC.reason}`)
          if (!lifoC) violations.push(`${g.name} seed=${seed} CLUSTERED: verifyWitness failed`)
        }
      }
    }

    console.log('\n=== D. oracle soundness audits (300 seeded instances) ===')
    console.log(
      `  verdicts: ${Object.entries(verdictCount).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    )
    console.log(
      `  feasible witnesses audited: ${audited} | clustered repack ok ${clusteredOk}, bailed(null) ${clusteredNull}` +
        ` | violations: ${violations.length}\n`,
    )
    expect(violations).toEqual([])
  })
})
