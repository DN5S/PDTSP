// Typed access to the bundled UEX reference data.
// Refresh it with `npm run fetch-data` (regenerates src/data/*.json), then restart.

import type { Location, Ship, OrbitEdge, OrbitInfo } from '../domain/types'
import locationsData from './locations.json'
import shipsData from './ships.json'
import orbitDistancesData from './orbitDistances.json'
import orbitsData from './orbits.json'

export const locations = locationsData as unknown as Location[]
export const ships = shipsData as unknown as Ship[]
export const orbits = orbitsData as unknown as OrbitInfo[]

// Distance edges must connect PUBLISHED orbits. Stale UEX rows reference orbit
// ids the orbits endpoint no longer lists; letting Floyd-Warshall route through
// those phantom nodes silently changes shortest paths (measured: 30 live-orbit
// pairs, e.g. Pyro IV → Terminus 60 vs 101 Gm). The fetch script filters these
// on refresh; this load-time filter keeps the app honest regardless of the data.
const knownOrbits = new Set(orbits.map((o) => o.id))
export const orbitDistances = (orbitDistancesData as unknown as OrbitEdge[]).filter(
  (e) => knownOrbits.has(e.from) && knownOrbits.has(e.to),
)

export const locationsById = new Map(locations.map((l) => [l.id, l]))
export const shipsById = new Map(ships.map((s) => [s.id, s]))
