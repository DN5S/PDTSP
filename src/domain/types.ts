// Shared domain types for the hauling route optimizer.

export type LocationType = 'station' | 'outpost' | 'city' | 'poi'

export interface Location {
  id: string
  uexId: number
  type: LocationType
  name: string
  fullName: string
  /** UEX orbit id used for distance lookup. */
  orbitId: number
  orbitName: string
  systemId: number
  systemName: string
}

export interface Ship {
  id: number
  name: string
  scu: number
  containerSizes: number[]
}

export interface Leg {
  id: string
  commodity: string
  scu: number
  /** Largest container size the mission provides for this cargo line. */
  maxBoxScu?: number
  pickupId: string
  dropoffId: string
  /** Opt-in split delivery for legs that cannot fit on an empty ship in one trip. */
  allowSplit?: boolean
}

export interface Mission {
  id: string
  label: string
  contractor?: string
  reward?: number
  color?: string
  legs: Leg[]
}

export interface StopAction {
  kind: 'load' | 'unload'
  legId: string
  missionId: string
  commodity: string
  scu: number
}

export interface RouteStop {
  locationId: string
  actions: StopAction[]
  loadAfter: number
  legDistance: number
  estimated: boolean
}

/** pdtsp is single-visit; pdtsp-l is LIFO-aware with revisits. */
export type RouteMethod = 'pdtsp' | 'pdtsp-l'

/** Box placement witness from the hard-LIFO oracle. */
export interface LoadoutBox {
  id: string
  missionId: string
  legId: string
  commodity: string
  scu: number
  pos: [number, number, number]
  dims: [number, number, number]
  loadStop: number
  deliverStop: number
}

/** One box operation in the execution checklist. */
export interface PlanOp {
  kind: 'load' | 'unload'
  boxId: string
}

export interface RoutePlan {
  stops: RouteStop[]
  totalDistance: number
  feasible: boolean
  reason?: string
  estimatedLegs: number
  method: 'exact' | 'heuristic'
  algorithm: RouteMethod
  revisits?: number
  /** Hard-LIFO oracle witness for gridded routes. */
  loadout?: LoadoutBox[]
  /** Per-box execution order over the witness; older plans may omit it. */
  opOrder?: PlanOp[]
  /** Raw handling measurement of the final witness. */
  handling?: { totalL: number; totalG: number; perStop: { L: number; G: number }[] }
}

export interface OrbitEdge {
  from: number
  to: number
  distance: number
}

export interface OrbitInfo {
  id: number
  name: string
  systemId: number
}
