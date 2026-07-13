import { describe, it, expect } from 'vitest'
import { optimizeRoute, type PlannerLeg } from './pdp'
import { buildRouteSteps, loadoutFromSteps } from './loadout'
import { SHIP_GRIDS, type Compartment } from '../ships/grids'
import type { RoutePlan, Ship } from '../domain/types'
import type { DistanceResolver } from './distanceMatrix'

// The 3D grid fills incrementally as the route checklist is worked: it starts
// empty, each checked LOAD step adds that cargo, each UNLOAD removes it, and no box
// is ever drawn floating (a box only shows once its support is also loaded).

type BoxLike = { id: string; pos: [number, number, number]; dims: [number, number, number] }

/** Box ids that sit above their bay floor without full support beneath — must be []. */
function floatingBoxes(boxes: BoxLike[], comps: Compartment[]): string[] {
  const floorZ = (b: BoxLike): number => {
    for (const c of comps) {
      if (
        b.pos[0] >= c.offset[0] && b.pos[0] + b.dims[0] <= c.offset[0] + c.dims[0] &&
        b.pos[1] >= c.offset[1] && b.pos[1] + b.dims[1] <= c.offset[1] + c.dims[1] &&
        b.pos[2] >= c.offset[2] && b.pos[2] + b.dims[2] <= c.offset[2] + c.dims[2]
      ) return c.offset[2]
    }
    return 0
  }
  const filled = new Set<string>()
  for (const b of boxes)
    for (let z = b.pos[2]; z < b.pos[2] + b.dims[2]; z++)
      for (let y = b.pos[1]; y < b.pos[1] + b.dims[1]; y++)
        for (let x = b.pos[0]; x < b.pos[0] + b.dims[0]; x++) filled.add(`${x},${y},${z}`)
  const bad: string[] = []
  for (const b of boxes) {
    if (b.pos[2] === floorZ(b)) continue
    let ok = true
    for (let y = b.pos[1]; y < b.pos[1] + b.dims[1] && ok; y++)
      for (let x = b.pos[0]; x < b.pos[0] + b.dims[0]; x++)
        if (!filled.has(`${x},${y},${b.pos[2] - 1}`)) { ok = false; break }
    if (!ok) bad.push(b.id)
  }
  return bad
}

function railen4Mission() {
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
  return { railen, legs, ship, resolver }
}

