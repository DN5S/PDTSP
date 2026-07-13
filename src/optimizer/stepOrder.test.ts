import { describe, it, expect } from 'vitest'
import { computeOpOrder } from './stepOrder'
import { buildRouteSteps } from './loadout'
import type { Compartment } from '../ships/grids'
import type { LoadoutBox, RoutePlan } from '../domain/types'

const box = (
  id: string, missionId: string, legId: string,
  pos: [number, number, number], dims: [number, number, number],
  loadStop: number, deliverStop: number,
): LoadoutBox => ({
  id, missionId, legId, commodity: 'Waste',
  scu: dims[0] * dims[1] * dims[2], pos, dims, loadStop, deliverStop,
})

describe('computeOpOrder (topological checklist order)', () => {
  it('covers every box exactly once per kind, unloads before loads at each stop', () => {
    const comps: Compartment[] = [{ offset: [0, 0, 0], dims: [2, 4, 2], blockingModel: 'vertical+depth', openingAxis: '+y' }]
    const boxes = [
      box('a-0', 'M1', 'a', [0, 0, 0], [1, 1, 1], 0, 2),
      box('b-0', 'M2', 'b', [0, 1, 0], [1, 1, 1], 0, 1),
      box('c-0', 'M3', 'c', [1, 0, 0], [1, 2, 1], 1, 2),
    ]
    const ops = computeOpOrder(boxes, comps)
    expect(ops).toHaveLength(boxes.length * 2)
    const stopOf = (op: { kind: string; boxId: string }) => {
      const b = boxes.find((x) => x.id === op.boxId)!
      return op.kind === 'load' ? b.loadStop : b.deliverStop
    }
    // Ops are grouped by ascending stop, unloads before loads within a stop.
    let prevStop = -1
    let prevRank = 0 // unload=0, load=1
    for (const op of ops) {
      const s = stopOf(op)
      const rank = op.kind === 'unload' ? 0 : 1
      expect(s > prevStop || (s === prevStop && rank >= prevRank)).toBe(true)
      prevStop = s
      prevRank = rank
    }
    // Every box appears exactly once per kind.
    const loads = ops.filter((o) => o.kind === 'load').map((o) => o.boxId).sort()
    const unloads = ops.filter((o) => o.kind === 'unload').map((o) => o.boxId).sort()
    expect(loads).toEqual(['a-0', 'b-0', 'c-0'])
    expect(unloads).toEqual(['a-0', 'b-0', 'c-0'])
  })

  it('horizontal door: loads go deep first, unloads come off door-side first', () => {
    // One lane [1,3,1], door +y. Deep box stays onboard longest.
    const comps: Compartment[] = [{ offset: [0, 0, 0], dims: [1, 3, 1], blockingModel: 'vertical+depth', openingAxis: '+y' }]
    const boxes = [
      box('door-0', 'M1', 'door', [0, 2, 0], [1, 1, 1], 0, 1),
      box('mid-0', 'M2', 'mid', [0, 1, 0], [1, 1, 1], 0, 2),
      box('deep-0', 'M3', 'deep', [0, 0, 0], [1, 1, 1], 0, 3),
    ]
    const ops = computeOpOrder(boxes, comps)
    const loadIds = ops.filter((o) => o.kind === 'load').map((o) => o.boxId)
    expect(loadIds).toEqual(['deep-0', 'mid-0', 'door-0'])
    // Unloads happen at distinct stops here, in delivery order — door-side first
    // by construction of the (valid) witness.
    const unloadIds = ops.filter((o) => o.kind === 'unload').map((o) => o.boxId)
    expect(unloadIds).toEqual(['door-0', 'mid-0', 'deep-0'])
  })

  it('same-stop unload set comes off blockers-first (top before bottom in a pod)', () => {
    // Vertical pod, both boxes delivered at the SAME stop, stacked: the top box
    // must be listed before the one it rests on.
    const comps: Compartment[] = [{ offset: [0, 0, 0], dims: [1, 1, 2], blockingModel: 'vertical' }]
    const boxes = [
      box('bottom-0', 'M1', 'bottom', [0, 0, 0], [1, 1, 1], 0, 1),
      box('top-0', 'M2', 'top', [0, 0, 1], [1, 1, 1], 0, 1),
    ]
    const ops = computeOpOrder(boxes, comps)
    const unloadIds = ops.filter((o) => o.kind === 'unload').map((o) => o.boxId)
    expect(unloadIds).toEqual(['top-0', 'bottom-0'])
    // And the loads, symmetrically, bottom first.
    const loadIds = ops.filter((o) => o.kind === 'load').map((o) => o.boxId)
    expect(loadIds).toEqual(['bottom-0', 'top-0'])
  })

  it('leg-level cycle interleaves: a mission split across steps where legs mutually obstruct', () => {
    // One pod column of three: M1 bottom, M5 middle, M1 top. At leg level M1 ⊥ M5
    // AND M5 ⊥ M1 (mutual) — no leg-atomic order works, the checklist must go
    // M1(bottom), M5(middle), M1(top).
    const comps: Compartment[] = [{ offset: [0, 0, 0], dims: [1, 1, 3], blockingModel: 'vertical' }]
    const boxes = [
      box('m1a-0', 'M1', 'm1a', [0, 0, 0], [1, 1, 1], 0, 1),
      box('m5a-0', 'M5', 'm5a', [0, 0, 1], [1, 1, 1], 0, 1),
      box('m1a-1', 'M1', 'm1a', [0, 0, 2], [1, 1, 1], 0, 1),
    ]
    const ops = computeOpOrder(boxes, comps)
    const loadIds = ops.filter((o) => o.kind === 'load').map((o) => o.boxId)
    expect(loadIds).toEqual(['m1a-0', 'm5a-0', 'm1a-1'])

    // buildRouteSteps splits M1 into two steps around M5, each step carrying its
    // exact boxes with per-step SCU (no double count).
    const plan: RoutePlan = {
      stops: [
        {
          locationId: 'S0', legDistance: 0, estimated: false, loadAfter: 3,
          actions: [
            { kind: 'load', legId: 'm1a', missionId: 'M1', commodity: 'Waste', scu: 2 },
            { kind: 'load', legId: 'm5a', missionId: 'M5', commodity: 'Waste', scu: 1 },
          ],
        },
        {
          locationId: 'S1', legDistance: 5, estimated: false, loadAfter: 0,
          actions: [
            { kind: 'unload', legId: 'm1a', missionId: 'M1', commodity: 'Waste', scu: 2 },
            { kind: 'unload', legId: 'm5a', missionId: 'M5', commodity: 'Waste', scu: 1 },
          ],
        },
      ],
      totalDistance: 5, feasible: true, estimatedLegs: 0, method: 'heuristic', algorithm: 'pdtsp',
      loadout: boxes, opOrder: ops,
    }
    const steps = buildRouteSteps(plan)
    const loadSteps = steps.filter((s) => s.kind === 'load')
    expect(loadSteps.map((s) => s.missionId)).toEqual(['M1', 'M5', 'M1'])
    expect(loadSteps.map((s) => s.scu)).toEqual([1, 1, 1])
    expect(loadSteps.map((s) => s.boxIds)).toEqual([['m1a-0'], ['m5a-0'], ['m1a-1']])
    // Total SCU across steps equals the witness total exactly once.
    expect(loadSteps.reduce((a, s) => a + s.scu, 0)).toBe(3)
  })

  it('is deterministic: same witness in, same op order out', () => {
    const comps: Compartment[] = [
      { offset: [0, 0, 0], dims: [2, 4, 2], blockingModel: 'vertical+depth', openingAxis: '-y' },
      { offset: [3, 0, 0], dims: [2, 2, 2], blockingModel: 'vertical' },
    ]
    const boxes = [
      box('a-0', 'M1', 'a', [0, 3, 0], [1, 1, 1], 0, 2),
      box('a-1', 'M1', 'a', [0, 2, 0], [1, 1, 2], 0, 2),
      box('b-0', 'M2', 'b', [1, 3, 0], [1, 1, 1], 0, 1),
      box('c-0', 'M3', 'c', [3, 0, 0], [2, 2, 1], 0, 1),
      box('d-0', 'M4', 'd', [4, 0, 0], [1, 1, 1], 1, 2),
    ]
    const once = computeOpOrder(boxes, comps)
    const twice = computeOpOrder([...boxes].reverse(), comps)
    expect(twice).toEqual(once)
  })
})
