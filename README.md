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
```

The backend consumes `@poker-trainer/contracts` from the sibling checkout
while the repositories are developed locally. Before deployment, pin an exact
published contracts version and do not expose private solution modules to the
frontend.

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
`CORS_ORIGIN`, and `PG_BOSS_SCHEMA`. Invalid or missing values fail startup
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

## Docker and host-worker boundary

The complete local stack is started from `webapp/`:

```bash
cp ../.env.example ../.env
docker compose -f ../docker-compose.yml up -d --build
```

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

```bash
corepack pnpm db:migrate                 # superuser, once per database
corepack pnpm spot:ingest -- ...         # creates validated draft + archive
corepack pnpm spot:manage -- approve ...
corepack pnpm spot:manage -- schedule ...
corepack pnpm spot:manage -- publish ...
```

`spot:ingest` accepts the private `provider-envelope.json` emitted by the
private Solver selector, converts it to the versioned application envelope,
and stores public and private JSON in separate `SpotVersion` columns. It does
not publish automatically.
