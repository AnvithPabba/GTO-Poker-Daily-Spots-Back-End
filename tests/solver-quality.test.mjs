import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { assessSolverLog, parseSolverLog, SolverQualityError } from "../dist/solver/quality.js";
import { ingestSpot } from "../dist/solver/ingest.js";

const checkpoint = (iteration, total) => `Iter: ${iteration}\nTotal exploitability ${total} precent\n`;

async function createRejectedFixture(prefix, { includeOutput = true } = {}) {
  const fixture = await mkdtemp(join(tmpdir(), prefix));
  const configurationHash = "a".repeat(64);
  const preflop = {
    status: "unknown",
    label: "Preflop start unavailable",
    summary: "Synthetic ingestion quality fixture.",
  };
  const provenance = {
    schemaVersion: 1,
    configurationHash,
    preflop,
    resolvedRanges: { ip: "AA", oop: "KK" },
    authoredConfig: { solver: { minimum_iterations: 100, accuracy_percent: 0.1 } },
  };
  const envelope = { publicPayload: { source: { configurationHash }, preflop } };

  await Promise.all([
    writeFile(join(fixture, "input.txt"), "set_range_ip AA\nset_range_oop KK\n", "utf8"),
    writeFile(join(fixture, "solver.log"), checkpoint(11, "0.012891086"), "utf8"),
    writeFile(join(fixture, "configuration.json"), JSON.stringify(provenance), "utf8"),
    writeFile(join(fixture, "provider-envelope.json"), JSON.stringify(envelope), "utf8"),
    ...(includeOutput ? [writeFile(join(fixture, "output_result.json"), "{}", "utf8")] : []),
  ]);
  return fixture;
}

test("solver quality accepts a converged checkpoint after the minimum budget", () => {
  const report = assessSolverLog(checkpoint(201, "0.05"), { minimumIterations: 100, accuracyPercent: 0.1 });
  assert.equal(report.converged, true);
  assert.equal(report.lastIteration, 201);
});

test("solver quality rejects the premature eleven-iteration run", () => {
  assert.throws(() => assessSolverLog(checkpoint(11, "0.012891086"), { minimumIterations: 100, accuracyPercent: 0.1 }), (error) => {
    assert.equal(error instanceof SolverQualityError, true);
    assert.equal(error.report.lastObservedIteration, 11);
    assert.equal(error.report.lastObservedTotalPercent, 0.012891086);
    assert.equal(error.report.minimumReached, false);
    return true;
  });
});

test("ingestion archives a rejected raw run without creating database rows", async () => {
  // Arrange: this synthetic bundle reaches the log-quality gate without
  // depending on the private Solver repository or a developer filesystem.
  const fixture = await createRejectedFixture("poker-rejected-solve-");
  const archiveRoot = await mkdtemp(join(tmpdir(), "poker-rejected-archive-"));

  // Act / Assert
  await assert.rejects(() => ingestSpot({}, {
    envelopePath: join(fixture, "provider-envelope.json"),
    inputPath: join(fixture, "input.txt"),
    outputPath: join(fixture, "output_result.json"),
    logPath: join(fixture, "solver.log"),
    provenancePath: join(fixture, "configuration.json"),
    archiveRoot,
    title: "rejected",
    familyId: "test",
  }), SolverQualityError);
  const hashes = await readdir(join(archiveRoot, "solver-runs", "sha256"));
  assert.equal(hashes.length, 1);
  const rejectedMetadata = JSON.parse(await readFile(join(archiveRoot, "solver-runs", "sha256", hashes[0], "metadata.json"), "utf8"));
  assert.equal(rejectedMetadata.rejected, true);
  assert.match(rejectedMetadata.rejectionReason, /quality settings|before minimum/);
});

test("ingestion rejects malformed solver JSON after archiving the raw bundle", async () => {
  // Arrange
  const fixture = await createRejectedFixture("poker-malformed-solve-");
  await writeFile(join(fixture, "output_result.json"), "{not-json", "utf8");
  const archiveRoot = await mkdtemp(join(tmpdir(), "poker-malformed-archive-"));

  // Act / Assert
  await assert.rejects(() => ingestSpot({}, {
    envelopePath: join(fixture, "provider-envelope.json"),
    inputPath: join(fixture, "input.txt"),
    outputPath: join(fixture, "output_result.json"),
    logPath: join(fixture, "solver.log"),
    provenancePath: join(fixture, "configuration.json"),
    archiveRoot,
    title: "malformed",
    familyId: "test",
  }), SolverQualityError);
  const hashes = await readdir(join(archiveRoot, "solver-runs", "sha256"));
  assert.equal(hashes.length, 1);
  const rejectedMetadata = JSON.parse(await readFile(join(archiveRoot, "solver-runs", "sha256", hashes[0], "metadata.json"), "utf8"));
  assert.equal(rejectedMetadata.rejected, true);
  assert.match(rejectedMetadata.rejectionReason, /malformed JSON/);
});

test("ingestion archives missing solver artifacts as a rejected run", async () => {
  // Arrange
  const fixture = await createRejectedFixture("poker-missing-solve-", { includeOutput: false });
  const archiveRoot = await mkdtemp(join(tmpdir(), "poker-missing-archive-"));

  // Act / Assert
  await assert.rejects(() => ingestSpot({}, {
    envelopePath: join(fixture, "provider-envelope.json"),
    inputPath: join(fixture, "input.txt"),
    outputPath: join(fixture, "output_result.json"),
    logPath: join(fixture, "solver.log"),
    provenancePath: join(fixture, "configuration.json"),
    archiveRoot,
    title: "missing output",
    familyId: "test",
  }), SolverQualityError);
  const hashes = await readdir(join(archiveRoot, "solver-runs", "sha256"));
  const rejectedMetadata = JSON.parse(await readFile(join(archiveRoot, "solver-runs", "sha256", hashes[0], "metadata.json"), "utf8"));
  assert.deepEqual(rejectedMetadata.missingArtifacts, ["output_result.json"]);
});

test("solver quality rejects a late checkpoint above target and accepts native spelling", () => {
  assert.throws(() => assessSolverLog(checkpoint(201, "0.101"), { minimumIterations: 100, accuracyPercent: 0.1 }), /exceeds target/);
  const report = assessSolverLog(`${checkpoint(101, "0.2")}Iter: 201\nTotal exploitability 0.05 percent\n`, { minimumIterations: 100, accuracyPercent: 0.1 });
  assert.equal(report.lastIteration, 201);
  assert.equal(parseSolverLog("Iter: 101\nTotal exploitability 0.05 precent\n").length, 1);
});

test("solver quality rejects missing and malformed checkpoints", () => {
  assert.throws(() => assessSolverLog("solver crashed\n", { minimumIterations: 100, accuracyPercent: 0.1 }), /before minimum/);
  assert.throws(() => assessSolverLog(checkpoint(101, "nan"), { minimumIterations: 100, accuracyPercent: 0.1 }), /before minimum/);
});
