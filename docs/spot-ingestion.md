# Creating and publishing a spot

The local admin dashboard is optional. Keep `ADMIN_ENABLED=false` and
`ADMIN_TRUSTED_PROXY=false` whenever this stack is reachable through a tunnel;
use the ingestion/management CLI or a separately protected operator service in
that case. Setting both values to `true` is only for an unexposed local stack.

This is the repeatable authoring path from a native TexasSolver run to a
browser-visible database record. It runs on the Mac host. The Docker stack
does not mount `SolverOutputs` or the native solver binary.

Fresh databases intentionally have no challenge until this workflow completes.
If a pre-change development volume still serves the retired
`development-default-spot`, run `pnpm spot:retire-synthetic` once from the
backend with the database superuser URL; this preserves its attempts for audit
but cancels its publication state.

## 1. Solve and choose a decision node

From the private `Solver` repository:

```bash
python3 texassolver_tech_demo.py
# copy the printed sha256:<64-hex> solve ID
python3 path-select.py --solve <solve-sha> --spot-name "IP flop response"
```

The selector stops when you type `target` and then `export`. The selected
directory is:

```text
../SolverOutputs/<solve-sha-without-prefix>/spots/<spot-id>/
  manifest.json             # checksum-bound replay route
  node.json                 # safe public-state preview; no frequencies
  provider-envelope.json    # private native-provider payload for ingestion
  metadata.json             # provenance and human-readable summary
```

`provider-envelope.json` is intentionally private. It contains solver
frequencies and reached ranges and must never be copied to the frontend or
returned by a public API.

The run root also contains `configuration.json`, which records the canonical
resolved hand config, selected range scenario, literal IP/OOP ranges passed to
TexasSolver, and a deterministic configuration hash separate from the raw
artifact hash. Ingestion validates this provenance and copies only the public
preflop story and hand-class assumptions into the v3 public payload.

Known preflop actions are also the authoritative source for real table
positions. During normalization, each actor must have one consistent position
across its authored actions. Those positions populate
`presentation.positions`; generic legacy labels such as `IP` and `OOP` are
replaced by the authored `BTN`, `BB`, `SB`, and so on. If a provider supplies a
different explicit position, ingestion fails instead of publishing an
impossible story. The dealer actor is the actor in `BTN`. A supplied dealer
actor that conflicts with `BTN`, or a payload assigning `BTN` to both players,
is rejected. Consequently a `BTN opens → BB calls` spot always normalizes to
BTN/IP/dealer versus BB/OOP/first-to-act postflop.

Previously published immutable versions are not edited in place. If an early
v3 row retained BTN/BB in its structured actions but stored generic IP/OOP
presentation, the public read adapter reconciles the response from those
actions. This keeps the API internally consistent while preserving the exact
archived database record for audit.

The native process must be started with the TexasSolver provider bundle as its
working directory. TexasSolver v0.2.0 loads runtime resources relative to
`cwd`; inheriting the separate `Solver/` directory can produce a completed log
and malformed uniform exact-hand strategies. The supported Python wrapper
enforces this boundary. Do not replace it with an arbitrary `cat input.txt |
console_solver` invocation from another directory.

## 2. Apply the database migration once

The development migration is run by the database superuser, not either runtime
role. From `webapp/backend`:

```bash
DATABASE_URL='postgresql://postgres:<superuser-password>@127.0.0.1:55432/poker_trainer_dev' \
  corepack pnpm db:migrate
```

The migration adds `AttemptValidity` plus the invalidation metadata used when
an immutable solver version is replaced. The TypeScript client is generated
from the same schema; `build`, `typecheck`, and `test` run `prisma generate`
automatically. If an import command reports that Prisma does not know a field
such as `validity`, run `corepack pnpm db:generate` in `webapp/backend` and
retry. This fixes generated types only; `db:migrate` is still required to
change the database.

The API role (`trainer_api`) can create spot records after the migration; the
worker role (`solver_worker`) is for queue/host-worker access. Neither is a
superuser. Do not run `docker compose down -v` unless deleting the disposable
development database is intentional.

## 3. Import a selected spot

