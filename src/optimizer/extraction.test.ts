// Locks the view-side blocking model to the witnessAudit spec: vertical column
// clearance, vertical+depth resting + door-tunnel clearance, 'none' immunity,
// compartment isolation, and the stop-order unload simulation.

import { describe, expect, it } from 'vitest'
import { auditUnloadOrder, extractionBlockers, type CellBox } from './extraction'
import type { Compartment } from '../ships/grids'

const box = (id: string, pos: [number, number, number], dims: [number, number, number]): CellBox => ({
  id,
  pos,
  dims,
})

describe('extractionBlockers — vertical (top opening)', () => {
  const comps: Compartment[] = [{ offset: [0, 0, 0], dims: [4, 4, 4], blockingModel: 'vertical' }]

  it('blocks on cargo anywhere in the column above, even with an air gap', () => {
    const target = box('t', [0, 0, 0], [2, 2, 1])
    const floating = box('above', [0, 0, 3], [2, 2, 1]) // two layers up
    expect(extractionBlockers(target, [floating], comps)).toEqual(['above'])
  })

  it('ignores cargo beside the footprint', () => {
    const target = box('t', [0, 0, 0], [2, 2, 1])
    const beside = box('side', [2, 0, 1], [2, 2, 1])
    expect(extractionBlockers(target, [beside], comps)).toEqual([])
  })
})

describe('extractionBlockers — vertical+depth (horizontal door)', () => {
  const comps: Compartment[] = [
    { offset: [0, 0, 0], dims: [4, 6, 3], blockingModel: 'vertical+depth', openingAxis: '+y' },
  ]

  it('blocks on cargo resting directly on top', () => {
    const target = box('t', [0, 0, 0], [2, 2, 2])
    const resting = box('top', [0, 0, 2], [1, 1, 1])
    expect(extractionBlockers(target, [resting], comps)).toEqual(['top'])
  })

  it('blocks on cargo in the door tunnel at its own level', () => {
    const target = box('t', [0, 0, 0], [2, 2, 2])
    const inTunnel = box('tunnel', [0, 3, 0], [2, 2, 2])
    expect(extractionBlockers(target, [inTunnel], comps)).toEqual(['tunnel'])
  })

  it('ignores cargo behind the box or outside its lane', () => {
    const target = box('t', [0, 2, 0], [2, 2, 2])
    const behind = box('behind', [0, 0, 0], [2, 2, 2]) // away from the +y door
    const otherLane = box('lane', [2, 4, 0], [2, 2, 2]) // toward the door, different x lane
    expect(extractionBlockers(target, [behind, otherLane], comps)).toEqual([])
  })

  it('does not treat high cargo sharing the tunnel footprint as a tunnel blocker', () => {
    // Tunnel is checked at the target's own z-range only (slide model).
    const target = box('t', [0, 0, 0], [2, 2, 1])
    const highAhead = box('high', [0, 3, 1], [2, 2, 1]) // toward the door but above the slide level
    expect(extractionBlockers(target, [highAhead], comps)).toEqual([])
  })
})

describe('extractionBlockers — isolation rules', () => {
  it("'none' compartments never block", () => {
    const comps: Compartment[] = [{ offset: [0, 0, 0], dims: [4, 4, 4], blockingModel: 'none' }]
    const target = box('t', [0, 0, 0], [2, 2, 1])
    const above = box('a', [0, 0, 1], [2, 2, 1])
    expect(extractionBlockers(target, [above], comps)).toEqual([])
  })

  it('cargo in a different compartment never blocks', () => {
    const comps: Compartment[] = [
      { offset: [0, 0, 0], dims: [2, 2, 4], blockingModel: 'vertical' },
      { offset: [3, 0, 0], dims: [2, 2, 4], blockingModel: 'vertical' },
    ]
    const target = box('t', [0, 0, 0], [2, 2, 1])
    const otherBay = box('o', [3, 0, 1], [2, 2, 1])
    expect(extractionBlockers(target, [otherBay], comps)).toEqual([])
  })

  it('an off-grid target reports no blockers', () => {
    const comps: Compartment[] = [{ offset: [0, 0, 0], dims: [2, 2, 2], blockingModel: 'vertical' }]
    const target = box('t', [5, 5, 0], [1, 1, 1])
    expect(extractionBlockers(target, [box('a', [0, 0, 0], [1, 1, 1])], comps)).toEqual([])
  })
})

describe('auditUnloadOrder', () => {
  const comps: Compartment[] = [{ offset: [0, 0, 0], dims: [4, 4, 4], blockingModel: 'vertical' }]

  it('flags later-delivered cargo stacked on an earlier delivery', () => {
    const early = { ...box('early', [0, 0, 0], [2, 2, 1]), deliverStop: 1 }
    const late = { ...box('late', [0, 0, 1], [2, 2, 1]), deliverStop: 2 }
    expect(auditUnloadOrder([early, late], comps)).toEqual([
      { buriedId: 'early', deliverStop: 1, blockerIds: ['late'] },
    ])
  })

  it('accepts same-stop stacking and earlier-on-top ordering', () => {
    const sameA = { ...box('a', [0, 0, 0], [2, 2, 1]), deliverStop: 1 }
    const sameB = { ...box('b', [0, 0, 1], [2, 2, 1]), deliverStop: 1 }
    expect(auditUnloadOrder([sameA, sameB], comps)).toEqual([])

    const under = { ...box('u', [0, 0, 0], [2, 2, 1]), deliverStop: 3 }
    const onTopFirstOut = { ...box('f', [0, 0, 1], [2, 2, 1]), deliverStop: 1 }
    expect(auditUnloadOrder([under, onTopFirstOut], comps)).toEqual([])
  })
})
