import { describe, it, expect } from 'vitest';
import { passwordFormError } from '../pages/Account/ChangePasswordPage';

const ok = { current: 'Temporary-Passw0rd-123', next: 'A-Brand-New-Passphrase-77', confirm: 'A-Brand-New-Passphrase-77' };
const who = { email: 'owner@example.com', name: 'Sai Krishna' };

describe('change-password form rules (mirror of the server policy)', () => {
  it('accepts a long, different, matching password', () => expect(passwordFormError(ok, who)).toBe(''));
  it('requires the current password', () => expect(passwordFormError({ ...ok, current: '' }, who)).toMatch(/current/));
  it('rejects short, reused, repetitive, personal and mismatched passwords', () => {
    expect(passwordFormError({ ...ok, next: 'Short1!', confirm: 'Short1!' }, who)).toMatch(/at least 12/);
    expect(passwordFormError({ ...ok, next: ok.current, confirm: ok.current }, who)).toMatch(/different/);
    expect(passwordFormError({ ...ok, next: 'aaaaaaaaaaaaaaaa', confirm: 'aaaaaaaaaaaaaaaa' }, who)).toMatch(/repetitive/);
    expect(passwordFormError({ ...ok, next: 'my-owner@example.com-1', confirm: 'my-owner@example.com-1' }, who)).toMatch(/e-mail or name/);
    expect(passwordFormError({ ...ok, confirm: 'A-Brand-New-Passphrase-78' }, who)).toMatch(/do not match/);
  });
});
