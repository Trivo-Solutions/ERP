// G8c — e-invoice eligibility engine. PURE and deterministic: no Prisma, no network, no clock.
//
// It answers exactly ONE question: "can TRIVO technically submit THIS document to an IRP?" — i.e. is
// every datum a verified e-invoice payload needs present, well-formed and internally consistent?
// It deliberately does NOT answer "is the taxpayer legally required to e-invoice this?" (that depends
// on aggregate turnover thresholds and notifications TRIVO has no authoritative value for), so
// `statutoryApplicability` is always 'NOT_DETERMINABLE' rather than a guess.
//
// Missing data is never treated as eligible: a datum that cannot be established is a MISSING_DATA
// blocking reason → CANNOT_DETERMINE. A fact that rules the document out is NOT_ELIGIBLE.
//
// Format constraints below (document-number pattern, 01/04/2025 floor, HSN 4/6/8 digits, 6-digit
// pincode, 3-char legal-name minimum, ±₹1 tolerance, 1000-line cap, supported Typ values) come from
// the NIC e-Invoice sandbox spec for Generate IRN (core API v1.03, schema Version 1.1), read
// 2026-10-03 at einv-apisandbox.nic.in/version1.03/generate-irn.html.
import { validateGstin } from '../../../shared/gstin';
import {
  EInvoiceSource, EInvoiceEligibilityResult, EInvoiceReason, Numeric,
  EINVOICE_SUPPORTED_DOCUMENT_TYPES,
} from './eInvoice.types';

const TOLERANCE = 1; // ₹1 — the spec's own calculated-value tolerance
const MIN_DOCUMENT_DATE = Date.UTC(2025, 3, 1); // 01/04/2025
const MAX_LINES = 1000;
const DOC_NO_PATTERN = /^[a-zA-Z1-9][a-zA-Z0-9/-]{0,15}$/;

export function num(v: Numeric | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = Number(typeof v === 'number' ? v : v.toString());
  return Number.isFinite(n) ? n : NaN;
}

const blank = (s: string | null | undefined) => s === null || s === undefined || s.trim() === '';

