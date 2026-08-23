# Poker Daily Trainer backend

This is the private Node.js/Express service. It owns PostgreSQL JSONB
persistence, public spot reads/submissions, scoring, archive verification, and
the scheduler foundation. The native TexasSolver process remains on the Mac
host; Docker receives normalized imports, never the binary or raw archive.

## Local package checks

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:unit
pnpm test:load
```

The full `pnpm test` command includes a schema-drift regression test. It checks
that `prisma generate` remains a pre-step for every TypeScript compile/test
entry point and that the `AttemptValidity` model fields remain paired with the
committed migration.

The backend consumes the reviewed `@poker-trainer/contracts@0.3.1` tarball from
`vendor/`, making this repository and Docker build independent of sibling
source. npm publication still requires explicit approval; after publication,
replace the tarball spec with exact registry version `0.3.1`.

### Prisma schema/client synchronization

`prisma/schema.prisma` is the source of truth for database types. Whenever the
schema or a migration changes, regenerate the client with:

```bash
corepack pnpm db:generate
```

`build`, `typecheck`, and `test` run `prisma generate` automatically before
compiling, so a stale client cannot silently enter a Docker image or solver
import run. If TypeScript reports that a field is missing from a Prisma
`WhereInput`, `Select`, or model (for example `Attempt.validity`), run
`corepack pnpm db:generate` once and rerun the command. Applying migrations is
separate; generation never changes the database.

## Layers and injected boundaries

HTTP routes validate and authorize requests, then call focused domain or
infrastructure modules. `src/ports.ts` defines `SpotRepository`,
`IdentityProvider`, `ArchiveStore`, `CacheStore`, and `Clock`; in-memory fakes
are used by unit tests while Prisma/filesystem/provider adapters are used by
runtime composition. `src/errors.ts` provides typed application errors and
`src/oidc.ts` keeps bearer verification provider-neutral.

The composition root also wires a process-local metrics port and a loopback
admin audit trail. Production can replace those adapters with
Prometheus/OpenTelemetry, object storage, or a trusted OIDC verifier without
changing the public route contracts.

```mermaid
flowchart TD
    HTTP[Express routes] --> UseCases[Application operations]
    UseCases --> Domain[Scoring / publication rules]
    Domain --> Ports[Repository / archive / cache / identity ports]
    Ports --> PG[Prisma + PostgreSQL]
    Ports --> Archive[Filesystem or object archive]
    Ports --> Cache[No-op / memory / CDN cache]
