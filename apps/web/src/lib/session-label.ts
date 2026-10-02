import type { OrderSessionKind } from '@idosi/contracts';

/**
 * Several sessions can share one business date, so a session is always named by its code,
 * its business date and its own clock times, never by the date alone.
 */
const dateFormatter = new Intl.DateTimeFormat('vi-VN', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'Asia/Ho_Chi_Minh',
  year: 'numeric',
});
const clockFormatter = new Intl.DateTimeFormat('vi-VN', {
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
  timeZone: 'Asia/Ho_Chi_Minh',
});
const dateTimeFormatter = new Intl.DateTimeFormat('vi-VN', {
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
  month: '2-digit',
  second: '2-digit',
  timeZone: 'Asia/Ho_Chi_Minh',
  year: 'numeric',
});

export const sessionKindCopy: Record<OrderSessionKind, string> = {
  DEFAULT: 'Phiên mặc định',
  MANUAL: 'Phiên bổ sung',
};

/** Business date (yyyy-MM-dd, already a Vietnam calendar date) as dd/MM/yyyy. */
export function formatBusinessDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return year && month && day ? `${day}/${month}/${year}` : isoDate;
}

export function formatClock(instant: string): string {
  return clockFormatter.format(new Date(instant));
}

/** dd/MM/yyyy HH:mm:ss in Asia/Ho_Chi_Minh, for submission and audit instants. */
export function formatDateTime(instant: string): string {
  return dateTimeFormatter.format(new Date(instant));
}

export function formatInstantDate(instant: string): string {
  return dateFormatter.format(new Date(instant));
}

export interface SessionLabelInput {
  readonly id: string;
  readonly code?: string | undefined;
  readonly businessDate: string;
  readonly requestClosesAt: string;
  readonly allocationStartsAt: string;
}

/** "PDH-000123 · 02/10/2026 · chốt 10:00 · phân bổ 11:00" */
export function sessionLabel(session: SessionLabelInput): string {
  return [
    session.code ?? session.id.slice(0, 8),
    formatBusinessDate(session.businessDate),
    `chốt ${formatClock(session.requestClosesAt)}`,
    `phân bổ ${formatClock(session.allocationStartsAt)}`,
  ].join(' · ');
}
