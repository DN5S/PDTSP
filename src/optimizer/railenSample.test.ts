import { describe, it, expect } from 'vitest'
import { oracle, verifyWitness, type OracleItem } from './loadFeasibility'
import { optimizeRoute, type PlannerLeg } from './pdp'
import { SHIP_GRIDS } from '../ships/grids'
import { decomposeToBoxes } from '../domain/cargo'
import { validateGeometry, auditDigFree } from './witnessAudit'
import type { Dims3 } from './packPrimitives'
import type { Ship } from '../domain/types'
import type { DistanceResolver } from './distanceMatrix'

// Real sample from the app: Railen (623/640 SCU peak), Pyro run, 5 missions.
// Stop order from the screenshot's optimized route (Ruin Station revisited):
//   0 Ruin Station (load M1,M2,M4,M5) | 1 Rat's Nest | 2 Starlight Service |
//   3 Checkmate | 4 Rod's Fuel 'N Supplies (load M3) | 5 Stanton Gateway (Pyro) |
//   6 Megumi Refueling | 7 Ruin Station (deliver M3).
const boxesOf = (scu: number): Dims3[] => decomposeToBoxes(scu, 8).map((b) => b.dims)
const leg = (legId: string, missionId: string, commodity: string, scu: number, loadStop: number, deliverStop: number): OracleItem =>
  ({ legId, missionId, commodity, scu, boxes: boxesOf(scu), loadStop, deliverStop })

const items: OracleItem[] = [
  leg('m1a', 'M1', 'Waste', 72, 0, 5), leg('m1b', 'M1', 'Waste', 67, 0, 2),
  leg('m2a', 'M2', 'Waste', 59, 0, 6), leg('m2b', 'M2', 'Waste', 41, 0, 1), leg('m2c', 'M2', 'Waste', 58, 0, 2),
  leg('m3a', 'M3', 'Potassium', 61, 4, 7),
  leg('m4a', 'M4', 'Waste', 43, 0, 3), leg('m4b', 'M4', 'Waste', 23, 0, 4), leg('m4c', 'M4', 'Waste', 94, 0, 5),
  leg('m5a', 'M5', 'Waste', 88, 0, 5), leg('m5b', 'M5', 'Waste', 78, 0, 2),
]

// Geometry + extraction audits live in witnessAudit.ts — implementation-independent
// of the oracle (cell sweeps re-derived from the domain spec, not blocks()).

