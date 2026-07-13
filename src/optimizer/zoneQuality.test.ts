// Destination-zoning quality measurement — NOT part of the regular suite
// (guarded by VITE_VERIFY). Run with:
//   PowerShell:  $env:VITE_VERIFY='1'; npx vitest run src/optimizer/zoneQuality.test.ts
//
// Measures "this stop = this pod" cohesion: for every delivery stop, how many
// compartments does its cargo occupy? Compares the mission-clustered baseline
// against the new destination-zoned witness on the same routes, and confirms
// every zoned witness still passes the independent audits. Also reports when
// zoning correctly BAILS (tight loads) and the plan keeps its old witness.

import { describe, it, expect } from 'vitest'
import { optimizeRoute, type PlannerLeg } from './pdp'
import { clusteredWitness, zonedWitness, itemsFromPlan, verifyWitness, type OraclePlacedBox } from './loadFeasibility'
import { validateGeometry, auditDigFree } from './witnessAudit'
import { SHIP_GRIDS, gridCapacity, type Compartment } from '../ships/grids'
import type { Ship } from '../domain/types'
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

function compOf(b: OraclePlacedBox, comps: Compartment[]): number {
  return comps.findIndex((c) =>
    b.pos[0] >= c.offset[0] && b.pos[0] + b.dims[0] <= c.offset[0] + c.dims[0] &&
    b.pos[1] >= c.offset[1] && b.pos[1] + b.dims[1] <= c.offset[1] + c.dims[1] &&
    b.pos[2] >= c.offset[2] && b.pos[2] + b.dims[2] <= c.offset[2] + c.dims[2])
}

/** Per delivery stop: how many compartments hold its cargo? */
function stopCohesion(boxes: OraclePlacedBox[], comps: Compartment[]): { avgZones: number; pctSingle: number } {
  const byStop = new Map<number, Set<number>>()
  for (const b of boxes) {
    const set = byStop.get(b.deliverStop) ?? new Set<number>()
    set.add(compOf(b, comps))
    byStop.set(b.deliverStop, set)
  }
  const sizes = [...byStop.values()].map((s) => s.size)
  return {
    avgZones: sizes.reduce((a, b) => a + b, 0) / Math.max(sizes.length, 1),
    pctSingle: (sizes.filter((s) => s === 1).length / Math.max(sizes.length, 1)) * 100,
  }
}

/** Railen-scale generator with a controllable fill ratio. */
function genRailen(rng: () => number, fillTarget: number): { legs: PlannerLeg[]; resolver: DistanceResolver } {
  const N = 5 + Math.floor(rng() * 3) // 5..7 stops
  const pts: [number, number][] = Array.from({ length: N }, () => [rng() * 400, rng() * 400])
  const resolver = planeResolver(pts)
  const legs: PlannerLeg[] = []
  let id = 0
  const add = (p: number, q: number, scu: number) =>
    legs.push({ id: `l${id++}`, missionId: `m${1 + (id % 4)}`, commodity: 'Waste', scu, maxBoxScu: 8, pickupId: `S${p}`, dropoffId: `S${q}` })
  for (let v = 1; v < N; v++) add(0, v, 30 + Math.floor(rng() * 70))
  const extras = 1 + Math.floor(rng() * 3)
  for (let e = 0; e < extras; e++) {
    const p = rng() < 0.7 ? 0 : Math.floor(rng() * (N - 1))
    const q = p + 1 + Math.floor(rng() * (N - 1 - p))
    add(p, q, 20 + Math.floor(rng() * 50))
  }
  const target = 640 * fillTarget
  const total = legs.reduce((a, l) => a + l.scu, 0)
  const f = target / total
  for (const l of legs) l.scu = Math.max(8, Math.round(l.scu * f))
  return { legs, resolver }
}

const RUN = import.meta.env.VITE_VERIFY === '1'
const d = RUN ? describe : describe.skip

