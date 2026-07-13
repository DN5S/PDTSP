import { describe, expect, it } from 'vitest'
import type { RoutePlan, LoadoutBox } from '../domain/types'
import { routeSignature } from './routeProgress'

const plan: RoutePlan = {
  feasible: true,
  method: 'exact',
  algorithm: 'pdtsp',
  totalDistance: 216,
  estimatedLegs: 0,
  stops: [
    {
      locationId: 'baijini',
      legDistance: 0,
      estimated: false,
      loadAfter: 2160,
      actions: [{ kind: 'load', legId: 'waste', missionId: 'm1', commodity: 'WASTE', scu: 2160 }],
    },
    {
      locationId: 'ruin',
      legDistance: 99,
      estimated: false,
      loadAfter: 800,
      actions: [
        { kind: 'unload', legId: 'waste', missionId: 'm1', commodity: 'WASTE', scu: 2160 },
        { kind: 'load', legId: 'stim', missionId: 'm2', commodity: 'STIM', scu: 800 },
      ],
    },
    {
      locationId: 'levski',
      legDistance: 117,
      estimated: true,
      loadAfter: 0,
      actions: [{ kind: 'unload', legId: 'stim', missionId: 'm2', commodity: 'STIM', scu: 800 }],
    },
  ],
}

const clone = (p: RoutePlan): RoutePlan => JSON.parse(JSON.stringify(p)) as RoutePlan

describe('routeSignature', () => {
  it('pins the exact signature: stop list + ordered checklist steps', () => {
    expect(routeSignature(plan)).toBe(
      'baijini,ruin,levski' +
        '#0:load:m1:2160:waste.WASTE.2160' +
        '|1:unload:m1:2160:waste.WASTE.2160' +
        '|1:load:m2:800:stim.STIM.800' +
        '|2:unload:m2:800:stim.STIM.800',
    )
  })

  it('is empty for null and infeasible plans', () => {
    expect(routeSignature(null)).toBe('')
    expect(routeSignature({ ...clone(plan), feasible: false })).toBe('')
  })

  it('changes when an action scu, a stop order, or a location changes', () => {
    const sig = routeSignature(plan)

    const scuEdit = clone(plan)
    scuEdit.stops[0].actions[0].scu = 2000
    expect(routeSignature(scuEdit)).not.toBe(sig)

    const stopSwap = clone(plan)
    ;[stopSwap.stops[1], stopSwap.stops[2]] = [stopSwap.stops[2], stopSwap.stops[1]]
    expect(routeSignature(stopSwap)).not.toBe(sig)

    const locEdit = clone(plan)
    locEdit.stops[2].locationId = 'grim-hex'
    expect(routeSignature(locEdit)).not.toBe(sig)
  })

  it('distinguishes per-leg SCU recombinations within one mission step', () => {
    // Two legs of the same mission share pickup and dropoff; swapping their SCUs
    // keeps every per-step aggregate identical, so only per-action encoding can
    // tell the plans apart (progress must reset — the boxes differ).
    const mk = (scuA: number, scuB: number): RoutePlan => ({
      feasible: true,
      method: 'heuristic',
      algorithm: 'pdtsp',
      totalDistance: 10,
      estimatedLegs: 0,
      stops: [
        {
          locationId: 'a', legDistance: 0, estimated: false, loadAfter: scuA + scuB,
          actions: [
            { kind: 'load', legId: 'l1', missionId: 'm1', commodity: 'Ti', scu: scuA },
            { kind: 'load', legId: 'l2', missionId: 'm1', commodity: 'Ti', scu: scuB },
          ],
        },
        {
          locationId: 'b', legDistance: 10, estimated: false, loadAfter: 0,
          actions: [
            { kind: 'unload', legId: 'l1', missionId: 'm1', commodity: 'Ti', scu: scuA },
            { kind: 'unload', legId: 'l2', missionId: 'm1', commodity: 'Ti', scu: scuB },
          ],
        },
      ],
    })
    expect(routeSignature(mk(10, 20))).not.toBe(routeSignature(mk(20, 10)))
  })

  it('changes when a new witness reorders the load steps at a stop', () => {
    // Two missions load at stop 0; the checklist orders them bottom-of-hold first
    // from the witness. A grid edit that flips which mission sits at the bottom
    // must therefore produce a different signature (else kept progress would mark
    // the WRONG mission as loaded).
    const base: RoutePlan = {
      feasible: true,
      method: 'heuristic',
      algorithm: 'pdtsp',
      totalDistance: 10,
      estimatedLegs: 0,
      stops: [
        {
          locationId: 'a',
          legDistance: 0,
          estimated: false,
          loadAfter: 16,
          actions: [
            { kind: 'load', legId: 'l1', missionId: 'm1', commodity: 'Ti', scu: 8 },
            { kind: 'load', legId: 'l2', missionId: 'm2', commodity: 'Fe', scu: 8 },
          ],
        },
        {
          locationId: 'b',
          legDistance: 10,
          estimated: false,
          loadAfter: 8,
          actions: [{ kind: 'unload', legId: 'l1', missionId: 'm1', commodity: 'Ti', scu: 8 }],
        },
        {
          locationId: 'c',
          legDistance: 10,
          estimated: false,
          loadAfter: 0,
          actions: [{ kind: 'unload', legId: 'l2', missionId: 'm2', commodity: 'Fe', scu: 8 }],
        },
      ],
    }
    const box = (missionId: string, legId: string, z: number, deliverStop: number): LoadoutBox => ({
      id: `${legId}-0`, missionId, legId, commodity: 'Ti', scu: 8,
      pos: [0, 0, z], dims: [2, 2, 2], loadStop: 0, deliverStop,
    })
    const m1Bottom = clone(base)
    m1Bottom.loadout = [box('m1', 'l1', 0, 1), box('m2', 'l2', 2, 2)]
    const m2Bottom = clone(base)
    m2Bottom.loadout = [box('m1', 'l1', 2, 1), box('m2', 'l2', 0, 2)]
    expect(routeSignature(m1Bottom)).not.toBe(routeSignature(m2Bottom))
  })
})
