# Hauling-SC

Hauling-SC is a Star Citizen hauling planner. It takes a ship, cargo missions,
pickup and delivery locations, and a physical cargo grid, then produces a route,
a 3D loadout witness, and an executable load/unload checklist.

The project is not just a UI around shortest-path routing. Its core problem is a
pickup-and-delivery traveling salesman problem with 3D loading constraints:

```text
PDTSP-3DL = pickup-and-delivery routing
          + discrete 3D cargo packing
          + no-rehandling extraction/insertion rules
          + handling effort in the objective
```

This README folds the content of the design documents into one reference:

- `docs/formal-spec.md` - the mathematical semantics: axioms, theorems,
  feasibility, handling cost, objective function.
- `docs/algorithm-design.md` - algorithm architecture, literature positioning,
  implementation inventory, roadmap.
- `docs/hauling-sc-change-request.md` - the spec-to-code reverse-application
  plan and regression gates.

If this README and the formal spec disagree, the formal spec wins.

## Quick Start

```bash
npm install
npm run dev
npm test -- --testTimeout=20000
npm run build
npm run lint
```

Update local UEX-derived data:

```bash
npm run fetch-data
```

Run a verification-only harness:

```powershell
$env:VITE_VERIFY='1'
npx vitest run src/optimizer/insertionAudit.test.ts --testTimeout=20000
```

## Product Workflow

1. Select a ship.
2. Enter one or more missions. A mission contains one or more cargo legs.
3. For each leg, enter commodity, SCU amount, maximum container size, pickup
   location, and dropoff location.
4. Use the built-in cargo grid when the selected ship has one, or open the grid
   editor and define compartments manually.
5. Optionally enable split delivery on a leg that cannot fit into the selected
   gridded ship in one atomic load.
6. Let the worker solver compute a route and loadout.
7. Follow the generated route timeline and per-box load/unload checklist.
8. Use the 3D cargo view to inspect current cargo, staged cargo, next-step
   ghosts, unload spotlights, and blocking geometry.

The UI stores missions, selected ship, custom grids, and handling weights in
localStorage. There is no backend.

## Repository Map

```text
src/domain/          Shared domain types and SCU box catalog
src/data/            UEX-derived locations, orbits, distances, ships
src/ships/           Built-in ship cargo grids and grid import/export
src/optimizer/       Routing, 3D oracle, handling cost, verification tests
src/components/      Mission editor, route timeline, 3D cargo/grid UI
src/state/           Local persisted state and default handling weights
scripts/             UEX data fetch script
docs/                Original design/spec/change-request documents
```

Important implementation anchors:

| Area | File |
|---|---|
| Cargo box catalog and decomposition | `src/domain/cargo.ts` |
| Shared route/loadout types | `src/domain/types.ts` |
| Ship grid definitions | `src/ships/grids.ts` |
| Distance matrix | `src/optimizer/distanceMatrix.ts` |
| Main PDTSP solver | `src/optimizer/pdp.ts` |
| Revisit-capable solver | `src/optimizer/pdpRevisit.ts` |
| 3D loading oracle | `src/optimizer/loadFeasibility.ts` |
| Handling cost measurement | `src/optimizer/handlingCost.ts` |
| Per-box checklist ordering | `src/optimizer/stepOrder.ts` |
| Witness validation | `src/optimizer/witnessAudit.ts` |
| Loadout rendering transform | `src/optimizer/loadout.ts` |
| Solver worker | `src/optimizer/routeWorker.ts` |

## Domain Model

### Locations and Distances

Locations come from UEX-derived data. A location has an orbit id. Distance is
computed over an undirected orbit graph:

```text
same orbit             -> 0 Gm
direct UEX edge        -> edge distance
no direct edge         -> all-pairs shortest path
disconnected or unknown -> finite penalty
```

The finite penalty prevents missing data from becoming either free travel or
hard infeasibility. The implementation is Floyd-Warshall over orbit nodes in
`src/optimizer/distanceMatrix.ts`.

### Cargo Requests

A cargo leg is the atomic request:

```text
i = (pickup_i, dropoff_i, scu_i, maxBoxScu_i)
```

The SCU demand is decomposed into standard Star Citizen cargo boxes by
largest-first greedy decomposition:

```text
B_i = decomposeToBoxes(scu_i, maxBoxScu_i)
```

The standard catalog is:

| SCU | Dimensions `[x, y, z]` |
|---:|---|
| 32 | `[8, 2, 2]` |
| 24 | `[6, 2, 2]` |
| 16 | `[4, 2, 2]` |
| 8 | `[2, 2, 2]` |
| 4 | `[2, 2, 1]` |
| 2 | `[1, 2, 1]` |
| 1 | `[1, 1, 1]` |

Only yaw rotation in the X/Y plane is allowed. Boxes are not laid on their side,
and rotation during extraction is not part of the v1 model.

### Ships and Compartments

A ship may have a physical cargo grid. When a grid exists, its cell count is the
authoritative capacity:

```text
capacity(ship) = gridCapacity(compartments)
```

This overrides the ship's nominal UEX SCU, because UEX provides cargo capacity
but not cargo-bay geometry.

Each compartment has:

```text
offset:        global grid offset
dims:          [width, depth, height]
maxBoxScu:     optional maximum single box size
priority:      packing order bias
blockingModel: "vertical+depth" | "vertical" | "none"
openingAxis:   "+x" | "-x" | "+y" | "-y"
```

Blocking models:

| Model | Meaning |
|---|---|
| `vertical+depth` | Horizontal door/ramp. A box can be blocked by cargo above it or cargo between it and the door. |
| `vertical` | Top-open pod. A box can be blocked by cargo above it, but not by horizontal depth. |
| `none` | Independent access. Extraction blocking is ignored, but support and overlap rules still apply. |

Built-in grids currently cover RAFT, Prowler Utility, Railen, Ironclad Assault,
and Ironclad variants.

## Mathematical Problem Statement

Let `R = {1..n}` be the set of cargo requests. Request `i` has pickup `p_i`,
delivery `d_i`, and box multiset `B_i`. A plan chooses:

1. An event order over one pickup and one delivery event for every request.
2. A physical placement pose for every box.
3. A per-box operation order inside each stop.

A box pose is:

```text
pose(b) = (compartment, anchor, yaw)
```

where `anchor` is the integer min-corner cell and `yaw` is one of the allowed
X/Y orientations.

The goal is to minimize:

```text
F(plan) = sum travel_distance + sum handling_cost
```

subject to the hard physical rules below.

## Formal Semantics

### A1. Full-Base Support

Every resident box must have its entire bottom face supported by the compartment
floor or by the top faces of boxes at exactly the same height. Partial support
and overhang are not allowed. Support may be provided by multiple boxes together.

This applies to final resident poses. A box being moved is considered held.

### A2. No Rehandling

An operation may add or remove exactly one box. It may not temporarily move any
other box.

### A3. On-Top Blocking

If any box rests on top of box `b`, then `b` cannot be moved.

The current implementation uses a conservative vertical blocking relation: cargo
above the same `(x, y)` footprint blocks, even when the formal spec's narrower
"actually rests on" condition might allow more bridge-like cases.

### A4'. Straight-Line Insertion and Extraction

A box may be inserted or extracted only by sliding in a straight line along the
opening axis.

For a box `b`, its corridor `Cor(b)` is the set of cells swept by translating
the box along the door axis until it is fully outside the compartment, excluding
the box's own resident cells.

Extraction is possible iff:

```text
A3 passes and Cor(b) is empty
```

Insertion is the time reverse:

```text
the same corridor is empty at insertion time
and the final pose satisfies A1
```

The door is modeled as the whole opening face. There is no smaller aperture mask
in v1.

### A5. Withdrawn Visibility Rule

An older hard rule attempted to model tractor-beam visibility. It was removed.
Ship-dependent reach, operator access, and line-of-sight parameters made it
non-general. The project instead treats beam handling risk as a soft handling
cost through `G`.

### A6. Event Model

The plan has one pickup event and one delivery event for each request. Pickup
must precede delivery. Physical locations may be revisited. There is no depot,
no closed tour requirement, and no return-to-base cost.

Within one physical stop:

```text
all unloads happen before all loads
```

This is both natural operational behavior and a lossless normal form under the
structural theorems.

### A7. Request Atomicity