describe('REAL SAMPLE: Railen 623/640 Pyro run', () => {
  it('is hard-LIFO feasible with a geometrically valid, dig-free loadout', () => {
    const railen = SHIP_GRIDS.find((g) => g.match === 'Railen')!.compartments
    const totalBoxes = items.reduce((a, i) => a + i.boxes.length, 0)
    const peak = items.filter((i) => i.loadStop === 0).reduce((a, i) => a + i.scu, 0)
    const t0 = Date.now()
    const v = oracle(items, railen)
    const ms = Date.now() - t0

    /* eslint-disable no-console */
    console.log(`\n=== Railen sample: ${items.length} legs, ${totalBoxes} boxes, peak ${peak}/640 SCU ===`)
    console.log(`oracle verdict: ${v.status}   (${ms} ms)`)
    expect(v.status).toBe('feasible')
    if (v.status !== 'feasible') return
    const lifoOk = verifyWitness(v.boxes, railen)
    const geo = validateGeometry(v.boxes, railen)
    const dig = auditDigFree(v.boxes, railen)
    console.log(`LIFO clean (verifyWitness): ${lifoOk}`)
    console.log(`geometry valid (no overlap/support): ${geo.ok}${geo.ok ? '' : ' — ' + geo.reason}`)
    console.log(`extraction audit (independent): ${dig.ok}${dig.ok ? '' : ' — ' + dig.reason}`)
    if (geo.ok) console.log('peak simultaneous per-pod SCU:',
      geo.peakPod.map((s: number, i: number) => `pod${i}=${s}/${railen[i].dims[0] * railen[i].dims[1] * railen[i].dims[2]}`).join('  '))
    console.log('')
    /* eslint-enable no-console */
    expect(lifoOk).toBe(true)
    expect(geo.ok).toBe(true)
    expect(dig).toEqual({ ok: true })
  })

  // End-to-end Phase 2: the non-revisit subset (M1,M2,M4,M5 — all picked up at Ruin
  // Station) run through optimizeRoute with the Railen grid. The full 5-mission run
  // needs a Ruin Station revisit (M3), which is Phase 3.
  it('Phase 2 end-to-end: optimizeRoute produces a dig-free route + loadout for the 4-mission subset', () => {
    const railen = SHIP_GRIDS.find((g) => g.match === 'Railen')!.compartments
    const loc = ['Ruin', 'Stanton Gateway', 'Starlight', 'Megumi', "Rat's Nest", 'Checkmate']
    const idx = (name: string) => `S${loc.indexOf(name)}`
    const resolver: DistanceResolver = {
      between: (a, b) => (a === b ? { gm: 0, estimated: false, unreachable: false }
        : { gm: Math.abs(Number(a.slice(1)) - Number(b.slice(1))) * 15, estimated: false, unreachable: false }),
    }
    const ship: Ship = { id: 1, name: 'Gatac Railen', scu: 640, containerSizes: [1, 2, 4, 8, 16, 32] }
    const L = (id: string, m: string, scu: number, from: string, to: string): PlannerLeg =>
      ({ id, missionId: m, commodity: 'Waste', scu, maxBoxScu: 8, pickupId: idx(from), dropoffId: idx(to) })
    const legs: PlannerLeg[] = [
      L('m1a', 'M1', 72, 'Ruin', 'Stanton Gateway'), L('m1b', 'M1', 67, 'Ruin', 'Starlight'),
      L('m2a', 'M2', 59, 'Ruin', 'Megumi'), L('m2b', 'M2', 41, 'Ruin', "Rat's Nest"), L('m2c', 'M2', 58, 'Ruin', 'Starlight'),
      L('m4a', 'M4', 43, 'Ruin', 'Checkmate'), L('m4c', 'M4', 94, 'Ruin', 'Stanton Gateway'),
      L('m5a', 'M5', 88, 'Ruin', 'Stanton Gateway'), L('m5b', 'M5', 78, 'Ruin', 'Starlight'),
    ]
    const plan = optimizeRoute(legs, ship, resolver, { compartments: railen, oracleNodeBudget: 200_000 })

    /* eslint-disable no-console */
    console.log(`\n=== Phase 2 end-to-end (Railen, 4-mission subset) ===`)
    console.log(`feasible: ${plan.feasible}  method: ${plan.method}  distance: ${plan.totalDistance} Gm  loadout boxes: ${plan.loadout?.length ?? 0}`)
    /* eslint-enable no-console */
    expect(plan.feasible).toBe(true)
    expect(plan.loadout).toBeDefined()
    expect(verifyWitness(plan.loadout!, railen)).toBe(true)
    expect(validateGeometry(plan.loadout!, railen).ok).toBe(true)
    expect(auditDigFree(plan.loadout!, railen)).toEqual({ ok: true })
    // All 9 legs delivered.
    const delivered = new Set(plan.stops.flatMap((s) => s.actions.filter((a) => a.kind === 'unload').map((a) => a.legId)))
    expect(delivered.size).toBe(legs.length)
  })

  // Phase 3: the FULL 5-mission run. M3 is picked up at Rod's Fuel and delivered
  // back at Ruin Station, which forces a Ruin Station revisit — impossible for a
  // single-visit route. The oracle-gated revisit search must still find a dig-free
  // route (revisits emerge from minimising distance under the constraints).
  it('Phase 3 end-to-end: full 5-mission run finds a dig-free route with the required revisit', () => {
    const railen = SHIP_GRIDS.find((g) => g.match === 'Railen')!.compartments
    const loc = ['Ruin', 'Stanton Gateway', 'Starlight', 'Megumi', "Rat's Nest", 'Checkmate', "Rod's Fuel"]
    const idx = (name: string) => `S${loc.indexOf(name)}`
    const resolver: DistanceResolver = {
      between: (a, b) => (a === b ? { gm: 0, estimated: false, unreachable: false }
        : { gm: Math.abs(Number(a.slice(1)) - Number(b.slice(1))) * 15, estimated: false, unreachable: false }),
    }
    const ship: Ship = { id: 1, name: 'Gatac Railen', scu: 640, containerSizes: [1, 2, 4, 8, 16, 32] }
    const L = (id: string, m: string, c: string, scu: number, from: string, to: string): PlannerLeg =>
      ({ id, missionId: m, commodity: c, scu, maxBoxScu: 8, pickupId: idx(from), dropoffId: idx(to) })
    const legs: PlannerLeg[] = [
      L('m1a', 'M1', 'Waste', 72, 'Ruin', 'Stanton Gateway'), L('m1b', 'M1', 'Waste', 67, 'Ruin', 'Starlight'),
      L('m2a', 'M2', 'Waste', 59, 'Ruin', 'Megumi'), L('m2b', 'M2', 'Waste', 41, 'Ruin', "Rat's Nest"), L('m2c', 'M2', 'Waste', 58, 'Ruin', 'Starlight'),
      L('m3a', 'M3', 'Potassium', 61, "Rod's Fuel", 'Ruin'),
      L('m4a', 'M4', 'Waste', 43, 'Ruin', 'Checkmate'), L('m4b', 'M4', 'Waste', 23, 'Ruin', "Rod's Fuel"), L('m4c', 'M4', 'Waste', 94, 'Ruin', 'Stanton Gateway'),
      L('m5a', 'M5', 'Waste', 88, 'Ruin', 'Stanton Gateway'), L('m5b', 'M5', 'Waste', 78, 'Ruin', 'Starlight'),
    ]
    const t0 = Date.now()
    const plan = optimizeRoute(legs, ship, resolver, { compartments: railen, oracleNodeBudget: 200_000, timeBudgetMs: 6000 })
    const ms = Date.now() - t0

    /* eslint-disable no-console */
    console.log(`\n=== Phase 3 end-to-end (Railen, full 5 missions) ===`)
    console.log(`feasible: ${plan.feasible}  algorithm: ${plan.algorithm}  distance: ${plan.totalDistance}  revisits: ${plan.revisits ?? 0}  stops: ${plan.stops.length}  (${ms} ms)`)
    if (!plan.feasible) console.log(`reason: ${plan.reason}`)
    /* eslint-enable no-console */
    expect(plan.feasible).toBe(true)
    expect(plan.revisits ?? 0).toBeGreaterThanOrEqual(1) // Ruin Station revisit is unavoidable
    expect(plan.loadout).toBeDefined()
    expect(verifyWitness(plan.loadout!, railen)).toBe(true)
    expect(validateGeometry(plan.loadout!, railen).ok).toBe(true)
    expect(auditDigFree(plan.loadout!, railen)).toEqual({ ok: true })
    const delivered = new Set(plan.stops.flatMap((s) => s.actions.filter((a) => a.kind === 'unload').map((a) => a.legId)))
    expect(delivered.size).toBe(legs.length)
  })
})
