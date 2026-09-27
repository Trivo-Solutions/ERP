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

// Tagging
import { TagsPage } from './pages/Tagging/TagsPage';
import { NewTagPage } from './pages/Tagging/NewTagPage';
import { BranchesPage } from './pages/Tagging/BranchesPage';
import { BranchTransfersPage } from './pages/Tagging/BranchTransfersPage';
import { NewBranchTransferPage } from './pages/Tagging/NewBranchTransferPage';
import { BranchReceivesPage } from './pages/Tagging/BranchReceivesPage';
import { BranchReceiveDetailPage } from './pages/Tagging/BranchReceiveDetailPage';
import { StockLookupPage } from './pages/Tagging/StockLookupPage';
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
import { DayBook } from './pages/Reports/DayBook';
import { GstSummary } from './pages/Reports/GstSummary';
import { PurchaseGstSummary } from './pages/Reports/PurchaseGstSummary';

// Settings & Hardware
import { SettingsPage } from './pages/Settings/SettingsPage';
import { HardwarePage } from './pages/Hardware/HardwarePage';
import { useTabActive } from './components/Layout/TabActiveContext';

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
      <Route path="procurement/requisitions" element={<PurchaseRequisitions />} />
      <Route path="procurement/orders" element={<PurchaseOrders />} />
      <Route path="procurement/grn" element={<GrnVerification />} />
      <Route path="procurement/returns" element={<PurchaseReturns />} />
      <Route path="procurement/suppliers" element={<Suppliers />} />

      {/* Inventory */}
      <Route path="inventory/metals" element={<MetalVault />} />
      <Route path="inventory/stones" element={<DiamondAssortment />} />
      <Route path="inventory/consumables" element={<Consumables />} />

      {/* Orders */}
      <Route path="orders" element={<SalesOrders />} />
      <Route path="orders/clients" element={<Clients />} />
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
      <Route path="quality/hallmarking" element={<HallmarkingPage />} />
      <Route path="quality/repairs" element={<RepairJobs />} />

      {/* Masters */}
      <Route path="masters" element={<MastersPage />} />

      {/* Tagging */}
      <Route path="tagging/tags"         element={<TagsPage />} />
      <Route path="tagging/tags/new"     element={<NewTagPage />} />
      <Route path="tagging/tags/:id/edit" element={<NewTagPage />} />
      <Route path="tagging/lookup"       element={<StockLookupPage />} />
      <Route path="tagging/templates"    element={<TagTemplateDesignerPage />} />
      <Route path="tagging/branch-stock" element={<BranchStockSummary />} />
      <Route path="tagging/audits"       element={<StockAudit />} />
      <Route path="tagging/branches"     element={<BranchesPage />} />
      <Route path="tagging/transfers"    element={<BranchTransfersPage />} />
      <Route path="tagging/transfers/new" element={<NewBranchTransferPage />} />
      <Route path="tagging/receives"     element={<BranchReceivesPage />} />
      <Route path="tagging/receives/:id" element={<BranchReceiveDetailPage />} />

      {/* Estimation (standalone) */}
      <Route path="estimation" element={<EstimationPage />} />
      <Route path="estimation/templates" element={<EstimateTemplateDesignerPage />} />

      {/* Sales */}
      <Route path="sales/memos" element={<MemoOutPage />} />
      <Route path="sales/invoices" element={<SalesInvoices />} />
      <Route path="sales/invoices/new" element={<NewSalePage />} />
      <Route path="sales/invoices/:id/edit" element={<NewSalePage />} />
      <Route path="sales/exchanges" element={<OldGoldExchange />} />

      {/* Finance */}
      <Route path="finance/journals" element={<JournalEntries />} />
      <Route path="finance/accounts" element={<ChartOfAccounts />} />
      <Route path="finance/trial-balance" element={<TrialBalance />} />
      <Route path="finance/pnl" element={<PnLStatement />} />
      <Route path="finance/cost-centers" element={<CostCenters />} />
      <Route path="finance/dealer-aging" element={<DealerAging />} />
      <Route path="finance/client-ledger" element={<ClientLedger />} />
      <Route path="finance/client-ledger/:clientId" element={<ClientLedger />} />
      <Route path="finance/supplier-ledger" element={<SupplierLedger />} />
      <Route path="finance/supplier-ledger/:supplierId" element={<SupplierLedger />} />

      {/* Reports */}
      <Route path="reports/wip" element={<WipSummary />} />
      <Route path="reports/stock" element={<StockSummary />} />
      <Route path="reports/karigar" element={<KarigarBalances />} />
      <Route path="reports/aging" element={<AgingReceivables />} />
      <Route path="reports/sales-register" element={<SalesRegister />} />
      <Route path="reports/stock-book" element={<StockBook />} />
      <Route path="reports/stock-on-hand" element={<StockOnHand />} />
      <Route path="reports/dead-stock" element={<DeadStock />} />
      <Route path="reports/day-book" element={<DayBook />} />
      <Route path="reports/gst-summary" element={<GstSummary />} />
      <Route path="reports/purchase-gst-summary" element={<PurchaseGstSummary />} />

      {/* Hardware & Settings */}
      <Route path="hardware" element={<HardwarePage />} />
      <Route path="settings" element={<SettingsPage />} />
      <Route path="*" element={<UnknownPage />} />
    </Routes>
  );
}
