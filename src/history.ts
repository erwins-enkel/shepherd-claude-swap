import type { PoolAccount } from "./accounts";

export const QUOTA_RING_CAP = 288;
export const SPAWN_RING_CAP = 50;
export const CHART_WINDOW = 60;
export const MAX_DETAILED_ACCOUNTS = 16;

export interface QuotaSample {
  five: number | null;
  seven: number | null;
}

export interface SpawnEvent {
  sessionId: string;
  accountNumber: number;
  at: string;
}

export class History {
  private quotaRings: Map<number, QuotaSample[]> = new Map();
  private spawnRing: SpawnEvent[] = [];

  recordQuota(pool: PoolAccount[]): void {
    for (const acct of pool) {
      let ring = this.quotaRings.get(acct.number);
      if (!ring) {
        ring = [];
        this.quotaRings.set(acct.number, ring);
      }
      ring.push({ five: acct.fiveHourPct, seven: acct.sevenDayPct });
      if (ring.length > QUOTA_RING_CAP) {
        ring.splice(0, ring.length - QUOTA_RING_CAP);
      }
    }
  }

  recordSpawn(event: SpawnEvent): void {
    this.spawnRing.push(event);
    if (this.spawnRing.length > SPAWN_RING_CAP) {
      this.spawnRing.splice(0, this.spawnRing.length - SPAWN_RING_CAP);
    }
  }

  quotaFor(accountNumber: number): QuotaSample[] {
    return this.quotaRings.get(accountNumber) ?? [];
  }

  recentSpawns(): SpawnEvent[] {
    return this.spawnRing;
  }
}

/**
 * Downsample `points` to at most `window` entries, retaining chronological order
 * and always anchoring the first and last (newest) points.
 */
export function downsample(points: number[], window: number): number[] {
  if (points.length === 0) return [];
  if (points.length <= window) return points.slice();

  const n = points.length;
  const result: number[] = [];

  if (window === 1) {
    return [points[n - 1]!];
  }

  for (let i = 0; i < window; i++) {
    const idx = i === window - 1 ? n - 1 : Math.round((i / (window - 1)) * (n - 1));
    result.push(points[idx]!);
  }

  return result;
}