### Recommended: one command from `Solver`

The Solver authoring command combines the native solve, interactive path
selection, export, validated import, approval, and scheduling:

```bash
cd ../../Solver
python3 texassolver_tech_demo.py \
  --config configs/2bet-pot-100bb.json \
  --publish \
  --spot-name "Single-raised pot flop decision"
```

After you type `export`, the backend assigns slot 1 on the first unoccupied
Pacific date starting tomorrow. Repeat the command to append the next spot to
the next free date. Existing scheduled/published dates are never overwritten
unless the operator supplies both an exact date and the explicit replacement
flag.
The command derives a host-side `DATABASE_URL` from `webapp/.env` when one is
not already exported; set `DATABASE_URL` explicitly for another database.

Target an exact date, or intentionally replace its active slot 1:

```bash
python3 texassolver_tech_demo.py --config configs/2bet-pot-100bb.json \
  --publish --publication-date 2026-08-27

python3 texassolver_tech_demo.py --config configs/2bet-pot-100bb.json \
  --publish --publication-date 2026-08-27 --replace-existing
```

The first command fails with the occupying immutable version ID when the date
is not empty. Replacement cancels rather than deletes the old slot,
supersedes the old version, invalidates stale attempts, writes `AdminAudit`,
and gives the new version the same Pacific date/order. Published dates are
republished immediately; future dates remain scheduled.

Monitor the publication window before or after authoring:

```bash
# Default today -5 through +5 Pacific days
python3 texassolver_tech_demo.py --list-spots

# Exact inclusive range and replacement history
python3 texassolver_tech_demo.py --list-spots \
  --from-date 2026-08-01 --to-date 2026-08-31 --include-cancelled
```

The backend-native form is `corepack pnpm spot:list -- --before 5 --after 5`.
Add `--json` for automation. The monitor reads PostgreSQL only and never opens
the solver archive or exposes private solution payloads.

If the import fails, the raw solve and exported bundle remain available and no
publication slot is created. Fix the reported database/configuration issue
and rerun the publication handoff with the retained bundle (this does not
rerun TexasSolver):

```bash
cd webapp/backend
DATABASE_URL='postgresql://trainer_api:<app-password>@127.0.0.1:55432/poker_trainer_dev' \
  SOLVER_OUTPUTS_DIR='../../SolverOutputs' \
  corepack pnpm spot:publish -- \
    --envelope '../../SolverOutputs/<solve-sha>/spots/<spot-id>/provider-envelope.json' \
    --input '../../SolverOutputs/<solve-sha>/input.txt' \
    --output '../../SolverOutputs/<solve-sha>/output_result.json' \
    --log '../../SolverOutputs/<solve-sha>/solver.log' \
    --provenance '../../SolverOutputs/<solve-sha>/configuration.json' \
    --title 'IP flop response on Qs Jh 2h' \
    --family 'srp-default' \
    --spot-id '<spot-id>' \
    --spot-version-id '<spot-id>_v1'
```

The retry is idempotent for an already scheduled version: it reports the
existing slot rather than creating a duplicate.

### Manual/import-only workflow

The ingestion command creates a versioned template, solver job, raw archive,
successful solver run, draft `Spot`, and validated `SpotVersion` in one
transactional application boundary. It verifies the archive checksums and
converts the Python provider envelope into the public/private application
shape. The private archive stays under `SolverOutputs`.

```bash
cd webapp/backend
DATABASE_URL='postgresql://trainer_api:<app-password>@127.0.0.1:55432/poker_trainer_dev' \
  SOLVER_OUTPUTS_DIR='../../SolverOutputs' \
  corepack pnpm spot:ingest \
    --envelope '../../SolverOutputs/<solve-sha>/spots/<spot-id>/provider-envelope.json' \
    --input '../../SolverOutputs/<solve-sha>/input.txt' \
    --output '../../SolverOutputs/<solve-sha>/output_result.json' \
    --log '../../SolverOutputs/<solve-sha>/solver.log' \
    --provenance '../../SolverOutputs/<solve-sha>/configuration.json' \
    --title 'IP flop response on Qs Jh 2h' \
    --family 'srp-default' \
    --spot-id 'srp_qs_jh_2h_ip_response' \
    --spot-version-id 'srp_qs_jh_2h_ip_response_v1' \
    --publication-date '2026-08-21' \
    --slot-order 1 \
    --initial-actor oop
```