A request's boxes must all be loaded during one pickup visit and unloaded during
one delivery visit. Quantity splitting is forbidden by default.

This prevents degenerate plans like "leave 1 SCU behind only because it makes
the loadout easier, then make a separate trip for it."

### A7'. Opt-In Split Delivery

If a request cannot fit into an empty ship in one atomic load, the user may
opt into preprocessing that splits the request into the minimum deterministic
sequence of atomic sub-requests. The core planner still sees only atomic
requests.

Current code applies this to gridded-ship legs that fail an empty-grid packing
check and verifies that every produced chunk can be loaded into an empty grid.

## Structural Results

The design documents contain several useful theorems. They are not academic
decoration; they explain why the implementation is shaped the way it is.

### Theorem 1. Column Prefix Invariant

From an empty state, any valid sequence of insertions and extractions leaves each
grid column `(x, y)` occupied as a bottom prefix:

```text
occupied column = [0, H(x, y))
```

There are no holes under resident cargo. This follows from full-base support on
insertion and on-top blocking on extraction.

Implementation consequence: a heightmap is a complete geometric representation
for support heights, though cell-level box identity is still needed to identify
blockers.

### Theorem 2. Placement Height Uniqueness

Given an `(x, y)` anchor and yaw, the only valid support height is the common
height of all footprint columns. If the footprint columns have different
heights, the pose is unsupported.

Implementation consequence: placement search is effectively 2D times yaw, not
arbitrary 3D.

### Theorem 3. No Insertion Under Existing Cargo

A valid insertion can only place a box above all existing boxes sharing its
footprint. "Sliding a box underneath" existing cargo is not representable.

### Theorem 4. Extraction Monotonicity

If a box is extractable in state `S`, removing some other box cannot make it
less extractable.

For a set of boxes to unload at one stop, a greedy "remove any currently
extractable box" process is complete for feasibility. It is not necessarily
optimal for handling effort, which is why an explicit operation checklist still
matters.

### Theorem 5. Unload-Before-Load Normal Form

If any valid interleaving of same-stop unload and load operations exists, then
the order "all unloads, then all loads" also exists and is no worse for handling.

This justifies the stop semantics used by both the oracle and route UI.

### Theorem 6. Feasibility Characterization

Under whole-face doors and request atomicity, an instance is feasible iff:

1. Relevant locations are connected in the orbit graph, and
2. Each request's entire box set can be packed into an empty ship.

Interactions between different requests can increase cost and force revisits,
but they do not create absolute impossibility when revisits are allowed. The
single-request shuttle plan is the fallback constructive proof.

### Theorem 7. Blocking Pairs and Interval Structure

For two placed boxes `i` and `j`, define:

```text
j blocks i iff
  cells(j) intersects Cor(i)
  or j is vertically above i under the blocking model
```

For every blocking pair, their onboard intervals must be nested or disjoint:

```text
j loaded after i and delivered before i   -> nested, LIFO-compatible
or
j and i are never onboard together        -> disjoint
```

Partial overlap is invalid because one endpoint of the blocked box's interval
would require moving through an occupied corridor or under stacked cargo.

Implementation consequence: once poses are fixed, operation order can be derived
as a deterministic topological order over blocking pairs. That is what
`src/optimizer/stepOrder.ts` does for checklist generation.

## Accessibility and Oracle Model

The oracle answers: given a route timeline, can the cargo be placed so that all
load and unload operations are executable without rehandling?

The core verdict type is:

```text
feasible          -> includes a placement witness
infeasible-proven -> includes a reason
unknown-budget    -> search budget ended; not an impossibility proof
```

The `unknown-budget` distinction is essential. A budgeted DFS that fails to find
a witness has not proved no witness exists.

### Current Oracle Implementation

The current implementation uses a deterministic backtracking DFS:

1. Build route items with `loadStop` and `deliverStop`.
2. Apply fast certificates such as peak load exceeding grid capacity or a box
   fitting no compartment.
3. Process stops in order.
4. At each stop, unload first, then load that stop's boxes as a batch.
5. Generate candidate placements across valid compartments.
6. Check support, overlap, delivery-side LIFO validity, and insertion-side
   corridor validity.
7. Return the full committed placement witness if solved.

