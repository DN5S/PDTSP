// Distance resolver.
//
// UEX gives crowdsourced orbit-to-orbit distances (gigameters) that are sparse.
// We treat them as an undirected weighted graph and run Floyd-Warshall to get
// all-pairs shortest paths, so any two locations get a distance:
//   same orbit            -> 0
//   direct UEX edge       -> that distance        (estimated: false)
//   no direct edge        -> multi-hop shortest   (estimated: true)
//   no path (disconnected)-> a large penalty       (unreachable: true)
// A penalty is used instead of 0/Infinity so the optimizer avoids such legs
// without treating them as free or strictly impossible.

import type { Location, OrbitEdge } from '../domain/types'

export interface Distance {
  gm: number
  /** true when the value is not a direct UEX edge (multi-hop path or penalty). */
  estimated: boolean
  /** true when the two orbits are not connected; gm is then a penalty value. */
  unreachable: boolean
}

export interface DistanceResolver {
  between(aLocId: string, bLocId: string): Distance
}

export function createDistanceResolver(
  locations: Location[],
  edges: OrbitEdge[],
): DistanceResolver {
  const orbitOfLoc = new Map<string, number>()
  for (const l of locations) orbitOfLoc.set(l.id, l.orbitId)

  // Collect orbit nodes from edges and location orbits.
  const index = new Map<number, number>()
  const addOrbit = (o: number) => {
    if (!index.has(o)) index.set(o, index.size)
  }
  for (const e of edges) {
    addOrbit(e.from)
    addOrbit(e.to)
  }
  for (const o of orbitOfLoc.values()) addOrbit(o)

  const n = index.size
  const INF = Infinity
  const dist = new Float64Array(n * n).fill(INF)
  const directDist = new Float64Array(n * n).fill(INF)
  for (let i = 0; i < n; i++) dist[i * n + i] = 0

  for (const e of edges) {
    const i = index.get(e.from)!
    const j = index.get(e.to)!
    const w = e.distance
    if (!Number.isFinite(w) || w <= 0) continue
    // Undirected: keep the minimum reported distance in either direction.
    if (w < dist[i * n + j]) {
      dist[i * n + j] = w
      dist[j * n + i] = w
    }
    if (w < directDist[i * n + j]) {
      directDist[i * n + j] = w
      directDist[j * n + i] = w
    }
  }

  // Floyd-Warshall.
  for (let k = 0; k < n; k++) {
    const kn = k * n
    for (let i = 0; i < n; i++) {
      const inn = i * n
      const dik = dist[inn + k]
      if (dik === INF) continue
      for (let j = 0; j < n; j++) {
        const alt = dik + dist[kn + j]
        if (alt < dist[inn + j]) dist[inn + j] = alt
      }
    }
  }

  // Penalty for unreachable pairs: well above any real path.
  let maxFinite = 0
  for (let i = 0; i < n * n; i++) {
    const d = dist[i]
    if (d !== INF && d > maxFinite) maxFinite = d
  }
  const PENALTY = maxFinite > 0 ? maxFinite * 3 : 1_000_000

  return {
    between(aLocId, bLocId) {
      const oa = orbitOfLoc.get(aLocId)
      const ob = orbitOfLoc.get(bLocId)
      if (oa === undefined || ob === undefined) {
        return { gm: PENALTY, estimated: true, unreachable: true }
      }
      if (oa === ob) return { gm: 0, estimated: false, unreachable: false }
      const i = index.get(oa)
      const j = index.get(ob)
      if (i === undefined || j === undefined) {
        return { gm: PENALTY, estimated: true, unreachable: true }
      }
      const direct = directDist[i * n + j]
      if (direct !== INF) return { gm: Math.round(direct), estimated: false, unreachable: false }
      const d = dist[i * n + j]
      if (d === INF) return { gm: PENALTY, estimated: true, unreachable: true }
      return {
        gm: Math.round(d),
        estimated: true,
        unreachable: false,
      }
    },
  }
}
