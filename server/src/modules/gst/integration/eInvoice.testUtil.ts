// Test-only helper: builds a structurally + checksum-valid GSTIN.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function makeGstin(state: string, letters: string, digits: string, entity = '1'): string {
  const first14 = `${state}${letters}${digits}A${entity}Z`;
  let factor = 2; let sum = 0;
  for (let i = first14.length - 1; i >= 0; i--) {
    let p = ALPHABET.indexOf(first14[i]) * factor;
    factor = factor === 2 ? 1 : 2;
    p = Math.floor(p / 36) + (p % 36);
    sum += p;
  }
  return first14 + ALPHABET[(36 - (sum % 36)) % 36];
}
