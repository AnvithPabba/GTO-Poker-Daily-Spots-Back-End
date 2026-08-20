import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArchiveStore } from "./ports.js";

export class FilesystemArchiveStore implements ArchiveStore {
  public constructor(private readonly root: string) {}
  private path(key: string): string { if (key.includes("..") || key.startsWith("/")) throw new Error("invalid archive key"); return join(this.root, key); }
  public async put(key: string, content: Uint8Array, checksum: string): Promise<void> { const actual = createHash("sha256").update(content).digest("hex"); if (actual !== checksum) throw new Error("archive checksum mismatch"); const path = this.path(key); await mkdir(dirname(path), { recursive: true }); try { const existing = await readFile(path); if (Buffer.compare(existing, content) !== 0) throw new Error("conflicting archive replacement"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await writeFile(path, content, { flag: "wx" }); } }
  public async get(key: string): Promise<Uint8Array> { return readFile(this.path(key)); }
  public async head(key: string): Promise<{ checksum: string; size: number }> { const content = await readFile(this.path(key)); const info = await stat(this.path(key)); return { checksum: createHash("sha256").update(content).digest("hex"), size: info.size }; }
}
