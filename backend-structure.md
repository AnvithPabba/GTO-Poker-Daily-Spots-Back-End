# Poker Daily Trainer: Backend Architecture

## Purpose and Boundaries

This document defines the Node.js + Express + TypeScript backend, Prisma/PostgreSQL persistence, `pg-boss` queues, host-native solver integration, normalized spot storage, publication scheduler, guest attempts, and scoring.

The backend is the trust boundary. It alone can read private GTO solutions and decide official/practice status. The browser receives public challenge data before submission and solution data only in the response to a valid stored attempt.

See [../../overall-structure.md](../../overall-structure.md) for the ordered implementation roadmap, [../frontend/frontend-structure.md](../frontend/frontend-structure.md) for client behavior, and [../../Solver/solver-structure.md](../../Solver/solver-structure.md) for raw tree extraction and reach propagation. The detailed archive-to-PostgreSQL handoff and public/private read flows are in [../../storage-and-retrieval.md](../../storage-and-retrieval.md).

### Current implementation boundary

Blocks 3–7A are implemented as a local backend foundation: the Prisma schema
and migration, archive/import command, provider normalization and validation,
Pacific publication/replenishment jobs, public read endpoints, guest
completion hints, synchronous attempt scoring, and their unit/database/full-
containers receive only normalized artifacts through the private ingestion
boundary. The exact operator procedure is
[`docs/spot-ingestion.md`](docs/spot-ingestion.md).

Blocks 8–14 now include the runnable React-facing v2 boundary, provider-backed
account history, cookie rotation, loopback admin calendar/job controls with
append-only audit records, filesystem archive/checksum ports, cache/metrics
ports, and deterministic load smoke tests. External OIDC/JWKS, object storage,
Prometheus, CDN, and multi-replica deployment adapters remain explicit
provider injection points rather than hidden local implementations.

The implemented v2 contract removes the old public mode split. Every spot has
one required featured concrete hand, a selectable catalog
of one to twenty concrete hands, and explicit hero/dealer/position/chip
presentation metadata. Frequencies and reached ranges remain private JSONB.

## Runtime Responsibilities

Use the same backend codebase with separate process roles:

- **API process:** Public reads, guest/account sessions, synchronous attempt validation/scoring, and localhost admin APIs.
- **Scheduler/worker process:** `pg-boss` schedules, buffer checks, publication, cleanup, and non-native background work.
- **Host solver worker:** A Mac-native process that uses the ownership-checked lease helpers, invokes `console_solver`, archives output, selects candidates, normalizes payloads, and reports heartbeats/results.
- **PostgreSQL:** Prisma application state and `pg-boss` durable queue state.
- **Raw archive:** Append-only filesystem/object storage for solver inputs, outputs, and logs; PostgreSQL stores logical archive keys/checksums, never absolute machine paths; never a public static directory.

Scoring requests are small deterministic calculations and remain synchronous in the API transaction flow. Do not enqueue them.

## Module Boundaries

Planned backend modules should separate concerns even if version 1 deploys them together:

```text
http/
  public spot and attempt controllers
  localhost admin controllers and middleware
application/
  spot query, attempt, publication, template, job, and admin services
domain/
  lifecycle rules, scoring registry, candidate ranking, and normalized contracts
infrastructure/
  Prisma repositories, pg-boss adapters, archive adapter, clock, hashing, logging
solver-worker/
  input generation, native process runner, tree adapter, reach engine, normalizer
```

Controllers parse and validate transport data, call application services, and map typed errors. They do not query Prisma directly or implement scoring/lifecycle decisions.

## API Conventions

- Prefix version 1 routes with `/api/v1`.
- Use JSON, UTC RFC 3339 timestamps, UUID/ULID-style opaque IDs, and Pacific `YYYY-MM-DD` publication dates.
- Validate requests and responses with shared Zod schemas. Private schemas remain backend-only.
- Use a consistent error envelope with `code`, `message`, `requestId`, and optional field issues.
- Require an idempotency key for attempt POSTs and mutation-style admin actions where retries could duplicate work.
- Use cursor pagination for archive, jobs, runs, and logs.
- Return ETags on public GETs. Immutable spot-version responses can use long-lived public caching; today's index uses short caching and revalidation.
- Never accept a client-provided score, official/practice flag, GTO vector, publication status, or guest ID.

