import { Routes, Route, Navigate } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard/Dashboard';
import { WorkflowPage } from './pages/Workflow/WorkflowPage';

// Product Design
import { DesignLibrary } from './pages/ProductDesign/DesignLibrary';
import { DesignDetail } from './pages/ProductDesign/DesignDetail';
import { MetalRates } from './pages/ProductDesign/MetalRates';

// Procurement
import { PurchaseRequisitions } from './pages/Procurement/PurchaseRequisitions';
import { PurchaseOrders } from './pages/Procurement/PurchaseOrders';
import { GrnVerification } from './pages/Procurement/GrnVerification';
import { Suppliers } from './pages/Procurement/Suppliers';
import { PurchaseReturns } from './pages/Procurement/PurchaseReturns';
import { DebitNotesPage } from './pages/Procurement/DebitNotesPage';
import { DebitNoteTemplatesPage } from './pages/Procurement/DebitNoteTemplatesPage';

// Inventory
import { MetalVault } from './pages/Inventory/MetalVault';
import { DiamondAssortment } from './pages/Inventory/DiamondAssortment';
import { Consumables } from './pages/Inventory/Consumables';

// Orders
import { SalesOrders } from './pages/Orders/SalesOrders';
import { Clients } from './pages/Orders/Clients';
import { Reservations } from './pages/Orders/Reservations';

// Manufacturing
import { FactoryFloor } from './pages/Manufacturing/FactoryFloor';
import { JobCards } from './pages/Manufacturing/JobCards';
import { JobCardDetail } from './pages/Manufacturing/JobCardDetail';
import { QcCheckpoints } from './pages/Manufacturing/QcCheckpoints';

// Outsourcing
import { KarigarLedger } from './pages/Outsourcing/KarigarLedger';
import { KarigarTransactions } from './pages/Outsourcing/KarigarTransactions';
import { SubcontractorInvoices } from './pages/Outsourcing/SubcontractorInvoices';

// Quality
import { HallmarkingPage } from './pages/Quality/HallmarkingPage';
import { RepairJobs } from './pages/Quality/RepairJobs';

// Masters
import { MastersPage } from './pages/Masters/MastersPage';
import { OfferManagementPage } from './pages/Offers/OfferManagementPage';
import { ApprovalInboxPage } from './pages/Offers/ApprovalInboxPage';

// Tagging
import { TagsPage } from './pages/Tagging/TagsPage';
import { NewTagPage } from './pages/Tagging/NewTagPage';
import { BranchesPage } from './pages/Tagging/BranchesPage';
import { BranchTransfersPage } from './pages/Tagging/BranchTransfersPage';
import { NewBranchTransferPage } from './pages/Tagging/NewBranchTransferPage';
import { BranchReceivesPage } from './pages/Tagging/BranchReceivesPage';
import { BranchReceiveDetailPage } from './pages/Tagging/BranchReceiveDetailPage';
import { StockLookupPage } from './pages/Tagging/StockLookupPage';
import { JewelTransactionHistory } from './pages/Tagging/JewelTransactionHistory';
import { BranchStockSummary } from './pages/Tagging/BranchStockSummary';
import { StockAudit } from './pages/Tagging/StockAudit';
import { TagTemplateDesignerPage } from './pages/Tagging/TagTemplateDesignerPage';

// Estimation (standalone — separate from Jewelry Tagging so it can be role-gated independently)
import { EstimationPage } from './pages/Estimation/EstimationPage';
import { EstimateTemplateDesignerPage } from './pages/Estimation/EstimateTemplateDesignerPage';

