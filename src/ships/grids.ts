// Hand-authored ship cargo grids. UEX gives SCU totals, not physical grid shape.
// One cell is 1 SCU; separate compartments cannot be bridged across gaps.

import type { Ship } from '../domain/types'

/** Horizontal extraction direction. */
export type OpeningAxis = '+x' | '-x' | '+y' | '-y'

/** Extraction blocking model for a compartment. */
export type BlockingModel = 'vertical+depth' | 'vertical' | 'none'

export interface Compartment {
  offset: [number, number, number]
  /** Cell dimensions [x width, y length, z height]. */
  dims: [number, number, number]
  /** Largest single box accepted; fitting geometry is still checked separately. */
  maxBoxScu?: number
  /** Lower values are packed first. */
  priority?: number
  blockingModel?: BlockingModel
  /** Defaults to the +end of the longer horizontal axis. */
  openingAxis?: OpeningAxis
}

export function compartmentBlocking(c: Compartment): BlockingModel {
  return c.blockingModel ?? 'vertical+depth'
}

export function compartmentOpeningAxis(c: Compartment): OpeningAxis {
  return c.openingAxis ?? (c.dims[0] >= c.dims[1] ? '+x' : '+y')
}

/** Grid-editor opening choice. 'top' maps to vertical-only blocking. */
export type OpeningFace = OpeningAxis | 'top'

export function compartmentOpening(c: Compartment): OpeningFace {
  return compartmentBlocking(c) === 'vertical' ? 'top' : compartmentOpeningAxis(c)
}

/** Return a compartment copy with opening-derived blocking fields. */
export function withOpening(c: Compartment, face: OpeningFace): Compartment {
  return face === 'top'
    ? { ...c, blockingModel: 'vertical' }
    : { ...c, blockingModel: 'vertical+depth', openingAxis: face }
}

export interface ShipGrid {
  /** Case-insensitive substring matched against the UEX ship name. */
  match: string
  label: string
  compartments: Compartment[]
}

const LEFT_LANE_X = 9
const RIGHT_LANE_X = 30
const RESTRICTED_FRONT_Y = 0
const TOP_LANE_Y = 0
const BOTTOM_LANE_Y = 8

const MAIN_20X6X6: [number, number, number] = [20, 6, 6]
const MAIN_10X6X6: [number, number, number] = [10, 6, 6]
const RESTRICTED_2X2X2: [number, number, number] = [2, 2, 2]

function largeGrid(y: number): Compartment {
  return { offset: [LEFT_LANE_X, y, 0], dims: MAIN_20X6X6 }
}

function smallGrid(y: number): Compartment {
  return { offset: [RIGHT_LANE_X, y, 0], dims: MAIN_10X6X6 }
}

function restrictedForwardGrids(): Compartment[] {
  const offsets: [number, number, number][] = [
    [2, RESTRICTED_FRONT_Y + 3, 0],
    [5, RESTRICTED_FRONT_Y + 5, 0],
    [2, RESTRICTED_FRONT_Y + 6, 0],
    [5, RESTRICTED_FRONT_Y + 8, 0],
    [2, RESTRICTED_FRONT_Y + 9, 0],
  ]
  return offsets.map((offset) => ({
    offset,
    dims: RESTRICTED_2X2X2,
    maxBoxScu: 1,
    priority: 100,
  }))
}

function ironcladAssaultCompartments(): Compartment[] {
  return [
    largeGrid(TOP_LANE_Y),
    largeGrid(BOTTOM_LANE_Y),
  ]
}

function ironcladCompartments(): Compartment[] {
  return [
    largeGrid(TOP_LANE_Y),
    largeGrid(BOTTOM_LANE_Y),
    smallGrid(TOP_LANE_Y),
    smallGrid(BOTTOM_LANE_Y),
    // Forward 40-SCU patch: five 2x2x2, 1-SCU-only grids packed last.
    ...restrictedForwardGrids(),
  ]
}

export const SHIP_GRIDS: ShipGrid[] = [
  // RAFT: one 8 x 12 x 2 bay (192 SCU).
  {
    match: 'RAFT',
    label: 'Argo RAFT',
    compartments: [{ offset: [0, 0, 0], dims: [8, 12, 2] }],
  },
  // Prowler Utility: two 16-SCU bays split by a gap; cargo cannot span across.
  {
    match: 'Prowler Utility',
    label: 'Esperia Prowler Utility',
    compartments: [
      { offset: [0, 0, 0], dims: [4, 2, 2] },
      { offset: [0, 3, 0], dims: [4, 2, 2] },
    ],
  },
  // Railen: 640 SCU on six external pods, laid out as:
  //   back row:      [4][4]
  //   front row:  [2][4][4][2]
  // (four 4x32 pods = [4,8,4], two 2x32 pods = [2,8,4]).
  {
    match: 'Railen',
    label: 'Gatac Railen',
    // External pods extract upward; separate pods never block each other.
    compartments: [
      { offset: [0, 0, 0], dims: [2, 8, 4], blockingModel: 'vertical' }, // front-left  2x32
      { offset: [3, 0, 0], dims: [4, 8, 4], blockingModel: 'vertical' }, // front-mid-L 4x32
      { offset: [8, 0, 0], dims: [4, 8, 4], blockingModel: 'vertical' }, // front-mid-R 4x32
      { offset: [13, 0, 0], dims: [2, 8, 4], blockingModel: 'vertical' }, // front-right 2x32
      { offset: [3, 9, 0], dims: [4, 8, 4], blockingModel: 'vertical' }, // back-left   4x32
      { offset: [8, 9, 0], dims: [4, 8, 4], blockingModel: 'vertical' }, // back-right  4x32
    ],
  },
  // Ironclad Assault: lift grids excluded; 2x (20 x 6 x 6) = 1440 SCU.
  {
    match: 'Ironclad Assault',
    label: 'Drake Ironclad Assault',
    compartments: ironcladAssaultCompartments(),
  },
  // Ironclad: practical main hold is 2160 SCU plus a 40-SCU 1-SCU-only patch.
  {
    match: 'Ironclad',
    label: 'Drake Ironclad (2160 + 40x1SCU)',
    compartments: ironcladCompartments(),
  },
]

export function gridBounds(compartments: Compartment[]): [number, number, number] {
  let x = 0
  let y = 0
  let z = 0
  for (const c of compartments) {
    x = Math.max(x, c.offset[0] + c.dims[0])
    y = Math.max(y, c.offset[1] + c.dims[1])
    z = Math.max(z, c.offset[2] + c.dims[2])
  }
  return [x, y, z]
}

export function gridCapacity(compartments: Compartment[]): number {
  return compartments.reduce((sum, c) => sum + c.dims[0] * c.dims[1] * c.dims[2], 0)
}

export function compartmentAllowsBox(compartment: Compartment, scu: number): boolean {
  return compartment.maxBoxScu == null || scu <= compartment.maxBoxScu
}

export function compartmentPriority(compartment: Compartment): number {
  return compartment.priority ?? 0
}

export function getGridForShip(ship: Ship | null): ShipGrid | null {
  if (!ship) return null
  const name = ship.name.toLowerCase()
  return SHIP_GRIDS.find((g) => name.includes(g.match.toLowerCase())) ?? null
}
