// The grid file round-trip and the import validation rules: lenient wrapper
// (envelope or bare array), strict field-by-field compartment rebuilding.

import { describe, expect, it } from 'vitest'
import { gridFileName, parseGridFile, serializeGrid } from './gridExchange'
import type { Compartment } from './grids'

const comps: Compartment[] = [
  { offset: [0, 0, 0], dims: [8, 12, 2], blockingModel: 'vertical+depth', openingAxis: '+y' },
  { offset: [10, 0, 0], dims: [4, 4, 4], maxBoxScu: 8, priority: 2, blockingModel: 'vertical' },
]

describe('serializeGrid / parseGridFile round-trip', () => {
  it('preserves every compartment field and the ship name', () => {
    const parsed = parseGridFile(serializeGrid('RSI Hermes', comps))
    expect(parsed.ship).toBe('RSI Hermes')
    expect(parsed.compartments).toEqual(comps)
  })

  it('accepts a bare compartments array (no envelope)', () => {
    const parsed = parseGridFile(JSON.stringify(comps))
    expect(parsed.ship).toBeNull()
    expect(parsed.compartments).toEqual(comps)
  })

  it('drops unknown fields instead of carrying them into storage', () => {
    const parsed = parseGridFile(
      JSON.stringify([{ offset: [0, 0, 0], dims: [2, 2, 2], evil: 'payload' }]),
    )
    expect(parsed.compartments[0]).toEqual({ offset: [0, 0, 0], dims: [2, 2, 2] })
  })
})

describe('parseGridFile validation', () => {
  it('rejects non-JSON, wrong formats, and empty files', () => {
    expect(() => parseGridFile('not json')).toThrow(/not valid JSON/)
    expect(() => parseGridFile('{"format":"other","compartments":[]}')).toThrow(/not a hauling-sc grid/)
    expect(() => parseGridFile('{"format":"hauling-sc-grid","compartments":[]}')).toThrow(/no compartments/)
    expect(() => parseGridFile('42')).toThrow(/not a grid file/)
  })

  it('rejects malformed compartment fields with the bay called out', () => {
    expect(() => parseGridFile(JSON.stringify([{ offset: [0, 0], dims: [2, 2, 2] }]))).toThrow(/bay 1: offset/)
    expect(() => parseGridFile(JSON.stringify([{ offset: [0, 0, 0], dims: [2, 0, 2] }]))).toThrow(/bay 1: dims/)
    expect(() =>
      parseGridFile(JSON.stringify([comps[0], { offset: [0, 0, 0], dims: [2, 2, 2], blockingModel: 'sideways' }])),
    ).toThrow(/bay 2: blockingModel/)
    expect(() =>
      parseGridFile(JSON.stringify([{ offset: [0, 0, 0], dims: [2, 2, 2], openingAxis: '+z' }])),
    ).toThrow(/bay 1: openingAxis/)
    expect(() =>
      parseGridFile(JSON.stringify([{ offset: [0, 0, 0], dims: [2, 2, 2], maxBoxScu: 0 }])),
    ).toThrow(/bay 1: maxBoxScu/)
  })
})

describe('gridFileName', () => {
  it('slugs the ship name safely', () => {
    expect(gridFileName('RSI Hermes')).toBe('rsi-hermes-grid.json')
    expect(gridFileName('  ***  ')).toBe('ship-grid.json')
  })
})
