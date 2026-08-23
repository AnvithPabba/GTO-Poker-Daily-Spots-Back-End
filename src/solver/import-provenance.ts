type JsonObject = Record<string, unknown>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeSolverRange(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.split(",").map((token) => token.trim()).filter(Boolean).sort().join(",");
}

/**
 * Validate the provenance generated beside a real Solver run. This is kept at
 * the import boundary: normal API requests only read the normalized database
 * payload and never need access to Solver files.
 */
export function assertImportProvenance(rawEnvelope: unknown, provenance: unknown, inputText: string): void {
  if (!provenance || typeof provenance !== "object" || typeof (provenance as JsonObject).configurationHash !== "string") {
    throw new Error("configuration provenance is required and must contain configurationHash");
  }
  const publicPayload = rawEnvelope && typeof rawEnvelope === "object" ? (rawEnvelope as JsonObject).publicPayload : undefined;
  const source = publicPayload && typeof publicPayload === "object" ? (publicPayload as JsonObject).source : undefined;
  const envelopeHash = source && typeof source === "object" ? (source as JsonObject).configurationHash : undefined;
  const configurationHash = (provenance as JsonObject).configurationHash;
  if (envelopeHash !== configurationHash) throw new Error("provider envelope configurationHash does not match configuration.json");

  // The hash proves that the authored configuration is the one being imported;
  // comparing the structured context as well gives operators a useful failure
  // when an envelope was paired with the wrong provenance file or manually
  // edited after export. Key order is ignored, array order is significant.
  const expectedPreflop = (provenance as JsonObject).preflop;
  const actualPreflop = publicPayload && typeof publicPayload === "object"
    ? (publicPayload as JsonObject).preflop
    : undefined;
  if (canonicalJson(actualPreflop) !== canonicalJson(expectedPreflop)) {
    throw new Error("provider envelope preflop story does not match configuration.json");
  }

  const resolvedRanges = (provenance as JsonObject).resolvedRanges;
  if (!resolvedRanges || typeof resolvedRanges !== "object" || typeof (resolvedRanges as JsonObject).ip !== "string" || typeof (resolvedRanges as JsonObject).oop !== "string") {
    throw new Error("configuration provenance is missing resolved IP/OOP ranges");
  }
  const inputRanges: Record<string, string> = {};
  for (const line of inputText.split(/\r?\n/)) {
    const match = /^(set_range_(ip|oop))\s+(.+)$/.exec(line.trim());
    if (match) inputRanges[match[2]!] = match[3]!;
  }
  for (const actor of ["ip", "oop"] as const) {
    if (!inputRanges[actor] || normalizeSolverRange(inputRanges[actor]) !== normalizeSolverRange((resolvedRanges as JsonObject)[actor])) {
      throw new Error(`input.txt ${actor.toUpperCase()} range does not match configuration provenance`);
    }
  }
}
