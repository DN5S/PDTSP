import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { locationsById, shipsById } from './data'
import { flattenMissions, type PlannerLeg } from './optimizer/pdp'
import { loadoutFromSteps, buildRouteSteps, missionColor, type PlacedBox } from './optimizer/loadout'
import { routeSignature } from './optimizer/routeProgress'
import { getGridForShip, gridCapacity, type ShipGrid } from './ships/grids'
import type { Mission, RoutePlan } from './domain/types'
import type { SolveRequest, SolveResponse } from './optimizer/routeWorker'
import { useHaulingState } from './state/store'
import { ShipSelect } from './components/ShipSelect'
import { MissionEditor } from './components/MissionEditor'
import { RouteTimeline } from './components/RouteTimeline'
import { CargoGrid3D } from './components/CargoGrid3D'
import { GridEditor3D } from './components/GridEditor3D'
import './App.css'

// Accuracy-first search runs off-thread. Gridless ships can use exact Held-Karp
// below this limit; gridded ships always use the LIFO-oracle heuristic because
// exact state dominance is unsound when load order affects feasibility.
const WORKER_EXACT_LIMIT = 26
const WORKER_GRID_BUDGET_MS = 15_000
const newRouteWorker = () =>
  new Worker(new URL('./optimizer/routeWorker.ts', import.meta.url), { type: 'module' })

