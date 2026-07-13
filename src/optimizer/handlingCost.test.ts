import { describe, it, expect } from 'vitest'
import { handlingCost } from './handlingCost'
import type { Compartment } from '../ships/grids'
import type { LoadoutBox } from '../domain/types'

// The three calibration cases from the domain spec, verbatim:
//   - RAFT wall slide          → G = 0 (structure contact is free)
//   - flush two-lane neighbour → G > 0, small (the overlap scrapes once)
//   - aligned `101` tunnel     → G = 3 x door-depth (the "possible but brutal" price)

const box = (
  id: string, pos: [number, number, number], dims: [number, number, number],
  loadStop: number, deliverStop: number,
): LoadoutBox => ({
  id, missionId: id, legId: id, commodity: 'Waste',
  scu: dims[0] * dims[1] * dims[2], pos, dims, loadStop, deliverStop,
})

describe('handlingCost (L = slide length, G = lateral cargo exposure)', () => {
  it('RAFT wall slide: six 32-SCU drawers, G = 0 on every operation', () => {
    // RAFT bay [8,12,2], door +y. 32-SCU boxes span the full width and height —
    // their lateral faces only ever touch walls, floor and ceiling.
    const raft: Compartment[] = [{ offset: [0, 0, 0], dims: [8, 12, 2] }]
    const boxes: LoadoutBox[] = []
    for (let i = 0; i < 6; i++) {
      // Deepest delivered last (valid LIFO); all loaded together at stop 0.
      boxes.push(box(`b${i}`, [0, i * 2, 0], [8, 2, 2], 0, 6 - i))
    }
    const h = handlingCost(boxes, raft)
    expect(h.totalG).toBe(0)
    for (const b of h.perBox) {
      expect(b.load.G).toBe(0)
      expect(b.unload.G).toBe(0)
    }
    // L = door depth + own extent along the door axis.
    const deepest = h.perBox.find((b) => b.id === 'b0')!
    const atDoor = h.perBox.find((b) => b.id === 'b5')!
    expect(deepest.unload.L).toBe(10 + 2)
    expect(atDoor.unload.L).toBe(0 + 2)
  })

  it('flush neighbour: the second box scrapes past the first — G > 0 but small', () => {
    // Two-lane bay [2,3,1], door +y. A (1x2x1) sits deep in lane x=0; B (1x1x1)
    // loads at the NEXT stop into lane x=1 at the same depth — its slide passes
    // A's door-side cell once.
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [2, 3, 1], blockingModel: 'vertical+depth', openingAxis: '+y' }]
    const A = box('A', [0, 0, 0], [1, 2, 1], 0, 3)
    const B = box('B', [1, 0, 0], [1, 1, 1], 1, 2)
    const h = handlingCost([A, B], comp)
    const hB = h.perBox.find((b) => b.id === 'B')!
    const hA = h.perBox.find((b) => b.id === 'A')!
    expect(hB.load.G).toBe(1) // scrapes A once on the way in
    expect(hB.unload.G).toBe(1) // and once on the way out
    expect(hA.unload.G).toBe(0) // B is long gone when A leaves
    expect(hB.load.L).toBe(3) // depth 2 + own extent 1
  })

  it('same-stop load and unload colleagues are exempt from G measurement', () => {
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [2, 3, 1], blockingModel: 'vertical+depth', openingAxis: '+y' }]
    const A = box('A', [0, 0, 0], [1, 2, 1], 0, 2)
    const B = box('B', [1, 0, 0], [1, 1, 1], 0, 2)
    const h = handlingCost([A, B], comp)
    expect(h.totalG).toBe(0)
    for (const b of h.perBox) {
      expect(b.load.G).toBe(0)
      expect(b.unload.G).toBe(0)
    }
  })

  it("aligned `101` tunnel: G = 3 x door-depth per operation — priced, not forbidden", () => {
    // Bay [3,4,3], door +y. Two full slabs fill z=0..1; the top layer is
    // `1 0 1` — cargo columns left and right of an empty tunnel at x=1, z=2.
    // The probe box sits at the deep end of the tunnel: every slide step inside
    // touches cargo on 3 faces (left, right, below).
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [3, 4, 3], blockingModel: 'vertical+depth', openingAxis: '+y' }]
    const boxes = [
      box('slab0', [0, 0, 0], [3, 4, 1], 0, 9),
      box('slab1', [0, 0, 1], [3, 4, 1], 0, 9),
      box('colL', [0, 0, 2], [1, 4, 1], 0, 9),
      box('colR', [2, 0, 2], [1, 4, 1], 0, 9),
      box('probe', [1, 0, 2], [1, 1, 1], 1, 2),
    ]
    const h = handlingCost(boxes, comp)
    const probe = h.perBox.find((b) => b.id === 'probe')!
    const doorDepth = 3 // comp depth 4, box at y=0 with extent 1
    expect(probe.load.L).toBe(doorDepth + 1)
    expect(probe.load.G).toBe(3 * doorDepth)
    expect(probe.unload.G).toBe(3 * doorDepth)
  })

  it("'vertical' pods slide up: L runs to the rim, lateral cargo counts, structure does not", () => {
    // Pod [2,1,3]: probe (1x1x1) on the floor at x=0 with a 3-tall neighbour
    // column at x=1 — lifting the probe out scrapes the column for 2 steps
    // (positions z=1 and z=2), then it is clear of the rim.
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [2, 1, 3], blockingModel: 'vertical' }]
    const probe = box('probe', [0, 0, 0], [1, 1, 1], 1, 2)
    const col = box('col', [1, 0, 0], [1, 1, 3], 0, 3)
    const h = handlingCost([probe, col], comp)
    const p = h.perBox.find((b) => b.id === 'probe')!
    expect(p.unload.L).toBe(3) // 2 cells of headroom + own height 1
    expect(p.unload.G).toBe(2)
  })

  it("'none' compartments are free: L = 0, G = 0", () => {
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [2, 2, 2], blockingModel: 'none' }]
    const h = handlingCost([box('a', [0, 0, 0], [1, 1, 1], 0, 1)], comp)
    expect(h.totalL).toBe(0)
    expect(h.totalG).toBe(0)
  })
})
