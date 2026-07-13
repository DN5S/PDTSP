import { describe, it, expect } from 'vitest'
import { oracle, feasibilityForRoute, verifyWitness, type OracleItem } from './loadFeasibility'
import { optimizeRoute } from './pdp'
import { SHIP_GRIDS, type Compartment } from '../ships/grids'
import type { Dims3 } from './packPrimitives'
import type { PlannerLeg } from './pdp'
import type { Ship } from '../domain/types'
import type { DistanceResolver } from './distanceMatrix'

const mk = (legId: string, loadStop: number, deliverStop: number, boxes: Dims3[]): OracleItem => ({
  legId, missionId: legId, commodity: 'X',
  scu: boxes.reduce((a, b) => a + b[0] * b[1] * b[2], 0),
  boxes, loadStop, deliverStop,
})
const B8: Dims3 = [2, 2, 2] // 8-SCU box
const B1: Dims3 = [1, 1, 1] // 1-SCU box

describe('loadFeasibility oracle', () => {
  it('lane separation: two missions in a height-2 hold pack side by side, earlier delivery toward the door', () => {
    // [4,2,2] holds two 8-SCU boxes side by side (single layer). Door defaults to +x.
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [4, 2, 2] }]
    const A = mk('a', 0, 1, [B8]) // delivered first
    const B = mk('b', 0, 2, [B8]) // delivered second
    const v = oracle([A, B], comp)
    expect(v.status).toBe('feasible')
    if (v.status !== 'feasible') return
    expect(verifyWitness(v.boxes, comp)).toBe(true)
    // Depth-awareness: A (delivered first) must sit toward the +x opening (higher x) than B.
    const boxA = v.boxes.find((b) => b.legId === 'a')!
    const boxB = v.boxes.find((b) => b.legId === 'b')!
    expect(boxA.pos[0]).toBeGreaterThan(boxB.pos[0])
  })

  it('buried vertical box (gravity-forced) is infeasible-proven', () => {
    // Single 1x1x2 column. A loaded first (→ floor), B loaded later and delivered
    // later ends up on top of A → blocks A's earlier extraction. No escape.
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [1, 1, 2] }]
    const A = mk('a', 0, 2, [B1])
    const B = mk('b', 1, 3, [B1])
    const v = oracle([A, B], comp)
    expect(v.status).toBe('infeasible-proven')
  })

  it('correct LIFO stack: earlier-delivery on top is feasible', () => {
    // Same column, both loaded together. Oracle must put B (later delivery) on the
    // floor and A (earlier delivery) on top.
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [1, 1, 2] }]
    const A = mk('a', 0, 1, [B1]) // delivered first → must end up on top
    const B = mk('b', 0, 2, [B1])
    const v = oracle([A, B], comp)
    expect(v.status).toBe('feasible')
    if (v.status !== 'feasible') return
    expect(verifyWitness(v.boxes, comp)).toBe(true)
    const boxA = v.boxes.find((b) => b.legId === 'a')!
    const boxB = v.boxes.find((b) => b.legId === 'b')!
    expect(boxA.pos[2]).toBeGreaterThan(boxB.pos[2]) // A above B
  })

  it("'none' compartment ignores LIFO — the buried order is feasible", () => {
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [1, 1, 2], blockingModel: 'none' }]
    const A = mk('a', 0, 2, [B1])
    const B = mk('b', 1, 3, [B1])
    const v = oracle([A, B], comp)
    expect(v.status).toBe('feasible')
  })

  // --- insertion-side corridor (the other half of the blocking-interval condition) ---
  // Extraction has always been enforced; these pin the INSERTION path: a box loaded
  // mid-route must be able to slide IN past cargo already onboard.

  it('insertion corridor: cargo loaded earlier and parked door-side rejects the only LIFO-valid placement — infeasible', () => {
    // Single lane [1,2,1], door +y. A: load 0, deliver 2. B: load 1, deliver 3.
    // Extraction (A first) forces B deeper than A; insertion of B at stop 1 must
    // slide past A. A deep → B has no deeper cell; A at the door → B's way in is
    // blocked. Every branch dies — the oracle must PROVE it, not pack it.
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [1, 2, 1], blockingModel: 'vertical+depth', openingAxis: '+y' }]
    const A = mk('a', 0, 2, [B1])
    const B = mk('b', 1, 3, [B1])
    const v = oracle([A, B], comp)
    expect(v.status).toBe('infeasible-proven')
  })

  it('insertion corridor: swapping the delivery order makes the same cargo feasible (B door-side, clear way in)', () => {
    // Same lane and load stops, deliveries swapped: A: load 0, deliver 3. B: load 1,
    // deliver 2. A settles deep, B slides in at the door and comes off first.
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [1, 2, 1], blockingModel: 'vertical+depth', openingAxis: '+y' }]
    const A = mk('a', 0, 3, [B1])
    const B = mk('b', 1, 2, [B1])
    const v = oracle([A, B], comp)
    expect(v.status).toBe('feasible')
    if (v.status !== 'feasible') return
    expect(verifyWitness(v.boxes, comp)).toBe(true)
    const boxA = v.boxes.find((b) => b.legId === 'a')!
    const boxB = v.boxes.find((b) => b.legId === 'b')!
    expect(boxB.pos[1]).toBeGreaterThan(boxA.pos[1]) // B toward the +y door
  })

  it('capacity overflow is a proven global certificate', () => {
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [2, 2, 2] }] // 8 SCU
    const A = mk('a', 0, 1, [B8])
    const B = mk('b', 0, 1, [B8]) // 16 SCU peak > 8
    const v = oracle([A, B], comp)
    expect(v.status).toBe('infeasible-proven')
    if (v.status === 'infeasible-proven') expect(v.reason).toMatch(/capacity/)
  })

  it('budget exhaustion returns unknown-budget, not infeasible', () => {
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [4, 4, 4] }]
    const items = [
      mk('a', 0, 4, [B8]), mk('b', 0, 5, [B8]), mk('c', 0, 6, [B8]), mk('d', 0, 7, [B8]),
    ]
    const v = oracle(items, comp, { nodeBudget: 2 })
    expect(v.status).toBe('unknown-budget')
  })

  it('integration: a real route on the Ironclad is feasible with a clean witness', () => {
    const iron = SHIP_GRIDS.find((g) => g.match === 'Ironclad Assault')!.compartments
    const line: DistanceResolver = {
      between: (a, b) => (a === b ? { gm: 0, estimated: false, unreachable: false }
        : { gm: Math.abs(Number(a.slice(1)) - Number(b.slice(1))) * 10, estimated: false, unreachable: false }),
    }
    const ship: Ship = { id: 1, name: 'Drake Ironclad Assault', scu: 1440, containerSizes: [1, 2, 4, 8, 16, 32] }
    const legs: PlannerLeg[] = [
      { id: 'l0', missionId: 'm0', commodity: 'Ti', scu: 32, pickupId: 'S0', dropoffId: 'S1' },
      { id: 'l1', missionId: 'm1', commodity: 'Fe', scu: 64, pickupId: 'S0', dropoffId: 'S2' },
      { id: 'l2', missionId: 'm2', commodity: 'Au', scu: 32, pickupId: 'S0', dropoffId: 'S3' },
    ]
    const plan = optimizeRoute(legs, ship, line)
    const v = feasibilityForRoute(legs, plan, iron)
    expect(v.status).toBe('feasible')
    if (v.status === 'feasible') expect(verifyWitness(v.boxes, iron)).toBe(true)
  })

  // Regression: a box that must rest on smaller boxes loaded WITH it. The heuristic
  // order places the big box first (support fails); the batch search must try other
  // orders rather than declaring the (feasible) pack proven-impossible.
  it('support ordering: a big box resting on smaller same-batch boxes is feasible, not proven-infeasible', () => {
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [4, 3, 2], blockingModel: 'vertical' }]
    const items = [
      mk('a', 0, 1, [[4, 1, 1]]), mk('b', 0, 1, [[1, 1, 1]]), mk('c', 0, 1, [[1, 1, 1]]),
      mk('d', 0, 1, [[4, 1, 2]]), mk('e', 0, 1, [[2, 2, 1]]),
    ]
    const v = oracle(items, comp)
    expect(v.status).toBe('feasible')
    if (v.status === 'feasible') expect(verifyWitness(v.boxes, comp)).toBe(true)
  })

  // Regression: a box loaded at the SAME stop an earlier box is delivered must not be
  // treated as blocking it (unload precedes load at a stop) — verifyWitness must agree.
  it('verifyWitness: same-stop-loaded box does not block the box coming off at that stop', () => {
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [2, 1, 2], blockingModel: 'vertical+depth', openingAxis: '+x' }]
    const i0 = mk('i0', 0, 1, [[1, 1, 1], [2, 1, 1]])
    const i1 = mk('i1', 1, 2, [[1, 1, 2], [1, 1, 2]])
    const v = oracle([i0, i1], comp)
    expect(v.status).toBe('feasible')
    if (v.status === 'feasible') expect(verifyWitness(v.boxes, comp)).toBe(true)
  })
})
