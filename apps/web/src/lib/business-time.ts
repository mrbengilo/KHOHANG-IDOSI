const BUSINESS_TIME_ZONE = 'Asia/Ho_Chi_Minh';

export function businessDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  if (!year || !month || !day) throw new Error('Không thể xác định ngày nghiệp vụ');
  return `${year}-${month}-${day}`;
}

const dateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
export function formatDocumentTime(value: string | null): string {
  if (!value || !Number.isFinite(new Date(value).getTime())) return 'Chưa ghi nhận';
  const parts = new Map(dateTime.formatToParts(new Date(value)).map((p) => [p.type, p.value]));
  return `${parts.get('hour')}:${parts.get('minute')}:${parts.get('second')} ${parts.get('day')}/${parts.get('month')}/${parts.get('year')}`;
}
