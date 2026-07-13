import { describe, it, expect } from 'vitest'
import { optimizeRoute, type PlannerLeg } from './pdp'
import { SHIP_GRIDS, gridCapacity, type Compartment } from '../ships/grids'
import { verifyWitness } from './loadFeasibility'
import { validateGeometry, auditDigFree } from './witnessAudit'
import type { Ship } from '../domain/types'
import type { DistanceResolver } from './distanceMatrix'

// A7′ opt-in split delivery: a leg the EMPTY ship cannot carry in one go is
// honestly infeasible under request atomicity; with the leg's allowSplit flag
// the planner splits it IN PREPROCESSING into the minimum number of atomic
// sub-legs. Guard: a leg the ship can carry whole is NEVER split — no
// "leave 1 SCU behind for convenience" degeneration.

const lineResolver: DistanceResolver = {
  between: (a, b) => (a === b ? { gm: 0, estimated: false, unreachable: false }
    : { gm: Math.abs(Number(a.slice(1)) - Number(b.slice(1))) * 10, estimated: false, unreachable: false }),
}
const mkShip = (name: string, scu: number): Ship => ({ id: 9, name, scu, containerSizes: [1, 2, 4, 8, 16, 32] })

describe("A7′ opt-in split delivery", () => {
  const raft = SHIP_GRIDS.find((g) => g.match === 'RAFT')!.compartments // 192 SCU
  const raftShip = mkShip('Argo RAFT', gridCapacity(raft))

  it('without the opt-in, an oversized leg is infeasible and the reason offers the split', () => {
    const legs: PlannerLeg[] = [
      { id: 'X', missionId: 'M', commodity: 'Ore', scu: 384, pickupId: 'S0', dropoffId: 'S1' },
    ]
    const plan = optimizeRoute(legs, raftShip, lineResolver, { compartments: raft })
    expect(plan.feasible).toBe(false)
    expect(plan.reason).toMatch(/exceeds/)
    expect(plan.reason).toMatch(/Allow split delivery/)
  })

  it('gridless ships: the oversized-leg reason points at drawing a cargo grid instead', () => {
    // Split needs the grid path (revisit planner + geometric chunk checks);
    // without a grid the way to unlock it is authoring one in the grid editor.
    const legs: PlannerLeg[] = [
      { id: 'X', missionId: 'M', commodity: 'Ore', scu: 384, pickupId: 'S0', dropoffId: 'S1', allowSplit: true },
    ]
    const plan = optimizeRoute(legs, mkShip('Gridless Hauler', 192), lineResolver)
    expect(plan.feasible).toBe(false)
    expect(plan.reason).toMatch(/exceeds/)
    expect(plan.reason).toMatch(/Draw a cargo grid/)
  })

  it('with the opt-in, 2x-capacity cargo becomes two atomic sub-legs — two full trips', () => {
    const legs: PlannerLeg[] = [
      { id: 'X', missionId: 'M', commodity: 'Ore', scu: 384, pickupId: 'S0', dropoffId: 'S1', allowSplit: true },
    ]
    const plan = optimizeRoute(legs, raftShip, lineResolver, { compartments: raft })
    expect(plan.feasible).toBe(true)
    // All 384 SCU delivered, in atomic sub-legs each within capacity.
    const unloads = plan.stops.flatMap((s) => s.actions.filter((a) => a.kind === 'unload'))
    expect(unloads.reduce((a, u) => a + u.scu, 0)).toBe(384)
    for (const u of unloads) expect(u.scu).toBeLessThanOrEqual(192)
    expect(new Set(unloads.map((u) => u.legId)).size).toBe(2) // minimum count: 2 trips
    for (const s of plan.stops) expect(s.loadAfter).toBeLessThanOrEqual(192)
    // The route physically shuttles: 4 stop visits (S0,S1,S0,S1), 2 revisits.
    expect(plan.stops).toHaveLength(4)
    // Witness stays fully audited.
    expect(plan.loadout).toBeDefined()
    expect(verifyWitness(plan.loadout!, raft)).toBe(true)
    expect(validateGeometry(plan.loadout!, raft).ok).toBe(true)
    expect(auditDigFree(plan.loadout!, raft)).toEqual({ ok: true })
  })

  it('the spec example: a 64-SCU ship with 128 SCU of cargo makes exactly 2 round trips', () => {
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [4, 4, 4] }] // 64 SCU
    const ship = mkShip('Test Freighter', 64)
    const legs: PlannerLeg[] = [
      // 8-SCU containers ([2,2,2]) — 32-SCU ones ([8,2,2]) would not fit a 4x4x4 hold at all.
      { id: 'X', missionId: 'M', commodity: 'Ore', scu: 128, maxBoxScu: 8, pickupId: 'S0', dropoffId: 'S1', allowSplit: true },
    ]
    const plan = optimizeRoute(legs, ship, lineResolver, { compartments: comp })
    expect(plan.feasible).toBe(true)
    const unloads = plan.stops.flatMap((s) => s.actions.filter((a) => a.kind === 'unload'))
    expect(unloads.map((u) => u.scu).sort((a, b) => a - b)).toEqual([64, 64])
  })

  it('also splits a capacity-under leg when empty-grid geometry cannot carry it whole', () => {
    // Capacity is 12 SCU, but [3,2,2] cannot hold an 8-SCU [2,2,2] box and a
    // 4-SCU [2,2,1] box at the same time. Each chunk fits the empty hold.
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [3, 2, 2] }]
    const ship = mkShip('Fragmented Test Hold', 12)
    const legs: PlannerLeg[] = [
      { id: 'X', missionId: 'M', commodity: 'Ore', scu: 12, maxBoxScu: 8, pickupId: 'S0', dropoffId: 'S1', allowSplit: true },
    ]
    const plan = optimizeRoute(legs, ship, lineResolver, { compartments: comp })
    expect(plan.feasible).toBe(true)
    const unloads = plan.stops.flatMap((s) => s.actions.filter((a) => a.kind === 'unload'))
    expect(unloads.map((u) => u.scu).sort((a, b) => a - b)).toEqual([4, 8])
    expect(new Set(unloads.map((u) => u.legId)).size).toBe(2)
    // The split chunks are not co-loaded just because their total SCU equals capacity.
    expect(Math.max(...plan.stops.map((s) => s.loadAfter))).toBe(8)
    expect(plan.stops.map((s) => s.locationId)).toEqual(['S0', 'S1', 'S0', 'S1'])
    expect(plan.loadout).toBeDefined()
    expect(verifyWitness(plan.loadout!, comp)).toBe(true)
    expect(validateGeometry(plan.loadout!, comp).ok).toBe(true)
    expect(auditDigFree(plan.loadout!, comp)).toEqual({ ok: true })
  })

  it('guard: a leg the ship carries whole is never split, even when opted in', () => {
    const legs: PlannerLeg[] = [
      { id: 'X', missionId: 'M', commodity: 'Ore', scu: 192, pickupId: 'S0', dropoffId: 'S1', allowSplit: true },
    ]
    const plan = optimizeRoute(legs, raftShip, lineResolver, { compartments: raft })
    expect(plan.feasible).toBe(true)
    const unloads = plan.stops.flatMap((s) => s.actions.filter((a) => a.kind === 'unload'))
    expect(unloads).toHaveLength(1)
    expect(unloads[0].legId).toBe('X') // original id — untouched, no '#k' sub-legs
    expect(plan.stops).toHaveLength(2) // one trip
  })

  it('split delivery still cannot conjure room for an indivisible container', () => {
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [2, 2, 2] }] // 8 SCU
    const ship = mkShip('Tiny', 8)
    const legs: PlannerLeg[] = [
      // 16-SCU containers ([4,2,2]) can never fit an 8-SCU hold, split or not.
      { id: 'X', missionId: 'M', commodity: 'Ore', scu: 32, maxBoxScu: 16, pickupId: 'S0', dropoffId: 'S1', allowSplit: true },
    ]
    const plan = optimizeRoute(legs, ship, lineResolver, { compartments: comp })
    expect(plan.feasible).toBe(false)
    expect(plan.reason).toMatch(/16-SCU container/)
  })
})
