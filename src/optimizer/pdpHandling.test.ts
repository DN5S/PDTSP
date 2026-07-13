import { describe, it, expect } from 'vitest'
import { optimizeRoute, type PlannerLeg } from './pdp'
import { SHIP_GRIDS, type Compartment } from '../ships/grids'
import { verifyWitness } from './loadFeasibility'
import { validateGeometry, auditDigFree } from './witnessAudit'
import type { Ship } from '../domain/types'
import type { DistanceResolver } from './distanceMatrix'

// Objective F = distance + Σ(α·L + δ·G).
//  1. Metamorphic backward compatibility: α = δ = 0 must reproduce the
//     pure-distance plans EXACTLY (snapshots taken before pricing landed).
//  2. Pricing effect: a large δ makes the planner pay distance to avoid
//     scraping past onboard cargo.

const railen = SHIP_GRIDS.find((g) => g.match === 'Railen')!.compartments
const railenShip: Ship = { id: 1, name: 'Gatac Railen', scu: 640, containerSizes: [1, 2, 4, 8, 16, 32] }
const loc = ['Ruin', 'Stanton Gateway', 'Starlight', 'Megumi', "Rat's Nest", 'Checkmate', "Rod's Fuel"]
const idx = (name: string) => `S${loc.indexOf(name)}`
const lineResolver = (gmPerStep: number): DistanceResolver => ({
  between: (a, b) => (a === b ? { gm: 0, estimated: false, unreachable: false }
    : { gm: Math.abs(Number(a.slice(1)) - Number(b.slice(1))) * gmPerStep, estimated: false, unreachable: false }),
})
const L = (id: string, m: string, c: string, scu: number, from: string, to: string): PlannerLeg =>
  ({ id, missionId: m, commodity: c, scu, maxBoxScu: 8, pickupId: idx(from), dropoffId: idx(to) })