## Public Endpoints

### `GET /api/v1/spots/today`

Returns the current Pacific publication date and its published spots ordered by `slotOrder`.

```ts
type TodayResponse = {
  publicationDate: string;
  timezone: "America/Los_Angeles";
  isFallback: boolean;
  fallbackFromDate?: string;
  spots: PublicSpotSummary[];
};
```

If no slot is published for the current date, return the latest published date's spots with `isFallback: true`, preserve their actual publication date, and emit/deduplicate an operational alert. Do not synthesize a current-date completion.

### `GET /api/v1/spots/:id`

Returns one currently published spot's immutable public `SpotVersion` payload. The `id` is the public spot ID; the response includes the immutable `spotVersionId` required by submissions. Unpublished, held, rejected, or superseded-only records are not publicly readable.

### `GET /api/v1/spots/archive`

Returns published spot summaries grouped or filterable by Pacific date. Planned query parameters include `cursor`, `limit`, `from`, and `to`. When a guest cookie resolves, summaries may include completion state for that guest without exposing attempts from another guest.

### `POST /api/v1/spots/:id/attempts`

Validates and synchronously scores the featured hand plus any selected optional
concrete hands against the requested immutable version.

```ts
type AttemptRequest = {
  spotVersionId: string;
  idempotencyKey: string;
  hands: Array<{
    combo: string;
    allocations: Record<string, number>;
  }>;
};
```

Every allocation is an integer number of basis points and every hand totals
exactly `10_000`. The v2 contract accepts one through twenty unique concrete
combos from the public selectable set, requires the featured combo, and ignores
every unselected combo.

The successful response is the first point where solution data may be returned:

```ts
type AttemptResponse = {
  attemptId: string;
  official: boolean;
  metric: { key: string; version: number };
  aggregator: { key: "equal_average"; version: number };
  overallSimilarity: number;
  hands: Array<{
    combo: string;
    similarity: number;
    gtoMajorityActionId: string;
    actions: Array<{
      actionId: string;
      submittedBasisPoints: number;
      gtoBasisPoints: number;
      signedDifferenceBasisPoints: number;
      absoluteDifferenceBasisPoints: number;
    }>;
  }>;
};
```

An idempotent replay returns the originally stored response. A new idempotency key after the official attempt creates a practice attempt.

## Localhost-Only Admin Endpoints

All routes below live under `/api/v1/admin`, use the same application services as jobs/schedulers, and fail closed unless the direct peer is loopback. Do not trust `X-Forwarded-For` unless an explicitly configured trusted local proxy is present. Bind the prototype admin listener to loopback where practical.

| Method and route | Purpose |
| --- | --- |
| `GET/POST /templates` | List or create versioned solver templates |
| `GET/PATCH /templates/:id` | Inspect or revise editable template metadata/config by creating a new version |
| `GET/POST /jobs` | List/filter jobs or enqueue a template |
| `GET /jobs/:id` | Attempts, timing, worker heartbeat, and failure detail |
| `POST /jobs/:id/retry` | Explicitly start a fresh retry cycle after allowed states |
| `POST /jobs/:id/hold` | Prevent claim/publication flow without deleting audit history |
| `DELETE /jobs/:id` | Remove only a safely removable queued job; retain audit record |
| `POST /jobs/reorder` | Atomically update authoring queue priority/order |
| `GET /runs/:id` | Run metadata, bounded logs, archive reference, checksums, candidates |
| `GET /drafts` | List candidate/spot versions awaiting validation or approval |
| `GET /drafts/:id/preview` | Admin-only public preview plus clearly separated private inspection |
| `POST /drafts/:id/validate` | Rerun versioned validation without changing solution data |
| `POST /drafts/:id/approve` | Guarded transition from validated to approved |
| `POST /drafts/:id/reject` | Reject with reason while retaining provenance |
| `GET /publication-slots` | Calendar, ordered slots, gaps, and buffer metrics |
| `POST /publication-slots` | Schedule an approved immutable version |
| `PATCH /publication-slots/:id` | Hold, reorder, or reschedule before publication |
| `DELETE /publication-slots/:id` | Unschedule safely and return version to approved state |

