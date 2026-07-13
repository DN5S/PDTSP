import { describe, it, expect } from 'vitest'
import { optimizeRoute } from './pdp'
import { optimizeRevisitRoute } from './pdpRevisit'
import { loadoutFromWitness } from './loadout'
import { verifyWitness } from './loadFeasibility'
import { validateGeometry, auditDigFree } from './witnessAudit'
import type { PlannerLeg } from './pdp'
import type { RoutePlan, Ship } from '../domain/types'
import type { Compartment } from '../ships/grids'
import type { DistanceResolver } from './distanceMatrix'

// At every stop, all unloads (deliveries) must be listed before any load (pickup).
const unloadsBeforeLoads = (plan: RoutePlan): boolean =>
  plan.stops.every((s) => {
    let sawLoad = false
    for (const a of s.actions) {
      if (a.kind === 'load') sawLoad = true
      else if (sawLoad) return false
    }
    return true
  })

const line: DistanceResolver = {
  between: (a, b) => (a === b ? { gm: 0, estimated: false, unreachable: false }
    : { gm: Math.abs(Number(a.slice(1)) - Number(b.slice(1))) * 10, estimated: false, unreachable: false }),
}
const ship = (scu: number): Ship => ({ id: 1, name: 'T', scu, containerSizes: [1, 2, 4, 8, 16, 32] })

