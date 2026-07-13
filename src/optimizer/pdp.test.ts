import { describe, it, expect } from 'vitest'
import { optimizeRoute } from './pdp'
import type { PlannerLeg, OptimizeOptions } from './pdp'
import type { Ship } from '../domain/types'
import type { DistanceResolver } from './distanceMatrix'

// Line graph A-B-C-D, 10 Gm per hop.
const D: Record<string, number> = { 'A|B': 10, 'B|C': 10, 'C|D': 10, 'A|C': 20, 'B|D': 20, 'A|D': 30 }
const resolver: DistanceResolver = {
  between(a, b) {
    if (a === b) return { gm: 0, estimated: false, unreachable: false }
    const g = D[`${a}|${b}`] ?? D[`${b}|${a}`]
    return g === undefined
      ? { gm: 999, estimated: true, unreachable: true }
      : { gm: g, estimated: false, unreachable: false }
  },
}
const ship = (scu: number): Ship => ({ id: 1, name: 'Test', scu, containerSizes: [1, 2, 4, 8] })
const leg = (
  id: string, commodity: string, scu: number, pickupId: string, dropoffId: string,
): PlannerLeg => ({ id, missionId: 'm1', commodity, scu, pickupId, dropoffId })

const run = (legs: PlannerLeg[], scu: number, opts?: OptimizeOptions) =>
  optimizeRoute(legs, ship(scu), resolver, opts)