Every admin mutation records actor/source, request ID, before/after state, reason where required, and timestamp in an audit record. Direct frequency editing is intentionally unsupported.

## Public and Private Spot Contracts

Store public and private JSONB separately on an immutable `SpotVersion`. Never create public JSON by deleting keys from a private object at request time.

### Public payload

- Schema/normalizer version and public identifiers.
- Initial table state, ordered normalized history, and exact decision state.
- Legal actions in strategy order, each with a payload-local ID and parsed semantics.
- Required featured concrete combo and an explicit selectable concrete-combo catalog containing it.
- Hero actor, dealer actor, IP/OOP position labels, holding visibility, and chip unit so the client never infers presentation semantics.
- Only UI-safe reach/selectability metadata that cannot expose the answer.

### Private payload

- Same identity/action order for consistency checks.
- GTO frequencies per eligible concrete combo.
- Raw and normalized reached-range weights for both players.
- Candidate/featured-combo ranking evidence.
- Scoring metric and aggregator keys/versions.
- Majority-action/explanation inputs and normalization audit data.

A dedicated leakage test recursively scans every public response/fixture and fails on known private fields or probability arrays in strategy-like locations.

## Prisma Data Model

The field list below is both the semantic model and the implemented Prisma
model in `prisma/schema.prisma`; the SQL migration adds the partial unique
indexes and immutable-payload trigger that Prisma cannot express alone.

### `SolverTemplate`

- `id`, stable family ID, and monotonically increasing `version`.
- `name`, optional description/tags, `status` (`active`, `held`, `retired`).
- `config` JSONB validated against a versioned private schema.
- `configSchemaVersion`, `selectionRankingVersion`, deterministic default seed policy.
- `createdAt`, `updatedAt`, and optional `supersedesTemplateId`.
- Unique `(familyId, version)`.

### `SolverJob`

- `id`, `templateId`, effective seed, priority/order, and `status` (`queued`, `running`, `retry_wait`, `succeeded`, `failed`, `held`, `cancelled`).
- `attemptCount`, `maxAttempts` fixed to three initially, `nextAttemptAt`.
- Worker lease/heartbeat fields, last error code/message, enqueue/start/finish timestamps.
- Optional pointer to successful run and `pg-boss` job identity.
- Index `(status, nextAttemptAt, priority, createdAt)` for claiming/administration.

### `SolverRun`

- `id`, `jobId`, attempt number, solver version/platform, immutable resolved input JSONB.
- Start/finish/duration/exit status and bounded log references.
- Input/output SHA-256, archive input/output/log references, archive verification timestamp.
- Normalizer/selector versions and structured failure details.
- Unique `(jobId, attemptNumber)` and unique successful output checksum where appropriate.

### `Spot`

- `id`, stable public identity, title/metadata/tags, and lifecycle status summary.
- The former `mode` column is removed by the v2 forward migration because every
  spot supports the same featured-hand-plus-optional-extras behavior.
- `createdAt`, `updatedAt`, optional current approved/published version relation.
- Contains no mutable solution frequency.

### `SpotVersion`

- `id`, `spotId`, version number, `solverRunId`, candidate/path manifest JSONB.
- `schemaVersion`, `normalizerVersion`, `selectionRankingVersion`.
- `publicPayload` JSONB and `privateSolutionPayload` JSONB in separate columns.
- Payload SHA-256 values, `status` (`draft`, `validated`, `approved`, `scheduled`, `published`, `rejected`, `superseded`).
- Validation report/version, creation/validation/approval timestamps.
- Unique `(spotId, version)`; immutable payloads after creation.

### `PublicationSlot`

- `id`, `publicationDate` as a Pacific calendar date, `slotOrder` integer, `spotVersionId`.
- `status` (`scheduled`, `held`, `published`, `cancelled`), scheduled/published timestamps.
- Unique active `(publicationDate, slotOrder)` and unique active `spotVersionId`.
- Index `(status, publicationDate, slotOrder)` for today's query and buffer count.