describe('objective F = distance + handling', () => {
  it('metamorphic: alpha = delta = 0 reproduces the pure-distance plans exactly', () => {
    const four: PlannerLeg[] = [
      L('m1a', 'M1', 'Waste', 72, 'Ruin', 'Stanton Gateway'), L('m1b', 'M1', 'Waste', 67, 'Ruin', 'Starlight'),
      L('m2a', 'M2', 'Waste', 59, 'Ruin', 'Megumi'), L('m2b', 'M2', 'Waste', 41, 'Ruin', "Rat's Nest"),
      L('m4a', 'M4', 'Waste', 43, 'Ruin', 'Checkmate'), L('m4c', 'M4', 'Waste', 94, 'Ruin', 'Stanton Gateway'),
    ]
    const resolver = lineResolver(15)
    const zero = optimizeRoute(four, railenShip, resolver, { compartments: railen, alphaMilli: 0, deltaMilli: 0 })
    const dflt = optimizeRoute(four, railenShip, resolver, { compartments: railen })
    expect(zero).toEqual(dflt)
    // Pure-distance snapshot (pre-pricing build, 2026-07-07): distance 75,
    // single-visit S0..S5.
    expect(zero.totalDistance).toBe(75)
    expect(zero.algorithm).toBe('pdtsp')
    expect(zero.stops.map((s) => s.locationId)).toEqual(['S0', 'S1', 'S2', 'S3', 'S4', 'S5'])

    const five: PlannerLeg[] = [
      ...four.slice(0, 4),
      L('m2c', 'M2', 'Waste', 58, 'Ruin', 'Starlight'),
      L('m3a', 'M3', 'Potassium', 61, "Rod's Fuel", 'Ruin'),
      L('m4a', 'M4', 'Waste', 43, 'Ruin', 'Checkmate'), L('m4b', 'M4', 'Waste', 23, 'Ruin', "Rod's Fuel"), L('m4c', 'M4', 'Waste', 94, 'Ruin', 'Stanton Gateway'),
      L('m5a', 'M5', 'Waste', 88, 'Ruin', 'Stanton Gateway'), L('m5b', 'M5', 'Waste', 78, 'Ruin', 'Starlight'),
    ]
    const zero5 = optimizeRoute(five, railenShip, resolver, {
      compartments: railen, oracleNodeBudget: 200_000, timeBudgetMs: 6000, alphaMilli: 0, deltaMilli: 0,
    })
    const dflt5 = optimizeRoute(five, railenShip, resolver, {
      compartments: railen, oracleNodeBudget: 200_000, timeBudgetMs: 6000,
    })
    expect(zero5).toEqual(dflt5)
    // Pure-distance snapshot: distance 180, revisit route ending back at Ruin.
    expect(zero5.totalDistance).toBe(180)
    expect(zero5.algorithm).toBe('pdtsp-l')
    expect(zero5.revisits).toBe(1)
    expect(zero5.stops.map((s) => s.locationId)).toEqual(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S0'])
  })

  it('exposes the final witness handling on the plan (weight-free measurement)', () => {
    const legs: PlannerLeg[] = [
      L('m1a', 'M1', 'Waste', 72, 'Ruin', 'Stanton Gateway'), L('m1b', 'M1', 'Waste', 67, 'Ruin', 'Starlight'),
      L('m2a', 'M2', 'Waste', 59, 'Ruin', 'Megumi'),
    ]
    const plan = optimizeRoute(legs, railenShip, lineResolver(15), { compartments: railen })
    expect(plan.feasible).toBe(true)
    expect(plan.handling).toBeDefined()
    const h = plan.handling!
    expect(h.perStop).toHaveLength(plan.stops.length)
    expect(h.perStop.reduce((a, s) => a + s.L, 0)).toBe(h.totalL)
    expect(h.perStop.reduce((a, s) => a + s.G, 0)).toBe(h.totalG)
    expect(h.totalL).toBeGreaterThan(0)
    /* eslint-disable no-console */
    console.log(`Railen 3-leg handling: totalL ${h.totalL}, totalG ${h.totalG}, distance ${plan.totalDistance}`)
    /* eslint-enable no-console */
  })

  it('app-default weights: golden 5-mission fixture stays feasible, audited and deterministic', () => {
    const five: PlannerLeg[] = [
      L('m1a', 'M1', 'Waste', 72, 'Ruin', 'Stanton Gateway'), L('m1b', 'M1', 'Waste', 67, 'Ruin', 'Starlight'),
      L('m2a', 'M2', 'Waste', 59, 'Ruin', 'Megumi'), L('m2b', 'M2', 'Waste', 41, 'Ruin', "Rat's Nest"), L('m2c', 'M2', 'Waste', 58, 'Ruin', 'Starlight'),
      L('m3a', 'M3', 'Potassium', 61, "Rod's Fuel", 'Ruin'),
      L('m4a', 'M4', 'Waste', 43, 'Ruin', 'Checkmate'), L('m4b', 'M4', 'Waste', 23, 'Ruin', "Rod's Fuel"), L('m4c', 'M4', 'Waste', 94, 'Ruin', 'Stanton Gateway'),
      L('m5a', 'M5', 'Waste', 88, 'Ruin', 'Stanton Gateway'), L('m5b', 'M5', 'Waste', 78, 'Ruin', 'Starlight'),
    ]
    const resolver = lineResolver(15)
    const opts = {
      compartments: railen, oracleNodeBudget: 200_000, timeBudgetMs: 6000,
      alphaMilli: 40, deltaMilli: 160, // store defaults (DEFAULT_ALPHA_MILLI/DEFAULT_DELTA_MILLI)
    }
    const plan = optimizeRoute(legsCopy(five), railenShip, resolver, opts)
    expect(plan.feasible).toBe(true)
    expect(plan.loadout).toBeDefined()
    expect(verifyWitness(plan.loadout!, railen)).toBe(true)
    expect(validateGeometry(plan.loadout!, railen).ok).toBe(true)
    expect(auditDigFree(plan.loadout!, railen)).toEqual({ ok: true })
    // Calibration guard (formal-spec §5): Σh within ~10–30% of total travel on
    // the golden fixture — handling informs routing without drowning it.
    const h = plan.handling!
    const sigma = (40 * h.totalL + 160 * h.totalG) / 1000
    /* eslint-disable no-console */
    console.log(`golden fixture under app defaults: distance ${plan.totalDistance}, totalL ${h.totalL}, totalG ${h.totalG}, Σh ${sigma.toFixed(1)} Gm (${((sigma / plan.totalDistance) * 100).toFixed(1)}%)`)
    /* eslint-enable no-console */
    expect(sigma).toBeGreaterThan(plan.totalDistance * 0.10)
    expect(sigma).toBeLessThan(plan.totalDistance * 0.30)
    // Determinism holds with pricing on.
    const again = optimizeRoute(legsCopy(five), railenShip, resolver, opts)
    expect(again).toEqual(plan)

    function legsCopy(ls: PlannerLeg[]): PlannerLeg[] {
      return ls.map((l) => ({ ...l }))
    }
  })

  it('negative handling weights normalize to pure-distance routing', () => {
    const legs: PlannerLeg[] = [
      L('m1a', 'M1', 'Waste', 72, 'Ruin', 'Stanton Gateway'), L('m1b', 'M1', 'Waste', 67, 'Ruin', 'Starlight'),
      L('m2a', 'M2', 'Waste', 59, 'Ruin', 'Megumi'), L('m2b', 'M2', 'Waste', 41, 'Ruin', "Rat's Nest"),
    ]
    const resolver = lineResolver(15)
    const zero = optimizeRoute(legs, railenShip, resolver, { compartments: railen, alphaMilli: 0, deltaMilli: 0 })
    const negative = optimizeRoute(legs, railenShip, resolver, { compartments: railen, alphaMilli: -40, deltaMilli: -160 })
    expect(negative).toEqual(zero)
  })

  it('pricing effect: a large delta pays distance to avoid scraping past onboard cargo', () => {
    // One two-lane bay [2,3,1], door +y. A (2 SCU, deep, onboard S0→S3) and
    // B (1 SCU, S1→S2): the shortest route S0,S1,S2,S3 slides B past A twice
    // (G = 2). With δ priced high, the planner must find a route where the two
    // are never onboard together (G = 0) even though it travels further.
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [2, 3, 1], blockingModel: 'vertical+depth', openingAxis: '+y' }]
    const ship: Ship = { id: 2, name: 'Test Skiff', scu: 6, containerSizes: [1, 2, 4, 8] }
    const legs: PlannerLeg[] = [
      { id: 'A', missionId: 'MA', commodity: 'Ore', scu: 2, maxBoxScu: 2, pickupId: 'S0', dropoffId: 'S3' },
      { id: 'B', missionId: 'MB', commodity: 'Gas', scu: 1, maxBoxScu: 1, pickupId: 'S1', dropoffId: 'S2' },
    ]
    const resolver = lineResolver(10)

    const cheap = optimizeRoute(legs, ship, resolver, { compartments: comp, alphaMilli: 0, deltaMilli: 0 })
    expect(cheap.feasible).toBe(true)
    expect(cheap.totalDistance).toBe(30) // S0,S1,S2,S3 — the distance optimum
    expect(cheap.handling!.totalG).toBe(2)

    const priced = optimizeRoute(legs, ship, resolver, { compartments: comp, alphaMilli: 0, deltaMilli: 20_000 })
    expect(priced.feasible).toBe(true)
    // F(pure-distance route) = 30 + 20·2 = 70; the planner must do strictly
    // better by trading distance for a scrape-free loading.
    const F = priced.totalDistance + (20_000 * priced.handling!.totalG) / 1000
    expect(F).toBeLessThan(70)
    expect(priced.totalDistance).toBeGreaterThan(30)
    expect(priced.handling!.totalG).toBeLessThanOrEqual(1)
    // Still a fully valid dig-free plan.
    expect(verifyWitness(priced.loadout!, comp)).toBe(true)
    expect(validateGeometry(priced.loadout!, comp).ok).toBe(true)
    expect(auditDigFree(priced.loadout!, comp)).toEqual({ ok: true })
  })
})
