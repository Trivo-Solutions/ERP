import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { JwtPayload } from '../middleware/auth';
import { tenantQuery } from './tenantContext';

// ═══════════════════════════════════════════════════════════════════════════
// Realtime isolation rules
//
//  1. EVERY room is namespaced by companyId:
//        company:<cid>                      everyone in the company
//        company:<cid>:user:<uid>           one member
//        company:<cid>:role:<roleName>      one role inside the company
//        company:<cid>:branch:<bid>         one branch (joined only for branches the member may access)
//        company:<cid>:jobcard:<id>         one job card
//        company:<cid>:factory:floor        factory-floor feed
//     There are NO bare rooms (`role:X`, `user:X`, `factory:floor`, `jobcard:X`): role names like
//     SUPER_ADMIN are identical in every company, so a bare role room would be shared by all of them.
//
//  2. The company a socket belongs to comes ONLY from its verified token (and is re-checked against the
//     database at connect). No client event can name a company or join a room outside its own prefix.
//
//  3. emit.* REQUIRES a companyId (compile-time and runtime). There is no "broadcast to everyone" path.
// ═══════════════════════════════════════════════════════════════════════════

let io: SocketServer | undefined;

export const room = {
  company: (cid: string) => `company:${cid}`,
  user: (cid: string, uid: string) => `company:${cid}:user:${uid}`,
  role: (cid: string, role: string) => `company:${cid}:role:${role}`,
  branch: (cid: string, bid: string) => `company:${cid}:branch:${bid}`,
  jobcard: (cid: string, id: string) => `company:${cid}:jobcard:${id}`,
  factory: (cid: string) => `company:${cid}:factory:floor`,
};

export function initWebSocket(httpServer: HttpServer) {
  io = new SocketServer(httpServer, {
    cors: { origin: env.CLIENT_URL, credentials: true },
    transports: ['websocket', 'polling'],
  });

  io.use(async (socket: Socket, next) => {
    const token = socket.handshake.auth.token as string;
    if (!token) return next(new Error('Authentication required'));
    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    } catch {
      return next(new Error('Invalid token'));
    }
    if (!payload.companyId || !payload.companyUserId) return next(new Error('Token missing tenant context — please log in again'));

    // Same live re-validation HTTP requests get: an active membership of an active company, for this user.
    try {
      const membership = await tenantQuery(payload.companyId, (tx) =>
        tx.companyUser.findFirst({
          where: { id: payload.companyUserId, companyId: payload.companyId },
          include: { user: { select: { isActive: true } }, company: { select: { isActive: true } } },
        })
      );
      if (!membership || membership.userId !== payload.userId || !membership.isActive || !membership.user.isActive || !membership.company.isActive) {
        return next(new Error('Invalid token'));
      }
    } catch {
      return next(new Error('Invalid token'));
    }
    (socket as any).user = payload;
    next();
  });

  io.on('connection', (socket: Socket) => {
    const user = (socket as any).user as JwtPayload;
    const cid = user.companyId;
    logger.debug(`WS connected: ${user.email} [company:${cid}] [${socket.id}]`);

    socket.join(room.company(cid));
    socket.join(room.user(cid, user.userId));
    socket.join(room.role(cid, user.roleName));
    // Branch rooms: only the branches this member is authorised for (allBranches members carry all of them).
    for (const bid of user.branchAccess?.branchIds ?? []) socket.join(room.branch(cid, bid));

    socket.on('subscribe:jobcard', (jobCardId: unknown) => {
      // The room is company-prefixed, so it can only ever carry THIS company's events; the id is only
      // accepted if it is a plain identifier (no room-name tricks).
      if (typeof jobCardId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(jobCardId)) return;
      socket.join(room.jobcard(cid, jobCardId));
    });

    socket.on('subscribe:factory', () => {
      socket.join(room.factory(cid));
    });

    socket.on('disconnect', () => {
      logger.debug(`WS disconnected: ${user.email}`);
    });
  });

  logger.info('✅ WebSocket server initialized');
}

// Returns null instead of throwing when Socket.io hasn't been initialized (unit tests, scripts, or any
// code path invoked outside the live HTTP server's lifecycle): a missing transport is a no-op, not a crash.
export function getIO(): SocketServer | null {
  return io ?? null;
}

/** Drop every live socket of a company (e.g. when it is suspended). */
export function disconnectCompany(companyId: string) {
  io?.in(room.company(companyId)).disconnectSockets(true);
}

function need(companyId: string): string {
  if (!companyId || typeof companyId !== 'string') throw new Error('emit.* requires a companyId — there is no global broadcast');
  return companyId;
}

export const emit = {
  jobCardUpdate(jobCardId: string, data: unknown, companyId: string) {
    const cid = need(companyId);
    const s = getIO();
    if (!s) return;
    s.to(room.jobcard(cid, jobCardId)).emit('jobcard:update', data);
    s.to(room.factory(cid)).emit('factory:update', { type: 'jobcard', id: jobCardId, data });
  },
  /** A scale reading goes to the device's branch if it has one (so branch-restricted users only hear their own), else the company. */
  scaleReading(deviceId: string, weight: number, companyId: string, branchId?: string | null) {
    const cid = need(companyId);
    const s = getIO();
    if (!s) return;
    s.to(branchId ? room.branch(cid, branchId) : room.company(cid)).emit(`scale:${deviceId}`, { weight, timestamp: Date.now() });
  },
  rfidScan(tagId: string, location: string, companyId: string) {
    const cid = need(companyId);
    getIO()?.to(room.factory(cid)).emit('rfid:scan', { tagId, location, timestamp: Date.now() });
  },
  stockAlert(stockCode: string, message: string, companyId: string) {
    const cid = need(companyId);
    getIO()?.to(room.role(cid, 'SUPER_ADMIN')).to(room.role(cid, 'STORE_MANAGER')).emit('stock:alert', { stockCode, message });
  },
  memoAlert(memoId: string, daysLeft: number, companyId: string) {
    const cid = need(companyId);
    getIO()?.to(room.role(cid, 'SALES_MANAGER')).to(room.role(cid, 'SUPER_ADMIN')).emit('memo:alert', { memoId, daysLeft });
  },
  notification(userId: string, payload: unknown, companyId: string) {
    const cid = need(companyId);
    getIO()?.to(room.user(cid, userId)).emit('notification', payload);
  },
};
