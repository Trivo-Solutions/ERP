import { BridgeConfig } from './config';
import { CaptureTransport } from './capture/captureTransport';
import { ErpTransport } from './erpTransport';
import { BRIDGE_VERSION } from './version';

// "Is this station provisioned correctly?" — answered with the real credential against the real ERP, reported only as
// normalized categories. Nothing here prints the credential, a response body, or a URL with anything but the host.
export type StationCheck =
  | 'OK'
  | 'ERP_UNREACHABLE'
  | 'CREDENTIAL_REJECTED'      // revoked / expired / unknown / wrong company
  | 'CAPTURE_SCOPE_MISSING'    // heartbeat accepted, command channel refused: a pre-Phase-5D credential — re-issue it
  | 'STATION_ID_MISMATCH'      // the ERP refused the request as invalid: STATION_ID is not this credential's station
  | 'UNEXPECTED';

export const CHECK_MESSAGES: Record<StationCheck, string> = {
  OK: 'The ERP accepted the station credential, including remote capture.',
  ERP_UNREACHABLE: 'The ERP could not be reached (network, TLS or server error). Nothing was verified; the bridge will keep retrying.',
  CREDENTIAL_REJECTED: 'The ERP rejected the station credential (revoked, expired, or for another station/company). Ask an authorized ERP user to issue a new one.',
  CAPTURE_SCOPE_MISSING: 'The credential works for heartbeat but lacks the station:capture scope (issued before remote capture existed). Ask an authorized ERP user to issue a new credential and provision again.',
  STATION_ID_MISMATCH: 'The ERP refused the request as invalid — STATION_ID most likely does not match the station this credential was issued for.',
  UNEXPECTED: 'The ERP answered in an unexpected way.',
};

export async function checkStation(config: BridgeConfig, secret: string, erp: ErpTransport, capture: CaptureTransport): Promise<StationCheck> {
  const hb = await erp.sendHeartbeat(
    { stationId: config.stationId, bridgeVersion: BRIDGE_VERSION, cameraState: 'DISCONNECTED', timestamp: new Date().toISOString() }, secret,
  );
  if (!hb.ok) {
    switch (hb.kind) {
      case 'AUTH': return 'CREDENTIAL_REJECTED';
      case 'REJECTED': return 'STATION_ID_MISMATCH';
      case 'NETWORK': case 'SERVER': return 'ERP_UNREACHABLE';
      default: return 'UNEXPECTED';
    }
  }
  // A zero-wait poll: it authenticates the capture scope and does not claim or change any command.
  const poll = await capture.pollCommand(secret, 0);
  if (poll.ok) return 'OK';
  if (poll.kind === 'AUTH') return 'CAPTURE_SCOPE_MISSING';
  return poll.kind === 'NETWORK' || poll.kind === 'SERVER' ? 'ERP_UNREACHABLE' : 'UNEXPECTED';
}