The current code does not yet implement the full future depth-map/bitset
incremental oracle described in the design document. It uses occupancy arrays
and DFS with deterministic node budgets. The depth-map and Zobrist/undo design
remain roadmap items.

### Insertion-Side Symmetry

The change-request document identified a historical gap: extraction was checked,
but insertion corridors were not always enforced. The current code includes
`insertOk`, which rejects a candidate if older onboard cargo already occupies
the candidate's insertion path.

Same-stop load batches are exempt from this older-cargo rule because their
internal order is chosen by the batch search.

## Handling Cost

The handling model is intentionally soft. Hard feasibility decides whether a
straight slide is physically allowed; handling cost decides how annoying or risky
that slide is.

For one operation:

```text
h = alpha * L + delta * G
```

where:

- `L` is the slide length to fully exit or enter through the door/rim.
- `G` is the accumulated lateral cargo-cell contact exposure during the slide.

`G` counts other cargo, not walls, floor, ceiling, or door frame. Structural
contact is treated as stable guidance. Cargo contact is risky because tractor
beam handling is closer to pulling a loosely held object than moving a perfectly
rigid fixture.

Examples from the formal spec:

| Case | Interpretation |
|---|---|
| RAFT wall-guided slide | `G = 0`, because only structure is adjacent. |
| Final tight placement beside another cargo row | small positive `G`, because only the final segment has cargo exposure. |
| A long `101/111/111` tunnel pattern | high `G`, because the moving box is exposed to cargo on several sides for many slide steps. |

Handling is measured from the final witness in
`src/optimizer/handlingCost.ts`. The planner uses:

```text
F = distance + (alphaMilli * totalL + deltaMilli * totalG) / 1000
```

Default values:

```text
DEFAULT_ALPHA_MILLI = 40
DEFAULT_DELTA_MILLI = 160
```

Calibration intent:

- Total handling should usually be roughly 10-30 percent of travel cost on
  representative cases.
- `delta` should be a single-digit multiple of `alpha`.
- Handling should influence route choice without drowning out travel distance.
- `alpha = delta = 0` recovers legacy distance-only routing.

## Objective Function

The full objective is:

```text
F(plan) = sum_{consecutive stops} dist(a, b)
        + sum_{operations} (alpha * L_op + delta * G_op)
```

Properties:

- Every accepted request is mandatory.
- The base number of request events is fixed: one pickup and one delivery per
  atomic request.
- Revisit count has no direct penalty. Revisits are priced through travel and
  handling.
- Same-orbit travel may be zero. In such cases, splitting at the request level
  can be naturally optimal. A7 prevents splitting below the request level.
- Tie-breaking is part of determinism. Candidate enumeration, stable sorting,
  integer fixed-point weights, and node budgets are preferred over wall-clock
  dependent behavior.

## Solver Architecture

### Gridless Mode

When no cargo grid is available, the solver treats the ship as scalar SCU
capacity. Distinct physical stops are optimized as a pickup-and-delivery route:

- Small enough instances use sparse Held-Karp exact search.
- Larger instances use heuristic nearest-neighbor seeding and local relocation.
- Capacity and pickup-before-delivery precedence are enforced.

This mode cannot reason about physical loadout or extraction.

### Gridded Mode

When a cargo grid is available, physical feasibility is route-order dependent.
Held-Karp dominance over `(visited mask, last stop)` is unsound because two
routes with the same visited set and last stop can have different onboard cargo
geometry.

The current gridded flow is:

1. Generate a single-visit route candidate with the PDTSP heuristic.
2. Generate a revisit-capable candidate with event-level `pdtsp-l`.
3. Gate candidates through the hard 3D oracle.
4. Score feasible candidates by `F`.
5. Choose the best candidate.
6. Attempt witness-quality repacks with destination zoning and mission
   clustering.
7. Recompute checklist and handling from the final witness.

### Future Architecture From the Design Document

The design document describes a fuller three-layer architecture:

| Layer | Role |
|---|---|
| Layer 0 | Packing/retrieval oracle: heightmap, depth-map, bitsets, blockers, undo, deterministic feasibility and handling scans. |
| Layer 1 | Constructive planner: baseline single-request shuttles, then merge or insert requests only when the oracle and objective allow it. |
| Layer 2 | Optional improvement: LNS/ALNS-style search that improves distance without degrading handling feasibility. |
| Anchor | CP-SAT or exact small-instance model for validation only. |