export function evaluateEInvoiceEligibility(src: EInvoiceSource): EInvoiceEligibilityResult {
  const reasons: EInvoiceReason[] = [];
  const no = (code: string, message: string) => reasons.push({ code, message, kind: 'NOT_ELIGIBLE' });
  const missing = (code: string, message: string) => reasons.push({ code, message, kind: 'MISSING_DATA' });

  const { invoice, tax, registration } = src;

  if (!EINVOICE_SUPPORTED_DOCUMENT_TYPES.includes(src.documentType)) {
    no('DOCUMENT_TYPE_UNSUPPORTED', `Document type ${src.documentType} is not supported yet; only INV is`);
  }

  // ── document state / ownership consistency ───────────────────────────────
  if (invoice.companyId !== registration.companyId) no('COMPANY_MISMATCH', 'Invoice and GST registration belong to different companies');
  if (invoice.status === 'VOID') no('INVOICE_VOID', 'A void invoice cannot be e-invoiced');
  else if (invoice.status === 'DRAFT') no('INVOICE_NOT_ISSUED', 'A draft invoice has not been issued');
  if (!registration.isActive) no('REGISTRATION_INACTIVE', 'The GST registration is inactive');

  // ── seller ────────────────────────────────────────────────────────────────
  const sellerGstin = validateGstin(registration.gstin);
  if (!sellerGstin.valid) no('SELLER_GSTIN_INVALID', 'The registration GSTIN is not a valid GSTIN');

  if (!tax) {
    missing('TAX_INVOICE_MISSING', 'The invoice has no tax-invoice (GST) record');
  } else {
    if (tax.irn) no('IRN_ALREADY_GENERATED', 'This invoice already carries an IRN');
    if (blank(tax.sellerRegistrationId)) missing('SELLER_REGISTRATION_MISSING', 'The invoice was not issued under a recorded GST registration');
    else if (tax.sellerRegistrationId !== registration.id) no('REGISTRATION_MISMATCH', 'The invoice was issued under a different GST registration');
    if (tax.gstin.trim().toUpperCase() !== registration.gstin.trim().toUpperCase()) no('SELLER_GSTIN_MISMATCH', "The invoice's seller GSTIN differs from the registration's GSTIN");
    if (invoice.branchGstRegistrationId && invoice.branchGstRegistrationId !== registration.id) {
      no('BRANCH_REGISTRATION_MISMATCH', "The invoice's branch is linked to a different GST registration");
    }
    if (blank(tax.sellerLegalName) || tax.sellerLegalName!.trim().length < 3) missing('SELLER_NAME_MISSING', 'Seller legal name (min 3 characters) is not on the invoice snapshot');
    if (blank(tax.sellerAddress)) missing('SELLER_ADDRESS_MISSING', 'Seller address is not on the invoice snapshot');
    else if (tax.sellerAddress!.trim().length > 200) no('SELLER_ADDRESS_TOO_LONG', 'Seller address exceeds 200 characters');
    if (blank(tax.sellerCity) || tax.sellerCity!.trim().length < 3) missing('SELLER_CITY_MISSING', 'Seller city/location (min 3 characters) is missing');
    if (!/^[1-9]\d{5}$/.test(tax.sellerPincode ?? '')) missing('SELLER_PINCODE_INVALID', 'Seller pincode must be 6 digits');
    if (blank(tax.sellerStateCode)) missing('SELLER_STATE_MISSING', 'Seller state code is missing');
    else if (sellerGstin.valid && Number(tax.sellerStateCode) !== Number(sellerGstin.stateCode)) no('SELLER_STATE_MISMATCH', "Seller state code does not match the GSTIN's state");
  }

  // ── document identity ─────────────────────────────────────────────────────
  if (!DOC_NO_PATTERN.test(invoice.invoiceNumber)) no('DOCUMENT_NUMBER_INVALID', 'Invoice number must be 1-16 characters, start with a letter or 1-9, and use only letters, digits, / and -');
  if (Number.isNaN(invoice.invoiceDate.getTime())) missing('DOCUMENT_DATE_MISSING', 'Invoice date is missing');
  else if (invoice.invoiceDate.getTime() < MIN_DOCUMENT_DATE) no('DOCUMENT_DATE_TOO_OLD', 'Documents dated before 01/04/2025 are not accepted');

  if (invoice.currency !== 'INR') no('CURRENCY_NOT_SUPPORTED', 'Only INR invoices are supported; export / foreign-currency e-invoicing is not');

  // ── buyer / recipient ─────────────────────────────────────────────────────
  let buyerState: string | null = null;
  if (tax) {
    if (blank(tax.buyerGstin)) {
      no('BUYER_NOT_REGISTERED', 'The recipient has no GSTIN (B2C) — not a B2B e-invoice document');
    } else {
      const bg = validateGstin(tax.buyerGstin);
      if (!bg.valid) no('BUYER_GSTIN_INVALID', 'The recipient GSTIN is not a valid GSTIN');
      else {
        buyerState = bg.stateCode ?? null;
        if (!blank(tax.buyerStateCode) && Number(tax.buyerStateCode) !== Number(buyerState)) no('BUYER_STATE_MISMATCH', "The recipient's state code does not match their GSTIN");
        if (!/^\d{1,2}$/.test(tax.placeOfSupply.trim())) missing('PLACE_OF_SUPPLY_UNRESOLVED', 'Place of supply was not resolved to a state code');
        else if (buyerState && Number(tax.placeOfSupply) !== Number(buyerState)) no('POS_BUYER_STATE_MISMATCH', "Place of supply differs from the recipient GSTIN's state");
      }
    }
    if (!blank(tax.buyerCountry) && tax.buyerCountry!.trim().toLowerCase() !== 'india') no('EXPORT_NOT_SUPPORTED', 'A recipient outside India is an export — not supported');
    if (blank(tax.buyerName) || tax.buyerName!.trim().length < 3) missing('BUYER_NAME_MISSING', 'Recipient legal name (min 3 characters) is missing');
    if (blank(tax.buyerAddress)) missing('BUYER_ADDRESS_MISSING', 'Recipient address is missing');
    else if (tax.buyerAddress!.trim().length > 200) no('BUYER_ADDRESS_TOO_LONG', 'Recipient address exceeds 200 characters');
    if (blank(tax.buyerCity) || tax.buyerCity!.trim().length < 3) missing('BUYER_CITY_MISSING', 'Recipient city/location (min 3 characters) is missing');
    if (!/^[1-9]\d{5}$/.test(tax.buyerPincode ?? '')) missing('BUYER_PINCODE_INVALID', 'Recipient pincode must be 6 digits');
  }

  // ── lines & tax ───────────────────────────────────────────────────────────
  const items = src.items;
  if (items.length === 0) no('NO_LINE_ITEMS', 'The invoice has no line items');
  if (items.length > MAX_LINES) no('TOO_MANY_LINES', `More than ${MAX_LINES} line items`);

  let sumTaxable = 0, sumCgst = 0, sumSgst = 0, sumIgst = 0;
  items.forEach((it, i) => {
    const n = i + 1;
    if (blank(it.hsnCode) || !/^(\d{4}|\d{6}|\d{8})$/.test(it.hsnCode!.trim())) missing('LINE_HSN_INVALID', `Line ${n}: HSN must be 4, 6 or 8 digits`);
    if (!(it.quantity > 0)) missing('LINE_QUANTITY_INVALID', `Line ${n}: quantity must be positive`);
    if (blank(it.uqc)) missing('LINE_UQC_MISSING', `Line ${n}: unit of measure (UQC) is required for goods`);
    if (blank(it.description) || it.description.trim().length < 3) missing('LINE_DESCRIPTION_MISSING', `Line ${n}: description (min 3 characters) is missing`);
    const taxable = num(it.taxableValue), rate = num(it.taxRate), c = num(it.cgstAmount), s = num(it.sgstAmount), g = num(it.igstAmount);
    if ([taxable, rate, c, s, g].some(Number.isNaN)) { no('LINE_TAX_INVALID', `Line ${n}: tax values are not numeric`); return; }
    if (rate * 100 === 0.5) no('LINE_RATE_INVALID', `Line ${n}: a 0.5% GST rate is not accepted`);
    if (g > 0 && (c > 0 || s > 0)) no('LINE_TAX_SPLIT_INVALID', `Line ${n}: IGST cannot be combined with CGST/SGST`);
    if (Math.abs(taxable * rate - (c + s + g)) > TOLERANCE) no('LINE_TAX_MISMATCH', `Line ${n}: tax amounts do not equal taxable value × rate`);
    sumTaxable += taxable; sumCgst += c; sumSgst += s; sumIgst += g;
  });

  if (items.length > 0 && sumTaxable === 0 && num(invoice.subtotal) > 0) {
    missing('LINE_TAX_NOT_SNAPSHOT', 'Line-level taxable values were never recorded for this invoice');
  } else if (tax) {
    const cess = num(tax.cess);
    if (cess > 0) no('CESS_NOT_ITEMIZED', 'The invoice carries cess, which is not recorded per line');
    if (Math.abs(sumCgst - num(tax.cgst)) > TOLERANCE || Math.abs(sumSgst - num(tax.sgst)) > TOLERANCE || Math.abs(sumIgst - num(tax.igst)) > TOLERANCE) {
      no('TAX_TOTAL_MISMATCH', "Line tax amounts do not add up to the invoice's tax totals");
    }
    const computed = sumTaxable + sumCgst + sumSgst + sumIgst + cess + num(invoice.otherCharges) + num(invoice.roundOff);
    if (Math.abs(computed - num(invoice.totalAmount)) > TOLERANCE) no('INVOICE_TOTAL_MISMATCH', "Line values do not add up to the invoice total");
  }

  const hasBlocking = reasons.length > 0;
  const status = !hasBlocking ? 'ELIGIBLE' : reasons.some((r) => r.kind === 'NOT_ELIGIBLE') ? 'NOT_ELIGIBLE' : 'CANNOT_DETERMINE';

  const warnings: EInvoiceReason[] = [
    { code: 'STATUTORY_APPLICABILITY_NOT_DETERMINABLE', kind: 'INFO', message: 'TRIVO cannot establish whether e-invoicing is legally mandatory for this taxpayer (no verified turnover threshold)' },
    { code: 'SUPPLY_TYPE_ASSUMED_B2B', kind: 'INFO', message: 'Supply type is B2B (registered recipient); SEZ and export supplies are not represented in the data model' },
    { code: 'FILING_PERIOD_NOT_EVALUATED', kind: 'INFO', message: 'IRN registration changes no reported figure, so filing-period mutation protection is not consulted' },
  ];

  return {
    status,
    technicallyEligible: status === 'ELIGIBLE',
    statutoryApplicability: 'NOT_DETERMINABLE',
    blockingReasons: reasons,
    warnings,
    documentType: src.documentType,
    documentId: invoice.id,
    registrationId: registration.id,
    gstin: registration.gstin,
    supplyType: status === 'ELIGIBLE' ? 'B2B' : null,
  };
}
