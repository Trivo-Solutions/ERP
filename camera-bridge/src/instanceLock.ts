import fs from 'fs';
import path from 'path';

// One bridge per station. Two bridges polling the same station could each pick up a command and release the shutter
// twice, so a second start must refuse. The lock is a file holding the owner's pid; a lock whose process is gone (crash,
// hard kill by Task Scheduler) is taken over. (A recycled pid can in principle look alive; the failure mode is a refused
// start, never a double capture, and deleting bridge.lock clears it.)
export class InstanceLockError extends Error {}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export class InstanceLock {
  private held = false;
  constructor(private readonly file: string, private readonly pid: number = process.pid) {}

  acquire(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(this.file, String(this.pid), { flag: 'wx' });
        this.held = true;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new InstanceLockError('Cannot create the instance lock');
        const owner = Number.parseInt(fs.readFileSync(this.file, 'utf8').trim(), 10);
        if (Number.isInteger(owner) && owner !== this.pid && alive(owner)) throw new InstanceLockError('Another bridge instance is already running on this station');
        fs.rmSync(this.file, { force: true }); // stale: its owner is gone
      }
    }
    throw new InstanceLockError('Cannot take the instance lock');
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      if (Number.parseInt(fs.readFileSync(this.file, 'utf8').trim(), 10) === this.pid) fs.rmSync(this.file, { force: true });
    } catch { /* already gone */ }
  }
}