### `GuestSession`

- `id`, hash of opaque cookie token, creation/last-seen/expiry timestamps, optional rotation lineage.
- Revocation timestamp and minimal abuse-control metadata.
- Never store or log the raw cookie token.

### `Attempt`

- `id`, `guestSessionId`, `spotId`, immutable `spotVersionId`.
- Optional `accountId` is a separate authenticated owner; account and guest
  histories never merge.
- `official` boolean, `practiceOrdinal`, idempotency key.
- Validated submission JSONB, result JSONB, overall score.
- `metricKey`, `metricVersion`, `aggregatorKey`, `aggregatorVersion`.
- Created timestamp and optional request metadata that respects privacy policy.
- Unique `(guestSessionId, spotVersionId, idempotencyKey)`.
- A database-enforced partial unique constraint for one official attempt per `(guestSessionId, spotVersionId)`; add with SQL migration if Prisma cannot express it directly.
- Indexes for guest archive completion/history and spot analytics.

`Account` stores the provider subject, optional email, and role JSON. Its
official-attempt uniqueness and idempotency constraints mirror the guest
constraints while retaining separate histories.

Lifecycle/audit events may use a separate append-only audit table during implementation. They should not be overloaded into mutable JSON logs on these records.

## Solver Template Contract

A template is declarative and versioned. It must capture enough information to reproduce both the solve and candidate choice:

### Game and ranges

- Initial pot and effective stack in one documented chip unit.
- Position mapping and acting player at the root.
- OOP and IP configured range strings or canonical expanded weights.
- Initial street/board rules and excluded cards.

### Board generation

- Fixed cards plus suit/rank/texture constraints for generated cards.
- Deterministic random seed and board generator version.
- Duplicate/blocker validation and bounded generation attempts.

### Tree configuration

- Street-specific OOP/IP bet sizes, raise sizes, donk sizes where supported, and all-in options.
- A clear unit for sizes: pot fraction, absolute chips, geometric choice, or all-in semantic value.
- No application field named after a particular amount such as `oopBet25`.
- Accuracy/exploitability target, threads, iteration cap, print interval, and dump depth/rounds.

### Candidate policy

- Preferred target street and actor.
- Semantic history pattern such as actor + action type + optional sizing band; never a Python attribute chain.
- Minimum hero and opponent reach mass.
- Mixed-strategy requirements: minimum number of material actions, minimum action frequency, and minimum normalized entropy.
- Featured-combo and selectable-combo constraints.
- Selection/ranking version and deterministic tie seed.

Templates should be rejected before enqueue if their units are ambiguous, ranges cannot expand, board constraints are impossible, or dump depth cannot reach the target street.

## Local Solver Job Pipeline

1. Scheduler or admin enqueues a versioned template reference and resolved seed in `pg-boss`.
2. The host worker claims it with a lease, persists `running`, and sends heartbeats.
3. It resolves and freezes template configuration, then writes a solver input artifact without interpolating untrusted shell text.
4. It runs the Mac-native solver in an isolated working directory and captures stdout, stderr, exit code, solver version, and timings.
5. It validates that output exists and is structurally readable, then hashes and archives input/output/logs.
6. It enumerates candidates, normalizes public/private payloads, and stores a draft version with provenance.
7. Automated validation transitions the version to `validated`; admin approval transitions it to `approved`.
8. On a recoverable failure, `pg-boss` reschedules with exponential backoff until three total attempts have run.
9. The third failure marks the job `failed`, emits an alert, releases its lease, and leaves unrelated jobs claimable.

Suggested delays are one minute after attempt one and five minutes after attempt two, stored/configured rather than assumed by UI. Re-running a permanently failed job starts a new audited retry cycle; do not erase previous runs.

## Automatic Candidate Selection

### Enumeration and reconstruction

Walk the complete serialized solver tree through explicit decision/chance/terminal cursors. At every decision node:

1. Verify `actions` and `strategy.actions` have identical order and values.
2. Verify each strategy vector length equals the action count and sums to one within tolerance.
3. Replay the path from solver input to reconstruct board, street, actor, pot, stacks, commitments, call amount, and all-in state.
4. Expand both configured ranges, apply board blockers, multiply reach by chosen prior action frequencies, and apply dealt-card blockers.
5. Retain raw reach mass for eligibility/auditing and normalized reach for display/ranking.
6. Detect dump truncation separately from a legitimate terminal action.

### Hard rejection

Reject a candidate if any of these hold:

- Node is not a decision or lacks a complete strategy table.
- Board/cards/history are malformed or blocked.
- Pot, stacks, contributions, actor, or all-in continuation is inconsistent.
- Either player's total reach is zero or below the configured hard minimum.
- Required source path lies beyond `dump_rounds` or has an unexplained missing continuation.
- No eligible hero combo has meaningful reach.
- All eligible strategies are effectively pure under the template thresholds.

### Ranking

Rank in two pools:

1. **Preferred pool:** Candidates satisfying target street, actor, semantic history, reach, and mixing rules.
2. **Global fallback pool:** Every hard-valid decision candidate satisfying global safety/interest minima.

Use preferred pool if nonempty; otherwise use the fallback pool. Record that fallback occurred.

For an action vector `p` with `k` legal actions, featured-combo mixing can use normalized Shannon entropy:

```text
entropy(p) = -sum(p_i * ln(p_i)) / ln(k)
```

Treat `0 * ln(0)` as zero. Combine entropy with bounded reach and candidate-level quality using weights declared by the selection/ranking version. Prefer adequate reach over an extreme entropy score on a nearly unreachable combo. Filter illegal/blocked/zero-reach combos before scoring.

Resolve equal scores using a stable hash of `(jobSeed, sourcePath, combo, rankingVersion)`. Never use process-global randomness or traversal order as the final tie-breaker.

## Normalization and Validation

Normalization emits:

- Public history/state/action data with local action IDs `a0`, `a1`, and so on in solver strategy order.
- Private frequencies keyed by those same IDs.
- A source manifest tied to solver output SHA-256.
- Public/private schema versions plus normalizer and ranking versions.

Bet/raise `amount`, `toAmount`, and `isAllIn` derive from solver labels plus reconstructed commitments. Consumers never construct `.oop_bet_25` or guess an amount from template percentages.

Before a draft can become validated:

- Re-verify archive checksum and path manifest.
- Validate public/private JSON independently.
- Verify IDs/action orders/candidate identity agree across payloads.
- Verify every GTO vector has every action exactly once and totals `10_000` basis points or one within the chosen private representation/tolerance.
- Verify selected combos are legal, reached, unblocked, and present in private strategy.
- Verify public JSON contains no solution/reached-range private fields.
- Verify history replay reaches the stored decision state exactly.
- Verify publication metadata does not change immutable poker/solution content.

## Publication Scheduling

Use `pg-boss` for durable schedules and singleton execution.

### Replenishment

- Run daily at 6:00 PM in `America/Los_Angeles`; derive UTC execution correctly across DST.
- Count distinct future approved/scheduled unpublished spots from tomorrow onward.
- Target seven days of coverage and enqueue enough eligible templates to fill the deficit.
- Alert whenever coverage is below three, including cause and failed/queued job summary.
- Use a singleton key per Pacific date so multiple worker replicas cannot double-enqueue the nightly batch.

### Publication

- Run at Pacific midnight using a singleton key per publication date.
- In one guarded transaction, publish every eligible scheduled slot for that date in ascending `slotOrder`.
- Leave held/invalid slots unpublished and alert on gaps.
- Once published, the referenced spot-version payload remains immutable.
- If reads find no published current-date slot, return the latest published set with `isFallback: true` and raise a deduplicated alert.

The database supports multiple slots per day even while initial authoring targets one.

## Guest Session and Attempt Semantics

Generate at least 256 bits of cryptographic randomness for a guest token. Store only a keyed hash or strong token hash in PostgreSQL. Cookie behavior:

- `HttpOnly` always.
- `Secure` in production.
- `SameSite=Lax` unless a documented cross-site architecture requires otherwise.
- Narrow path/domain and bounded lifetime with safe rotation.

Submission processing:

1. Validate the public request shape and load the published immutable spot version.
2. Resolve/create the guest session and lock/serialize the official-attempt decision.
3. Validate that the featured combo is present, there are at most nineteen
   additional unique selectable combos, every legal action ID is present, and
   each allocation contains integer basis points totaling exactly `10_000`.
4. Load the private solution only inside the attempt service.
5. Score each submitted hand, aggregate, and construct the reveal result.
6. Insert attempt and decide `official` atomically under the unique constraint.
7. Return the stored result. On an idempotency conflict, return the matching prior result.

Future accounts do not claim or merge guest attempts. Authenticated and guest histories remain separate unless a later product decision and migration explicitly change that rule.

## Scoring Architecture

Use an extensible registry/factory:

```ts
interface SimilarityMetric {
  key: string;
  version: number;
  score(predicted: number[], gto: number[]): MetricResult;
}

type MetricResult = {
  similarity: number;
  signedDifferences: number[];
  absoluteDifferences: number[];
};
```

The registry resolves a key/version stored on the spot version. It rejects unknown metrics rather than silently switching algorithms.

### L1 similarity version 1

Convert basis points to normalized fractions in `[0, 1]`, ensure both vectors share legal-action order, then compute:

```text
L1 = sum(abs(predicted_i - gto_i))
similarity = 100 * (1 - 0.5 * L1)
```

For valid probability distributions, `L1` is in `[0, 2]`, so similarity is in `[0, 100]`. Store adequate precision and round only for display/transport policy. An exact match scores 100; mutually disjoint pure actions score 0.

For each action:

```text
signed difference = submitted - GTO
absolute difference = abs(signed difference)
```

The majority action is the action with greatest GTO frequency; resolve exact ties by legal-action order and label it as a tie in explanation metadata if appropriate.

### Multi-hand aggregation version 1

For `n` selected concrete hands:

```text
overall similarity = sum(hand similarity_i) / n
```

Every selected concrete hand has equal weight. Reach does not weight the version 1 result. Unselected hands are absent and ignored. Store `equal_average` and version `1` so a future reach-weighted aggregator can coexist without changing historical scores.

## Caching and Indexing

- Index published slots by status/date/order and spot versions by public ID/status.
- Index attempts by guest/version, including the official uniqueness constraint and archive-completion query.
- Index solver jobs by claimable state/time/priority and runs by job/attempt.
- Generate strong ETags from immutable public payload hashes.
- Use long public cache headers for immutable version resources and short `stale-while-revalidate` caching for today/archive indexes.
- An optional in-process or CDN cache may store public payloads only. Private solutions and guest-specific completion data are private/no-store unless a safe key strategy is proven.
- Invalidate/revalidate the mutable daily index after publication; immutable versions require no invalidation.

## Docker and Host Topology

Development/production-like containers:

- **Static frontend container:** Serves the built Vite assets and forwards API paths or uses configured same-origin API base.
- **Express API container:** Public/admin HTTP server; admin surface bound/guarded for localhost in version 1.
- **Express scheduler/worker container:** Runs `pg-boss` jobs for replenishment, publication, and maintenance.
- **PostgreSQL container:** Development database and queue store with persistent volume and health check.

Outside containers:

- **Host-native Mac solver worker:** Connects to PostgreSQL with a scoped credential, invokes the current Mac solver binary, and writes to the configured raw archive.

Do not expose PostgreSQL or the raw archive publicly. Do not copy `console_solver`, huge output JSON, guest secrets, or private solution fixtures into frontend/static images.

## Security and Operational Controls

- Rate-limit reads and attempts separately; bound request JSON, hand count, action count, and log-page sizes.
- Use secure headers, strict CORS/same-origin policy, parameterized Prisma access, and validated identifiers.
- Protect against solution probing by requiring eligible combos/action IDs and reasonable per-guest/IP limits; do not rely on hiding route names.
- Redact guest tokens, private solutions, raw ranges, and oversized solver output from structured logs.
- Treat solver files/labels as untrusted input: validate paths, avoid shell execution, and use isolated per-run directories.
- Record request IDs and canonical IDs through API, queue, worker, run, candidate, version, slot, and attempt logs.
- Monitor worker heartbeat, job age/failure rate, archive integrity, candidate rejection reasons, approval buffer, publication lag, fallback responses, API latency/error rate, and database health.
- Back up PostgreSQL and raw archive independently; test restoration and checksum reconciliation.

