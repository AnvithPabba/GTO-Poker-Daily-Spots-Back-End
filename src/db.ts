import { PrismaClient } from "@prisma/client";

export function createPrismaClient(databaseUrl?: string): PrismaClient {
  return new PrismaClient(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : undefined);
}

let sharedClient: PrismaClient | undefined;

export function getPrismaClient(databaseUrl?: string): PrismaClient {
  sharedClient ??= createPrismaClient(databaseUrl);
  return sharedClient;
}

export async function disconnectPrismaClient(): Promise<void> {
  if (sharedClient) {
    await sharedClient.$disconnect();
    sharedClient = undefined;
  }
}
