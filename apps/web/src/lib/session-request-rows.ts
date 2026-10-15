/** Vietnam wall-clock formatting for when a request or document was sent. */
const submittedDateFormatter = new Intl.DateTimeFormat('vi-VN', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'Asia/Ho_Chi_Minh',
});
const submittedTimeFormatter = new Intl.DateTimeFormat('vi-VN', {
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
  timeZone: 'Asia/Ho_Chi_Minh',
});

/** Vietnam wall-clock date and time a request was sent, independent of the browser zone. */
export function formatRequestSubmittedAt(value: string): { date: string; time: string } {
  const instant = new Date(value);
  return {
    date: submittedDateFormatter.format(instant),
    time: submittedTimeFormatter.format(instant),
  };
}