// Sales
import { MemoOutPage } from './pages/Sales/MemoOutPage';
import { SalesInvoices } from './pages/Sales/SalesInvoices';
import { NewSalePage } from './pages/Sales/NewSalePage';
import { OldGoldExchange } from './pages/Sales/OldGoldExchange';
import { GstRegistrationsPage } from './pages/Sales/GstRegistrationsPage';
import { GstCompliancePage } from './pages/Compliance/GstCompliancePage';
import { TaxInvoiceTemplatesPage } from './pages/Sales/TaxInvoiceTemplatesPage';
import { TaxInvoiceTemplateDesignerPage } from './pages/Sales/TaxInvoiceTemplateDesignerPage';
import { CreditNotesPage } from './pages/Sales/CreditNotesPage';
import { CustomerAdvances } from './pages/Sales/CustomerAdvances';
import { CreditNoteTemplatesPage } from './pages/Sales/CreditNoteTemplatesPage';

// Finance
import { JournalEntries } from './pages/Finance/JournalEntries';
import { ChartOfAccounts } from './pages/Finance/ChartOfAccounts';
import { TrialBalance } from './pages/Finance/TrialBalance';
import { DealerAging } from './pages/Finance/DealerAging';
import { ClientLedger } from './pages/Finance/ClientLedger';
import { SupplierLedger } from './pages/Finance/SupplierLedger';
import { PnLStatement } from './pages/Finance/PnLStatement';
import { CostCenters } from './pages/Finance/CostCenters';

// Reports
import { WipSummary } from './pages/Reports/WipSummary';
import { StockSummary } from './pages/Reports/StockSummary';
import { KarigarBalances } from './pages/Reports/KarigarBalances';
import { AgingReceivables } from './pages/Reports/AgingReceivables';
import { SalesRegister } from './pages/Reports/SalesRegister';
import { StockOnHand } from './pages/Reports/StockOnHand';
import { DeadStock } from './pages/Reports/DeadStock';
import { StockBook } from './pages/Reports/StockBook';
import { SalesReport } from './pages/Reports/SalesReport';
import { BarcodeHistory } from './pages/Reports/BarcodeHistory';
import { SalesReturnRegister } from './pages/Reports/SalesReturnRegister';
import { RepairRegister } from './pages/Tagging/RepairRegister';
import { RepairTransfers } from './pages/Tagging/RepairTransfers';
import { DayBook } from './pages/Reports/DayBook';
import { GstSummary } from './pages/Reports/GstSummary';
import { PurchaseGstSummary } from './pages/Reports/PurchaseGstSummary';
import { Gstr1Table12 } from './pages/Reports/Gstr1Table12';
import { Gstr1Table13 } from './pages/Reports/Gstr1Table13';
import { Gstr1 } from './pages/Reports/Gstr1';

// Photography
import { PhotographyDashboard } from './pages/Photography/PhotographyDashboard';
import { PhotographyCapturePage } from './pages/Photography/PhotographyCapturePage';
import { PhotographySettingsPage } from './pages/Photography/PhotographySettingsPage';

// Settings & Hardware
import { SettingsPage } from './pages/Settings/SettingsPage';
import { CompanyUsersPage } from './pages/Settings/CompanyUsersPage';
import { RoleEditorPage } from './pages/Settings/RoleEditorPage';
import { PaymentConfigPage } from './pages/Settings/PaymentConfigPage';
import { HardwarePage } from './pages/Hardware/HardwarePage';
import { useTabActive } from './components/Layout/TabActiveContext';
import { RequirePermission } from './components/auth/RequirePermission';

// A location no route matches falls back to the dashboard — but only from the tab on screen, so a
// stale background tab (restored after a reload) can't hijack the router.
function UnknownPage() {
  return useTabActive() ? <Navigate to="/" replace /> : null;
}

