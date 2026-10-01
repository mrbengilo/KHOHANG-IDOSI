import { ErrorEnvelopeSchema } from '@idosi/contracts';
import { reportUnauthorizedResponse } from './session-expiry';
import { addTabSessionHeader } from './tab-session';

type ClientError = new (
  message: string,
  status: number,
  code?: string,
  requestId?: string,
) => Error;
const baseUrl = (import.meta.env.VITE_API_BASE_URL?.trim() || '/api/v1').replace(/\/$/, '');
// Pinned for this document lifetime: refetch must never authorize a pre-reset form/retry.
let resetEpoch: string | undefined;

/** Bound both headers and body consumption; aborting a write never proves a rollback. */
export async function requestJson(
  path: string,
  init: RequestInit | undefined,
  ErrorType: ClientError,
  timeoutMs?: number,
): Promise<unknown> {
  const writing = !['GET', 'HEAD'].includes((init?.method ?? 'GET').toUpperCase());
  const headers = new Headers(init?.headers);
  if (resetEpoch !== undefined) headers.set('x-idosi-reset-epoch', resetEpoch);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  if (init?.body !== undefined && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');
  addTabSessionHeader(headers);
  const controller = new AbortController();
  const callerSignal = init?.signal;
  const cancel = () => controller.abort(callerSignal?.reason);
  callerSignal?.throwIfAborted();
  callerSignal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort(new DOMException('Request deadline exceeded', 'TimeoutError'));
    },
    timeoutMs ?? (writing ? 120_000 : 60_000),
  );
  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        credentials: 'include',
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new ErrorType(
        writing
          ? 'Mất kết nối. Chưa xác định thao tác đã hoàn tất hay chưa. Kiểm tra lại trạng thái trước khi gửi lại; giữ nguyên nội dung khi thử lại.'
          : 'Không thể kết nối máy chủ. Vui lòng kiểm tra mạng và thử lại.',
        0,
        'NETWORK_ERROR',
      );
    }
    const responseEpoch = response.headers.get('x-idosi-reset-epoch');
    if (responseEpoch && resetEpoch === undefined && (!writing || responseEpoch === '0'))
      resetEpoch = responseEpoch;
    if (responseEpoch && resetEpoch !== responseEpoch) {
      // A full navigation drops query caches, mutation closures and in-memory drafts together.
      // Never retry the interrupted write with the new epoch.
      window.location.reload();
      throw new ErrorType(
        'Hệ thống đã được thiết lập lại. Đang tải dữ liệu mới.',
        409,
        'RESET_REQUIRED',
      );
    }
    reportUnauthorizedResponse(response.status, path);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      if (response.ok)
        throw new ErrorType(
          writing
            ? 'Phản hồi không hợp lệ. Chưa xác định kết quả thao tác; hãy kiểm tra lại trạng thái trước khi gửi lại.'
            : 'Máy chủ trả về dữ liệu không hợp lệ. Vui lòng tải lại dữ liệu.',
          response.status,
          'INVALID_RESPONSE',
        );
      payload = null;
    }
    if (!response.ok) {
      const parsed = ErrorEnvelopeSchema.safeParse(payload);
      if (parsed.success)
        throw new ErrorType(
          parsed.data.error.message,
          response.status,
          parsed.data.error.code,
          parsed.data.error.requestId,
        );
      throw new ErrorType(`Yêu cầu thất bại (${response.status}).`, response.status);
    }
    return payload;
  } catch (error) {
    if (timedOut)
      throw new ErrorType(
        writing
          ? 'Quá thời gian chờ. Chưa xác định thao tác đã hoàn tất hay chưa. Kiểm tra lại trạng thái trước khi gửi lại; giữ nguyên nội dung khi thử lại.'
          : 'Quá thời gian chờ máy chủ. Vui lòng thử tải lại dữ liệu.',
        0,
        'REQUEST_TIMEOUT',
      );
    if (callerSignal?.aborted) throw callerSignal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', cancel);
  }
}
