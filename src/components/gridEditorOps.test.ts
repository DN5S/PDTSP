import { describe, it, expect } from 'vitest'
import { duplicateBay, duplicateLayout, freeSpotFor } from './gridEditorOps'
import type { Compartment } from '../ships/grids'

const bay = (
  offset: [number, number, number], dims: [number, number, number], extra: Partial<Compartment> = {},
): Compartment => ({ offset, dims, ...extra })

describe('grid editor bay duplication', () => {
  it('places the copy beside the source with a 1-cell gap', () => {
    const a = bay([0, 0, 0], [8, 2, 2], { blockingModel: 'vertical' })
    const out = duplicateBay([a], 0)
    expect(out).toHaveLength(2)
    expect(out[1].offset).toEqual([9, 0, 0])
    expect(out[1].dims).toEqual([8, 2, 2])
    expect(out[1].blockingModel).toBe('vertical')
    // Source untouched (fresh arrays, no shared references).
    expect(out[0].offset).toEqual([0, 0, 0])
    expect(out[1].offset).not.toBe(out[0].offset)
  })

  it('repeated duplication tiles a row, then wraps behind when the row is taken', () => {
    let comps = [bay([0, 0, 0], [4, 2, 2])]
    comps = duplicateBay(comps, 0) // beside: x=5
    comps = duplicateBay(comps, 0) // beside occupied -> behind: y=3
    expect(comps[1].offset).toEqual([5, 0, 0])
    expect(comps[2].offset).toEqual([0, 3, 0])
    // Every pair stays non-overlapping.
    const cells = new Set<string>()
    for (const c of comps)
      for (let z = c.offset[2]; z < c.offset[2] + c.dims[2]; z++)
        for (let y = c.offset[1]; y < c.offset[1] + c.dims[1]; y++)
          for (let x = c.offset[0]; x < c.offset[0] + c.dims[0]; x++) {
            const k = `${x},${y},${z}`
            expect(cells.has(k)).toBe(false)
            cells.add(k)
          }
  })

  it('falls back to a floor scan when beside and behind are both blocked', () => {
    const src = bay([0, 0, 0], [2, 2, 1])
    const blockers = [src, bay([3, 0, 0], [2, 2, 1]), bay([0, 3, 0], [2, 2, 1])]
    const spot = freeSpotFor(src, blockers)
    const copy = { ...src, offset: spot }
    for (const o of blockers) {
      const disjoint =
        copy.offset[0] + copy.dims[0] <= o.offset[0] || o.offset[0] + o.dims[0] <= copy.offset[0] ||
        copy.offset[1] + copy.dims[1] <= o.offset[1] || o.offset[1] + o.dims[1] <= copy.offset[1] ||
        copy.offset[2] + copy.dims[2] <= o.offset[2] || o.offset[2] + o.dims[2] <= copy.offset[2]
      expect(disjoint).toBe(true)
    }
  })

  it('duplicateLayout copies the whole set behind the current one (capacity x2)', () => {
    const set = [
      bay([0, 0, 0], [8, 2, 2], { blockingModel: 'vertical' }),
      bay([9, 0, 0], [8, 2, 2], { blockingModel: 'vertical' }),
      bay([0, 3, 0], [8, 2, 2], { blockingModel: 'vertical' }),
    ]
    const out = duplicateLayout(set)
    expect(out).toHaveLength(6)
    // Shifted by layout depth (y extent 5) + 1-cell gap = +6 on Y.
    expect(out[3].offset).toEqual([0, 6, 0])
    expect(out[4].offset).toEqual([9, 6, 0])
    expect(out[5].offset).toEqual([0, 9, 0])
    // No overlap between the two sets.
    for (const a of out.slice(0, 3))
      for (const b of out.slice(3))
        expect(
          a.offset[1] + a.dims[1] <= b.offset[1] || b.offset[1] + b.dims[1] <= a.offset[1],
        ).toBe(true)
  })
})