```

## Runtime processes

The same image runs two separate Compose services:

- `api`: `node dist/server.js`, bound to `0.0.0.0:3000` inside the network and
  `127.0.0.1:3000` on the host;
- `worker`: `node dist/worker.js`, bound to `0.0.0.0:3001` inside the network and
  `127.0.0.1:3001` on the host.

Required runtime variable:

```text
DATABASE_URL=postgresql://<role>:<password>@<host>:<port>/<database>
```

Optional variables are `API_HOST`, `API_PORT`, `WORKER_HOST`, `WORKER_PORT`,
`CORS_ORIGIN`, `PG_BOSS_SCHEMA`, and `ADMIN_TRUSTED_PROXY`. Invalid or missing values fail startup
with a concise validation error; passwords are never printed.

Health endpoints:

```bash
curl http://127.0.0.1:3000/health/live
curl http://127.0.0.1:3000/health/ready
curl http://127.0.0.1:3001/health/live
curl http://127.0.0.1:3001/health/ready
```

Liveness is process-only. Readiness executes `SELECT 1` and returns `503`
when PostgreSQL is unavailable. Pool and pg-boss errors are handled so a
transient database outage does not kill either health server. SIGTERM/SIGINT
close the HTTP server, queue connection, and PostgreSQL pool gracefully.

The health app advertises only the configured origin, varies CORS responses by
origin, and allows the browser methods/headers needed for public reads and
attempt submissions. Public daily indexes use short cache lifetimes and vary
by the guest cookie; a recognized guest receives `private, no-store`
completion data so a shared cache cannot leak another player's completion
state. Unknown errors are logged server-side and returned as stable generic
error envelopes.

The deterministic load smoke test exercises a health or read endpoint without
external services:

```bash
pnpm test:load
LOAD_PATH=/api/v1/daily-games/today LOAD_REQUESTS=500 LOAD_CONCURRENCY=25 pnpm test:load
```

It reports throughput and fails on any non-2xx response; it is a baseline, not
a substitute for a production capacity test.

## Docker and host-worker boundary

The complete local stack is started from `webapp/`:

```bash
cp ../.env.example ../.env
docker compose -f ../docker-compose.yml up -d --build
```

For a new local volume, apply the schema with the development superuser (never
with `trainer_api` or `solver_worker`):

```bash
DATABASE_URL='postgresql://postgres:replace-with-a-local-development-secret@127.0.0.1:55432/poker_trainer_dev' pnpm db:migrate
DATABASE_URL='postgresql://postgres:replace-with-a-local-development-secret@127.0.0.1:55432/poker_trainer_dev' pnpm db:seed
```

`db:seed` is intentionally content-free and idempotent. It does not create a
synthetic challenge or pretend that a solver answer exists. Import a real
provider envelope with the procedure in `docs/spot-ingestion.md` before the
daily page can show a spot.

If a development volume was created by an older revision and still contains
the retired `development-default-spot`, run
`DATABASE_URL='postgresql://postgres:<password>@127.0.0.1:55432/poker_trainer_dev' pnpm spot:retire-synthetic` once. It cancels its publication
slots and marks its versions superseded while preserving old attempts and
payloads for audit; it does not run in production and is unnecessary on a
fresh volume.

The native Mac worker must use the host-published database endpoint:

```text
postgresql://solver_worker:<password>@127.0.0.1:55432/<POSTGRES_DB>
```

It must not expect the Docker DNS name `postgres`, and no `SolverOutputs`,
native `console_solver`, or raw tree is mounted into this image. Only the
private application import path may store normalized metadata/payloads in
PostgreSQL. The ownership-checked lease helpers in
`src/solver/host-worker.ts` provide claim, heartbeat, reclaim, retry, and
completion transitions for that host process. See [`../README.md`](../README.md) and
[`../../storage-and-retrieval.md`](../../storage-and-retrieval.md) for the
storage boundary.

## Add a spot to PostgreSQL

Use the complete authoring/import/approval/schedule/publish procedure in
[`docs/spot-ingestion.md`](docs/spot-ingestion.md). The short version is:

From the private `Solver` directory, the recommended single command is:

```bash
python3 texassolver_tech_demo.py \
  --config configs/2bet-pot-100bb.json \
  --publish \
  --spot-name "Single-raised pot flop decision"
```

It pauses for the numbered selector and only continues after `export`. The
backend then validates/imports the bundle, approves it, and assigns slot 1 on
the first free Pacific date starting tomorrow. Repeating it appends the next
spot; cancelling before export or a failed import leaves no publication slot.
The command uses `DATABASE_URL`, or derives the host-side Docker URL from
`webapp/.env`.

The equivalent manual commands remain available for operators who need to
inspect each lifecycle transition:

```bash
corepack pnpm db:migrate                 # superuser, once per database
corepack pnpm spot:ingest -- ...         # creates validated draft + archive
corepack pnpm spot:manage -- approve ...
corepack pnpm spot:manage -- schedule ...
corepack pnpm spot:manage -- publish ...
```

`spot:ingest` accepts the private `provider-envelope.json` and its sibling
`configuration.json` emitted by the private Solver selector, converts them to
the versioned application envelope, verifies the configuration hash and input
ranges, and stores public and private JSON in separate `SpotVersion` columns.
It does not publish automatically. The browser and normal API requests never
read the Solver repository or `SolverOutputs`.

## Public resource flow, accounts, and local administration

The public flow is `GET /daily-games/today` → `GET /spots/:spotId` →
`POST /spots/:spotId/attempts` → `GET /attempts/:attemptId`. Statistics and
cursor history live under `/users/me/*`. These routes resolve an injected
provider-neutral bearer principal when configured, otherwise a stable guest
identity beneath rotating opaque cookies. Account and guest histories are
never implicitly merged. The local admin surface is loopback-only.
Compose's Nginx frontend adds a private proxy marker for `/api/v1/admin/*`;
the API accepts that marker only when `ADMIN_TRUSTED_PROXY=true` and
`NODE_ENV` is not `production`. Direct API requests still require a loopback
source, and production keeps the marker disabled. This lets the local browser
dashboard work without making the admin surface public:
`/api/v1/admin/calendar`, `/metrics`, `/audit`, guarded job retry/hold/cancel,
and version approve/schedule/hold operations are available only when
`ADMIN_ENABLED=true`. The trusted Nginx proxy path additionally requires
`ADMIN_TRUSTED_PROXY=true`; both are local-development settings and must remain
false for a Cloudflare Tunnel or public deployment. An optional injected
identity provider additionally requires an `admin` role. Mutations append an
`AdminAudit` row and do not expose private frequency values.
