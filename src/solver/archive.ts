import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

export type ArchiveArtifact = { name: "input.txt" | "output_result.json" | "solver.log" | "metadata.json"; content: string | Uint8Array };
export type ArchivedRun = {
  sourceHash: string;
  artifacts: Record<ArchiveArtifact["name"], { key: string; sha256: string; bytes: number }>;
};

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function sourceHash(artifacts: ArchiveArtifact[]): string {
  return createHash("sha256")
    .update(artifacts.filter((artifact) => artifact.name !== "metadata.json").map((artifact) => `${artifact.name}:${sha256(artifact.content)}`).sort().join("\n"))
    .digest("hex");
}

function assertSafeRoot(root: string, candidate: string): void {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}/`)) {
    throw new Error("archive path escapes configured root");
  }
}

export async function archiveRun(root: string, artifacts: ArchiveArtifact[]): Promise<ArchivedRun> {
  const expected = new Set<ArchiveArtifact["name"]>(["input.txt", "output_result.json", "solver.log"]);
  const supplied = new Set(artifacts.map((artifact) => artifact.name));
  if (supplied.size !== artifacts.length) throw new Error("duplicate archive artifact name");
  for (const required of expected) if (!supplied.has(required)) throw new Error(`missing archive artifact ${required}`);
  const hash = sourceHash(artifacts);
  const directory = join(root, "solver-runs", "sha256", hash);
  assertSafeRoot(root, directory);
  await mkdir(directory, { recursive: true });
  const result = {} as ArchivedRun["artifacts"];
  for (const artifact of artifacts) {
    let destination = join(directory, artifact.name);
    assertSafeRoot(root, destination);
    const bytes = typeof artifact.content === "string" ? Buffer.byteLength(artifact.content) : artifact.content.byteLength;
    const digest = sha256(artifact.content);
    try {
      const existing = await readFile(destination);
      if (sha256(existing) !== digest) {
        if (artifact.name !== "metadata.json") throw new Error(`conflicting archive replacement for ${artifact.name}`);
        // Source artifacts define the immutable run identity. Metadata records
        // an import observation and can legitimately change when a previously
        // rejected run is retried after importer fixes. Keep both records
        // append-only instead of overwriting the first one or blocking retry.
        destination = join(directory, `metadata-${digest}.json`);
        assertSafeRoot(root, destination);
        try {
          const existingVersion = await readFile(destination);
          if (sha256(existingVersion) !== digest) throw new Error("conflicting archive replacement for versioned metadata.json");
        } catch (versionError: unknown) {
          if (versionError instanceof Error && versionError.message.startsWith("conflicting archive")) throw versionError;
          const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
          await writeFile(temporary, artifact.content, { flag: "wx" });
          await rename(temporary, destination);
        }
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith("conflicting archive")) throw error;
      const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temporary, artifact.content, { flag: "wx" });
      await rename(temporary, destination);
    }
    result[artifact.name] = { key: `solver-runs/sha256/${hash}/${basename(destination)}`, sha256: digest, bytes };
  }
  return { sourceHash: hash, artifacts: result };
}

export async function verifyArchive(root: string, archived: ArchivedRun): Promise<void> {
  const sourceArtifacts: Array<{ name: string; digest: string }> = [];
  for (const [name, metadata] of Object.entries(archived.artifacts)) {
    const path = join(root, metadata.key);
    assertSafeRoot(root, path);
    const file = await readFile(path);
    const digest = sha256(file);
    if (digest !== metadata.sha256) throw new Error(`archive checksum mismatch for ${name}`);
    const fileStat = await stat(path);
    if (fileStat.size !== metadata.bytes) throw new Error(`archive size mismatch for ${name}`);
    if (name !== "metadata.json") sourceArtifacts.push({ name, digest });
  }
  if (sourceArtifacts.length !== 3) throw new Error("archive is missing a required source artifact");
  const actualSourceHash = createHash("sha256").update(sourceArtifacts.sort((left, right) => left.name.localeCompare(right.name)).map((artifact) => `${artifact.name}:${artifact.digest}`).join("\n")).digest("hex");
  if (actualSourceHash !== archived.sourceHash) throw new Error("archive source hash mismatch");
}

export function archiveKeyToPath(root: string, key: string): string {
  if (key.startsWith("/") || key.includes("..")) throw new Error("invalid archive key");
  const path = resolve(root, key);
  assertSafeRoot(root, path);
  if (relative(resolve(root), path).startsWith("..")) throw new Error("invalid archive key");
  return path;
}
