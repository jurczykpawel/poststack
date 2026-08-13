/**
 * Liveness state for the queue worker.
 *
 * When idle, freshness advances only after a successful database poll. While one or more jobs are
 * active, the flush timer itself proves that the event loop is responsive, so long-running async
 * work may advance the timestamp without waiting for the job to finish.
 */
export class WorkerHeartbeat {
  private lastDatabaseActivityMs: number;
  private activeJobs = 0;

  constructor(private readonly now: () => number = Date.now) {
    this.lastDatabaseActivityMs = now();
  }

  databaseReached(): void {
    this.lastDatabaseActivityMs = this.now();
  }

  jobStarted(): void {
    this.activeJobs += 1;
    this.databaseReached();
  }

  jobCompleted(): void {
    if (this.activeJobs === 0) return;
    this.activeJobs -= 1;
    this.databaseReached();
  }

  timestampSeconds(): number {
    const activityMs = this.activeJobs > 0 ? this.now() : this.lastDatabaseActivityMs;
    return Math.floor(activityMs / 1000);
  }
}
