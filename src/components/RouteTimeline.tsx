import { useEffect, useState } from 'react'
import type { RoutePlan } from '../domain/types'
import { buildRouteSteps, type RouteStepView } from '../optimizer/loadout'
import { locationsById } from '../data'

interface Props {
  plan: RoutePlan | null
  /** True while the worker is still searching — the plan is withheld until done. */
  solving?: boolean
  completedStepCount?: number
  onCompletedStepCountChange?: (count: number) => void
  missionLabel?: (id: string) => string
  missionColorFor?: (id: string) => string
}

export function RouteTimeline({
  completedStepCount = 0,
  onCompletedStepCountChange,
  plan,
  solving = false,
  missionLabel = (id) => id,
  missionColorFor = () => 'var(--accent, #5b8cff)',
}: Props) {
  // Elapsed seconds for the searching indicator. Owned HERE so the 1 Hz tick
  // re-renders only this panel (which, while solving, is just the notice
  // below) — not the whole App tree with the 3D view in it.
  const [solvingSeconds, setSolvingSeconds] = useState(0)
  useEffect(() => {
    if (!solving) return
    setSolvingSeconds(0)
    const t0 = Date.now()
    const iv = setInterval(() => setSolvingSeconds(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(iv)
  }, [solving])

  if (solving) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Optimized route</h2>
          <span className="muted">searching…</span>
        </div>
        <p className="muted empty">
          Searching for the optimal route{solvingSeconds > 0 ? ` — ${solvingSeconds}s` : ''}…
          <br />
          <span className="muted">Large routes can take a while; the result is the best order found.</span>
        </p>
      </section>
    )
  }

  if (!plan) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Optimized route</h2>
        </div>
        <p className="muted empty">Select a ship and add at least one cargo leg to plan a route.</p>
      </section>
    )
  }

  if (!plan.feasible) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Optimized route</h2>
        </div>
        <p className="warn">{plan.reason}</p>
      </section>
    )
  }

  const digFree = plan.loadout != null
  const revisits = plan.revisits ?? 0
  const steps = buildRouteSteps(plan)
  const completed = Math.min(completedStepCount, steps.length)

  // Steps grouped per stop, plus each stop's global step base index.
  const byStop: RouteStepView[][] = plan.stops.map(() => [])
  for (const st of steps) byStop[st.stopIndex].push(st)
  const base: number[] = []
  let acc = 0
  byStop.forEach((a, i) => { base[i] = acc; acc += a.length })

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Optimized route</h2>
        <span className="muted">
          {digFree ? 'dig-free · ' : ''}
          {plan.method === 'exact' ? 'optimal' : 'near'} · {plan.stops.length} stops
          {revisits > 0 ? ` · ${revisits} revisit${revisits > 1 ? 's' : ''}` : ''}
        </span>
      </div>

      <ol className="timeline">
        {plan.stops.map((s, i) => {
          const loc = locationsById.get(s.locationId)
          const stopSteps = byStop[i]
          const stopBase = base[i]
          const hasLoad = stopSteps.some((st) => st.kind === 'load')
          return (
            <li className="stop" key={`${s.locationId}-${i}`}>
              <span className="stop-num">{i + 1}</span>
              <div className="stop-body">
                <div className="stop-head">
                  <span className="stop-name">{loc?.name ?? s.locationId}</span>
                  <span className="stop-dist">
                    {i === 0 ? 'start' : `${s.legDistance} Gm${s.estimated ? ' ~est' : ''}`}
                  </span>
                </div>

                {digFree && hasLoad && <div className="stop-hint">load bottom-of-hold first</div>}

                <div className="checklist">
                  {stopSteps.map((step, j) => {
                    const gi = stopBase + j
                    const done = gi < completed
                    const sign = step.kind === 'load' ? '+' : '−'
                    return (
                      <label className={`check-step ${step.kind} ${done ? 'done' : ''}`} key={`${step.kind}-${step.missionId}-${j}`}>
                        <input
                          type="checkbox"
                          checked={done}
                          onChange={(e) => onCompletedStepCountChange?.(e.currentTarget.checked ? gi + 1 : gi)}
                        />
                        <span className="legend-dot" style={{ background: missionColorFor(step.missionId) }} />
                        <span className="cs-verb">{step.kind === 'load' ? 'Load' : 'Unload'}</span>
                        <span className="cs-label">{missionLabel(step.missionId)}</span>
                        <span className={`cs-scu ${step.kind}`}>{sign}{step.scu} SCU</span>
                        <span className="cs-chips">
                          {step.actions.map((a) => (
                            <span className={`chip ${step.kind}`} key={`${a.kind}-${a.legId}`}>{sign}{a.scu} {a.commodity}</span>
                          ))}
                        </span>
                      </label>
                    )
                  })}
                </div>

                <div className="loadbar">
                  <span className="loadbar-label">load {s.loadAfter}</span>
                </div>
              </div>
            </li>
          )
        })}
      </ol>

      {plan.estimatedLegs > 0 && (
        <p className="warn small">
          {plan.estimatedLegs} leg distance{plan.estimatedLegs > 1 ? 's' : ''} estimated (no direct UEX data).
        </p>
      )}
    </section>
  )
}
