// Web Worker: runs the route optimizer off the main thread. The tool's goal is
// the ACCURATE route, not a fast approximation — so long searches (exact
// Held-Karp up to the memory ceiling, generous oracle budgets for grid ships)
// are allowed to run for tens of seconds while the UI shows a live "searching…"
// state instead of freezing.
//
// The distance resolver is rebuilt here from the bundled data: functions can't
// cross the worker boundary, but the static JSON can be imported on both sides.

import { locations, orbitDistances } from '../data'
import { createDistanceResolver } from './distanceMatrix'
import { optimizeRoute, type PlannerLeg, type OptimizeOptions } from './pdp'
import type { Ship, RoutePlan } from '../domain/types'

export interface SolveRequest {
  id: number
  legs: PlannerLeg[]
  ship: Ship
  opts: OptimizeOptions
}

export interface SolveResponse {
  id: number
  plan: RoutePlan
}

const resolver = createDistanceResolver(locations, orbitDistances)

self.onmessage = (e: MessageEvent<SolveRequest>) => {
  const { id, legs, ship, opts } = e.data
  const plan = optimizeRoute(legs, ship, resolver, opts)
  const response: SolveResponse = { id, plan }
  ;(self as unknown as { postMessage: (m: SolveResponse) => void }).postMessage(response)
}
