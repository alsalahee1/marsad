/**
 * Hands a run to the queue. `dedupeKey` makes repeated enqueues of the same intent idempotent
 * at the queue level; the executor's atomic claim makes double execution impossible regardless.
 */
export interface RunDispatcher {
  enqueue(runId: string, dedupeKey: string): Promise<void>;
}