The provenance file is mandatory. It is generated beside the solve by
`texassolver_tech_demo.py` and contains the authored configuration, resolved
literal ranges, preflop scenario, and configuration hash. Do not substitute a
different hand config: the importer compares the envelope hash and both
`set_range_ip`/`set_range_oop` lines in `input.txt` with this file. For the
single-raised-pot story, generate the solve with
`Solver/configs/2bet-pot-100bb.json`; its public ranges will be `2bet_ip` and
`call_oop`, not the unrelated `default` ranges.

The importer also compares the structured `preflop` object in the private
provider envelope with `configuration.json` (ignoring JSON object key order).
This prevents an envelope from one scenario being paired with another
scenario's story. Numeric bet sizes come from the configuration/provenance and
are emitted as payload data; the API and frontend never use action method
aliases such as `oop_bet_25`.

Before creating any database rows, ingestion validates the native log against
the authored quality settings. It requires a post-minimum exploitability
checkpoint and a final exploitability value at or below the configured target.
The input, output, and log are archived even when this gate rejects the run;
the rejection report is stored beside them for diagnosis. A rejected run never
creates a `SpotVersion`.

The importer records a strategy-diversity diagnostic and enforces a semantic
publication gate. It rejects a large reached range whose exact combos all
collapse to one basis-point vector, as well as the observed multi-action
failure where every combo is 100% all-in. This catches invalid TexasSolver
v0.2.0 output even when its log reports near-zero exploitability. Narrow,
legitimately pure nodes are not rejected merely for being pure.

Provider floating-point frequencies are normalized per exact combo and
converted to 10,000 basis points with deterministic largest-remainder
apportionment. This preserves nonnegative actions and an exact total even when
the native vector is a few floating-point units above or below one. No rounding
correction is assigned blindly to the last action.

Use a new `--spot-version-id` for a new immutable version of an existing
`--spot-id`. Re-running the same version with identical public/private hashes
is idempotent; a different payload with an existing version ID is rejected.
The command prints the `templateId`, `jobId`, `solverRunId`, `spotId`, and
`spotVersionId`. Keep those IDs in the authoring log.

Several selected spots may originate from the same `output_result.json`.
Because `SolverRun.outputSha256` identifies the immutable native output, later
imports reuse that existing `SolverRun` after verifying the input, log, and
source identities. They create new `SpotVersion` rows; they do not create a
duplicate run or fail the unique output-checksum constraint.

Raw source artifacts are append-only. If the same raw run is retried after an
importer fix, a different import metadata observation is stored under a
content-addressed `metadata-<sha256>.json` key rather than overwriting the
earlier rejection record or blocking the retry.

To repair an already-published spot, import the corrected envelope with the
same logical `--spot-id` and a new version ID. The repair command performs the
approval, retargets the existing publication slot, and invalidates attempts
against the superseded version in one transaction:

```bash
DATABASE_URL='postgresql://trainer_api:<app-password>@127.0.0.1:55432/poker_trainer_dev' \
  corepack pnpm spot:repair -- \
    --envelope '../../SolverOutputs/<solve-sha>/spots/<spot-id>/provider-envelope.json' \
    --input '../../SolverOutputs/<solve-sha>/input.txt' \
    --output '../../SolverOutputs/<solve-sha>/output_result.json' \
    --log '../../SolverOutputs/<solve-sha>/solver.log' \
    --provenance '../../SolverOutputs/<solve-sha>/configuration.json' \
    --title 'Corrected flop decision' \
    --family 'srp-default' \
    --old-version-id '<currently-published-version-id>' \
    --new-version-id '<new-immutable-version-id>'
```