## Backend Testing Strategy

### Contract and unit tests

- Public/private Zod schemas and recursive leakage tests.
- Basis-point exact totals, combo/action uniqueness, and one-to-twenty range boundaries.
- L1 known vectors, bounds, action-order alignment, signed/absolute deltas, majority ties, and equal average.
- Semantic history matching, entropy/reach ranking, deterministic tie-breaking, and global fallback.
- Pot/stack/all-in reconstruction, blockers, reached ranges, terminal-versus-truncated detection, and dynamic bet sizes.
- Pacific schedule calculations across both DST transitions.

### Database and service integration tests

- Fresh migration, constraints, partial official-attempt uniqueness, slot uniqueness, and immutable-version guards.
- Concurrent first submissions produce exactly one official attempt.
- Idempotent submit returns the original result without duplicate rows.
- Valid lifecycle transitions succeed; skips/rewrites fail.
- Three solver attempts back off and permanently fail while another job continues.
- `pg-boss` singleton replenishment/publication jobs do not duplicate work.
- No-current-date query returns the latest published set with fallback flag and alert.

### API tests

- Today, individual spot, archive pagination, not-found, ETag/304, and fallback responses.
- GET response never contains GTO frequencies or private reach data.
- Attempt rejects unknown/stale version, blocked/unknown combo, unknown/missing action, floats, duplicate combos, 0/21 hands, or totals other than `10_000`.
- Attempt success returns all action comparisons and correct official/practice status.
- Local admin rejects non-loopback access and validates every mutation/transition.

### End-to-end worker tests

- Small real solver run produces a verifiable archive and deterministic normalized draft.
- Same checksum/path/seed/version reproduces the same payload.
- Corrupt archive, malformed output, insufficient dump depth, and no-interest candidate fail safely.
- Preferred candidate selection and global fallback are both exercised.
- Admin approval/scheduling reaches publication without allowing solution mutation.

## Backend Completion Checklist

The local implementation covers the Blocks 3–14 application boundary. External
providers and production drills remain deployment gates; they are not implied
by the Compose image.

- [x] All versioned public and localhost admin endpoints match shared contracts (admin mutations remain loopback guarded).
- [x] `SolverTemplate`, `SolverJob`, `SolverRun`, `Spot`, `SpotVersion`, `PublicationSlot`, `GuestSession`, and `Attempt` have migrations and constraints.
- [x] Public and private payloads are independently stored and validated.
- [x] GET paths cannot query/serialize solution frequencies.
- [x] Dynamic action sizes are normalized data with payload-local IDs.
- [x] Solver failures have a three-attempt exponential-backoff policy and do not block independent queued templates; native queue consumption remains the private host-worker boundary.
- [x] Candidate selection prefers template matches, then globally ranked valid decisions, with deterministic ties.
- [x] Invalid, truncated, blocked, zero-reach, and uninteresting nodes cannot publish.
- [x] Replenishment runs at 6:00 PM Pacific, targets seven days, and warns below three.
- [x] Publication is singleton at Pacific midnight and supports ordered multi-spot days.
- [x] Missing current-date content returns latest published with an explicit fallback flag and warning.
- [x] First accepted guest attempt is official and later attempts are practice under serializable transaction/unique constraints.
- [x] The current runtime enforces exact `10_000` totals and one-to-twenty concrete-hand boundaries.
- [x] Block 7A requires the featured combo in every attempt, permits zero to nineteen optional extras, adds public presentation metadata, and retires the public mode distinction.
- [x] L1 and equal-average calculations match the master/frontend contracts.
- [x] Scoring stays synchronous and is not added to a queue.
- [x] Account/OIDC ports, guest/account isolation, cookie rotation, metrics, archive/cache ports, and deterministic load smoke tests are covered by unit/integration checks.
- [x] Containers exclude the native solver, raw output, secrets, and private frontend data.
