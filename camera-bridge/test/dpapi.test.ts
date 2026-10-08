import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { DpapiCredentialStore } from '../src/credentials';

// Real Windows DPAPI round-trip (CurrentUser scope) through powershell.exe. Skipped off Windows.
describe.skipIf(process.platform !== 'win32')('DpapiCredentialStore', () => {
  it('stores the secret encrypted at rest and round-trips it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trivo-cred-'));
    const file = path.join(dir, 'station.cred');
    const secret = 'dpapi-test-secret-789';
    try {
      const s = new DpapiCredentialStore(file);
      expect(await s.load()).toBeNull();
      await s.save(secret);
      const onDisk = fs.readFileSync(file, 'utf8');
      expect(onDisk).not.toContain(secret);
      expect(onDisk.length).toBeGreaterThan(40);
      expect(await new DpapiCredentialStore(file).load()).toBe(secret);
      await expect(s.save('   ')).rejects.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
