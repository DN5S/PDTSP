// unionSurfaceGeometry: only exterior faces of the merged cell volume survive —
// touching boxes fuse into one silhouette (the whole point of the cluster
// overlays), and world mapping applies the grid offsets.

import { describe, expect, it } from 'vitest'
import { unionSurfaceGeometry } from './threeUtils'

const faceCount = (geometry: ReturnType<typeof unionSurfaceGeometry>) =>
  geometry.getAttribute('position').count / 6 // 2 triangles = 6 vertices per face

describe('unionSurfaceGeometry', () => {
  it('a single 1-cell box exposes 6 faces', () => {
    expect(faceCount(unionSurfaceGeometry([{ pos: [0, 0, 0], dims: [1, 1, 1] }], 0, 0))).toBe(6)
  })

  it('two touching cubes fuse: 10 faces, not 12', () => {
    const g = unionSurfaceGeometry(
      [
        { pos: [0, 0, 0], dims: [1, 1, 1] },
        { pos: [1, 0, 0], dims: [1, 1, 1] },
      ],
      0,
      0,
    )
    expect(faceCount(g)).toBe(10)
  })

  it('a 2x2x2 box equals eight fused unit cells', () => {
    const asOne = unionSurfaceGeometry([{ pos: [0, 0, 0], dims: [2, 2, 2] }], 0, 0)
    expect(faceCount(asOne)).toBe(24) // 6 sides x 4 exposed cell-faces

    const cells = []
    for (let z = 0; z < 2; z++)
      for (let y = 0; y < 2; y++)
        for (let x = 0; x < 2; x++) cells.push({ pos: [x, y, z] as [number, number, number], dims: [1, 1, 1] as [number, number, number] })
    expect(faceCount(unionSurfaceGeometry(cells, 0, 0))).toBe(24)
  })

  it('separated boxes keep separate silhouettes (face count adds up)', () => {
    const g = unionSurfaceGeometry(
      [
        { pos: [0, 0, 0], dims: [1, 1, 1] },
        { pos: [5, 0, 0], dims: [1, 1, 1] },
      ],
      0,
      0,
    )
    expect(faceCount(g)).toBe(12)
  })

  it('applies the world offsets to grid x/y', () => {
    const g = unionSurfaceGeometry([{ pos: [2, 3, 1], dims: [1, 1, 1] }], -10, -20)
    const pos = g.getAttribute('position')
    let minX = Infinity, minY = Infinity, minZ = Infinity
    for (let i = 0; i < pos.count; i++) {
      minX = Math.min(minX, pos.getX(i))
      minY = Math.min(minY, pos.getY(i))
      minZ = Math.min(minZ, pos.getZ(i))
    }
    expect([minX, minY, minZ]).toEqual([-8, 1, -17])
  })
})
