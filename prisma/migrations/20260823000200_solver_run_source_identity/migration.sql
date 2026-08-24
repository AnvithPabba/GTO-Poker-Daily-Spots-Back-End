-- A native output checksum alone is not a run identity. TexasSolver may emit
-- identical output bytes for different inputs (including failed/collapsed
-- solves). The normalized source hash covers the exact input/output pair and
-- remains shared by multiple selected nodes from that one solve.
DROP INDEX IF EXISTS "SolverRun_outputSha256_key";

CREATE INDEX IF NOT EXISTS "SolverRun_outputSha256_idx"
ON "SolverRun"("outputSha256");

CREATE UNIQUE INDEX "SolverRun_sourceHash_key"
ON "SolverRun"("sourceHash");
