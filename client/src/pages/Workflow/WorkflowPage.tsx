import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Grid, Card, CardContent, CardActionArea, Typography, Chip,
  Stepper, Step, StepLabel, StepContent, Button, Alert, Divider,
  List, ListItem, ListItemIcon, ListItemText, Checkbox,
  Tab, Tabs, LinearProgress, Badge, Tooltip,
} from '@mui/material';
import {
  TrendingUp, ShoppingCart, Inventory2, Assignment, Factory,
  Verified, LocalShipping, AccountBalance, Engineering,
  CheckCircle, RadioButtonUnchecked, Warning, ArrowForward,
  Schedule, Scale, Diamond, Receipt, Gavel,
} from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { KpiCard } from '../../components/common/KpiCard';

// ─────────────────────────────────────────────────────────────────────────────
// ORDER-TO-CASH WORKFLOW STEPS
// ─────────────────────────────────────────────────────────────────────────────

interface WorkflowStep {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  icon: React.ReactNode;
  color: string;
  path: string;
  actionLabel: string;
  tips: string[];
  hardwareNote?: string;
}

const ORDER_TO_CASH: WorkflowStep[] = [
  {
    id: 'rates',
    title: 'Step 1 — Update Metal Rates',
    subtitle: 'Every morning before any quoting or invoicing',
    description:
      'Enter today\'s gold/silver/platinum spot rates from MCX or IBJA. Every cost estimate, job card metal valuation, and sales invoice automatically uses the latest rate entered here.',
    icon: <TrendingUp />,
    color: '#44C47A',
    path: '/designs/rates',
    actionLabel: 'Open Metal Rates',
    tips: [
      'Enter rates for every karat you manufacture (22K, 18K, 14K, Silver, Platinum).',
      'Set Source to "MCX" or "IBJA" for traceability.',
      'Rates older than 1 day are flagged in orange on the estimate screen.',
    ],
  },
  {
    id: 'design',
    title: 'Step 2 — Design & BOM',
    subtitle: 'One-time per new style; skip for repeat orders',
    description:
      'Create or select a design, define its Bill of Materials (metal karat + weight range + stone specifications), and attach the 7-process routing with making charges and wastage tolerances.',
    icon: <Diamond />,
    color: '#7B1FA2',
    path: '/designs',
    actionLabel: 'Open Design Library',
    tips: [
      'Open a design → "BOM" tab → add metal and stone line items.',
      'Open "Process Routing" tab → set making charge per process (PER_GRAM or PER_PIECE).',
      'Once BOM is complete, click "Generate Estimate" to produce a client quotation.',
      '"Approve Design" locks the BOM so job cards can be raised against it.',
    ],
  },
  {
    id: 'procurement',
    title: 'Step 3 — Procure Raw Materials',
    subtitle: 'Only when vault stock is insufficient for the order',
    description:
      'Raise a Purchase Order against a supplier. Three types: Outright Purchase, Consignment/Memo-In, or Customer-Supplied Metal. After physical delivery, create a GRN and verify the scale weight against the invoice weight.',
    icon: <ShoppingCart />,
    color: '#0277BD',
    path: '/procurement/orders',
    actionLabel: 'Open Purchase Orders',
    tips: [
      'Create PO → confirm it → supplier delivers → create GRN.',
      'On the GRN form, click the scale icon to auto-fill weight from the connected weighing balance.',
      'If invoice weight ≠ scale weight by more than 0.5%, the GRN status shows "Discrepancy" and must be supervisor-approved before stock is released.',
      'Approved GRN automatically credits the Metal Vault.',
    ],
    hardwareNote: 'Connect your weighing scale via USB on the Hardware page before GRN entry.',
  },
  {
    id: 'order',
    title: 'Step 4 — Book the Sales Order',
    subtitle: 'As soon as the client confirms',
    description:
      'Create a Sales Order under the client record. Enter the design, quantity, delivery date, and any advance payment received (cash, bank transfer, or raw metal exchange). The system instantly hard-allocates the required metal and stones from the vault — preventing double-use.',
    icon: <Assignment />,
    color: '#00695C',
    path: '/orders',
    actionLabel: 'Open Sales Orders',
    tips: [
      'Select client → select approved design → enter quantity and unit price.',
      'Log the advance amount and mode (Cash / Bank / Metal).',
      'After saving, go to the order detail and check "Reservations" tab — the system shows exactly which stock was locked.',
      'Priority: URGENT orders are highlighted on the factory floor dashboard.',
    ],
  },
  {
    id: 'jobcard',
    title: 'Step 5 — Create Job Card',
    subtitle: 'Once materials are available and order is confirmed',
    description:
      'Issue a serialised digital job card for the production batch. Enter the actual metal weight being issued to the floor. The system generates a unique barcode and optionally writes an RFID tag for physical tracking across processes.',
    icon: <Factory />,
    color: '#E65100',
    path: '/manufacturing/jobs',
    actionLabel: 'Open Job Cards',
    tips: [
      'Select the order → design auto-fills → enter issued weight from scale.',
      'Print the barcode label and attach it to the physical item/tray.',
      'The Factory Floor dashboard immediately shows the new job under "MELTING".',
      'For batch orders (e.g. 20 rings), set Batch Size = 20 — one card tracks the whole batch.',
    ],
    hardwareNote: 'Scale reading auto-fills "Issued Weight" when the scale is connected.',
  },
  {
    id: 'manufacturing',
    title: 'Step 6 — Manufacturing & WIP Tracking',
    subtitle: 'Melting → Casting → Filing → Pre-Polish → Setting → Polish → Rhodium',
    description:
      'At each process station, scan the barcode → enter returned weight and scrap → advance to the next process. The system calculates actual metal loss per stage and compares against the configured tolerance. Excess loss automatically flags the artisan\'s ledger for deduction.',
    icon: <Scale />,
    color: '#1565C0',
    path: '/manufacturing',
    actionLabel: 'Open Factory Floor',
    tips: [
      'Open Job Card → click "Record WIP" → scale auto-fills returned weight.',
      'Click "Advance →" to move the piece to the next process.',
      'Loss % shown in red means it exceeds the tolerance — a supervisor alert is sent.',
      'The Factory Floor live dashboard updates in real-time across all workstations.',
    ],
    hardwareNote: 'Each workstation should have a scale connected. The live weight appears in the WIP form.',
  },
  {
    id: 'outsourcing',
    title: 'Step 6b — Outsource to Karigar (if applicable)',
    subtitle: 'For setting, casting, or polishing outsourced to external artisans',
    description:
      'Issue metal to an external karigar from the Karigar Ledger. Their running balance is tracked in a double-entry weight ledger. When they return finished goods, the system calculates their actual loss against the process tolerance and auto-deducts from their labor payout if excess.',
    icon: <Engineering />,
    color: '#558B2F',
    path: '/outsourcing/transactions',
    actionLabel: 'Open Issue / Return',
    tips: [
      'Issue screen → select karigar → enter metal type + karat + weight (scale auto-fills).',
      'Return screen → enter returned finished weight + scrap weight.',
      'System instantly shows loss % and whether it exceeds the allowed threshold.',
      'Generate sub-contractor invoice monthly from the Invoices screen.',
    ],
  },
  {
    id: 'qc',
    title: 'Step 7 — QC & Quality Sign-Off',
    subtitle: 'Mandatory hard-stop before final polish',
    description:
      'The QC supervisor inspects the stone-set piece, verifies the stone count and security, and digitally signs the checkpoint. Until this sign-off is recorded, the job card cannot advance to Final Polish — it is a system-enforced gate.',
    icon: <Verified />,
    color: '#00838F',
    path: '/manufacturing/jobs',
    actionLabel: 'Open Job Cards (QC Pending)',
    tips: [
      'Open a job card with status "QC_PENDING" → click "QC Checkpoint".',
      'Enter stone count verified, result (Pass / Fail / Conditional), and inspection notes.',
      'A digital signature timestamp is recorded under your user account.',
      'Failed items auto-create a Repair Job — the stone setting goes back without touching production records.',
    ],
  },
  {
    id: 'hallmarking',
    title: 'Step 8 — Hallmarking (BIS)',
    subtitle: 'Mandatory for gold jewelry sold in India',
    description:
      'Batch finished pieces and send them to your BIS-registered hallmarking centre. When the centre returns them, scan each piece and enter the unique HUID (Hallmarking Unique ID) directly against the job card. The HUID auto-populates on every downstream sales invoice.',
    icon: <Gavel />,
    color: '#6A1B9A',
    path: '/quality/hallmarking',
    actionLabel: 'Open Hallmarking',
    tips: [
      'Create Batch → add job card IDs → enter sending date and centre name.',
      'When pieces return, click "Receive Batch" → enter HUID for each piece.',
      'The HUID is stored against the job card and auto-appears on the invoice.',
      'Batch status moves from SENT → RECEIVED → COMPLETED.',
    ],
  },
  {
    id: 'invoice',
    title: 'Step 9 — Create Sales Invoice',
    subtitle: 'Final step — billing the client',
    description:
      'Create a tax invoice with today\'s gold rate (auto-fetched from Step 1). The system auto-calculates: metal value (net gold weight × rate) + making charges + stone value + 3% GST. CGST/SGST for same-state; IGST for inter-state. Enter HUID from the hallmarking step.',
    icon: <Receipt />,
    color: '#B71C1C',
    path: '/sales/invoices',
    actionLabel: 'Open Sales Invoices',
    tips: [
      'New Invoice → select client → add items (enter net gold weight, rate type, making charge).',
      'Enter HUID in each line item — mandatory for hallmarked gold.',
      'Choose Rate Type: SPOT_PLUS (today\'s rate + premium), FIXED, or COST_PLUS.',
      'For export orders, choose currency USD/EUR — the system tracks forex gain/loss on payment.',
      'After saving, download the Packing List from the invoice detail screen.',
    ],
  },
  {
    id: 'payment',
    title: 'Step 10 — Record Payment & Close',
    subtitle: 'Cash, bank transfer, or cheque',
    description:
      'Open the invoice and click "Record Payment". The outstanding balance updates in real-time. The client\'s running balance on their account also adjusts. For export payments received in forex, enter the actual receipt rate to auto-calculate forex gain/loss.',
    icon: <AccountBalance />,
    color: '#1B5E20',
    path: '/sales/invoices',
    actionLabel: 'Open Invoices',
    tips: [
      'Invoice detail → "Record Payment" → enter amount, mode, reference number.',
      'Partial payments are allowed — balance due updates after each entry.',
      'Journal entries are auto-generated in the Finance ledger for every payment.',
      'Invoice status: ISSUED → PARTIALLY_PAID → PAID.',
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// DAILY CHECKLIST
// ─────────────────────────────────────────────────────────────────────────────

const DAILY_CHECKLIST = [
  { id: 'rates', label: 'Update today\'s metal rates (MCX / IBJA)', path: '/designs/rates', critical: true },
  { id: 'memo', label: 'Check overdue memo-out alerts', path: '/sales/memos', critical: true },
  { id: 'floor', label: 'Review factory floor WIP status', path: '/manufacturing', critical: false },
  { id: 'qcpend', label: 'Clear QC pending job cards', path: '/manufacturing/jobs', critical: true },
  { id: 'grn', label: 'Verify any open GRNs with scale readings', path: '/procurement/grn', critical: false },
  { id: 'karigar', label: 'Review karigar metal balances', path: '/reports/karigar', critical: false },
  { id: 'stock', label: 'Check low consumable stock alerts', path: '/reports/stock', critical: false },
  { id: 'aging', label: 'Review aging receivables', path: '/reports/aging', critical: false },
];

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export function WorkflowPage() {
  const navigate = useNavigate();
  const [activeStep, setActiveStep] = useState(0);
  const [tab, setTab] = useState(0);
  const [checked, setChecked] = useState<string[]>([]);

  const { data: dashboard } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => apiGet<any>('/reports/dashboard'),
    refetchInterval: 60_000,
  });

  const kpis = (dashboard as any)?.kpis ?? {};

  const toggle = (id: string) =>
    setChecked((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);

  const criticalUnchecked = DAILY_CHECKLIST.filter(
    (item) => item.critical && !checked.includes(item.id)
  ).length;

  return (
    <Box>
      <PageHeader
        title="Operations Workflow"
        subtitle="Step-by-step guide for daily jewelry manufacturing operations"
      />

      {/* ── Alert bar ────────────────────────────────────────────────── */}
      {kpis.overdueMemoes > 0 && (
        <Alert severity="error" sx={{ mb: 2 }}
          action={<Button color="inherit" size="small" onClick={() => navigate('/sales/memos')}>View Memos</Button>}>
          <strong>{kpis.overdueMemoes} memo(s)</strong> are past their return deadline. Follow up immediately.
        </Alert>
      )}
      {kpis.qcPending > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}
          action={<Button color="inherit" size="small" onClick={() => navigate('/manufacturing/jobs')}>Open Jobs</Button>}>
          <strong>{kpis.qcPending} job card(s)</strong> are waiting for QC sign-off.
        </Alert>
      )}

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        {[
          { label: 'Active Orders', value: kpis.activeOrders ?? 0, icon: <Assignment />, color: '#44C47A' },
          { label: 'In Production', value: kpis.inProduction ?? 0, icon: <Factory />, color: '#0277BD' },
          { label: 'QC Pending', value: kpis.qcPending ?? 0, icon: <Verified />, color: '#E65100' },
          { label: 'Ready to Deliver', value: kpis.readyDelivery ?? 0, icon: <LocalShipping />, color: '#1B5E20' },
        ].map((k) => (
          <Grid item xs={6} md={3} key={k.label}>
            <KpiCard title={k.label} value={k.value} icon={k.icon} color={k.color} />
          </Grid>
        ))}
      </Grid>

      {/* ── Tabs ──────────────────────────────────────────────────────── */}
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 3 }}>
        <Tab label="Order-to-Cash Flow" />
        <Tab label={
          <Badge badgeContent={criticalUnchecked} color="error">
            <Box sx={{ pr: criticalUnchecked > 0 ? 1.5 : 0 }}>Daily Checklist</Box>
          </Badge>
        } />
        <Tab label="Quick Actions" />
      </Tabs>

      {/* ════════════════════════════════════════════════════════════════
          TAB 0: ORDER TO CASH STEPPER
      ════════════════════════════════════════════════════════════════ */}
      {tab === 0 && (
        <Grid container spacing={3}>
          {/* Step list */}
          <Grid item xs={12} md={4}>
            <Card sx={{ position: 'sticky', top: 16 }}>
              <CardContent sx={{ p: 0 }}>
                <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
                  <Typography variant="subtitle1" fontWeight={700}>Workflow Steps</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Click a step to see details and guidance
                  </Typography>
                </Box>
                {ORDER_TO_CASH.map((step, idx) => (
                  <Box
                    key={step.id}
                    onClick={() => setActiveStep(idx)}
                    sx={{
                      display: 'flex', alignItems: 'center', gap: 1.5, p: 1.5,
                      cursor: 'pointer', borderBottom: '1px solid #F4F6FB',
                      bgcolor: activeStep === idx ? `${step.color}08` : 'transparent',
                      borderLeft: activeStep === idx ? `3px solid ${step.color}` : '3px solid transparent',
                      transition: 'all 0.15s',
                      '&:hover': { bgcolor: `${step.color}06` },
                    }}
                  >
                    <Box sx={{ width: 32, height: 32, borderRadius: '50%', bgcolor: `${step.color}15`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', color: step.color, flexShrink: 0 }}>
                      {step.icon}
                    </Box>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="body2" fontWeight={activeStep === idx ? 700 : 400}
                        sx={{ color: activeStep === idx ? step.color : 'text.primary' }} noWrap>
                        {step.title.replace(/^Step \d+[a-z]? — /, '')}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap>
                        {step.subtitle}
                      </Typography>
                    </Box>
                  </Box>
                ))}
              </CardContent>
            </Card>
          </Grid>

          {/* Step detail */}
          <Grid item xs={12} md={8}>
            {(() => {
              const step = ORDER_TO_CASH[activeStep];
              return (
                <Card>
                  <CardContent sx={{ p: 3 }}>
                    {/* Header */}
                    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, mb: 3 }}>
                      <Box sx={{ width: 56, height: 56, borderRadius: 3, bgcolor: `${step.color}15`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: step.color, fontSize: 28, flexShrink: 0 }}>
                        {step.icon}
                      </Box>
                      <Box sx={{ flex: 1 }}>
                        <Typography variant="h6" fontWeight={700} color={step.color}>
                          {step.title}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {step.subtitle}
                        </Typography>
                      </Box>
                      <Button
                        variant="contained"
                        endIcon={<ArrowForward />}
                        onClick={() => navigate(step.path)}
                        sx={{ bgcolor: step.color, '&:hover': { bgcolor: step.color }, flexShrink: 0 }}
                      >
                        {step.actionLabel}
                      </Button>
                    </Box>

                    <Typography variant="body1" sx={{ mb: 3, lineHeight: 1.8 }}>
                      {step.description}
                    </Typography>

                    <Divider sx={{ mb: 2 }} />

                    {/* Tips */}
                    <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1.5 }}>
                      How to do it — step by step
                    </Typography>
                    <List dense disablePadding>
                      {step.tips.map((tip, i) => (
                        <ListItem key={i} sx={{ px: 0, py: 0.5, alignItems: 'flex-start' }}>
                          <ListItemIcon sx={{ minWidth: 28, mt: 0.3 }}>
                            <Box sx={{ width: 20, height: 20, borderRadius: '50%',
                              bgcolor: `${step.color}15`, display: 'flex', alignItems: 'center',
                              justifyContent: 'center', fontSize: 11, fontWeight: 700, color: step.color }}>
                              {i + 1}
                            </Box>
                          </ListItemIcon>
                          <ListItemText
                            primary={tip}
                            primaryTypographyProps={{ fontSize: 14, lineHeight: 1.6 }}
                          />
                        </ListItem>
                      ))}
                    </List>

                    {/* Hardware note */}
                    {step.hardwareNote && (
                      <Alert severity="info" icon={<Scale fontSize="small" />} sx={{ mt: 2, borderRadius: 2 }}>
                        <strong>Hardware:</strong> {step.hardwareNote}
                      </Alert>
                    )}

                    {/* Navigation */}
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 3 }}>
                      <Button
                        variant="outlined" disabled={activeStep === 0}
                        onClick={() => setActiveStep((s) => s - 1)}
                      >
                        ← Previous
                      </Button>
                      <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
                        {activeStep + 1} of {ORDER_TO_CASH.length}
                      </Typography>
                      <Button
                        variant="contained"
                        disabled={activeStep === ORDER_TO_CASH.length - 1}
                        onClick={() => setActiveStep((s) => s + 1)}
                        sx={{ bgcolor: step.color }}
                      >
                        Next →
                      </Button>
                    </Box>
                  </CardContent>
                </Card>
              );
            })()}
          </Grid>
        </Grid>
      )}

      {/* ════════════════════════════════════════════════════════════════
          TAB 1: DAILY CHECKLIST
      ════════════════════════════════════════════════════════════════ */}
      {tab === 1 && (
        <Grid container spacing={2}>
          <Grid item xs={12} md={7}>
            <Card>
              <CardContent>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
                  <Typography variant="subtitle1" fontWeight={700}>
                    Daily Operations — {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
                  </Typography>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                      {checked.length} / {DAILY_CHECKLIST.length} done
                    </Typography>
                    <Button size="small" onClick={() => setChecked([])}>Reset</Button>
                  </Box>
                </Box>

                <LinearProgress
                  variant="determinate"
                  value={(checked.length / DAILY_CHECKLIST.length) * 100}
                  sx={{ mb: 2, height: 8, borderRadius: 4 }}
                />

                <List disablePadding>
                  {DAILY_CHECKLIST.map((item, idx) => {
                    const done = checked.includes(item.id);
                    return (
                      <ListItem
                        key={item.id}
                        disablePadding
                        divider={idx < DAILY_CHECKLIST.length - 1}
                        sx={{ py: 0.5 }}
                        secondaryAction={
                          <Button
                            size="small" variant="outlined"
                            onClick={() => navigate(item.path)}
                            sx={{ fontSize: 11 }}
                          >
                            Open
                          </Button>
                        }
                      >
                        <ListItemIcon sx={{ minWidth: 40 }}>
                          <Checkbox
                            edge="start" checked={done}
                            onChange={() => toggle(item.id)}
                            icon={<RadioButtonUnchecked />}
                            checkedIcon={<CheckCircle color="success" />}
                          />
                        </ListItemIcon>
                        <ListItemText
                          primary={
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                              <Typography
                                variant="body2"
                                sx={{ textDecoration: done ? 'line-through' : 'none',
                                  color: done ? 'text.disabled' : 'text.primary', fontWeight: item.critical ? 600 : 400 }}
                              >
                                {item.label}
                              </Typography>
                              {item.critical && !done && (
                                <Chip label="Critical" size="small" color="error"
                                  sx={{ fontSize: 10, height: 18 }} />
                              )}
                            </Box>
                          }
                        />
                      </ListItem>
                    );
                  })}
                </List>

                {checked.length === DAILY_CHECKLIST.length && (
                  <Alert severity="success" sx={{ mt: 2, borderRadius: 2 }}>
                    All daily tasks complete — factory is ready to operate.
                  </Alert>
                )}
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12} md={5}>
            <Card sx={{ mb: 2 }}>
              <CardContent>
                <Typography variant="subtitle1" fontWeight={700} gutterBottom>Morning Sequence</Typography>
                <Stepper orientation="vertical" nonLinear>
                  {[
                    { label: 'Update metal rates', sub: '9:00 AM — before first quote', color: '#44C47A' },
                    { label: 'Clear QC pending', sub: 'Before floor opens', color: '#E65100' },
                    { label: 'Check memo-out alerts', sub: 'Follow up overdue pieces', color: '#B00020' },
                    { label: 'Review WIP dashboard', sub: 'Daily production briefing', color: '#0277BD' },
                    { label: 'Verify GRNs with scale', sub: 'For goods received overnight', color: '#1B5E20' },
                  ].map((s, i) => (
                    <Step key={i} active={false} completed={false}>
                      <StepLabel
                        StepIconProps={{ style: { color: s.color } }}
                        optional={<Typography variant="caption" color="text.secondary">{s.sub}</Typography>}
                      >
                        <Typography variant="body2" fontWeight={600}>{s.label}</Typography>
                      </StepLabel>
                      <StepContent>
                        <Box sx={{ height: 4 }} />
                      </StepContent>
                    </Step>
                  ))}
                </Stepper>
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <Typography variant="subtitle1" fontWeight={700} gutterBottom>End-of-Day Sequence</Typography>
                <List dense disablePadding>
                  {[
                    'Collect all WIP entries from floor supervisors',
                    'Update karigar return entries with scale weights',
                    'Reconcile vault — metal out vs. WIP balances',
                    'Generate subcontractor invoices for the day',
                    'Check outstanding sales invoice payments',
                  ].map((item, i) => (
                    <ListItem key={i} sx={{ px: 0 }}>
                      <ListItemIcon sx={{ minWidth: 28 }}>
                        <Box sx={{ width: 18, height: 18, borderRadius: '50%', bgcolor: '#F5F5E0',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 10, fontWeight: 700, color: '#44C47A' }}>
                          {i + 1}
                        </Box>
                      </ListItemIcon>
                      <ListItemText primary={item} primaryTypographyProps={{ fontSize: 13 }} />
                    </ListItem>
                  ))}
                </List>
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      )}

      {/* ════════════════════════════════════════════════════════════════
          TAB 2: QUICK ACTIONS
      ════════════════════════════════════════════════════════════════ */}
      {tab === 2 && (
        <Grid container spacing={2}>
          {[
            { title: 'Update Metal Rates', sub: 'Log today\'s gold/silver/platinum spot rates', icon: <TrendingUp />, color: '#44C47A', path: '/designs/rates' },
            { title: 'New Sales Order', sub: 'Book a client order with advance payment', icon: <Assignment />, color: '#00695C', path: '/orders' },
            { title: 'Create Job Card', sub: 'Issue metal and start production', icon: <Factory />, color: '#E65100', path: '/manufacturing/jobs' },
            { title: 'Record WIP Entry', sub: 'Log process weight and advance stage', icon: <Scale />, color: '#1565C0', path: '/manufacturing' },
            { title: 'Issue to Karigar', sub: 'Issue metal to artisan with weight record', icon: <Engineering />, color: '#558B2F', path: '/outsourcing/transactions' },
            { title: 'Receive from Karigar', sub: 'Return weight + scrap + loss calculation', icon: <Engineering />, color: '#6A1B9A', path: '/outsourcing/transactions' },
            { title: 'GRN Verification', sub: 'Verify delivery with weighing scale', icon: <Inventory2 />, color: '#0277BD', path: '/procurement/grn' },
            { title: 'QC Sign-Off', sub: 'Approve stone-set pieces before polish', icon: <Verified />, color: '#00838F', path: '/manufacturing/jobs' },
            { title: 'Send for Hallmarking', sub: 'Create batch for BIS hallmarking centre', icon: <Gavel />, color: '#7B1FA2', path: '/quality/hallmarking' },
            { title: 'Create Tax Invoice', sub: 'Bill client with GST + HUID', icon: <Receipt />, color: '#B71C1C', path: '/sales/invoices' },
            { title: 'Record Payment', sub: 'Mark invoice paid / partial payment', icon: <AccountBalance />, color: '#1B5E20', path: '/sales/invoices' },
            { title: 'Check Memo Aging', sub: 'Review overdue consignment stock', icon: <Warning />, color: '#F57F17', path: '/sales/memos' },
          ].map((action) => (
            <Grid item xs={12} sm={6} md={4} key={action.title}>
              <Card sx={{ height: '100%', '&:hover': { boxShadow: 4 }, transition: 'box-shadow 0.2s' }}>
                <CardActionArea onClick={() => navigate(action.path)} sx={{ height: '100%' }}>
                  <CardContent sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
                    <Box sx={{ width: 44, height: 44, borderRadius: 2.5, bgcolor: `${action.color}15`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: action.color, flexShrink: 0 }}>
                      {action.icon}
                    </Box>
                    <Box>
                      <Typography variant="subtitle2" fontWeight={700}>{action.title}</Typography>
                      <Typography variant="caption" color="text.secondary">{action.sub}</Typography>
                    </Box>
                  </CardContent>
                </CardActionArea>
              </Card>
            </Grid>
          ))}
        </Grid>
      )}
    </Box>
  );
}