describe('optimizeRoute with the hard-LIFO oracle gate (Phase 2)', () => {
  it('without compartments: behaviour unchanged, no loadout witness', () => {
    const legs: PlannerLeg[] = [
      { id: 'a', missionId: 'A', commodity: 'Ti', scu: 8, pickupId: 'S0', dropoffId: 'S1' },
      { id: 'b', missionId: 'B', commodity: 'Fe', scu: 8, pickupId: 'S0', dropoffId: 'S2' },
    ]
    const plan = optimizeRoute(legs, ship(100), line)
    expect(plan.feasible).toBe(true)
    expect(plan.method).toBe('exact')
    expect(plan.loadout).toBeUndefined()
  })

  it('with compartments: dig-free route + a clean loadout witness (shared pickup, reversed delivery)', () => {
    // Internal hold, 4 tall so cargo can stack. A delivered first, B far/last.
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [4, 2, 4] }]
    const legs: PlannerLeg[] = [
      { id: 'a', missionId: 'A', commodity: 'Ti', scu: 8, maxBoxScu: 8, pickupId: 'S0', dropoffId: 'S1' },
      { id: 'b', missionId: 'B', commodity: 'Fe', scu: 8, maxBoxScu: 8, pickupId: 'S0', dropoffId: 'S2' },
    ]
    const plan = optimizeRoute(legs, ship(100), line, { compartments: comp })
    expect(plan.feasible).toBe(true)
    expect(plan.method).toBe('heuristic')
    expect(plan.loadout).toBeDefined()
    expect(plan.loadout!.length).toBeGreaterThan(0)
    expect(verifyWitness(plan.loadout!, comp)).toBe(true)
    expect(validateGeometry(plan.loadout!, comp).ok).toBe(true)
    expect(auditDigFree(plan.loadout!, comp)).toEqual({ ok: true })
  })

  it('with compartments: a bigger multi-mission run stays dig-free', () => {
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [6, 4, 4] }] // 96 SCU
    const legs: PlannerLeg[] = [
      { id: 'a', missionId: 'A', commodity: 'Ti', scu: 16, maxBoxScu: 8, pickupId: 'S0', dropoffId: 'S1' },
      { id: 'b', missionId: 'B', commodity: 'Fe', scu: 16, maxBoxScu: 8, pickupId: 'S0', dropoffId: 'S2' },
      { id: 'c', missionId: 'C', commodity: 'Au', scu: 8, maxBoxScu: 8, pickupId: 'S0', dropoffId: 'S3' },
    ]
    const plan = optimizeRoute(legs, ship(200), line, { compartments: comp })
    expect(plan.feasible).toBe(true)
    expect(plan.loadout).toBeDefined()
    expect(verifyWitness(plan.loadout!, comp)).toBe(true)
    expect(validateGeometry(plan.loadout!, comp).ok).toBe(true)
    expect(auditDigFree(plan.loadout!, comp)).toEqual({ ok: true })
    // Every leg is delivered by the route.
    const delivered = new Set(plan.stops.flatMap((s) => s.actions.filter((a) => a.kind === 'unload').map((a) => a.legId)))
    expect(delivered.size).toBe(3)
  })

  it('capacity forces a double revisit (S0->S1->S0->S1) and it stays dig-free', () => {
    // 8-SCU hold, two 8-SCU legs both S0->S1 — only one fits at a time, so the
    // first must be delivered before the second is loaded: S0,S1,S0,S1.
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [2, 2, 2] }] // 8 SCU
    const legs: PlannerLeg[] = [
      { id: 'a', missionId: 'A', commodity: 'Ti', scu: 8, maxBoxScu: 8, pickupId: 'S0', dropoffId: 'S1' },
      { id: 'b', missionId: 'B', commodity: 'Fe', scu: 8, maxBoxScu: 8, pickupId: 'S0', dropoffId: 'S1' },
    ]
    const plan = optimizeRoute(legs, ship(8), line, { compartments: comp })
    expect(plan.feasible).toBe(true)
    expect(plan.revisits ?? 0).toBeGreaterThanOrEqual(2)
    expect(plan.loadout).toBeDefined()
    expect(verifyWitness(plan.loadout!, comp)).toBe(true)
    expect(validateGeometry(plan.loadout!, comp).ok).toBe(true)
    expect(auditDigFree(plan.loadout!, comp)).toEqual({ ok: true })
    expect(unloadsBeforeLoads(plan)).toBe(true)
  })

  it('revisit buildPlan lists unloads before loads at a shared stop', () => {
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [4, 2, 4] }]
    const legs: PlannerLeg[] = [
      { id: 'a', missionId: 'A', commodity: 'Ti', scu: 8, maxBoxScu: 8, pickupId: 'S0', dropoffId: 'S1' },
      { id: 'b', missionId: 'B', commodity: 'Fe', scu: 8, maxBoxScu: 8, pickupId: 'S1', dropoffId: 'S2' },
    ]
    // Route S0 -> S1 (deliver A, pick up B) -> S2. At S1 both happen.
    const plan = optimizeRevisitRoute(legs, ship(100), line, comp)
    expect(plan.feasible).toBe(true)
    const s1 = plan.stops.find((s) => s.locationId === 'S1')!
    expect(s1.actions[0].kind).toBe('unload') // A delivered before B loaded
    expect(unloadsBeforeLoads(plan)).toBe(true)
  })

  it('a user-authored grid larger than the UEX scu figure is honoured by the gates', () => {
    // Grid capacity (16) exceeds ship.scu (8) — geometry is authoritative, so both
    // legs ride together instead of being rejected by a stale-UEX pre-filter.
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [4, 2, 2] }] // 16 SCU
    const legs: PlannerLeg[] = [
      { id: 'a', missionId: 'A', commodity: 'Ti', scu: 8, maxBoxScu: 8, pickupId: 'S0', dropoffId: 'S1' },
      { id: 'b', missionId: 'B', commodity: 'Fe', scu: 8, maxBoxScu: 8, pickupId: 'S0', dropoffId: 'S1' },
    ]
    const plan = optimizeRoute(legs, ship(8), line, { compartments: comp })
    expect(plan.feasible).toBe(true)
    expect(plan.revisits ?? 0).toBe(0)
    expect(Math.max(...plan.stops.map((s) => s.loadAfter))).toBe(16)
  })

  it('a box that fits no compartment is honestly infeasible (never a diggy route)', () => {
    // 16-SCU leg decomposes to a [4,2,2] box; it fits no [2,2,4] compartment (width
    // 4 > 2). SCU (16) <= capacity (16), so it passes tooBig and reaches the oracle.
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [2, 2, 4] }]
    const legs: PlannerLeg[] = [
      { id: 'a', missionId: 'A', commodity: 'Ti', scu: 16, maxBoxScu: 16, pickupId: 'S0', dropoffId: 'S1' },
    ]
    const plan = optimizeRoute(legs, ship(16), line, { compartments: comp })
    expect(plan.feasible).toBe(false)
    expect(plan.reason).toMatch(/dig-free|hold|wider|larger/i)
  })

  it('loadoutFromWitness (app adapter) yields the onboard cargo at each stop', () => {
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [4, 2, 4] }]
    const legs: PlannerLeg[] = [
      { id: 'a', missionId: 'A', commodity: 'Ti', scu: 8, maxBoxScu: 8, pickupId: 'S0', dropoffId: 'S1' },
      { id: 'b', missionId: 'B', commodity: 'Fe', scu: 8, maxBoxScu: 8, pickupId: 'S0', dropoffId: 'S2' },
    ]
    const plan = optimizeRoute(legs, ship(100), line, { compartments: comp }) // route S0->S1->S2 (3 stops)
    expect(plan.feasible).toBe(true)
    expect(plan.loadout).toBeDefined()
    const at = (k: number) => loadoutFromWitness(plan.loadout!, comp, k)
    expect(at(0).boxes.length).toBe(0)            // nothing loaded yet
    expect(at(1).boxes.length).toBe(2)            // both aboard after the initial load
    expect(at(1).usedScu).toBe(16)
    expect(at(2).boxes.length).toBe(1)            // A delivered at S1, B still aboard
    expect(at(plan.stops.length).boxes.length).toBe(0) // route complete, hold empty
  })
})