The current repository has a practical subset of this architecture, not the full
future version.

## Current Spec-to-Code Status

The change-request document listed five gaps. Current working-tree status:

| Gap | Requirement | Current status |
|---|---|---|
| G1 | Enforce insertion corridor, not only extraction corridor. | Implemented with `insertOk` in `loadFeasibility.ts`. |
| G2 | Produce executable stop-internal operation order. | Implemented with topological `computeOpOrder` and `buildRouteSteps`. |
| G3 | Replace pure distance objective with `distance + handling`. | Implemented in `pdp.ts`, `pdpRevisit.ts`, and `handlingCost.ts`. |
| G4 | Use deterministic oracle and route budgets. | Oracle verdicts use node budgets; route heuristics use deterministic candidate budgets. |
| G5 | Support opt-in split for empty-grid-infeasible atomic legs. | Implemented for gridded legs with empty-grid chunk verification. |

Known intentional conservatism:

- Vertical blocking is stronger than the strict formal "rests-on" relation.
- Bridge-like placements that may be valid in the mathematical spec can still be
  rejected by the current oracle and audits.
- This is accepted for v1 because relaxing it touches the oracle, independent
  audits, UI simulation, and test fixtures together.

## Verification

The project uses ordinary unit tests plus specialized verification harnesses.

Core invariants:

- No overlap.
- No floating cargo.
- In-bounds placement.
- Full-base support.
- Pickup precedes delivery.
- Delivered boxes are no longer onboard.
- Grid capacity is not exceeded.
- Oracle `unknown-budget` is not treated as `infeasible-proven`.
- Feasible witnesses can be replayed by independent audits.
- Same route inputs produce deterministic plans under deterministic budgets.

Important test groups:

| Test area | Purpose |
|---|---|
| `loadFeasibility.test.ts` | Oracle feasibility, unknown-budget semantics, support and capacity. |
| `insertionAudit.test.ts` | Insertion/extraction model gap checks. |
| `manualAudit.test.ts` | Whether the produced checklist is executable. |
| `handlingCost.test.ts` | `L` and `G` measurement cases. |
| `pdpHandling.test.ts` | Route objective with handling weights. |
| `pdpSplit.test.ts` | A7/A7' split-delivery behavior. |
| `determinism.test.ts` | Stable output across repeated solves. |
| `railenSample.test.ts` | Golden Railen high-fill route/loadout case. |
| `verification.test.ts` | Brute-force and generated-instance comparison harnesses. |

Run the regular suite:

```bash
npm test -- --testTimeout=20000
```

Some heavy diagnostic tests are gated:

```powershell
$env:VITE_VERIFY='1'
npx vitest run src/optimizer/verification.test.ts --testTimeout=20000
```

## Data and Ship Grids

UEX data supplies locations, orbit edges, and ship metadata. It does not supply
physical cargo-bay geometry. The physical grids in `src/ships/grids.ts` are
hand-authored.

Built-in grid examples:

- Argo RAFT: one `8 x 12 x 2` bay.
- Esperia Prowler Utility: two separated `4 x 2 x 2` bays.
- Gatac Railen: six top-open external pods.
- Drake Ironclad Assault: two large `20 x 6 x 6` grids.
- Drake Ironclad: main holds plus restricted 1-SCU-only compartments.

Users can define custom grids in the app. Custom grids override the built-in
geometry for that ship in localStorage.

## UI Semantics

The route timeline shows physical stops and cargo actions. The stepper is based
on the derived per-box `opOrder`, not merely mission order. This matters because
two boxes at the same stop can block each other, and a valid route can still have
an invalid manual checklist if the stop-internal order is wrong.

The 3D cargo view is witness-based:

- It does not repack cargo just for display.
- It shows the route as executed so far.
- It stages boxes until their support exists.
- It can show the next load as ghost geometry.
- It can spotlight the next unload target.
- Mission coloring is stable across label/reward edits.

## Literature and Positioning

The problem intersects several known families:

| Literature area | Relevance |
|---|---|
| TSPPD / PDTSP | Pickup-before-delivery routing, insertion moves, local search neighborhoods. |
| TSPPD-LIFO | LIFO interval structure, blocking-preserving route moves. |
| DTSPMS | Multi-stack routing and loading decomposition. |
| 3L-CVRP | Routing with a 3D packing oracle and feasibility caching. |
| Container loading problem | Support constraints, orthogonal packing, discrete placement search. |
| 3L-PDP | Closest classical family: pickup/delivery plus 3D loading and rear-door constraints. |

What is specific here:

- Worker convenience is a first-class objective, not an incidental constraint.
- Cargo is discrete and standardized into SCU boxes.
- Full-base support is required, not a partial support ratio.
- Straight-line slide feasibility is hard, but slide effort is soft.
- Rehandling is forbidden.
- Revisit is allowed.
- Quantity splitting below request level is forbidden.

Suggested reading from the design document:

1. Maennel and Bortfeldt, 2016, EJOR 254(3)
2. Maennel and Bortfeldt, 2018, EJOR 264(1)
3. Gendreau, Iori, Laporte, and Martello, 2006, Transportation Science 40(3)
4. Carrabs, Cordeau, and Laporte, 2007
5. Cordeau, Iori, Laporte, and Salazar-Gonzalez, 2010
6. Bortfeldt and Waescher, 2013, EJOR 229(1)
7. Petersen and Madsen, 2009
8. Battarra, Erdogan, Laporte, and Vigo, 2010
9. Iori and Martello, 2010

## Roadmap

The design roadmap is organized by independently useful milestones:

| Milestone | Goal | Completion standard |
|---|---|---|
| M0 | Strong oracle implementation with heightmap, depth-map/bitsets, corridor checks, support, blocking pairs, undo, and deterministic budgets. | Invariant tests, formal examples, and small brute-force comparisons pass. |
| M1 | Constructive planner using baseline-merge or paired insertion with door-aware placement. | Always emits an executable plan for generated feasible instances, with independent verifier pass. |
| M2 | Convenience-preserving improvement layer. | Same time budget improves `F` over M1 without violating invariants. |
| M3 | Exact/anchor and benchmark harness. | Small instances have ground-truth comparisons and regression benchmarks. |

Current implementation already covers a practical subset:

- React 19 + TypeScript + Vite UI.
- Three.js cargo/grid visualization.
- Web Worker route solving.
- Gridless exact/heuristic PDTSP.
- Gridded oracle-gated PDTSP and revisit-capable `pdtsp-l`.
- Handling cost objective.
- Split-delivery preprocessing for empty-grid-infeasible gridded legs.
- Witness-based checklist and 3D execution view.

Remaining larger work:

- Replace or supplement occupancy DFS with the planned depth-map/bitset oracle.
- Add stronger incremental route-neighborhood validation using blocking-pair
  interval arithmetic.
- Add baseline-merge planner mode.
- Add LNS/ALNS improvement operators that preserve handling quality.
- Add exact small-instance anchor for gap measurement.
- Revisit conservative vertical blocking only if the benefit justifies touching
  all validators.

## Open Parameters and Extension Points

Stable v1 user-facing parameters:

- `alpha`: base slide-length handling weight.
- `delta`: cargo-exposure handling weight.
- `allowSplit`: opt-in split delivery for truly empty-grid-infeasible atomic requests.

Reserved extension points:

- Docking or stop-count cost `gamma`.
- Wall-slide friction `kappa`.
- Rotating extraction tiers.
- Smaller aperture masks instead of whole-face doors.
- Structural load limits.
- Ship-specific compartment accessibility by stop.

These should be added as documented extensions, not arbitrary toggles on the
physical axioms. Toggling axioms silently invalidates theorems and oracle
contracts.

## Development Notes

The app is intentionally frontend-only. Solver state is deterministic where it
matters for correctness, and the route worker is terminated when fresher input
arrives.

Useful commands:

```bash
npm run dev       # local Vite server
npm run build     # TypeScript build plus Vite build
npm run preview   # preview production build
npm run lint      # oxlint
npm test          # vitest run
```

When changing solver semantics, update tests before trusting the UI. The UI
renders the witness it receives; it is not the authority for physical validity.
