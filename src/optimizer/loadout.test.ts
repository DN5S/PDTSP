import { describe, it, expect } from 'vitest'
import { missionColor } from './loadout'
import { getGridForShip, gridCapacity } from '../ships/grids'

describe('loadout display helpers', () => {
  it('keeps the first ten mission colors distinct', () => {
    const colors = Array.from({ length: 10 }, (_, i) => missionColor(i))
    expect(new Set(colors).size).toBe(colors.length)
  })

  it('maps Ironclad family cargo grids with lift space excluded', () => {
    const assault = getGridForShip({ id: 231, name: 'Drake Ironclad Assault', scu: 1440, containerSizes: [] })!
    const ironclad = getGridForShip({ id: 230, name: 'Drake Ironclad', scu: 2200, containerSizes: [] })!
    const assaultLargeGrids = assault.compartments.filter((c) => c.dims.join('x') === '20x6x6')
    const ironcladLargeGrids = ironclad.compartments.filter((c) => c.dims.join('x') === '20x6x6')
    const ironcladSmallGrids = ironclad.compartments.filter((c) => c.dims.join('x') === '10x6x6')
    const ironcladRestrictedGrids = ironclad.compartments.filter(
      (c) => c.dims.join('x') === '2x2x2' && c.priority === 100 && c.maxBoxScu === 1,
    )

    expect(assault.label).toBe('Drake Ironclad Assault')
    expect(assault.compartments).toHaveLength(2)
    expect(assaultLargeGrids).toHaveLength(2)
    expect(assaultLargeGrids.map((c) => c.offset)).toEqual([
      [9, 0, 0],
      [9, 8, 0],
    ])
    expect(gridCapacity(assault.compartments)).toBe(1440)

    expect(ironcladLargeGrids).toHaveLength(2)
    expect(ironcladSmallGrids).toHaveLength(2)
    expect(ironcladRestrictedGrids).toHaveLength(5)
    expect(ironcladLargeGrids.map((c) => c.offset)).toEqual([
      [9, 0, 0],
      [9, 8, 0],
    ])
    expect(ironcladSmallGrids.map((c) => c.offset)).toEqual([
      [30, 0, 0],
      [30, 8, 0],
    ])
    expect(ironcladRestrictedGrids.map((c) => c.offset)).toEqual([
      [2, 3, 0],
      [5, 5, 0],
      [2, 6, 0],
      [5, 8, 0],
      [2, 9, 0],
    ])
    expect(gridCapacity(ironclad.compartments)).toBe(2200)
    expect(ironcladRestrictedGrids.reduce((sum, c) => sum + c.dims[0] * c.dims[1] * c.dims[2], 0)).toBe(40)
  })
})
