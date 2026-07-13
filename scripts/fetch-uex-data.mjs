// Build-time data fetch for the hauling route optimizer.
//
// UEX 2.0 public reference endpoints need no token. We only need STATIC data,
// so we fetch once and bundle it as JSON; the app makes zero runtime API calls.
// To refresh after a game patch, re-run this (npm run fetch-data) and restart.
//
// Output (src/data/): locations.json, orbits.json, orbitDistances.json,
// ships.json, meta.json.

import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const BASE = 'https://api.uexcorp.uk/2.0'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getData(path) {
  const url = `${BASE}/${path}`
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (body.status !== 'ok') throw new Error(`status=${body.status}`)
      return body.data
    } catch (err) {
      if (attempt === 3) throw new Error(`GET ${path} failed: ${err.message}`)
      await sleep(800 * attempt)
    }
  }
}

const truthy = (v) => v === 1 || v === '1' || v === true

function parseContainerSizes(s) {
  if (!s) return []
  return String(s)
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
}

async function main() {
  await mkdir(OUT, { recursive: true })
  console.log('Fetching UEX reference data (no auth)…')

  const systems = await getData('star_systems')
  const liveSystems = systems.filter((s) => truthy(s.is_available_live))
  const liveSystemIds = new Set(liveSystems.map((s) => s.id))
  const systemName = new Map(systems.map((s) => [s.id, s.name]))
  console.log(`  systems: ${liveSystems.length} live (${liveSystems.map((s) => s.name).join(', ')})`)

  const orbitsRaw = await getData('orbits')
  const orbits = orbitsRaw
    .filter((o) => liveSystemIds.has(o.id_star_system))
    .map((o) => ({ id: o.id, name: o.name, systemId: o.id_star_system }))
  const orbitName = new Map(orbits.map((o) => [o.id, o.name]))

  const endpoints = [
    ['station', 'space_stations'],
    ['outpost', 'outposts'],
    ['city', 'cities'],
    ['poi', 'poi'],
  ]
  const locations = []
  for (const [type, ep] of endpoints) {
    const rows = await getData(ep)
    for (const r of rows) {
      if (!truthy(r.is_available_live)) continue
      if (!liveSystemIds.has(r.id_star_system)) continue
      if (!r.id_orbit) continue
      const full = r.name || r.nickname || `#${r.id}`
      locations.push({
        id: `${type}:${r.id}`,
        uexId: r.id,
        type,
        name: r.nickname || r.name || full,
        fullName: full,
        orbitId: r.id_orbit,
        orbitName: orbitName.get(r.id_orbit) ?? '',
        systemId: r.id_star_system,
        systemName: systemName.get(r.id_star_system) ?? '',
      })
    }
    await sleep(300)
  }
  console.log(`  locations: ${locations.length}`)

  const edges = new Map()
  const edgeKey = (a, b) => `${a}->${b}`
  const addEdges = (rows) => {
    for (const d of rows ?? []) {
      const from = d.id_orbit_origin
      const to = d.id_orbit_destination
      const distance = Number(d.distance)
      if (!from || !to || !Number.isFinite(distance) || distance <= 0) continue
      edges.set(edgeKey(from, to), { from, to, distance })
    }
  }
  for (const a of liveSystems) {
    addEdges(await getData(`orbits_distances?id_star_system_origin=${a.id}&id_star_system_destination=${a.id}`))
    await sleep(300)
  }
  for (const a of liveSystems) {
    for (const b of liveSystems) {
      if (a.id === b.id) continue
      addEdges(await getData(`orbits_distances?id_star_system_origin=${a.id}&id_star_system_destination=${b.id}`))
      await sleep(300)
    }
  }
  // Keep only edges between PUBLISHED orbits: UEX's distance table retains rows
  // for orbits the orbits endpoint has delisted, and routing through those
  // phantom nodes silently changes shortest paths. Log what is dropped so data
  // drift stays visible on every refresh.
  const knownOrbits = new Set(orbits.map((o) => o.id))
  const allEdges = [...edges.values()]
  const orbitDistances = allEdges.filter((e) => knownOrbits.has(e.from) && knownOrbits.has(e.to))
  const dropped = allEdges.length - orbitDistances.length
  console.log(`  orbit distance edges: ${orbitDistances.length}${dropped ? ` (${dropped} dropped: unpublished orbit endpoints)` : ''}`)

  const vehicles = await getData('vehicles')
  const ships = vehicles
    .filter((v) => truthy(v.is_cargo) && Number(v.scu) > 0)
    .map((v) => ({
      id: v.id,
      name: v.name_full || v.name,
      scu: Number(v.scu),
      containerSizes: parseContainerSizes(v.container_sizes),
    }))
    .sort((a, b) => a.scu - b.scu)
  console.log(`  cargo ships: ${ships.length}`)

  const gv = await getData('game_versions')

  const write = (file, data) => writeFile(join(OUT, file), JSON.stringify(data), 'utf8')
  await write('locations.json', locations)
  await write('orbits.json', orbits)
  await write('orbitDistances.json', orbitDistances)
  await write('ships.json', ships)
  await write('meta.json', {
    generatedAt: new Date().toISOString(),
    gameVersion: gv,
    counts: {
      locations: locations.length,
      orbits: orbits.length,
      orbitDistances: orbitDistances.length,
      ships: ships.length,
    },
  })

  console.log(`Done. ${locations.length} locations, ${orbitDistances.length} edges, ${ships.length} ships → src/data/.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
