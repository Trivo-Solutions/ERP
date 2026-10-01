import { exportToCsv, CsvColumn } from './exportToCsv';
import type {
  Gstr1B2bInvoiceRecord,
  Gstr1B2clInvoiceRecord,
  Gstr1B2csGroup,
  Gstr1CreditNoteReportDocument,
} from '../types/gstr1';

/**
 * Format date for CSV export (YYYY-MM-DD)
 */
function formatDate(d: string | Date | null | undefined): string {
  if (!d) return '';
  if (typeof d === 'string') {
    return d.split('T')[0];
  }
  return d.toISOString().split('T')[0];
}

/**
 * Format rate as percentage string (e.g. 3%, 18%)
 */
function formatRatePercent(rate: number): string {
  if (rate === null || rate === undefined || isNaN(rate)) return '0%';
  return `${Number((rate * 100).toFixed(2))}%`.replace('.00%', '%');
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 4: B2B CSV Export
// ─────────────────────────────────────────────────────────────────────────────

interface Table4CsvRow {
  buyerGstin: string;
  invoiceNumber: string;
  invoiceDate: string;
  invoiceValue: number;
  placeOfSupply: string;
  reverseCharge: string;
  rate: string;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  hsnCode: string;
  uqc: string;
  quantity: number;
}

export function exportTable4Csv(
  records: Gstr1B2bInvoiceRecord[],
  filename = 'gstr1-table4-b2b.csv'
) {
  const rows: Table4CsvRow[] = [];

  for (const inv of records) {
    if (inv.lines && inv.lines.length > 0) {
      for (const line of inv.lines) {
        rows.push({
          buyerGstin: inv.buyerGstin ?? '',
          invoiceNumber: inv.invoiceNumber,
          invoiceDate: formatDate(inv.invoiceDate),
          invoiceValue: inv.invoiceValue,
          placeOfSupply: inv.placeOfSupply ?? '',
          reverseCharge: inv.reverseCharge ? 'Y' : 'N',
          rate: formatRatePercent(line.gstRate),
          taxableValue: line.taxableValue,
          igst: line.igst,
          cgst: line.cgst,
          sgst: line.sgst,
          cess: line.cess,
          hsnCode: line.hsnCode ?? '',
          uqc: line.uqc ?? '',
          quantity: line.quantity,
        });
      }
    } else {
      rows.push({
        buyerGstin: inv.buyerGstin ?? '',
        invoiceNumber: inv.invoiceNumber,
        invoiceDate: formatDate(inv.invoiceDate),
        invoiceValue: inv.invoiceValue,
        placeOfSupply: inv.placeOfSupply ?? '',
        reverseCharge: inv.reverseCharge ? 'Y' : 'N',
        rate: '',
        taxableValue: inv.totals.taxableValue,
        igst: inv.totals.igst,
        cgst: inv.totals.cgst,
        sgst: inv.totals.sgst,
        cess: inv.totals.cess,
        hsnCode: '',
        uqc: '',
        quantity: 0,
      });
    }
  }

  const columns: CsvColumn<Table4CsvRow>[] = [
    { header: 'Recipient GSTIN', value: (r) => r.buyerGstin },
    { header: 'Invoice Number', value: (r) => r.invoiceNumber },
    { header: 'Invoice Date', value: (r) => r.invoiceDate },
    { header: 'Invoice Value', value: (r) => r.invoiceValue },
    { header: 'Place of Supply', value: (r) => r.placeOfSupply },
    { header: 'Reverse Charge', value: (r) => r.reverseCharge },
    { header: 'Rate', value: (r) => r.rate },
    { header: 'Taxable Value', value: (r) => r.taxableValue },
    { header: 'IGST', value: (r) => r.igst },
    { header: 'CGST', value: (r) => r.cgst },
    { header: 'SGST', value: (r) => r.sgst },
    { header: 'Cess', value: (r) => r.cess },
    { header: 'HSN', value: (r) => r.hsnCode },
    { header: 'UQC', value: (r) => r.uqc },
    { header: 'Quantity', value: (r) => r.quantity },
  ];

  exportToCsv(filename, columns, rows);
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 5: B2CL CSV Export
// ─────────────────────────────────────────────────────────────────────────────

interface Table5CsvRow {
  invoiceNumber: string;
  invoiceDate: string;
  invoiceValue: number;
  placeOfSupply: string;
  threshold: number;
  rate: string;
  taxableValue: number;
  igst: number;
  cess: number;
  hsnCode: string;
  uqc: string;
  quantity: number;
}

export function exportTable5Csv(
  records: Gstr1B2clInvoiceRecord[],
  filename = 'gstr1-table5-b2cl.csv'
) {
  const rows: Table5CsvRow[] = [];

  for (const inv of records) {
    if (inv.lines && inv.lines.length > 0) {
      for (const line of inv.lines) {
        rows.push({
          invoiceNumber: inv.invoiceNumber,
          invoiceDate: formatDate(inv.invoiceDate),
          invoiceValue: inv.invoiceValue,
          placeOfSupply: inv.placeOfSupply ?? '',
          threshold: inv.threshold,
          rate: formatRatePercent(line.gstRate),
          taxableValue: line.taxableValue,
          igst: line.igst,
          cess: line.cess,
          hsnCode: line.hsnCode ?? '',
          uqc: line.uqc ?? '',
          quantity: line.quantity,
        });
      }
    } else {
      rows.push({
        invoiceNumber: inv.invoiceNumber,
        invoiceDate: formatDate(inv.invoiceDate),
        invoiceValue: inv.invoiceValue,
        placeOfSupply: inv.placeOfSupply ?? '',
        threshold: inv.threshold,
        rate: '',
        taxableValue: inv.totals.taxableValue,
        igst: inv.totals.igst,
        cess: inv.totals.cess,
        hsnCode: '',
        uqc: '',
        quantity: 0,
      });
    }
  }

  const columns: CsvColumn<Table5CsvRow>[] = [
    { header: 'Invoice Number', value: (r) => r.invoiceNumber },
    { header: 'Invoice Date', value: (r) => r.invoiceDate },
    { header: 'Invoice Value', value: (r) => r.invoiceValue },
    { header: 'Place of Supply', value: (r) => r.placeOfSupply },
    { header: 'Applicable Threshold', value: (r) => r.threshold },
    { header: 'Rate', value: (r) => r.rate },
    { header: 'Taxable Value', value: (r) => r.taxableValue },
    { header: 'IGST', value: (r) => r.igst },
    { header: 'Cess', value: (r) => r.cess },
    { header: 'HSN', value: (r) => r.hsnCode },
    { header: 'UQC', value: (r) => r.uqc },
    { header: 'Quantity', value: (r) => r.quantity },
  ];

  exportToCsv(filename, columns, rows);
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 7: B2CS CSV Export
// Phase A: Preserves Gross / Reduction / Net columns. NEVER collapses them!
// ─────────────────────────────────────────────────────────────────────────────

export function exportTable7Csv(
  groups: Gstr1B2csGroup[],
  filename = 'gstr1-table7-b2cs.csv'
) {
  const columns: CsvColumn<Gstr1B2csGroup>[] = [
    { header: 'Supply Type', value: (r) => (r.isInterState ? 'Inter-State' : 'Intra-State') },
    { header: 'Place of Supply', value: (r) => r.placeOfSupply },
    { header: 'Rate', value: (r) => formatRatePercent(r.gstRate) },
    { header: 'HSN', value: (r) => r.hsnCode ?? '' },
    { header: 'UQC', value: (r) => r.uqc ?? '' },

    // Taxable Value: Gross, Reduction, Net
    { header: 'Gross Taxable Value', value: (r) => r.grossTaxableValue },
    { header: 'Credit Note Reduction', value: (r) => r.creditNoteTaxableReduction },
    { header: 'Net Taxable Value', value: (r) => r.taxableValue },

    // IGST: Gross, Reduction, Net
    { header: 'Gross IGST', value: (r) => r.grossIgst },
    { header: 'Credit Note IGST Reduction', value: (r) => r.creditNoteIgstReduction },
    { header: 'Net IGST', value: (r) => r.igst },

    // CGST: Gross, Reduction, Net
    { header: 'Gross CGST', value: (r) => r.grossCgst },
    { header: 'Credit Note CGST Reduction', value: (r) => r.creditNoteCgstReduction },
    { header: 'Net CGST', value: (r) => r.cgst },

    // SGST: Gross, Reduction, Net
    { header: 'Gross SGST', value: (r) => r.grossSgst },
    { header: 'Credit Note SGST Reduction', value: (r) => r.creditNoteSgstReduction },
    { header: 'Net SGST', value: (r) => r.sgst },

    // Cess: Gross, Reduction, Net & generic Cess
    { header: 'Gross Cess', value: (r) => r.grossCess },
    { header: 'Credit Note Cess Reduction', value: (r) => r.creditNoteCessReduction },
    { header: 'Net Cess', value: (r) => r.cess },
    { header: 'Cess', value: (r) => r.cess },

    // Quantity: Gross, Reduction, Net
    { header: 'Gross Quantity', value: (r) => r.grossQuantity },
    { header: 'Credit Note Quantity Reduction', value: (r) => r.creditNoteQuantityReduction },
    { header: 'Net Quantity', value: (r) => r.quantity },

    // Statutory Filing Status & Diagnostics
    { header: 'Filing Eligible', value: (r) => (r.filingEligible ? 'Yes' : 'No') },
    {
      header: 'Diagnostic',
      value: (r) => (r.filingEligible ? '' : 'Negative net B2CS bucket'),
    },
  ];

  exportToCsv(filename, columns, groups);
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 9B: Credit / Debit Notes CSV Export
// Supports: CDNR (Registered), CDNUR (B2CL), CDNUR (Export)
// STRICTLY NO CDNUR B2CS!
// ─────────────────────────────────────────────────────────────────────────────

interface Table9bCsvRow {
  documentType: string;
  creditNoteNumber: string;
  creditNoteDate: string;
  originalInvoiceNumber: string;
  originalInvoiceDate: string;
  buyerGstin: string;
  placeOfSupply: string;
  reasonCode: string;
  reasonNotes: string;
  noteValue: number;
  rate: string;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  hsnCode: string;
  uqc: string;
  quantity: number;
}

export function exportTable9bCsv(
  documents: Gstr1CreditNoteReportDocument[],
  tableCategory: 'CDNR' | 'CDNUR_B2CL' | 'CDNUR_EXPORT',
  filename?: string
) {
  const defaultFilename =
    tableCategory === 'CDNR'
      ? 'gstr1-table9b-cdnr.csv'
      : tableCategory === 'CDNUR_B2CL'
      ? 'gstr1-table9b-cdnur-b2cl.csv'
      : 'gstr1-table9b-cdnur-export.csv';

  const rows: Table9bCsvRow[] = [];

  for (const doc of documents) {
    if (doc.rateBreakdown && doc.rateBreakdown.length > 0) {
      for (const rb of doc.rateBreakdown) {
        rows.push({
          documentType: doc.documentType,
          creditNoteNumber: doc.creditNoteNumber,
          creditNoteDate: formatDate(doc.creditNoteDate),
          originalInvoiceNumber: doc.originalInvoiceNumber,
          originalInvoiceDate: formatDate(doc.originalInvoiceDate),
          buyerGstin: doc.buyerGstin ?? '',
          placeOfSupply: doc.placeOfSupply ?? '',
          reasonCode: doc.reasonCode ?? '',
          reasonNotes: doc.reasonNotes ?? '',
          noteValue: doc.noteValue,
          rate: formatRatePercent(rb.rate),
          taxableValue: rb.taxableValue,
          igst: rb.igst,
          cgst: rb.cgst,
          sgst: rb.sgst,
          cess: rb.cess,
          hsnCode: rb.hsnCode ?? '',
          uqc: rb.uqc ?? '',
          quantity: rb.quantity,
        });
      }
    } else {
      rows.push({
        documentType: doc.documentType,
        creditNoteNumber: doc.creditNoteNumber,
        creditNoteDate: formatDate(doc.creditNoteDate),
        originalInvoiceNumber: doc.originalInvoiceNumber,
        originalInvoiceDate: formatDate(doc.originalInvoiceDate),
        buyerGstin: doc.buyerGstin ?? '',
        placeOfSupply: doc.placeOfSupply ?? '',
        reasonCode: doc.reasonCode ?? '',
        reasonNotes: doc.reasonNotes ?? '',
        noteValue: doc.noteValue,
        rate: '',
        taxableValue: doc.taxableValue,
        igst: doc.igst,
        cgst: doc.cgst,
        sgst: doc.sgst,
        cess: doc.cess,
        hsnCode: '',
        uqc: '',
        quantity: 0,
      });
    }
  }

  const columns: CsvColumn<Table9bCsvRow>[] = [
    { header: 'Document Type', value: (r) => r.documentType },
    { header: 'Note Number', value: (r) => r.creditNoteNumber },
    { header: 'Note Date', value: (r) => r.creditNoteDate },
    { header: 'Original Invoice Number', value: (r) => r.originalInvoiceNumber },
    { header: 'Original Invoice Date', value: (r) => r.originalInvoiceDate },
    ...(tableCategory === 'CDNR' ? [{ header: 'Recipient GSTIN', value: (r: Table9bCsvRow) => r.buyerGstin }] : []),
    { header: 'Place of Supply', value: (r) => r.placeOfSupply },
    { header: 'Reason Code', value: (r) => r.reasonCode },
    { header: 'Reason Notes', value: (r) => r.reasonNotes },
    { header: 'Note Value', value: (r) => r.noteValue },
    { header: 'Rate', value: (r) => r.rate },
    { header: 'Taxable Value', value: (r) => r.taxableValue },
    { header: 'IGST', value: (r) => r.igst },
    { header: 'CGST', value: (r) => r.cgst },
    { header: 'SGST', value: (r) => r.sgst },
    { header: 'Cess', value: (r) => r.cess },
    { header: 'HSN', value: (r) => r.hsnCode },
    { header: 'UQC', value: (r) => r.uqc },
    { header: 'Quantity', value: (r) => r.quantity },
  ];

  exportToCsv(filename || defaultFilename, columns, rows);
}
