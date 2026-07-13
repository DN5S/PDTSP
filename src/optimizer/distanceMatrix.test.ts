import { describe, it, expect } from 'vitest'
import { createDistanceResolver } from './distanceMatrix'
import type { Location, OrbitEdge } from '../domain/types'

const loc = (id: string, orbitId: number): Location => ({
  id,
  uexId: 0,
  type: 'station',
  name: id,
  fullName: id,
  orbitId,
  orbitName: '',
  systemId: 1,
  systemName: 'Test',
})

// Orbits: 1-2-3 in a line (10 each); orbit 4 isolated.
const edges: OrbitEdge[] = [
  { from: 1, to: 2, distance: 10 },
  { from: 2, to: 3, distance: 10 },
]
const locations = [loc('A', 1), loc('Ab', 1), loc('B', 2), loc('C', 3), loc('D', 4)]

describe('distance resolver', () => {
  const r = createDistanceResolver(locations, edges)

  it('returns 0 for locations sharing an orbit', () => {
    expect(r.between('A', 'Ab')).toEqual({ gm: 0, estimated: false, unreachable: false })
  })

  it('returns direct edge distance, not estimated', () => {
    expect(r.between('A', 'B')).toEqual({ gm: 10, estimated: false, unreachable: false })
  })

  it('fills multi-hop distance and marks it estimated', () => {
    expect(r.between('A', 'C')).toEqual({ gm: 20, estimated: true, unreachable: false })
  })

  it('prefers direct UEX distance even when a multi-hop path is shorter', () => {
    const resolver = createDistanceResolver(locations, [
      { from: 1, to: 2, distance: 10 },
      { from: 2, to: 3, distance: 10 },
      { from: 1, to: 3, distance: 30 },
    ])

    expect(resolver.between('A', 'C')).toEqual({ gm: 30, estimated: false, unreachable: false })
  })

  it('is symmetric', () => {
    expect(r.between('C', 'A').gm).toBe(20)
  })

  it('uses a finite penalty for disconnected orbits', () => {
    const d = r.between('A', 'D')
    expect(d.unreachable).toBe(true)
    expect(d.gm).toBe(60) // 3 x max finite (20)
  })
})

describe('bundled distance data', () => {
  it('every edge connects PUBLISHED orbits (no phantom nodes in the route graph)', async () => {
    const { orbits, orbitDistances } = await import('../data')
    const known = new Set(orbits.map((o) => o.id))
    const dangling = orbitDistances.filter((e) => !known.has(e.from) || !known.has(e.to))
    expect(dangling).toEqual([])
    expect(orbitDistances.length).toBeGreaterThan(500) // sanity: filter didn't nuke the dataset
  })
})
