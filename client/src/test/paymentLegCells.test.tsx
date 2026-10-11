import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PaymentLegBankCell, PaymentLegDetailCell } from '../components/sales/PaymentLegCells';
import { blankMeta, CollectionOptions } from '../utils/paymentLegMeta';

const OPTIONS: CollectionOptions = {
  branchId: 'b1',
  providers: [
    { id: 'hdfc', name: 'HDFC', shortCode: 'HDFC', category: 'BANK', supportedMethods: ['UPI', 'BANK_TRANSFER'] },
    { id: 'sbi', name: 'SBI', shortCode: null, category: 'BANK', supportedMethods: ['UPI'] },
  ],
  terminals: [{ id: 't1', code: 'POS-1', name: 'C1', tid: 'T1', mid: null, supportedMethods: ['CARD'], providerId: 'x', providerName: 'Axis' }],
  requireTerminalForCard: true, requireProviderForBankTransfer: true, requireProviderForUpi: true,
};
const props = (mode: string, over: Record<string, unknown> = {}) => ({ mode, value: blankMeta(), onChange: () => {}, options: OPTIONS, ...over });
const bank = (mode: string, over = {}) => renderToStaticMarkup(<PaymentLegBankCell {...props(mode, over)} />);
const detail = (mode: string, over = {}) => renderToStaticMarkup(<PaymentLegDetailCell {...props(mode, over)} />);

describe('single-row payment cells (one table row per entry)', () => {
  it('UPI lists every bank allocated to the branch in the same row, with no terminal', () => {
    const html = bank('UPI');
    expect(html).toContain('HDFC (HDFC)');
    expect(html).toContain('SBI');
    expect(html).toContain('Bank *');
    expect(html).not.toContain('POS terminal');
    expect(detail('UPI')).not.toMatch(/input|select/); // nothing more to fill for UPI
  });

  it('card shows the terminal and the approval code, cash shows neither', () => {
    expect(bank('CARD')).toContain('POS-1 · Axis · TID T1');
    expect(detail('CARD')).toContain('Approval / auth code');
    for (const fn of [bank, detail]) expect(fn('CASH')).not.toMatch(/<select|<input/);
  });

  it('cheque shows number, date and bank inline', () => {
    const html = detail('CHEQUE');
    expect(html).toContain('Cheque no.');
    expect(html).toContain('Date');
    expect(html).toContain('Bank');
  });

  it('explains a missing setup, and loading / error, without a second row', () => {
    expect(bank('UPI', { options: { ...OPTIONS, providers: [] } })).toContain('No bank set up');
    expect(bank('UPI', { options: null, isLoading: true })).toContain('Loading');
    expect(bank('UPI', { options: null, isError: true })).toContain('Options unavailable');
  });

  it('credit-settlement modes take nothing', () => {
    for (const m of ['OLD_GOLD', 'STORE_CREDIT', 'CUSTOMER_ADVANCE']) {
      expect(bank(m)).not.toMatch(/<select/);
      expect(detail(m)).not.toMatch(/<input/);
    }
  });
});
