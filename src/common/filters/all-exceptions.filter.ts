import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
}

/**
 * Converts every thrown error into a consistent JSON envelope and maps common
 * Prisma errors to sensible HTTP codes (e.g. unique-constraint → 409). Prevents
 * leaking stack traces / internal messages to clients in production.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const { status, message, error } = this.resolve(exception);

    if (status >= 500) {
      this.logger.error(
        `${req.method} ${req.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ErrorBody = {
      statusCode: status,
      error,
      message,
      path: req.url,
      timestamp: new Date().toISOString(),
    };
    res.status(status).json(body);
  }

  private resolve(exception: unknown): {
    status: number;
    message: string | string[];
    error: string;
  } {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      const status = exception.getStatus();
      if (typeof response === 'string') {
        return { status, message: response, error: exception.name };
      }
      const r = response as { message?: string | string[]; error?: string };
      return {
        status,
        message: r.message ?? exception.message,
        error: r.error ?? exception.name,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return { status: HttpStatus.CONFLICT, message: 'Resource already exists', error: 'Conflict' };
        case 'P2025':
          return { status: HttpStatus.NOT_FOUND, message: 'Resource not found', error: 'NotFound' };
        case 'P2003':
          return {
            status: HttpStatus.BAD_REQUEST,
            message: 'Related resource does not exist',
            error: 'BadRequest',
          };
        default:
          break;
      }
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return { status: HttpStatus.BAD_REQUEST, message: 'Invalid query', error: 'BadRequest' };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: 'InternalServerError',
    };
  }
}
