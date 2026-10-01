import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { inputGuard } from './middleware/inputGuard';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';
import { logger } from './config/logger';
import { errorHandler, notFound } from './middleware/error';
import { rejectClientTenantSelectors } from './middleware/tenant';

// Module routers
import { authRouter } from './modules/auth/auth.router';
import { designRouter } from './modules/product-design/design.router';
import { procurementRouter } from './modules/procurement/procurement.router';
import { inventoryRouter } from './modules/inventory/inventory.router';
import { ordersRouter } from './modules/orders/orders.router';
import { manufacturingRouter } from './modules/manufacturing/manufacturing.router';
import { outsourcingRouter } from './modules/outsourcing/outsourcing.router';
import { qualityRouter } from './modules/quality/quality.router';
import { salesRouter } from './modules/sales/sales.router';
import { financeRouter } from './modules/finance/finance.router';
import { settingsRouter } from './modules/settings/settings.router';
import { hardwareRouter } from './modules/hardware/hardware.router';
import { reportsRouter } from './modules/reports/reports.router';
import { taggingRouter } from './modules/tagging/tagging.router';
import { estimationRouter } from './modules/tagging/estimation.router';
import { mastersRouter } from './modules/masters/masters.router';
import { gstRouter } from './modules/gst/gst.router';
import { companyRouter } from './modules/company/company.router';
import { platformRouter } from './modules/platform/platform.router';

const app = express();

// Security
if (env.TRUST_PROXY !== undefined && env.TRUST_PROXY !== '') {
  // '1' / '2' = hop count; 'true'/'false'; anything else is passed through as an address/subnet list.
  const v = env.TRUST_PROXY;
  app.set('trust proxy', /^d+$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v);
}
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: env.CLIENT_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// Rate limiting
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.API_RATE_LIMIT_MAX,
  message: { success: false, error: 'Too many requests' },
}) as any);
// (Strict credential-endpoint limiting lives on the routes themselves — see auth.router.ts. An
// app-level limiter here used to target '/api/auth', which never matched the real '/api/v1/auth'.)

// Request parsing
app.use(compression() as any);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/api', inputGuard); // ids must be strings, no nested query objects — see middleware/inputGuard.ts

// Logging
app.use(morgan('dev', {
  stream: { write: (msg) => logger.http(msg.trim()) },
  skip: () => env.NODE_ENV === 'test',
}));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// Tenant is determined by authentication only — reject (400), never silently accept, a
// client-supplied companyId/tenantId/organizationId on ANY route, authenticated or not.
app.use(rejectClientTenantSelectors);

// API Routes
const API = '/api/v1';
app.use(`${API}/auth`, authRouter);
app.use(`${API}/designs`, designRouter);
app.use(`${API}/procurement`, procurementRouter);
app.use(`${API}/inventory`, inventoryRouter);
app.use(`${API}/orders`, ordersRouter);
app.use(`${API}/manufacturing`, manufacturingRouter);
app.use(`${API}/outsourcing`, outsourcingRouter);
app.use(`${API}/quality`, qualityRouter);
app.use(`${API}/sales`, salesRouter);
app.use(`${API}/finance`, financeRouter);
app.use(`${API}/settings`, settingsRouter);
app.use(`${API}/company`, companyRouter);
// TRIVO operator API (company provisioning) — separate operator key, no tenant auth; disabled unless configured.
app.use(`${API}/platform`, platformRouter);
app.use(`${API}/hardware`, hardwareRouter);
app.use(`${API}/reports`, reportsRouter);
app.use(`${API}/tagging`, taggingRouter);
app.use(`${API}/estimation`, estimationRouter);
app.use(`${API}/masters`, mastersRouter);
// GST Phase C — GST master/utility services (GSTIN validate/lookup, HSN/SAC search). Deliberately its
// own top-level namespace, not nested under /finance — these are cross-module utilities future
// Customer/Supplier/Product masters and Sales/Purchase will call directly, not a finance report.
app.use(`${API}/gst`, gstRouter);

// 404 & error handlers
app.use(notFound);
app.use(errorHandler);

export { app };
