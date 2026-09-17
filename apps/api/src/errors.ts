import type { ApiErrorCode } from '@idosi/contracts';

export class ApiError extends Error {
  public constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly statusCode: number,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function unauthenticated(
  message = 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn',
): ApiError {
  return new ApiError('UNAUTHENTICATED', message, 401);
}

export function forbidden(message = 'Bạn không có quyền thực hiện thao tác này'): ApiError {
  return new ApiError('FORBIDDEN', message, 403);
}

export function notFound(message: string): ApiError {
  return new ApiError('NOT_FOUND', message, 404);
}

export function conflict(message: string): ApiError {
  return new ApiError('CONFLICT', message, 409);
}