export default function App() {
  const {
    shipId, setShipId, missions, setMissions, gridOverrides, setGridOverride,
    handlingAlphaMilli, handlingDeltaMilli,
  } = useHaulingState()
  const [mode, setMode] = useState<'plan' | 'grid'>('plan')
  const ship = shipId != null ? shipsById.get(shipId) ?? null : null

  const builtin = getGridForShip(ship)
  const override = shipId != null ? gridOverrides[String(shipId)] : undefined
  const grid = useMemo<ShipGrid | null>(() => {
    if (override && override.length) {
      return { match: ship?.name ?? '', label: `${ship?.name ?? 'Ship'} · custom grid`, compartments: override }
    }
    return builtin
  }, [override, builtin, ship])

  const validLegs = useMemo(
    () =>
      flattenMissions(missions).filter(
        (l) => l.commodity.trim() && l.scu > 0 && l.pickupId && l.dropoffId,
      ),
    [missions],
  )

  // Only route-relevant fields should trigger the solver; label/reward edits
  // intentionally leave this key unchanged.
  const legsKey = useMemo(() => JSON.stringify(validLegs), [validLegs])

  // Debounce cargo edits, but keep a mission snapshot so the old plan can still
  // resolve labels/colors during the debounce window.
  const [routeLegs, setRouteLegs] = useState<{ key: string; legs: PlannerLeg[]; missions: Mission[] }>(
    () => ({ key: legsKey, legs: validLegs, missions }),
  )
  useEffect(() => {
    if (routeLegs.key === legsKey) return
    const t = setTimeout(() => setRouteLegs({ key: legsKey, legs: validLegs, missions }), 250)
    return () => clearTimeout(t)
  }, [legsKey, validLegs, missions, routeLegs.key])

  // Grid saves replace object identity; the solver key is based on geometry.
  const gridKey = useMemo(() => (grid ? JSON.stringify(grid.compartments) : ''), [grid])

  // Superseded worker searches are terminated instead of queued behind fresher
  // inputs.
  const [solve, setSolve] = useState<{ plan: RoutePlan | null; solving: boolean }>({
    plan: null,
    solving: false,
  })
  const requestIdRef = useRef(0)
  useEffect(() => {
    if (!ship || !routeLegs.legs.length) {
      setSolve({ plan: null, solving: false })
      return
    }
    const id = ++requestIdRef.current
    const opts = grid
      ? {
          compartments: grid.compartments,
          timeBudgetMs: WORKER_GRID_BUDGET_MS,
          alphaMilli: handlingAlphaMilli,
          deltaMilli: handlingDeltaMilli,
        }
      : { exactLimit: WORKER_EXACT_LIMIT }
    const request: SolveRequest = { id, legs: routeLegs.legs, ship, opts }
    setSolve((s) => ({ plan: s.plan, solving: true }))
    let worker = newRouteWorker()
    const finish = (e: MessageEvent<SolveResponse>) => {
      if (e.data.id === id) setSolve({ plan: e.data.plan, solving: false })
    }
    worker.onmessage = finish
    worker.onerror = () => {
      // Exact search may OOM in the worker; retry once with the heuristic.
      worker.terminate()
      worker = newRouteWorker()
      worker.onmessage = finish
      worker.postMessage({ ...request, opts: { ...opts, exactLimit: 0 } })
    }
    worker.postMessage(request)
    return () => worker.terminate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ship, routeLegs.key, gridKey, handlingAlphaMilli, handlingDeltaMilli])
  // While solving, hide the previous route rather than presenting it as current.
  const plan = solve.solving ? null : solve.plan
  const solving = solve.solving

  const scuHauled = validLegs.reduce((a, l) => a + l.scu, 0)
  const reward = missions.reduce((a, m) => a + (m.reward ?? 0), 0)
  const peakLoad = plan?.feasible ? Math.max(0, ...plan.stops.map((s) => s.loadAfter)) : 0
  // Match solver capacity: user-authored grid geometry beats the UEX SCU value.
  const capScu = grid ? gridCapacity(grid.compartments) : ship?.scu ?? 0
  const overCapacity = ship != null && peakLoad > capScu
  const routeKey = useMemo(() => routeSignature(plan), [plan])
  const steps = useMemo(() => (plan?.feasible ? buildRouteSteps(plan) : []), [plan])
  const totalSteps = steps.length

  // Progress/focus are valid only for the exact route signature they came from.
  const [progress, setProgress] = useState<{ key: string; count: number; focus: string | null }>(
    { key: '', count: 0, focus: null },
  )
  const completedStepCount = progress.key === routeKey ? progress.count : 0
  const focusedMissionId = progress.key === routeKey ? progress.focus : null
  const setCompletedStepCount = useCallback(
    (count: number) =>
      setProgress((p) => ({ key: routeKey, count, focus: p.key === routeKey ? p.focus : null })),
    [routeKey],
  )
  const toggleFocusedMission = useCallback(
    (id: string) =>
      setProgress((p) => ({
        key: routeKey,
        count: p.key === routeKey ? p.count : 0,
        focus: p.key === routeKey && p.focus === id ? null : id,
      })),
    [routeKey],
  )
  const clampedCompletedStepCount = plan?.feasible ? Math.min(completedStepCount, totalSteps) : 0

  // The 3D view shows the route as executed so far, not the final loaded state.
  const loadout = useMemo(() => {
    if (!grid || !plan?.feasible || !plan.loadout) return null
    return loadoutFromSteps(plan, grid.compartments, clampedCompletedStepCount)
  }, [grid, plan, clampedCompletedStepCount])

  const activeFocusedMissionId =
    focusedMissionId && loadout?.missionOrder.includes(focusedMissionId) ? focusedMissionId : null
  const deferredScu = loadout?.deferred.reduce((a, b) => a + b.scu, 0) ?? 0
  // Prefer live mission names, then the snapshot that produced the current plan.
  const missionLabel = useCallback(
    (id: string) =>
      missions.find((m) => m.id === id)?.label ??
      routeLegs.missions.find((m) => m.id === id)?.label ??
      id,
    [missions, routeLegs.missions],
  )
  // Mission colors are stable across label/reward edits to avoid rebuilding the
  // 3D scene while the user types.
  const missionColorSig =
    missions.map((m) => `${m.id}:${m.color ?? ''}`).join(',') +
    '|' +
    routeLegs.missions.map((m) => m.id).join(',')
  const missionColorFor = useMemo(() => {
    const index = new Map(routeLegs.missions.map((m, i) => [m.id, i] as const))
    const override = new Map<string, string>()
    missions.forEach((m, i) => {
      index.set(m.id, i)
      if (m.color) override.set(m.id, m.color)
    })
    return (id: string) => override.get(id) ?? missionColor(index.get(id) ?? 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missionColorSig])

  // The next unchecked step drives 3D ghosts/spotlights.
  const nextStep = plan?.feasible ? steps[clampedCompletedStepCount] ?? null : null
  const ghostBoxes = useMemo<PlacedBox[]>(() => {
    if (!grid || !plan?.loadout || !nextStep || nextStep.kind !== 'load') return []
    // opOrder pins exact boxes; legacy steps fall back to the leg ids.
    const stepBoxIds = nextStep.boxIds ? new Set(nextStep.boxIds) : null
    const legIds = new Set(nextStep.actions.map((a) => a.legId))
    return plan.loadout
      .filter(
        (b) =>
          stepBoxIds
            ? stepBoxIds.has(b.id)
            : b.missionId === nextStep.missionId &&
              legIds.has(b.legId) &&
              b.loadStop === nextStep.stopIndex,
      )
      .map((b) => ({
        id: b.id, missionId: b.missionId, legId: b.legId, commodity: b.commodity, scu: b.scu,
        pos: [...b.pos] as [number, number, number],
        dims: [...b.dims] as [number, number, number],
        loadStop: b.loadStop, deliverStop: b.deliverStop,
      }))
  }, [grid, plan, nextStep])
  const unloadSpotlight = useMemo(
    () =>
      nextStep?.kind === 'unload'
        ? { missionId: nextStep.missionId, stopIndex: nextStep.stopIndex }
        : null,
    [nextStep],
  )
  const stepLocationName = useCallback(
    (stopIndex: number) => {
      const id = plan?.stops[stopIndex]?.locationId
      return id ? locationsById.get(id)?.name ?? id : ''
    },
    [plan],
  )
  const stepper = useMemo(() => {
    if (!plan?.feasible || !totalSteps) return null
    // The index counts completed steps; the caption names the next action.
    const caption = nextStep
      ? `Next: ${nextStep.kind === 'load' ? 'LOAD' : 'UNLOAD'} ${missionLabel(nextStep.missionId)} · ${nextStep.scu} SCU @ ${stepLocationName(nextStep.stopIndex)}`
      : 'Route complete'
    return {
      index: clampedCompletedStepCount,
      total: totalSteps,
      label: caption,
      color: nextStep ? missionColorFor(nextStep.missionId) : null,
    }
  }, [plan, totalSteps, nextStep, clampedCompletedStepCount, missionLabel, missionColorFor, stepLocationName])
  // Functional update keeps rapid stepper clicks from collapsing into one delta.
  const stepBy = useCallback(
    (delta: number) =>
      setProgress((p) => {
        const current = p.key === routeKey ? p.count : 0
        return {
          key: routeKey,
          count: Math.max(0, Math.min(totalSteps, current + delta)),
          focus: p.key === routeKey ? p.focus : null,
        }
      }),
    [routeKey, totalSteps],
  )

  return (
    <div className="app">
      <header className="topbar">
        <h1>Hauling PDTSP</h1>
        <div className="topbar-right">
          <ShipSelect value={shipId} onChange={setShipId} />
          {ship && (
            <button
              className={`seg-btn topbar-toggle ${mode === 'grid' ? 'active' : ''}`}
              onClick={() => setMode((m) => (m === 'grid' ? 'plan' : 'grid'))}
              type="button"
            >
              {mode === 'grid' ? '← Plan' : 'Edit grid'}
            </button>
          )}
        </div>
      </header>

      {mode === 'grid' && ship ? (
        <GridEditor3D
          key={ship.id}
          ship={ship}
          initial={grid?.compartments ?? []}
          builtin={builtin?.compartments ?? null}
          onSave={(comps) => setGridOverride(ship.id, comps)}
          onClose={() => setMode('plan')}
        />
      ) : (
       <>
      <div className="metrics">
        <Metric label="Total distance" value={plan?.feasible ? `${plan.totalDistance} Gm` : '—'} />
        <Metric
          label="Stops"
          value={plan?.feasible ? `${plan.stops.length}${plan.revisits ? ` · ${plan.revisits} revisit${plan.revisits > 1 ? 's' : ''}` : ''}` : '—'}
        />
        <Metric label="SCU hauled" value={scuHauled ? String(scuHauled) : '—'} />
        <Metric label="Reward" value={reward ? reward.toLocaleString() : '—'} />
        <Metric
          label="aUEC / Gm"
          value={reward && plan?.feasible && plan.totalDistance ? Math.round(reward / plan.totalDistance).toLocaleString() : '—'}
        />
        <Metric
          label="aUEC / SCU"
          value={reward && scuHauled ? Math.round(reward / scuHauled).toLocaleString() : '—'}
        />
      </div>

      {ship && (
        <div className={`gauge ${overCapacity ? 'over' : ''}`}>
          <span className="muted">Peak load</span>
          <div className="gauge-track">
            <div
              className="gauge-fill"
              style={{ width: `${Math.min(100, capScu ? (peakLoad / capScu) * 100 : 0)}%` }}
            />
          </div>
          <span>
            {peakLoad} / {capScu} SCU
          </span>
        </div>
      )}

      <div className="grid">
        <MissionEditor missions={missions} setMissions={setMissions} colorFor={missionColorFor} />
        <RouteTimeline
          completedStepCount={clampedCompletedStepCount}
          onCompletedStepCountChange={setCompletedStepCount}
          plan={plan}
          solving={solving}
          missionLabel={missionLabel}
          missionColorFor={missionColorFor}
        />
      </div>

      {ship && (
        <section className="loadout">
          <div className="panel-head">
            <h2>Cargo loadout</h2>
            <span className="muted">
              {grid
                ? `${grid.label} · loaded ${loadout?.usedScu ?? 0}${deferredScu ? ` +${deferredScu} pending` : ''} / plan peak ${peakLoad} / capacity ${gridCapacity(grid.compartments)} SCU`
                : 'no grid spec'}
            </span>
          </div>

          {!grid && (
            <div className="muted empty">
              <p>No cargo grid for {ship.name} yet — draw one to unlock the dig-free 3D loadout.</p>
              <button className="ghost-btn" onClick={() => setMode('grid')} type="button">
                Create grid
              </button>
            </div>
          )}

          {grid && loadout && (
            <>
              <div className="legend">
                {loadout.missionOrder.map((id) => (
                  <button
                    className={`legend-item ${activeFocusedMissionId === id ? 'active' : ''}`}
                    key={id}
                    onClick={() => toggleFocusedMission(id)}
                    type="button"
                  >
                    <span className="legend-dot" style={{ background: missionColorFor(id) }} />
                    {missionLabel(id)}
                  </button>
                ))}
              </div>
              <CargoGrid3D
                focusedMissionId={activeFocusedMissionId}
                ghostBoxes={ghostBoxes}
                missionColorFor={missionColorFor}
                missionLabel={missionLabel}
                onStep={stepBy}
                plan={loadout}
                stepper={stepper}
                unloadSpotlight={unloadSpotlight}
              />
              <p className="cargo3d-hints">
                Drag boxes to rearrange · R rotates the held box · ←/→ steps the route ·
                a box with cargo on top can't be grabbed
              </p>
            </>
          )}

          {grid && !loadout && (
            <p className="muted empty">
              {solving
                ? 'Searching for the optimal route…'
                : validLegs.length === 0
                  ? 'Add cargo legs to see the recommended loadout.'
                  : 'No dig-free loadout — adjust missions or use a larger/wider hold.'}
            </p>
          )}
        </section>
      )}
       </>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  )
}
