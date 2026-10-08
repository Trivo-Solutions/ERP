import fs from 'fs';
import path from 'path';
import { CAMERA_ID } from './discovery';

/** The camera a person explicitly chose. Only an id and a display name — nothing secret, nothing from the ERP. */
export interface StoredSelection { id: string; displayName: string }

export interface SelectionStore {
  load(): StoredSelection | null;
  save(sel: StoredSelection | null): void;
}

export class MemorySelectionStore implements SelectionStore {
  constructor(private sel: StoredSelection | null = null) {}
  load(): StoredSelection | null { return this.sel; }
  save(sel: StoredSelection | null): void { this.sel = sel; }
}

/** `<data>/camera-selection.json`. A missing, corrupt or hand-edited file is simply "no selection" — never an error. */
export class FileSelectionStore implements SelectionStore {
  constructor(private readonly file: string) {}

  load(): StoredSelection | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      if (typeof raw.id === 'string' && CAMERA_ID.test(raw.id) && typeof raw.displayName === 'string' && raw.displayName.length <= 80) {
        return { id: raw.id, displayName: raw.displayName.replace(/[^A-Za-z0-9._ -]/g, ' ').trim() || 'Camera' };
      }
    } catch { /* absent or unreadable */ }
    return null;
  }

  save(sel: StoredSelection | null): void {
    try {
      if (!sel) { fs.rmSync(this.file, { force: true }); return; }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ id: sel.id, displayName: sel.displayName }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch { /* best effort: the choice then lasts until restart */ }
  }
}