d('destination zoning: stop-cohesion before vs after', () => {
  it('measures zones-per-stop on Railen runs across fill levels + fixture regressions', { timeout: 600_000 }, () => {
    const railen = SHIP_GRIDS.find((g) => g.match === 'Railen')!.compartments
    const ship = mkShip('Gatac Railen', 640)
    const violations: string[] = []
    const rows: string[] = []
    let zonedApplied = 0
    let bailed = 0
    let total = 0

    const study = (label: string, legs: PlannerLeg[], resolver: DistanceResolver, comps: Compartment[], s: Ship) => {
      const plan = optimizeRoute(legs, s, resolver, { compartments: comps, oracleNodeBudget: 10_000, timeBudgetMs: 6000 })
      if (!plan.feasible || !plan.loadout) {
        rows.push(`  ${label}: infeasible — skipped`)
        return
      }
      total++
      const items = itemsFromPlan(legs, plan)
      const baseline = clusteredWitness(items, comps, { nodeBudget: 4000 })
      const zoned = zonedWitness(items, comps, { nodeBudget: 8000 })
      const base = stopCohesion(baseline ?? plan.loadout, comps)
      const now = stopCohesion(plan.loadout, comps)
      const peak = Math.max(...plan.stops.map((st) => st.loadAfter))
      if (zoned) zonedApplied++
      else bailed++
      rows.push(
        `  ${label} (peak ${peak}/${gridCapacity(comps)}): zones/stop ${f1(base.avgZones)}→${f1(now.avgZones)}` +
          ` | single-zone stops ${f1(base.pctSingle)}%→${f1(now.pctSingle)}% | zoning ${zoned ? 'APPLIED' : 'bailed (kept old witness)'}`,
      )
      // The plan's final witness must still pass every audit.
      const geo = validateGeometry(plan.loadout, comps)
      const dig = auditDigFree(plan.loadout, comps)
      const lifo = verifyWitness(plan.loadout, comps)
      if (!geo.ok) violations.push(`${label}: geometry — ${geo.reason}`)
      if (!dig.ok) violations.push(`${label}: dig-free — ${dig.reason}`)
      if (!lifo) violations.push(`${label}: verifyWitness failed`)
      const boxCount = items.reduce((a, i) => a + i.boxes.length, 0)
      if (plan.loadout.length !== boxCount) violations.push(`${label}: loadout ${plan.loadout.length}/${boxCount} boxes`)
    }

    console.log('\n=== destination zoning: zones-per-stop (baseline clustered → shipped witness) ===')

    // Random Railen runs at three fill levels.
    for (const fill of [0.5, 0.65, 0.8]) {
      for (let k = 0; k < 5; k++) {
        const seed = Math.round(fill * 100) * 1000 + k
        const { legs, resolver } = genRailen(mulberry32(seed), fill)
        study(`Railen fill~${Math.round(fill * 100)}% seed=${seed}`, legs, resolver, railen, ship)
      }
    }

    // Fixture regression: the 4-mission 600-SCU run (94% fill) — zoning should
    // BAIL here and leave the mission-clustered witness untouched.
    {
      const loc = ['Ruin', 'Stanton Gateway', 'Starlight', 'Megumi', "Rat's Nest", 'Checkmate']
      const idx = (name: string) => `S${loc.indexOf(name)}`
      const resolver: DistanceResolver = {
        between: (a, b) => (a === b ? { gm: 0, estimated: false, unreachable: false }
          : { gm: Math.abs(Number(a.slice(1)) - Number(b.slice(1))) * 15, estimated: false, unreachable: false }),
      }
      const L = (id: string, m: string, scu: number, from: string, to: string): PlannerLeg =>
        ({ id, missionId: m, commodity: 'Waste', scu, maxBoxScu: 8, pickupId: idx(from), dropoffId: idx(to) })
      const legs: PlannerLeg[] = [
        L('m1a', 'M1', 72, 'Ruin', 'Stanton Gateway'), L('m1b', 'M1', 67, 'Ruin', 'Starlight'),
        L('m2a', 'M2', 59, 'Ruin', 'Megumi'), L('m2b', 'M2', 41, 'Ruin', "Rat's Nest"), L('m2c', 'M2', 58, 'Ruin', 'Starlight'),
        L('m4a', 'M4', 43, 'Ruin', 'Checkmate'), L('m4c', 'M4', 94, 'Ruin', 'Stanton Gateway'),
        L('m5a', 'M5', 88, 'Ruin', 'Stanton Gateway'), L('m5b', 'M5', 78, 'Ruin', 'Starlight'),
      ]
      study('FIXTURE Railen 4-mission 600 SCU', legs, resolver, railen, ship)
    }

    console.log(rows.join('\n'))
    console.log(`  zoning applied ${zonedApplied}/${total}, bailed ${bailed}/${total} | audit violations: ${violations.length}\n`)
    expect(violations).toEqual([])
  })
})
