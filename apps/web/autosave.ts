const idleDelay = 10_000;
const batchSize = 20;
const batchIdleDelay = 1_000;
const maxDelay = 60_000;
const retryDelay = 30_000;

/** Schedule one write per burst of committed edits. A paused editor keeps its deadlines. */
export class AutoSave {
  private changes = 0;
  private firstEdit = 0;
  private lastEdit = 0;
  private retryAt = 0;
  private deadline?: number;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly flush: () => void) {}

  recordEdit() {
    this.lastEdit = Date.now();
    if (!this.changes) this.firstEdit = this.lastEdit;
    this.changes++;
  }

  reset() {
    this.disarm();
    this.changes = 0;
    this.retryAt = 0;
  }

  retryLater() {
    this.retryAt = Date.now() + retryDelay;
  }

  update(dirty: boolean, paused: boolean) {
    if (!dirty) return this.reset();
    if (paused) return this.disarm();
    if (!this.changes) this.recordEdit();
    const idle = this.changes >= batchSize ? batchIdleDelay : idleDelay;
    const due = Math.max(this.retryAt, Math.min(this.firstEdit + maxDelay, this.lastEdit + idle));
    if (this.deadline === due) return;
    this.disarm();
    this.deadline = due;
    this.timer = setTimeout(
      () => {
        this.deadline = undefined;
        this.timer = undefined;
        this.flush();
      },
      Math.max(0, due - Date.now()),
    );
  }

  private disarm() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.deadline = undefined;
  }
}
