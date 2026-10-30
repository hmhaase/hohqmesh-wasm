// Runs jobs in a module worker that can be killed at any time (hung or crashed
// Fortran). A killed or failed worker is replaced lazily by the next run(), so a
// worker that cannot even load fails each run once instead of respawning in a loop.
export class Runner {
  constructor(url) {
    this.url = url;
    this.seq = 0;
    this.pending = null;
    this.worker = null;
  }

  ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker(this.url, { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (!this.pending || data.id !== this.pending.id) return;
      if (data.type === 'log') this.pending.onLog?.(data.line, data.err);
      else if (data.type === 'done') this.settle(data);
    };
    this.worker.onerror = e => {
      e.preventDefault();
      this.abort({ crash: e.message || 'worker failed to load or crashed' });
    };
  }

  settle(result) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve({ exitCode: -1, ms: 0, files: {}, outputs: [], ...result });
  }

  abort(result) {
    this.worker?.terminate();
    this.worker = null;
    this.settle(result);
  }

  run(message, { onLog, timeoutMs } = {}) {
    if (this.pending) this.abort({ crash: 'superseded', superseded: true });
    this.ensureWorker();
    const id = ++this.seq;
    return new Promise(resolve => {
      this.pending = { id, resolve, onLog };
      if (timeoutMs) this.pending.timer = setTimeout(() => this.abort({ crash: `timed out after ${timeoutMs / 1000} s` }), timeoutMs);
      this.worker.postMessage({ id, ...message });
    });
  }

  stop() { if (this.pending) this.abort({ crash: 'stopped by user', stopped: true }); }
  get busy() { return this.pending !== null; }
}
