import { describe, it, expect } from 'vitest'
import { resolveBoxCell } from './gridSnap'
import type { Compartment } from '../ships/grids'

// Argo RAFT: single 8 x 12 x 2 bay -> bounds [8,12,2], ox=-4, oz=-6.
const RAFT: Compartment[] = [{ offset: [0, 0, 0], dims: [8, 12, 2] }]
const RAFT_BOUNDS: [number, number, number] = [8, 12, 2]

// Prowler: two 4x2x2 bays split by a gap at y=2 -> bounds [4,5,2], ox=-2, oz=-2.5.
const PROWLER: Compartment[] = [
  { offset: [0, 0, 0], dims: [4, 2, 2] },
  { offset: [0, 3, 0], dims: [4, 2, 2] },
]
const PROWLER_BOUNDS: [number, number, number] = [4, 5, 2]

describe('resolveBoxCell (box-based, compartment-aware)', () => {
  it('snaps an 8-SCU box centred in the grid to the right cell', () => {
    expect(resolveBoxCell(0, 0, [2, 2, 2], 8, RAFT, RAFT_BOUNDS, 0)).toEqual({ inGrid: true, pos: [3, 5, 0] })
  })

  it('clamps the footprint in-bounds instead of overflowing the right edge', () => {
    expect(resolveBoxCell(4, 0, [2, 2, 2], 8, RAFT, RAFT_BOUNDS, 0).pos[0]).toBe(6)
  })

  it('keeps a full-width box on-grid when dragged toward an edge', () => {
    const r = resolveBoxCell(3.5, 0, [8, 2, 2], 32, RAFT, RAFT_BOUNDS, 0)
    expect(r.inGrid).toBe(true)
    expect(r.pos[0]).toBe(0)
  })

  it('goes off-grid when the box centre leaves the footprint', () => {
    expect(resolveBoxCell(10, 0, [2, 2, 2], 8, RAFT, RAFT_BOUNDS, 0).inGrid).toBe(false)
    expect(resolveBoxCell(0, -9, [2, 2, 2], 8, RAFT, RAFT_BOUNDS, 0).inGrid).toBe(false)
  })

  it('preserves the height (z) cell', () => {
    expect(resolveBoxCell(0, 0, [2, 2, 2], 8, RAFT, RAFT_BOUNDS, 1).pos[2]).toBe(1)
  })

  it('never returns a negative min-corner near the front/left edge', () => {
    const r = resolveBoxCell(-3.9, -5.9, [2, 2, 2], 8, RAFT, RAFT_BOUNDS, 0)
    expect(r.pos[0]).toBeGreaterThanOrEqual(0)
    expect(r.pos[1]).toBeGreaterThanOrEqual(0)
  })

  it('treats the gap between Prowler bays as off-grid', () => {
    // Ship-space y = 2.5 is the gap between bay 0 (y0-2) and bay 1 (y3-5).
    expect(resolveBoxCell(0, 0, [2, 2, 2], 8, PROWLER, PROWLER_BOUNDS, 0).inGrid).toBe(false)
  })

  it('snaps into the rear Prowler bay (offset applied)', () => {
    // Ship-space y = 4 is inside bay 1 (offset y=3).
    const r = resolveBoxCell(0, 1.5, [2, 2, 2], 8, PROWLER, PROWLER_BOUNDS, 0)
    expect(r.inGrid).toBe(true)
    expect(r.pos[1]).toBeGreaterThanOrEqual(3)
  })

  it('treats a compartment as off-grid when the box exceeds its max size', () => {
    const restricted: Compartment[] = [{ offset: [0, 0, 0], dims: [5, 8, 1], maxBoxScu: 1 }]
    expect(resolveBoxCell(0, 0, [2, 2, 1], 4, restricted, [5, 8, 1], 0).inGrid).toBe(false)
    expect(resolveBoxCell(0, 0, [1, 1, 1], 1, restricted, [5, 8, 1], 0).inGrid).toBe(true)
  })
})
