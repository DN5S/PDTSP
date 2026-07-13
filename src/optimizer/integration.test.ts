import { describe, it, expect } from 'vitest'
import { locations, ships, orbitDistances, locationsById } from '../data'
import { createDistanceResolver } from './distanceMatrix'
import { optimizeRoute, flattenMissions } from './pdp'
import { verifyWitness } from './loadFeasibility'
import { validateGeometry, auditDigFree } from './witnessAudit'
import { buildRouteSteps, loadoutFromSteps } from './loadout'
import { getGridForShip } from '../ships/grids'
import type { Mission } from '../domain/types'

const loc = (name: string) => {
  const l = locations.find((x) => x.systemName === 'Stanton' && x.name === name)
  if (!l) throw new Error(`location not found: ${name}`)
  return l.id
}

describe('integration: optimize with real UEX data', () => {
  const resolver = createDistanceResolver(locations, orbitDistances)
  const ship = ships.find((s) => s.name.includes('Caterpillar'))!

  const missions: Mission[] = [
    {
      id: 'm1', label: 'Covalex run', contractor: 'Covalex', reward: 120000,
      legs: [
        // maxBoxScu 16: the Caterpillar accepts up to 24-SCU containers (UEX), so
        // the default 32s would be honestly rejected by the container gate.
        { id: 'l1', commodity: 'Titanium', scu: 64, maxBoxScu: 16, pickupId: loc('Lorville'), dropoffId: loc('Everus') },
        { id: 'l2', commodity: 'Aluminum', scu: 32, maxBoxScu: 16, pickupId: loc('Lorville'), dropoffId: loc('Baijini') },
      ],
    },
    {
      id: 'm2', label: 'Hurston run', contractor: 'Hurston', reward: 90000,
      legs: [
        { id: 'l3', commodity: 'Quantanium', scu: 48, maxBoxScu: 16, pickupId: loc('Area 18'), dropoffId: loc('New Babbage') },
      ],
    },
    {
      id: 'm3', label: 'ARC run', reward: 60000,
      legs: [
        { id: 'l4', commodity: 'Iron', scu: 40, maxBoxScu: 16, pickupId: loc('ARC-L1'), dropoffId: loc('Orison') },
      ],
    },
  ]

  it('produces a feasible, capacity-respecting route', () => {
    const legs = flattenMissions(missions)
    const plan = optimizeRoute(legs, ship, resolver)

    expect(plan.feasible).toBe(true)
    // Every pickup/dropoff location is visited.
    const visited = new Set(plan.stops.map((s) => s.locationId))
    for (const l of legs) {
      expect(visited.has(l.pickupId)).toBe(true)
      expect(visited.has(l.dropoffId)).toBe(true)
    }
    // Capacity never exceeded.
    expect(Math.max(...plan.stops.map((s) => s.loadAfter))).toBeLessThanOrEqual(ship.scu)
    expect(plan.totalDistance).toBeGreaterThan(0)

    const line = plan.stops
      .map((s, i) => {
        const name = locationsById.get(s.locationId)?.name ?? s.locationId
        const acts = s.actions
          .map((a) => `${a.kind === 'load' ? '+' : '-'}${a.scu} ${a.commodity}`)
          .join(', ')
        const dist = i === 0 ? 'start' : `${s.legDistance} Gm${s.estimated ? '~' : ''}`
        return `  ${i + 1}. ${name} [${dist}] ${acts}  (load ${s.loadAfter})`
      })
      .join('\n')
    console.log(
      `\nShip: ${ship.name} (${ship.scu} SCU) | method=${plan.method} | ` +
        `total=${plan.totalDistance} Gm | estimatedLegs=${plan.estimatedLegs}\n${line}\n`,
    )
  })

  // The path App.tsx actually wires for grid ships: compartments + the real UEX
  // distance resolver (same-orbit 0-Gm ties, estimated multi-hop legs) through the
  // oracle gate, revisit race, and clustered re-pack — at PRODUCTION default budgets.
  it('grid ship (Railen) with real UEX data: dig-free route, audited witness, steps round-trip', () => {
    const railen = ships.find((s) => s.name.includes('Railen'))!
    const grid = getGridForShip(railen)!
    expect(grid.compartments.length).toBeGreaterThan(0)

    const gridMissions: Mission[] = [
      {
        id: 'g1', label: 'Hurston shuttle', reward: 80000,
        legs: [
          { id: 'l1', commodity: 'Waste', scu: 48, maxBoxScu: 8, pickupId: loc('Lorville'), dropoffId: loc('Everus') },
          { id: 'l2', commodity: 'Scrap', scu: 32, maxBoxScu: 8, pickupId: loc('Lorville'), dropoffId: loc('Baijini') },
        ],
      },
      {
        id: 'g2', label: 'ArcCorp run', reward: 95000,
        legs: [
          { id: 'l3', commodity: 'Titanium', scu: 56, maxBoxScu: 8, pickupId: loc('Area 18'), dropoffId: loc('New Babbage') },
        ],
      },
      {
        id: 'g3', label: 'Lagrange loop', reward: 60000,
        legs: [
          { id: 'l4', commodity: 'Iron', scu: 40, maxBoxScu: 8, pickupId: loc('ARC-L1'), dropoffId: loc('Orison') },
        ],
      },
    ]
    const legs = flattenMissions(gridMissions)
    const plan = optimizeRoute(legs, railen, resolver, { compartments: grid.compartments })

    expect(plan.feasible).toBe(true)
    expect(plan.loadout).toBeDefined()
    // Witness holds under the oracle's own verifier AND the independent audits.
    expect(verifyWitness(plan.loadout!, grid.compartments)).toBe(true)
    expect(validateGeometry(plan.loadout!, grid.compartments).ok).toBe(true)
    expect(auditDigFree(plan.loadout!, grid.compartments)).toEqual({ ok: true })
    // Every leg delivered.
    const delivered = new Set(plan.stops.flatMap((s) => s.actions.filter((a) => a.kind === 'unload').map((a) => a.legId)))
    expect(delivered.size).toBe(legs.length)

    // Checklist wiring App.tsx composes: steps cover all actions, and the 3D fill
    // is empty before the first step and empty again after the last unload.
    const steps = buildRouteSteps(plan)
    expect(steps.reduce((a, st) => a + st.actions.length, 0))
      .toBe(plan.stops.reduce((a, s) => a + s.actions.length, 0))
    expect(loadoutFromSteps(plan, grid.compartments, 0).boxes.length).toBe(0)
    expect(loadoutFromSteps(plan, grid.compartments, steps.length).boxes.length).toBe(0)
    // After the first load step something is actually drawn.
    const firstLoad = steps.findIndex((st) => st.kind === 'load')
    expect(firstLoad).toBeGreaterThanOrEqual(0)
    expect(loadoutFromSteps(plan, grid.compartments, firstLoad + 1).usedScu).toBeGreaterThan(0)
  })
})
