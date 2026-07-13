// Export/import of user-authored cargo grids as shareable JSON.
//
// Custom grids live only in localStorage (per browser, per origin), so this is
// the backup and community-sharing path. The envelope records which ship the
// grid was drawn for; import is lenient about the wrapper (a bare Compartment[]
// array is accepted) but every compartment is validated and rebuilt
// field-by-field, so hand-edited files can't smuggle unexpected shapes into the
// optimizer.

import type { BlockingModel, Compartment, OpeningAxis } from './grids'

export const GRID_FILE_FORMAT = 'hauling-sc-grid'

export interface GridFile {
  format: typeof GRID_FILE_FORMAT
  version: 1
  /** Ship the grid was authored for (informational — geometry is ship-agnostic). */
  ship: string
  compartments: Compartment[]
}

export function serializeGrid(shipName: string, compartments: Compartment[]): string {
  const file: GridFile = { format: GRID_FILE_FORMAT, version: 1, ship: shipName, compartments }
  return JSON.stringify(file, null, 2)
}

export function gridFileName(shipName: string): string {
  const slug = shipName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${slug || 'ship'}-grid.json`
}

export interface ParsedGridFile {
  /** Ship name from the envelope, when present. */
  ship: string | null
  compartments: Compartment[]
}

/** Parse an exported grid file (or a bare compartments array). Throws an Error
 *  with a human-readable message on anything malformed. */
export function parseGridFile(text: string): ParsedGridFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('not valid JSON')
  }

  let ship: string | null = null
  let raw: unknown
  if (Array.isArray(data)) {
    raw = data
  } else if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    if (d.format !== GRID_FILE_FORMAT) throw new Error('not a hauling-sc grid file')
    ship = typeof d.ship === 'string' ? d.ship : null
    raw = d.compartments
  } else {
    throw new Error('not a grid file')
  }

  if (!Array.isArray(raw) || raw.length === 0) throw new Error('no compartments in file')
  return { ship, compartments: raw.map(parseCompartment) }
}

const BLOCKING_MODELS: BlockingModel[] = ['vertical+depth', 'vertical', 'none']
const OPENING_AXES: OpeningAxis[] = ['+x', '-x', '+y', '-y']

function parseCompartment(value: unknown, index: number): Compartment {
  const bay = `bay ${index + 1}`
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${bay}: not an object`)
  }
  const c = value as Record<string, unknown>

  const triple = (v: unknown, name: string, min: number): [number, number, number] => {
    if (!Array.isArray(v) || v.length !== 3 || v.some((n) => !Number.isInteger(n) || (n as number) < min)) {
      throw new Error(`${bay}: ${name} must be 3 integers ≥ ${min}`)
    }
    return [v[0] as number, v[1] as number, v[2] as number]
  }

  // Rebuild the compartment field-by-field: unknown keys are dropped.
  const out: Compartment = {
    offset: triple(c.offset, 'offset', 0),
    dims: triple(c.dims, 'dims', 1),
  }
  if (c.maxBoxScu !== undefined) {
    if (typeof c.maxBoxScu !== 'number' || !Number.isFinite(c.maxBoxScu) || c.maxBoxScu < 1) {
      throw new Error(`${bay}: maxBoxScu must be a number ≥ 1`)
    }
    out.maxBoxScu = c.maxBoxScu
  }
  if (c.priority !== undefined) {
    if (typeof c.priority !== 'number' || !Number.isFinite(c.priority)) {
      throw new Error(`${bay}: priority must be a number`)
    }
    out.priority = c.priority
  }
  if (c.blockingModel !== undefined) {
    if (!BLOCKING_MODELS.includes(c.blockingModel as BlockingModel)) {
      throw new Error(`${bay}: blockingModel must be one of ${BLOCKING_MODELS.join(', ')}`)
    }
    out.blockingModel = c.blockingModel as BlockingModel
  }
  if (c.openingAxis !== undefined) {
    if (!OPENING_AXES.includes(c.openingAxis as OpeningAxis)) {
      throw new Error(`${bay}: openingAxis must be one of ${OPENING_AXES.join(', ')}`)
    }
    out.openingAxis = c.openingAxis as OpeningAxis
  }
  return out
}
