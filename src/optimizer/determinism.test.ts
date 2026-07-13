import { describe, it, expect } from 'vitest'
import { optimizeRoute, type PlannerLeg } from './pdp'
import { oracle, type OracleItem } from './loadFeasibility'
import { SHIP_GRIDS } from '../ships/grids'
import { decomposeToBoxes } from '../domain/cargo'
import type { Dims3 } from './packPrimitives'
import type { Ship } from '../domain/types'
import type { DistanceResolver } from './distanceMatrix'

// Determinism of the PLAN as a whole (formal-spec §7.3): every oracle budget is
// node-based, candidate enumeration is lexicographic, and unknown verdicts are
// never conflated with proofs — so the same instance must produce the exact
// same plan (stops, distance, witness coordinates, checklist order) on every
// run and every machine. Compatibility timeBudgetMs values must not change
// route selection; route search is capped by deterministic candidate counts.

const railen = SHIP_GRIDS.find((g) => g.match === 'Railen')!.compartments
const ship: Ship = { id: 1, name: 'Gatac Railen', scu: 640, containerSizes: [1, 2, 4, 8, 16, 32] }
const loc = ['Ruin', 'Stanton Gateway', 'Starlight', 'Megumi', "Rat's Nest", 'Checkmate', "Rod's Fuel"]
const idx = (name: string) => `S${loc.indexOf(name)}`
const resolver: DistanceResolver = {
  between: (a, b) => (a === b ? { gm: 0, estimated: false, unreachable: false }
    : { gm: Math.abs(Number(a.slice(1)) - Number(b.slice(1))) * 15, estimated: false, unreachable: false }),
}
const L = (id: string, m: string, c: string, scu: number, from: string, to: string): PlannerLeg =>
  ({ id, missionId: m, commodity: c, scu, maxBoxScu: 8, pickupId: idx(from), dropoffId: idx(to) })

describe('plan determinism (node-budget gates, no wall clock in verdicts)', () => {
  it('single-visit instance: two runs produce the identical plan, witness and checklist', () => {
    const legs: PlannerLeg[] = [
      L('m1a', 'M1', 'Waste', 72, 'Ruin', 'Stanton Gateway'), L('m1b', 'M1', 'Waste', 67, 'Ruin', 'Starlight'),
      L('m2a', 'M2', 'Waste', 59, 'Ruin', 'Megumi'), L('m2b', 'M2', 'Waste', 41, 'Ruin', "Rat's Nest"),
      L('m4a', 'M4', 'Waste', 43, 'Ruin', 'Checkmate'), L('m4c', 'M4', 'Waste', 94, 'Ruin', 'Stanton Gateway'),
    ]
    const a = optimizeRoute(legs, ship, resolver, { compartments: railen })
    const b = optimizeRoute(legs, ship, resolver, { compartments: railen })
    expect(a.feasible).toBe(true)
    expect(b).toEqual(a)
  })

  it('revisit instance (full 5-mission fixture): two runs produce the identical plan', () => {
    const legs: PlannerLeg[] = [
      L('m1a', 'M1', 'Waste', 72, 'Ruin', 'Stanton Gateway'), L('m1b', 'M1', 'Waste', 67, 'Ruin', 'Starlight'),
      L('m2a', 'M2', 'Waste', 59, 'Ruin', 'Megumi'), L('m2b', 'M2', 'Waste', 41, 'Ruin', "Rat's Nest"), L('m2c', 'M2', 'Waste', 58, 'Ruin', 'Starlight'),
      L('m3a', 'M3', 'Potassium', 61, "Rod's Fuel", 'Ruin'),
      L('m4a', 'M4', 'Waste', 43, 'Ruin', 'Checkmate'), L('m4b', 'M4', 'Waste', 23, 'Ruin', "Rod's Fuel"), L('m4c', 'M4', 'Waste', 94, 'Ruin', 'Stanton Gateway'),
      L('m5a', 'M5', 'Waste', 88, 'Ruin', 'Stanton Gateway'), L('m5b', 'M5', 'Waste', 78, 'Ruin', 'Starlight'),
    ]
    const a = optimizeRoute(legs, ship, resolver, { compartments: railen, oracleNodeBudget: 200_000, timeBudgetMs: 6000 })
    const b = optimizeRoute(legs, ship, resolver, { compartments: railen, oracleNodeBudget: 200_000, timeBudgetMs: 6000 })
    expect(a.feasible).toBe(true)
    expect(b).toEqual(a)
  })

  it('route selection is independent of the compatibility timeBudgetMs value', () => {
    const legs: PlannerLeg[] = [
      L('m1a', 'M1', 'Waste', 72, 'Ruin', 'Stanton Gateway'), L('m1b', 'M1', 'Waste', 67, 'Ruin', 'Starlight'),
      L('m2a', 'M2', 'Waste', 59, 'Ruin', 'Megumi'), L('m2b', 'M2', 'Waste', 41, 'Ruin', "Rat's Nest"), L('m2c', 'M2', 'Waste', 58, 'Ruin', 'Starlight'),
      L('m3a', 'M3', 'Potassium', 61, "Rod's Fuel", 'Ruin'),
      L('m4a', 'M4', 'Waste', 43, 'Ruin', 'Checkmate'), L('m4b', 'M4', 'Waste', 23, 'Ruin', "Rod's Fuel"), L('m4c', 'M4', 'Waste', 94, 'Ruin', 'Stanton Gateway'),
      L('m5a', 'M5', 'Waste', 88, 'Ruin', 'Stanton Gateway'), L('m5b', 'M5', 'Waste', 78, 'Ruin', 'Starlight'),
    ]
    const base = optimizeRoute(legs, ship, resolver, { compartments: railen, oracleNodeBudget: 200_000, timeBudgetMs: 6000 })
    const zero = optimizeRoute(legs, ship, resolver, { compartments: railen, oracleNodeBudget: 200_000, timeBudgetMs: 0 })
    expect(base.feasible).toBe(true)
    expect(zero).toEqual(base)
  })

  it('oracle: identical items give the identical verdict and witness, and unknown stays unknown', () => {
    const boxesOf = (scu: number): Dims3[] => decomposeToBoxes(scu, 8).map((x) => x.dims)
    const mk = (legId: string, scu: number, ls: number, ds: number): OracleItem =>
      ({ legId, missionId: legId, commodity: 'Waste', scu, boxes: boxesOf(scu), loadStop: ls, deliverStop: ds })
    const items = [mk('a', 72, 0, 2), mk('b', 67, 0, 1), mk('c', 59, 1, 3)]
    const a = oracle(items, railen)
    const b = oracle(items, railen)
    expect(b).toEqual(a)
    expect(a.status).toBe('feasible')

    // A budget cut must report unknown-budget — never a proof — and repeat runs
    // must hit the budget at exactly the same node (same verdict, no wall clock).
    const tight1 = oracle(items, railen, { nodeBudget: 3 })
    const tight2 = oracle(items, railen, { nodeBudget: 3 })
    expect(tight1.status).toBe('unknown-budget')
    expect(tight2).toEqual(tight1)
  })
})