`spot:repair` refuses a candidate whose exact-combo vectors all collapse to one
basis-point vector. This safety check cannot be bypassed from the command line;
investigate or replace the native solver artifact instead. It cancels the old
slot, marks the old version
`SUPERSEDED`, invalidates its attempts (which remain available for audit), and
creates a scheduled slot for the replacement at the same date/order. It then
publishes that date. Invalidated attempts are excluded from progress, history,
streaks, and statistics; refreshing one returns `410 ATTEMPT_INVALIDATED`
without the stale GTO comparison.

When no corrected version exists yet, remove the misleading version from
public serving without deleting audit data:

```bash
corepack pnpm spot:manage -- quarantine \
  --spot-version-id '<bad-version-id>' \
  --reason 'native solver emitted a collapsed uniform strategy'
```

Quarantine cancels active publication slots, marks the version `SUPERSEDED`,
archives the logical spot when it was current, invalidates affected attempts,
and records an `AdminAudit` event. A refreshed invalid attempt returns
`410 ATTEMPT_INVALIDATED` rather than its stale comparison.

For a manually prepared, already-approved replacement, the lower-level
management commands remain available. Pass `--invalidate --reason ...` to the
`replace` command when the old attempts must be invalidated, then publish the
existing date.

If you already have a normalized application envelope (rather than the
provider envelope generated by `path-select.py`), it must still contain the
same public/private action IDs, exact 10,000-basis-point frequencies, source
hash, and candidate manifest. The server validates it before persistence.

## 4. Approve, schedule, and publish

Ingestion leaves the version `VALIDATED`; it is not public yet. Promote it
through the guarded lifecycle:

```bash
DATABASE_URL='postgresql://trainer_api:<app-password>@127.0.0.1:55432/poker_trainer_dev' \
  corepack pnpm spot:manage -- approve \
    --spot-version-id 'srp_qs_jh_2h_ip_response_v1'

DATABASE_URL='postgresql://trainer_api:<app-password>@127.0.0.1:55432/poker_trainer_dev' \
  corepack pnpm spot:manage -- schedule \
    --spot-version-id 'srp_qs_jh_2h_ip_response_v1' \
    --date '2026-08-21' --order 1

# Manual/local equivalent of the Pacific-midnight publication job:
DATABASE_URL='postgresql://trainer_api:<app-password>@127.0.0.1:55432/poker_trainer_dev' \
  corepack pnpm spot:manage -- publish --date '2026-08-21'
```

The production worker schedules replenishment at 6:00 PM Pacific and
publication at midnight Pacific through `pg-boss`. Publication is singleton
keyed and runs in a transaction; duplicate date/order or active-version slots
are rejected by PostgreSQL. The API serves the latest previous publication with
an explicit fallback flag if today has no published slot.

For immutable legacy v2 versions, run `corepack pnpm spot:migrate-v3` with the
application `DATABASE_URL`. It creates new v3 versions and retargets mutable
spot/slot references without editing v2 JSON. Missing legacy scenario
provenance is labeled `Preflop start unavailable` rather than inferred.

## 5. Verify the public boundary

```bash
curl http://127.0.0.1:3000/api/v1/daily-games/today
curl http://127.0.0.1:3000/api/v1/spots/srp_qs_jh_2h_ip_response
```

The public GET contains preflop assumptions, hand history, state, the featured combo/range options,
and legal actions only. It must not contain `privateSolutionPayload`,
`frequencies`, `reachedRanges`, or `reachWeight`. GTO percentages are read only
inside the attempt service. The POST returns an attempt ID and compact score;
`GET /api/v1/attempts/:attemptId` returns the ownership-checked comparison.
The first accepted attempt per stable guest/account and spot version is
official; later attempts are practice. The `Idempotency-Key` header returns the
original attempt for an identical retry and `409` for different content.

## Failure and recovery rules

- Invalid or incomplete solver candidates never become `VALIDATED`.
- A checksum mismatch or source-hash mismatch stops ingestion before a DB row is
  published.
- A failed native solve is retried up to three times by the solver-template
  queue; other templates continue independently.
- An approved version can be held/rejected before scheduling; a published
  version's poker payload is immutable.
- Keep raw input/output/log artifacts for reproducibility even though public
  clients only receive normalized public JSON.
