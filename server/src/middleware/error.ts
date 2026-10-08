import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { logger } from '../config/logger';

export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;
  /** Optional stable machine-readable code (e.g. for the Camera Bridge, which must not parse messages). */
  code?: string;

  constructor(message: string, statusCode = 500, isOperational = true, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

export function notFound(req: Request, _res: Response, next: NextFunction) {
  next(new AppError(`Route ${req.originalUrl} not found`, 404));
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof AppError) {
    logger.warn(`[${req.method}] ${req.path} → ${err.statusCode}: ${err.message}`);
    return res.status(err.statusCode).json({
      success: false,
      error: err.message,
      ...(err.code && { code: err.code }),
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const field = (err.meta?.target as string[])?.join(', ') ?? 'field';
      return res.status(409).json({ success: false, error: `Duplicate value for ${field}` });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({ success: false, error: 'Record not found' });
    }
    logger.error('Prisma error:', err);
    return res.status(500).json({ success: false, error: 'Database error' });
  }

  logger.error('Unhandled error:', err);
  return res.status(500).json({
    success: false,
    error: 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { details: err.message }),
  });
}
