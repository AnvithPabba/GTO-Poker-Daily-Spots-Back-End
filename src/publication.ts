import { PublicationSlotStatus, SpotStatus, SpotVersionStatus, type PrismaClient } from "@prisma/client";

export const PACIFIC_TIME_ZONE = "America/Los_Angeles";

function assertIsoDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("publication date must be YYYY-MM-DD");
  const [year, month, day] = value.split("-").map(Number);
  const candidate = new Date(Date.UTC(year!, month! - 1, day!));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month! - 1 || candidate.getUTCDate() !== day) throw new Error("publication date is invalid");
}

function dateParts(date: Date): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: PACIFIC_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function pacificDate(date = new Date()): string {
  const parts = dateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addPacificDays(date: string, days: number): string {
  assertIsoDate(date);
  if (!Number.isInteger(days)) throw new Error("days must be an integer");
  const [year, month, day] = date.split("-").map(Number);
  const result = new Date(Date.UTC(year!, month! - 1, day! + days));
  return result.toISOString().slice(0, 10);
}

/**
 * Return the first unoccupied Pacific calendar date at or after `startDate`.
 *
 * Publication slots are the source of truth for coverage.  Keeping this as a
 * pure helper makes the append-to-calendar policy deterministic and easy to
 * test; the caller is responsible for reading occupied dates in a transaction
 * and handling a unique-key race when multiple operators publish at once.
 */
export function nextAvailablePacificDate(startDate: string, occupiedDates: Iterable<string>): string {
  assertIsoDate(startDate);
  const occupied = new Set(occupiedDates);
  for (let offset = 0; offset <= 3660; offset += 1) {
    const candidate = addPacificDays(startDate, offset);
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error("no available publication date in the next ten years");
}

export function pacificMidnightUtc(date: string): Date {
  assertIsoDate(date);
  const [year, month, day] = date.split("-").map(Number);
  const naive = new Date(Date.UTC(year!, month! - 1, day!));
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: PACIFIC_TIME_ZONE, timeZoneName: "longOffset", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(naive).map((part) => [part.type, part.value]));
  const offset = parts.timeZoneName?.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  const offsetMinutes = offset ? (Number(offset[2]) * 60 + Number(offset[3] ?? 0)) * (offset[1] === "+" ? 1 : -1) : 0;
  return new Date(naive.getTime() - offsetMinutes * 60_000);
}

export function assertLifecycleTransition(from: SpotVersionStatus, to: SpotVersionStatus): void {
  const allowed: Record<SpotVersionStatus, SpotVersionStatus[]> = {
    DRAFT: [SpotVersionStatus.VALIDATED, SpotVersionStatus.REJECTED],
    VALIDATED: [SpotVersionStatus.APPROVED, SpotVersionStatus.REJECTED],
    APPROVED: [SpotVersionStatus.SCHEDULED, SpotVersionStatus.REJECTED],
    SCHEDULED: [SpotVersionStatus.PUBLISHED, SpotVersionStatus.APPROVED],
    PUBLISHED: [SpotVersionStatus.SUPERSEDED],
    REJECTED: [],
    SUPERSEDED: [],
  };
  if (!allowed[from].includes(to)) throw new Error(`invalid spot version transition ${from} -> ${to}`);
}

export async function approveSpotVersion(prisma: PrismaClient, versionId: string) {
  return prisma.$transaction(async (tx) => {
    const version = await tx.spotVersion.findUniqueOrThrow({ where: { id: versionId } });
    assertLifecycleTransition(version.status, SpotVersionStatus.APPROVED);
    const updated = await tx.spotVersion.update({ where: { id: versionId }, data: { status: SpotVersionStatus.APPROVED, approvedAt: new Date() } });
    await tx.spot.update({ where: { id: version.spotId }, data: { status: SpotStatus.APPROVED, currentVersionId: version.id } });
    return updated;
  });
}

export async function scheduleSpotVersion(prisma: PrismaClient, versionId: string, publicationDate: string, slotOrder: number) {
  try { assertIsoDate(publicationDate); } catch { throw new Error("invalid publication slot"); }
  if (!Number.isInteger(slotOrder) || slotOrder < 1) throw new Error("invalid publication slot");
  return prisma.$transaction(async (tx) => {
    const version = await tx.spotVersion.findUniqueOrThrow({ where: { id: versionId } });
    assertLifecycleTransition(version.status, SpotVersionStatus.SCHEDULED);
    const slot = await tx.publicationSlot.create({ data: { publicationDate: new Date(`${publicationDate}T00:00:00.000Z`), slotOrder, spotVersionId: versionId, status: PublicationSlotStatus.SCHEDULED } });
    await tx.spotVersion.update({ where: { id: versionId }, data: { status: SpotVersionStatus.SCHEDULED, scheduledAt: new Date() } });
    return slot;
  });
}

/**
 * Retarget an already-published slot without mutating its historical version.
 * The old version is retained as SUPERSEDED and the replacement is scheduled
 * into the same Pacific date/order for the normal publication transaction.
 */
export async function replacePublishedSlot(prisma: PrismaClient, oldVersionId: string, newVersionId: string) {
  if (oldVersionId === newVersionId) throw new Error("replacement versions must be different");
  return prisma.$transaction(async (tx) => {
    const oldVersion = await tx.spotVersion.findUniqueOrThrow({ where: { id: oldVersionId } });
    const newVersion = await tx.spotVersion.findUniqueOrThrow({ where: { id: newVersionId } });
    if (oldVersion.spotId !== newVersion.spotId) throw new Error("replacement versions must belong to the same spot");
    if (oldVersion.status !== SpotVersionStatus.PUBLISHED) throw new Error("old version must be published before replacement");
    if (newVersion.status !== SpotVersionStatus.APPROVED) throw new Error("replacement version must be approved before replacement");
    const oldSlot = await tx.publicationSlot.findFirst({ where: { spotVersionId: oldVersionId, status: PublicationSlotStatus.PUBLISHED }, orderBy: { publicationDate: "desc" } });
    if (!oldSlot) throw new Error("old version has no published slot to replace");
    await tx.publicationSlot.update({ where: { id: oldSlot.id }, data: { status: PublicationSlotStatus.CANCELLED, cancelledAt: new Date() } });
    await tx.spotVersion.update({ where: { id: oldVersionId }, data: { status: SpotVersionStatus.SUPERSEDED, supersededAt: new Date() } });
    const slot = await tx.publicationSlot.create({ data: { publicationDate: oldSlot.publicationDate, slotOrder: oldSlot.slotOrder, spotVersionId: newVersionId, status: PublicationSlotStatus.SCHEDULED } });
    await tx.spotVersion.update({ where: { id: newVersionId }, data: { status: SpotVersionStatus.SCHEDULED, scheduledAt: new Date() } });
    return { oldVersionId, newVersionId, slot };
  });
}

export async function publishPacificDate(prisma: PrismaClient, publicationDate: string, now = new Date()) {
  assertIsoDate(publicationDate);
  return prisma.$transaction(async (tx) => {
    const slots = await tx.publicationSlot.findMany({ where: { publicationDate: new Date(`${publicationDate}T00:00:00.000Z`), status: PublicationSlotStatus.SCHEDULED }, orderBy: { slotOrder: "asc" } });
    const published = [];
    for (const slot of slots) {
      const version = await tx.spotVersion.findUniqueOrThrow({ where: { id: slot.spotVersionId } });
      assertLifecycleTransition(version.status, SpotVersionStatus.PUBLISHED);
      await tx.spotVersion.update({ where: { id: version.id }, data: { status: SpotVersionStatus.PUBLISHED, publishedAt: now } });
      await tx.spot.update({ where: { id: version.spotId }, data: { status: SpotStatus.PUBLISHED, currentVersionId: version.id } });
      published.push(await tx.publicationSlot.update({ where: { id: slot.id }, data: { status: PublicationSlotStatus.PUBLISHED, publishedAt: now } }));
    }
    return published;
  });
}

export async function countFutureCoverage(prisma: PrismaClient, fromDate = pacificDate()): Promise<number> {
  const [slots, approved] = await Promise.all([
    prisma.publicationSlot.findMany({ where: { publicationDate: { gt: new Date(`${fromDate}T00:00:00.000Z`) }, status: { in: [PublicationSlotStatus.SCHEDULED, PublicationSlotStatus.PUBLISHED] } }, select: { spotVersionId: true } }),
    prisma.spotVersion.findMany({ where: { status: SpotVersionStatus.APPROVED }, select: { id: true } }),
  ]);
  return new Set([...slots.map((slot) => slot.spotVersionId), ...approved.map((version) => version.id)]).size;
}