describe('route optimizer', () => {
  it('handles a single leg', () => {
    const plan = run([leg('l1', 'Ti', 5, 'A', 'B')], 100)
    expect(plan.feasible).toBe(true)
    expect(plan.stops.map((s) => s.locationId)).toEqual(['A', 'B'])
    expect(plan.totalDistance).toBe(10)
    expect(plan.stops[0].actions).toEqual([
      { kind: 'load', legId: 'l1', missionId: 'm1', commodity: 'Ti', scu: 5 },
    ])
    expect(plan.stops[1].loadAfter).toBe(0)
  })

  it('interleaves pickups/dropoffs so capacity is never exceeded', () => {
    // Two 6-SCU legs, hold of 10 -> cannot carry both at once.
    const legs = [leg('l1', 'Ti', 6, 'A', 'C'), leg('l2', 'Al', 6, 'B', 'D')]
    const plan = run(legs, 10)
    expect(plan.feasible).toBe(true)
    expect(Math.max(...plan.stops.map((s) => s.loadAfter))).toBeLessThanOrEqual(10)
    expect(plan.totalDistance).toBe(50) // A,C,B,D
    expect(plan.stops.map((s) => s.locationId)).toEqual(['A', 'C', 'B', 'D'])
  })

  it('consolidates multiple commodities at a shared location', () => {
    const legs = [leg('l1', 'Titanium', 4, 'A', 'C'), leg('l2', 'Aluminum', 3, 'A', 'C')]
    const plan = run(legs, 100)
    expect(plan.stops.map((s) => s.locationId)).toEqual(['A', 'C'])
    expect(plan.stops[0].actions.filter((a) => a.kind === 'load')).toHaveLength(2)
    expect(plan.stops[0].loadAfter).toBe(7)
    expect(plan.stops[1].loadAfter).toBe(0)
    expect(plan.totalDistance).toBe(20)
  })

  it('reports infeasible when pickups at one stop exceed capacity', () => {
    // Both legs picked up at A (6+6) but hold is 10, single visit -> infeasible.
    const legs = [leg('l1', 'Ti', 6, 'A', 'C'), leg('l2', 'Al', 6, 'A', 'D')]
    const plan = run(legs, 10)
    expect(plan.feasible).toBe(false)
    // Gridless ships have no revisit planner — the way out is drawing a grid.
    expect(plan.reason).toMatch(/Draw a cargo grid/)
  })

  it('rejects a leg larger than the hold', () => {
    const plan = run([leg('l1', 'Ti', 200, 'A', 'B')], 100)
    expect(plan.feasible).toBe(false)
    expect(plan.reason).toMatch(/exceeds/)
  })

  it('rejects a leg with identical pickup and dropoff', () => {
    const plan = run([leg('l1', 'Ti', 5, 'A', 'A')], 100)
    expect(plan.feasible).toBe(false)
    expect(plan.reason).toMatch(/same pickup and dropoff/)
  })

  it('rejects mission containers the ship cannot accept (UEX containerSizes)', () => {
    // Zeus-like: 32 SCU hold but accepts at most 16-SCU containers. A 32-SCU leg
    // at the default max container size decomposes to one 32-SCU box → infeasible.
    const zeus: Ship = { id: 3, name: 'Zeus ES', scu: 32, containerSizes: [1, 2, 4, 8, 16] }
    const plan = optimizeRoute([leg('l1', 'Ti', 32, 'A', 'B')], zeus, resolver)
    expect(plan.feasible).toBe(false)
    expect(plan.reason).toMatch(/accepts/)

    // Same cargo declared as 16-SCU containers is fine.
    const ok = optimizeRoute([{ ...leg('l1', 'Ti', 32, 'A', 'B'), maxBoxScu: 16 }], zeus, resolver)
    expect(ok.feasible).toBe(true)

    // Empty containerSizes = UEX has no data → unknown, never a rejection.
    const unknown: Ship = { id: 4, name: 'Hull D', scu: 100, containerSizes: [] }
    expect(optimizeRoute([leg('l1', 'Ti', 32, 'A', 'B')], unknown, resolver).feasible).toBe(true)
  })

  it('keeps exact solving correct past 32 distinct stops', () => {
    const chainResolver: DistanceResolver = {
      between(a, b) {
        const ai = Number(a.slice(1))
        const bi = Number(b.slice(1))
        return { gm: Math.abs(ai - bi), estimated: false, unreachable: false }
      },
    }
    const legs = Array.from({ length: 32 }, (_, i) =>
      ({ id: `l${i}`, missionId: 'm1', commodity: 'Ti', scu: 1, pickupId: `S${i}`, dropoffId: `S${i + 1}` }),
    )

    // exactLimit: Infinity — this test exercises the BigInt masks of the exact
    // solver past 32 stops (the chain topology keeps its frontier tiny).
    const plan = optimizeRoute(legs, ship(1), chainResolver, { exactLimit: Infinity })

    expect(plan.feasible).toBe(true)
    expect(plan.method).toBe('exact')
    expect(plan.stops.map((s) => s.locationId)).toEqual(Array.from({ length: 33 }, (_, i) => `S${i}`))
    expect(Math.max(...plan.stops.map((s) => s.loadAfter))).toBe(1)
    expect(plan.totalDistance).toBe(32)
  })

  it('falls back to the heuristic above the default exactLimit and stays fast', () => {
    // 12 independent legs = 24 distinct stops. With exact Held-Karp this instance
    // measures ~13s; the default limit must route it to the heuristic instead.
    const lineResolver: DistanceResolver = {
      between(a, b) {
        return a === b
          ? { gm: 0, estimated: false, unreachable: false }
          : { gm: Math.abs(Number(a.slice(1)) - Number(b.slice(1))), estimated: false, unreachable: false }
      },
    }
    const legs = Array.from({ length: 12 }, (_, i) =>
      ({ id: `l${i}`, missionId: 'm1', commodity: 'Ti', scu: 1, pickupId: `S${2 * i}`, dropoffId: `S${2 * i + 1}` }),
    )
    const t0 = Date.now()
    const plan = optimizeRoute(legs, ship(100), lineResolver)
    const ms = Date.now() - t0
    expect(plan.feasible).toBe(true)
    expect(plan.method).toBe('heuristic')
    expect(ms).toBeLessThan(2000)
    // Every leg still delivered.
    const delivered = new Set(plan.stops.flatMap((s) => s.actions.filter((a) => a.kind === 'unload').map((a) => a.legId)))
    expect(delivered.size).toBe(legs.length)
  })

  it('heuristic matches exact on the capacity case', () => {
    const legs = [leg('l1', 'Ti', 6, 'A', 'C'), leg('l2', 'Al', 6, 'B', 'D')]
    const exact = run(legs, 10, { exactLimit: 14 })
    const heur = run(legs, 10, { exactLimit: 0 })
    expect(heur.method).toBe('heuristic')
    expect(heur.feasible).toBe(true)
    expect(heur.totalDistance).toBe(exact.totalDistance)
  })

  it('empty input is a feasible empty plan', () => {
    const plan = run([], 100)
    expect(plan).toMatchObject({ feasible: true, stops: [], totalDistance: 0 })
  })
})
