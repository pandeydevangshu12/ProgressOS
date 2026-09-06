import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { getWorkerEnv } from './workerEnv.js';

/**
 * Prisma Client Singleton (Prisma 7 — Driver Adapter Pattern)
 *
 * Supports:
 * 1. Traditional Node.js runtime / local development via process.env.DATABASE_URL
 * 2. Cloudflare Workers via env.HYPERDRIVE.connectionString
 *
 * Uses a Proxy singleton pattern to ensure only one active client instance exists,
 * preventing connection pool exhaustion and eliminating repeated per-request instantiations.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  activeConnectionString: string | undefined;
};

export function getDatabaseConnectionString(): string {
  const workerEnv = getWorkerEnv();
  if (workerEnv?.HYPERDRIVE?.connectionString) {
    return workerEnv.HYPERDRIVE.connectionString;
  }
  return process.env.DATABASE_URL || '';
}

export function createPrismaClient(overrideUrl?: string): PrismaClient {
  const connectionString = overrideUrl || getDatabaseConnectionString();
  const pool = new pg.Pool({
    connectionString,
    max: 20,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({
    adapter,
    log: ['error'],
  } as any);
}

function getActivePrisma(): PrismaClient {
  const currentUrl = getDatabaseConnectionString();
  if (
    !globalForPrisma.prisma ||
    (globalForPrisma.activeConnectionString !== currentUrl && currentUrl)
  ) {
    globalForPrisma.prisma = createPrismaClient(currentUrl);
    globalForPrisma.activeConnectionString = currentUrl;
  }
  return globalForPrisma.prisma;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const active = getActivePrisma();
    const value = Reflect.get(active, prop);
    if (typeof value === 'function') {
      return value.bind(active);
    }
    return value;
  },
});
