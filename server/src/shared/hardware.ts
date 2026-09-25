import { SerialPort } from 'serialport';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { AppError } from '../middleware/error';
import { tenantQuery, runAsPlatform } from './tenantContext';
import { emit } from './websocket';

interface ScaleReading {
  deviceId: string;
  weight: number;
  unit: string;
  timestamp: Date;
  isStable: boolean;
}

interface DeviceRef {
  companyId: string;
  deviceId: string;
  port: string;
  baudRate: number;
  branchId: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Hardware isolation rules
//
//  - A device exists ONLY as a company-owned HardwareDevice row. There is no environment-variable
//    "default scale" (the old SCALE_PORT fallback had no owner, so its readings had to be broadcast
//    to everyone). A misconfigured or missing device fails closed.
//  - Everything this service holds — open ports, last readings, ping updates — is keyed by
//    (companyId, deviceId), never deviceId alone: two companies may both name a scale "SCALE-1" and
//    must never see each other's weights.
//  - Anything a caller can ask for takes the caller's companyId; there is no "list every scale" call.
//  - Simulation (no physical hardware) is a development aid and is refused in production.
// ═══════════════════════════════════════════════════════════════════════════

const k = (companyId: string, deviceId: string) => `${companyId}::${deviceId}`;

class HardwareService {
  private scalePorts = new Map<string, SerialPort>();
  private lastReadings = new Map<string, ScaleReading>();
  private meta = new Map<string, { companyId: string; deviceId: string; branchId: string | null }>();

  /**
   * Startup: connect every active, company-owned SCALE device that has a server-side serial port.
   * This is a deliberate PLATFORM-level read across companies (there is no request, hence no tenant),
   * and each device is thereafter tracked strictly under its own company.
   */
  async initialize() {
    try {
      const devices = await runAsPlatform((db) => db.hardwareDevice.findMany({
        where: { isActive: true, deviceType: 'SCALE', port: { not: null } },
        select: { companyId: true, deviceId: true, port: true, baudRate: true, branchId: true },
      }));
      for (const d of devices) {
        await this.connectDevice({ companyId: d.companyId, deviceId: d.deviceId, port: d.port!, baudRate: d.baudRate ?? 9600, branchId: d.branchId });
      }
      logger.info(`✅ Hardware service initialized (${this.scalePorts.size} scale(s) connected)`);
    } catch (err) {
      logger.warn('Hardware service init warning (continuing without hardware):', err);
    }
  }

  /** Open a company-owned scale's serial port (also called when a device is created at runtime). */
  async connectDevice(ref: DeviceRef) {
    const key = k(ref.companyId, ref.deviceId);
    if (this.scalePorts.has(key)) return;
    this.meta.set(key, { companyId: ref.companyId, deviceId: ref.deviceId, branchId: ref.branchId });
    try {
      const serial = new SerialPort({ path: ref.port, baudRate: ref.baudRate, autoOpen: false });

      serial.open((err) => {
        if (err) {
          // Deliberately not surfaced to any caller: a port already in use may belong to another company.
          logger.warn(`Scale ${key} on ${ref.port} not available: ${err.message}`);
          return;
        }
        logger.info(`Scale ${key} connected on ${ref.port} @ ${ref.baudRate} baud`);
      });

      let buffer = '';
      serial.on('data', (data: Buffer) => {
        buffer += data.toString('ascii');
        const lines = buffer.split('\r\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) this.parseScaleData(ref.companyId, ref.deviceId, line.trim());
      });

      serial.on('error', (err) => logger.error(`Scale ${key} error:`, err));
      serial.on('close', () => {
        logger.warn(`Scale ${key} disconnected`);
        this.scalePorts.delete(key);
        setTimeout(() => this.connectDevice(ref), 5000);
      });

      this.scalePorts.set(key, serial);
    } catch (err) {
      logger.warn(`Could not open scale ${key}:`, err);
    }
  }

  private parseScaleData(companyId: string, deviceId: string, raw: string) {
    // Standard AND/Mettler Toledo format: "ST,GS,+  123.456 g"
    const match = raw.match(/([A-Z]{2}),([A-Z]{2}),([+-])\s*([\d.]+)\s*([a-z]+)/i);
    if (!match) return;

    const [, , stability, sign, value, unit] = match;
    const weight = parseFloat(`${sign}${value}`);
    const isStable = stability === 'ST';
    this.record(companyId, deviceId, { deviceId, weight, unit, timestamp: new Date(), isStable });

    if (isStable) {
      emit.scaleReading(deviceId, weight, companyId, this.meta.get(k(companyId, deviceId))?.branchId);
      void this.updateDevicePing(companyId, deviceId);
    }
  }

  private record(companyId: string, deviceId: string, reading: ScaleReading) {
    this.lastReadings.set(k(companyId, deviceId), reading);
  }

  getLastReading(companyId: string, deviceId: string): ScaleReading | null {
    return this.lastReadings.get(k(companyId, deviceId)) ?? null;
  }

  /** The caller's OWN company's connected scales — never another company's. */
  getConnectedScales(companyId: string): string[] {
    const out: string[] = [];
    for (const key of this.scalePorts.keys()) {
      const m = this.meta.get(key);
      if (m?.companyId === companyId) out.push(m.deviceId);
    }
    return out;
  }

  closeAll() {
    for (const [key, port] of this.scalePorts) {
      port.close();
      logger.info(`Scale ${key} closed`);
    }
    this.scalePorts.clear();
  }

  private async updateDevicePing(companyId: string, deviceId: string) {
    try {
      await tenantQuery(companyId, (tx) =>
        tx.hardwareDevice.updateMany({ where: { companyId, deviceId }, data: { lastPing: new Date() } })
      );
    } catch {}
  }

  /** Development aid: fake a stable reading for a company's own device. Refused in production. */
  async simulateScale(companyId: string, deviceId: string, weight: number, branchId?: string | null) {
    if (env.NODE_ENV === 'production') throw new AppError('Not found', 404);
    this.record(companyId, deviceId, { deviceId, weight, unit: 'g', timestamp: new Date(), isStable: true });
    emit.scaleReading(deviceId, weight, companyId, branchId);
  }
}

export const hardwareService = new HardwareService();