describe('incremental loadout (checklist fill)', () => {
  it('starts empty, fills per step with no floating boxes, ends empty', () => {
    const { railen, legs, ship, resolver } = railen4Mission()
    const plan = optimizeRoute(legs, ship, resolver, { compartments: railen, oracleNodeBudget: 200_000 })
    expect(plan.feasible).toBe(true)
    expect(plan.loadout).toBeDefined()

    const steps = buildRouteSteps(plan)
    const total = steps.length

    // Default: nothing checked -> empty grid.
    expect(loadoutFromSteps(plan, railen, 0).boxes).toHaveLength(0)

    // Every checklist prefix: nothing floats DURING loading — a float is legal
    // only mid-unload-session, for cargo that itself delivers at the current
    // step's stop (its support left in the same session). And whatever is
    // checked-but-unplaced is accounted for as deferred, not lost.
    for (let k = 0; k <= total; k++) {
      const lp = loadoutFromSteps(plan, railen, k)
      const currentStop = k > 0 ? steps[k - 1].stopIndex : -1
      const sameStopIds = new Set(
        lp.boxes.filter((b) => b.deliverStop === currentStop).map((b) => b.id),
      )
      for (const floater of floatingBoxes(lp.boxes, railen)) {
        expect(sameStopIds.has(floater)).toBe(true)
      }
      const checkedScu = steps
        .slice(0, k)
        .reduce((a, s) => a + (s.kind === 'load' ? s.scu : -s.scu), 0)
      expect(lp.usedScu + lp.deferred.reduce((a, b) => a + b.scu, 0)).toBe(checkedScu)
    }

    // Route complete: hold is empty again.
    expect(loadoutFromSteps(plan, railen, total).boxes).toHaveLength(0)

    // At the stop-0 boundary (all initial loads done) the closure hides nothing —
    // the full onboard witness is shown and nothing is left deferred.
    const stop0Steps = steps.filter((s) => s.stopIndex === 0).length
    const shown = loadoutFromSteps(plan, railen, stop0Steps)
    const witnessStop0 = plan.loadout!.filter((b) => b.loadStop === 0 && b.deliverStop > 0)
    expect(shown.boxes.length).toBe(witnessStop0.length)
    expect(shown.boxes.length).toBeGreaterThan(0)
    expect(shown.deferred).toHaveLength(0)
  })

  it('defers a box until its support loads, then keeps it placed through the unload session', () => {
    // Hand-crafted witness: M2 loads first but its top box rests on M1 cargo
    // that loads in the SECOND step (deferral), and everything delivers at the
    // SAME stop — where M1's unload is checked first, pulling the support out
    // from under the still-onboard M2 top box (sticky placement).
    const comps: Compartment[] = [{ offset: [0, 0, 0], dims: [2, 2, 2] }]
    const plan: RoutePlan = {
      stops: [
        {
          locationId: 'S0',
          actions: [
            { kind: 'load', legId: 'l2', missionId: 'M2', commodity: 'Waste', scu: 2 },
            { kind: 'load', legId: 'l1', missionId: 'M1', commodity: 'Ore', scu: 1 },
          ],
          loadAfter: 3,
          legDistance: 0,
          estimated: false,
        },
        {
          locationId: 'S1',
          actions: [
            { kind: 'unload', legId: 'l1', missionId: 'M1', commodity: 'Ore', scu: 1 },
            { kind: 'unload', legId: 'l2', missionId: 'M2', commodity: 'Waste', scu: 2 },
          ],
          loadAfter: 0,
          legDistance: 10,
          estimated: false,
        },
      ],
      totalDistance: 10,
      feasible: true,
      estimatedLegs: 0,
      method: 'heuristic',
      algorithm: 'pdtsp-l',
      loadout: [
        { id: 'm2-floor', missionId: 'M2', legId: 'l2', commodity: 'Waste', scu: 1, pos: [0, 0, 0], dims: [1, 1, 1], loadStop: 0, deliverStop: 1 },
        { id: 'm1-floor', missionId: 'M1', legId: 'l1', commodity: 'Ore', scu: 1, pos: [1, 0, 0], dims: [1, 1, 1], loadStop: 0, deliverStop: 1 },
        { id: 'm2-top', missionId: 'M2', legId: 'l2', commodity: 'Waste', scu: 1, pos: [1, 0, 1], dims: [1, 1, 1], loadStop: 0, deliverStop: 1 },
      ],
    }
    const steps = buildRouteSteps(plan)
    expect(steps[0]).toMatchObject({ kind: 'load', missionId: 'M2' })
    expect(steps[2]).toMatchObject({ kind: 'unload', missionId: 'M1' })

    // After step 1 (M2 checked): its floor box shows; its top box waits for
    // M1's support and must be reported as deferred (staging pad).
    const afterM2 = loadoutFromSteps(plan, comps, 1)
    expect(afterM2.boxes.map((b) => b.id)).toEqual(['m2-floor'])
    expect(afterM2.deferred.map((b) => b.id)).toEqual(['m2-top'])
    expect(afterM2.usedScu).toBe(1)

    // After step 2 (M1 checked): the support exists — nothing deferred.
    const afterM1 = loadoutFromSteps(plan, comps, 2)
    expect(afterM1.boxes.map((b) => b.id).sort()).toEqual(['m1-floor', 'm2-floor', 'm2-top'])
    expect(afterM1.deferred).toHaveLength(0)

    // After step 3 (unload M1 at the shared stop): m2-top lost its support but
    // is ABOUT TO BE UNLOADED here — it stays placed, and must NOT bounce back
    // to the staging pad.
    const midUnload = loadoutFromSteps(plan, comps, 3)
    expect(midUnload.boxes.map((b) => b.id).sort()).toEqual(['m2-floor', 'm2-top'])
    expect(midUnload.deferred).toHaveLength(0)

    // After the final unload: hold and pad are both empty.
    const done = loadoutFromSteps(plan, comps, 4)
    expect(done.boxes).toHaveLength(0)
    expect(done.deferred).toHaveLength(0)
  })
})
