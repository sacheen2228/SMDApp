/**
 * Lightweight durable job queue.
 *
 * Every write the recorder needs to make (insert signal, tracking update,
 * close trade) is enqueued as a row in `job_queue` and returns immediately —
 * the caller (a strategy module firing a signal) is never blocked on a
 * SQLite write. A single in-process worker drains the queue sequentially,
 * so writes to the same trade never race each other, and failures are
 * retried with backoff instead of silently dropped.
 *
 * This is intentionally dependency-free (no Redis/BullMQ) so the engine
 * runs standalone. If you outgrow a single process, swap this file for a
 * BullMQ/Redis-backed queue — every call site just does `queue.enqueue(...)`
 * so the swap is contained to this module.
 */
import { db } from "./db";
import { config } from "./config";
import { nowIst } from "./utils/ist";

export type JobHandler = (payload: any) => void;

const handlers = new Map<string, JobHandler>();
let draining = false;

export function registerHandler(jobType: string, handler: JobHandler): void {
  handlers.set(jobType, handler);
}

export function enqueue(jobType: string, payload: unknown): void {
  const now = nowIst();
  db.prepare(
    `INSERT INTO job_queue (job_type, payload_json, status, attempts, created_at, updated_at)
     VALUES (?, ?, 'pending', 0, ?, ?)`
  ).run(jobType, JSON.stringify(payload), now, now);
  void drain();
}

interface QueueRow {
  id: number;
  job_type: string;
  payload_json: string;
  attempts: number;
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const job = db
        .prepare(
          `SELECT id, job_type, payload_json, attempts FROM job_queue
           WHERE status = 'pending' ORDER BY id ASC LIMIT 1`
        )
        .get() as QueueRow | undefined;

      if (!job) break;

      db.prepare(`UPDATE job_queue SET status = 'processing', updated_at = ? WHERE id = ?`).run(
        nowIst(),
        job.id
      );

      const handler = handlers.get(job.job_type);
      try {
        if (!handler) throw new Error(`No handler registered for job type "${job.job_type}"`);
        handler(JSON.parse(job.payload_json));
        db.prepare(`UPDATE job_queue SET status = 'done', updated_at = ? WHERE id = ?`).run(
          nowIst(),
          job.id
        );
      } catch (err) {
        const attempts = job.attempts + 1;
        const maxAttempts = config.queueRetryDelaysMs.length;
        const failedPermanently = attempts > maxAttempts;
        db.prepare(
          `UPDATE job_queue SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`
        ).run(
          failedPermanently ? "failed" : "pending",
          attempts,
          err instanceof Error ? err.message : String(err),
          nowIst(),
          job.id
        );
        if (!failedPermanently) {
          const delay = config.queueRetryDelaysMs[attempts - 1] ?? 5000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          console.error(`[queue] Job ${job.id} (${job.job_type}) failed permanently:`, err);
        }
      }
    }
  } finally {
    draining = false;
  }
}

/** Re-queues any jobs left "processing" from a previous crash, then starts draining. */
export function recoverAndStart(): void {
  db.prepare(`UPDATE job_queue SET status = 'pending' WHERE status = 'processing'`).run();
  void drain();
}