/** Every page in the app. Rendered once per open tab, each with that tab's own location. */
export function PageRoutes({ location }: { location: { pathname: string; search: string } }) {
  return (
    <Routes location={location}>
      <Route index element={<Dashboard />} />
      <Route path="workflow" element={<WorkflowPage />} />

      {/* Product Design */}
      <Route path="designs" element={<DesignLibrary />} />
      <Route path="designs/:id" element={<DesignDetail />} />
      <Route path="designs/rates" element={<MetalRates />} />

      {/* Procurement */}
      <Route path="procurement/requisitions" element={<RequirePermission permission="po:view"><PurchaseRequisitions /></RequirePermission>} />
      <Route path="procurement/orders" element={<RequirePermission permission="po:view"><PurchaseOrders /></RequirePermission>} />
      <Route path="procurement/grn" element={<RequirePermission permission="grn:view"><GrnVerification /></RequirePermission>} />
      <Route path="procurement/returns" element={<RequirePermission permission="po:view"><PurchaseReturns /></RequirePermission>} />
      <Route path="procurement/debit-notes" element={<RequirePermission permission="debitNote:view"><DebitNotesPage /></RequirePermission>} />
      <Route path="procurement/debit-note-templates" element={<RequirePermission permission="debitNoteTemplate:view"><DebitNoteTemplatesPage /></RequirePermission>} />
      <Route path="procurement/suppliers" element={<RequirePermission permission="po:view"><Suppliers /></RequirePermission>} />

      {/* Inventory */}
      <Route path="inventory/metals" element={<MetalVault />} />
      <Route path="inventory/stones" element={<DiamondAssortment />} />
      <Route path="inventory/consumables" element={<Consumables />} />

      {/* Orders */}
      <Route path="orders" element={<SalesOrders />} />
      <Route path="orders/clients" element={<RequirePermission permission="client:view"><Clients /></RequirePermission>} />
      <Route path="orders/reservations" element={<Reservations />} />

      {/* Manufacturing */}
      <Route path="manufacturing" element={<FactoryFloor />} />
      <Route path="manufacturing/jobs" element={<JobCards />} />
      <Route path="manufacturing/jobs/:id" element={<JobCardDetail />} />
      <Route path="manufacturing/qc" element={<QcCheckpoints />} />

      {/* Outsourcing */}
      <Route path="outsourcing/ledger" element={<KarigarLedger />} />
      <Route path="outsourcing/transactions" element={<KarigarTransactions />} />
      <Route path="outsourcing/invoices" element={<SubcontractorInvoices />} />

      {/* Quality */}
      <Route path="quality/hallmarking" element={<RequirePermission permission="hallmark:manage"><HallmarkingPage /></RequirePermission>} />
      <Route path="quality/repairs" element={<RequirePermission permission="repair:view"><RepairJobs /></RequirePermission>} />

      {/* Masters */}
      <Route path="offers" element={<RequirePermission permission="offer:view"><OfferManagementPage /></RequirePermission>} />
      <Route path="offers/approvals" element={<RequirePermission permission="discount:approve"><ApprovalInboxPage /></RequirePermission>} />
      <Route path="masters" element={<RequirePermission permission="masters:view"><MastersPage /></RequirePermission>} />

      {/* Tagging */}
      <Route path="tagging/tags"         element={<TagsPage />} />
      <Route path="tagging/tags/new"     element={<NewTagPage />} />
      <Route path="tagging/tags/:id/edit" element={<NewTagPage />} />
      <Route path="photography" element={<RequirePermission permission="photography:view"><PhotographyDashboard /></RequirePermission>} />
      <Route path="photography/capture" element={<RequirePermission permission="photography:capture"><PhotographyCapturePage /></RequirePermission>} />
      <Route path="photography/settings" element={<RequirePermission permission="photography:manage_settings"><PhotographySettingsPage /></RequirePermission>} />
      <Route path="tagging/lookup"       element={<StockLookupPage />} />
      <Route path="tagging/transactions" element={<JewelTransactionHistory />} />
      <Route path="tagging/templates"    element={<TagTemplateDesignerPage />} />
      <Route path="tagging/branch-stock" element={<BranchStockSummary />} />
      <Route path="tagging/audits"       element={<StockAudit />} />
      <Route path="tagging/branches"     element={<BranchesPage />} />
      <Route path="tagging/transfers"    element={<BranchTransfersPage />} />
      <Route path="tagging/transfers/new" element={<NewBranchTransferPage />} />
      <Route path="tagging/receives"     element={<BranchReceivesPage />} />
      <Route path="tagging/repairs"      element={<RequirePermission permission="repair:view"><RepairRegister /></RequirePermission>} />
      <Route path="tagging/repair-transfers" element={<RequirePermission permission="repair:view"><RepairTransfers /></RequirePermission>} />
      <Route path="tagging/receives/:id" element={<BranchReceiveDetailPage />} />

      {/* Estimation (standalone) */}
      <Route path="estimation" element={<EstimationPage />} />
      <Route path="estimation/templates" element={<EstimateTemplateDesignerPage />} />

      {/* Sales */}
      <Route path="sales/memos" element={<RequirePermission permission="memo:manage"><MemoOutPage /></RequirePermission>} />
      <Route path="sales/invoices" element={<RequirePermission permission="sales:view"><SalesInvoices /></RequirePermission>} />
      <Route path="sales/invoices/new" element={<RequirePermission permission="invoice:create"><NewSalePage /></RequirePermission>} />
      <Route path="sales/invoices/:id/edit" element={<RequirePermission permission="invoice:edit"><NewSalePage /></RequirePermission>} />
      <Route path="sales/exchanges" element={<RequirePermission permission="sales:view"><OldGoldExchange /></RequirePermission>} />
      <Route path="sales/gst-registrations" element={<RequirePermission permission="gst:registration_view"><GstRegistrationsPage /></RequirePermission>} />
      <Route path="sales/gst-compliance" element={<RequirePermission permission="gst:registration_view"><GstCompliancePage /></RequirePermission>} />
      <Route path="compliance/gst" element={<RequirePermission permission="gst:registration_view"><GstCompliancePage /></RequirePermission>} />
      <Route path="sales/tax-invoice-templates" element={<RequirePermission permission="taxInvoiceTemplate:view"><TaxInvoiceTemplatesPage /></RequirePermission>} />
      <Route path="sales/tax-invoice-templates/designer" element={<RequirePermission permission="taxInvoiceTemplate:view"><TaxInvoiceTemplateDesignerPage /></RequirePermission>} />
      <Route path="sales/credit-notes" element={<RequirePermission permission="creditNote:view"><CreditNotesPage /></RequirePermission>} />
      <Route path="sales/advances" element={<RequirePermission permission="payment:view"><CustomerAdvances /></RequirePermission>} />
      <Route path="sales/credit-note-templates" element={<RequirePermission permission="creditNoteTemplate:view"><CreditNoteTemplatesPage /></RequirePermission>} />

      {/* Finance */}
      <Route path="finance/journals" element={<JournalEntries />} />
      <Route path="finance/accounts" element={<ChartOfAccounts />} />
      {/* J4-D1: these five now need report:financial_view (sensitive financial detail) — see navItems.tsx. */}
      <Route path="finance/trial-balance" element={<RequirePermission permission="report:trial_balance"><TrialBalance /></RequirePermission>} />
      <Route path="finance/pnl" element={<RequirePermission permission="report:pnl"><PnLStatement /></RequirePermission>} />
      <Route path="finance/cost-centers" element={<RequirePermission permission="report:cost_centers"><CostCenters /></RequirePermission>} />
      <Route path="finance/dealer-aging" element={<RequirePermission permission="report:dealer_aging"><DealerAging /></RequirePermission>} />
      <Route path="finance/client-ledger" element={<RequirePermission permission="report:client_ledger"><ClientLedger /></RequirePermission>} />
      <Route path="finance/client-ledger/:clientId" element={<RequirePermission permission="report:client_ledger"><ClientLedger /></RequirePermission>} />
      <Route path="finance/supplier-ledger" element={<RequirePermission permission="report:supplier_ledger"><SupplierLedger /></RequirePermission>} />
      <Route path="finance/supplier-ledger/:supplierId" element={<RequirePermission permission="report:supplier_ledger"><SupplierLedger /></RequirePermission>} />

      {/* Reports */}
      <Route path="reports/wip" element={<RequirePermission permission="report:wip"><WipSummary /></RequirePermission>} />
      <Route path="reports/stock" element={<RequirePermission permission="report:stock_summary"><StockSummary /></RequirePermission>} />
      <Route path="reports/karigar" element={<RequirePermission permission="report:karigar"><KarigarBalances /></RequirePermission>} />
      <Route path="reports/aging" element={<RequirePermission permission="report:aging_receivables"><AgingReceivables /></RequirePermission>} />
      <Route path="reports/sales-register" element={<RequirePermission permission="report:sales_register"><SalesRegister /></RequirePermission>} />
      <Route path="reports/sales-report" element={<RequirePermission permission="report:sales_report"><SalesReport /></RequirePermission>} />
      <Route path="reports/stock-book" element={<RequirePermission permission="report:stock_book"><StockBook /></RequirePermission>} />
      <Route path="reports/barcode-history" element={<RequirePermission permission="report:barcode_history"><BarcodeHistory /></RequirePermission>} />
      <Route path="reports/repair-register" element={<RequirePermission permission="repair:view"><RepairRegister /></RequirePermission>} />
      <Route path="reports/repair-transfers" element={<RequirePermission permission="repair:view"><RepairTransfers /></RequirePermission>} />
      <Route path="reports/sales-returns" element={<RequirePermission permission="sales:view"><SalesReturnRegister /></RequirePermission>} />
      <Route path="reports/stock-on-hand" element={<RequirePermission permission="report:stock_on_hand"><StockOnHand /></RequirePermission>} />
      <Route path="reports/dead-stock" element={<RequirePermission permission="report:dead_stock"><DeadStock /></RequirePermission>} />
      <Route path="reports/day-book" element={<RequirePermission permission="report:day_book"><DayBook /></RequirePermission>} />
      <Route path="reports/gst-summary" element={<RequirePermission permission="report:financial_view"><GstSummary /></RequirePermission>} />
      <Route path="reports/purchase-gst-summary" element={<RequirePermission permission="report:financial_view"><PurchaseGstSummary /></RequirePermission>} />
      <Route path="reports/gstr1-table12" element={<RequirePermission permission="report:financial_view"><Gstr1Table12 /></RequirePermission>} />
      <Route path="finance/reports/gstr1-table12" element={<RequirePermission permission="report:financial_view"><Gstr1Table12 /></RequirePermission>} />
      <Route path="reports/gstr1-table13" element={<RequirePermission permission="report:financial_view"><Gstr1Table13 /></RequirePermission>} />
      <Route path="finance/reports/gstr1-table13" element={<RequirePermission permission="report:financial_view"><Gstr1Table13 /></RequirePermission>} />
      <Route path="reports/gstr1" element={<RequirePermission permission="report:financial_view"><Gstr1 /></RequirePermission>} />
      <Route path="finance/reports/gstr1" element={<RequirePermission permission="report:financial_view"><Gstr1 /></RequirePermission>} />

      {/* Hardware & Settings */}
      <Route path="hardware" element={<RequirePermission permission="hardware:manage"><HardwarePage /></RequirePermission>} />
      <Route path="settings/users" element={<RequirePermission permission="user:manage"><CompanyUsersPage /></RequirePermission>} />
      <Route path="settings/roles" element={<RequirePermission permission="role:view"><RoleEditorPage /></RequirePermission>} />
      <Route path="settings/payment-config" element={<RequirePermission permission="paymentConfig:view"><PaymentConfigPage /></RequirePermission>} />
      <Route path="settings" element={<RequirePermission permission="system:config"><SettingsPage /></RequirePermission>} />
      <Route path="*" element={<UnknownPage />} />
    </Routes>
  );
}
