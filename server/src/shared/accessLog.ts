import type { Request, RequestHandler } from 'express';
import morgan from 'morgan';
import { redactUrlForLog } from './logRedaction';

/** The HTTP access-log middleware. The URL is logged through `redactUrlForLog`, so a customer's name / mobile number in
 *  a search query string never reaches the log. `app.ts` mounts exactly this; the tests drive the same function. */
export function accessLogMiddleware(write: (line: string) => void, skip?: () => boolean): RequestHandler {
  morgan.token('url', (req) => redactUrlForLog((req as Request).originalUrl ?? req.url ?? ''));
  return morgan('dev', { stream: { write }, skip: skip ? () => skip() : undefined });
}
