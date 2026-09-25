// dotenv is pre-loaded via ts-node --require dotenv/config (see nodemon.json / package.json)
// Do NOT import/call dotenv here — static imports are hoisted before any call inside this file.

import { createServer } from 'http';
import { app } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { connectDatabase, disconnectDatabase, assertDatabaseRoleSafety } from './config/database';
import { connectRedis, redis } from './config/redis';
import { initWebSocket } from './shared/websocket';
import { hardwareService } from './shared/hardware';

async function bootstrap() {
  try {
    await connectDatabase();
    await assertDatabaseRoleSafety(); // production refuses to boot without real RLS enforcement
    await connectRedis();

    const httpServer = createServer(app);
    initWebSocket(httpServer);

    await hardwareService.initialize();

    httpServer.listen(env.PORT, () => {
      logger.info(`🚀 TRIVO ERP Server running on port ${env.PORT}`);
      logger.info(`📦 Environment: ${env.NODE_ENV}`);
      logger.info(`🌐 Client URL: ${env.CLIENT_URL}`);
    });

    const shutdown = async (signal: string) => {
      logger.info(`${signal} received — shutting down gracefully`);
      httpServer.close(async () => {
        await disconnectDatabase();
        await redis?.quit().catch(() => {});
        hardwareService.closeAll();
        logger.info('Server shut down cleanly');
        process.exit(0);
      });
      setTimeout(() => { logger.error('Forced shutdown'); process.exit(1); }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection:', reason);
    });
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
}

bootstrap();
