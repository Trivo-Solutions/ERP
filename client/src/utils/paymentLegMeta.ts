// Payment Configuration: which extra fields a payment leg shows for each method, and the matching validation.
// The server (server/src/shared/paymentMetadata.ts) re-checks every rule - this only drives what the screen shows and
// stops an obviously incomplete leg before the round trip. Hiding a field here is never the security control.

export type LegMeta = { providerId: string; terminalId: string; authCode: string; chequeNumber: string; chequeDate: string; chequeBank: string };
export const blankMeta = (): LegMeta => ({ providerId: '', terminalId: '', authCode: '', chequeNumber: '', chequeDate: '', chequeBank: '' });

export interface OptionProvider { id: string; name: string; shortCode?: string | null; category: string; supportedMethods: string[] }
export interface OptionTerminal { id: string; code: string; name: string; tid: string; mid?: string | null; supportedMethods: string[]; providerId: string; providerName: string }
export interface CollectionOptions {
  branchId: string; providers: OptionProvider[]; terminals: OptionTerminal[];
  requireTerminalForCard: boolean; requireProviderForBankTransfer: boolean;
}

export interface LegFields {
  provider: boolean; providerRequired: boolean; providers: OptionProvider[];
  terminal: boolean; terminalRequired: boolean; terminals: OptionTerminal[];
  authCode: boolean; cheque: boolean;
}

const none: LegFields = { provider: false, providerRequired: false, providers: [], terminal: false, terminalRequired: false, terminals: [], authCode: false, cheque: false };

/** What to show for a method, given what the selected branch has configured. No options loaded = show nothing extra. */
export function fieldsFor(mode: string, options: CollectionOptions | null | undefined): LegFields {
  if (!options) return none;
  const m = mode.toUpperCase();
  const providers = options.providers.filter((p) => p.supportedMethods.includes(m));
  const terminals = options.terminals.filter((t) => t.supportedMethods.includes(m));
  switch (m) {
    case 'CARD':
      // Card is taken on a physical machine: the terminal is the thing to choose (it carries its own acquirer).
      return { ...none, terminal: terminals.length > 0, terminalRequired: options.requireTerminalForCard, terminals, authCode: true };
    case 'UPI':
      return { ...none, provider: providers.length > 0, providers, terminal: terminals.length > 0, terminals };
    case 'BANK_TRANSFER':
      return { ...none, provider: providers.length > 0, providerRequired: options.requireProviderForBankTransfer, providers };
    case 'CHEQUE':
      return { ...none, cheque: true, provider: providers.length > 0, providers };
    default:
      return none; // CASH and anything legacy: exactly what it was before
  }
}

/** Only the keys that apply to this method, with blanks dropped - never sends a stale field from a previous method. */
export function legMetaPayload(mode: string, meta: LegMeta, options: CollectionOptions | null | undefined): Record<string, string> {
  const f = fieldsFor(mode, options);
  const out: Record<string, string> = {};
  if (f.provider && meta.providerId) out.providerId = meta.providerId;
  if (f.terminal && meta.terminalId) out.terminalId = meta.terminalId;
  if (f.authCode && meta.authCode.trim()) out.authCode = meta.authCode.trim();
  if (f.cheque) {
    if (meta.chequeNumber.trim()) out.chequeNumber = meta.chequeNumber.trim();
    if (meta.chequeDate) out.chequeDate = meta.chequeDate;
    if (meta.chequeBank.trim()) out.chequeBank = meta.chequeBank.trim();
  }
  return out;
}

/** The first thing wrong with a leg, or '' when it is complete. */
export function legMetaError(mode: string, meta: LegMeta, options: CollectionOptions | null | undefined): string {
  const f = fieldsFor(mode, options);
  if (f.terminalRequired && !meta.terminalId) return 'Select the POS terminal';
  if (f.providerRequired && !meta.providerId) return 'Select the bank / provider';
  const code = meta.authCode.replace(/[^0-9]/g, '');
  if (f.authCode && meta.authCode && !/^[A-Za-z0-9/-]{1,30}$/.test(meta.authCode)) return 'Authorization code: letters, digits, - and / only';
  if (f.authCode && code.length >= 13 && code.length <= 19 && luhn(code)) return 'That looks like a card number - enter only the approval code';
  return '';
}

function luhn(digits: string): boolean {
  let sum = 0; let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}
