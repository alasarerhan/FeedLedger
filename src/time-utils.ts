export interface ZonedNow {
  date: string;
  time: string;
  hour: string;
  minute: string;
}

function getPart(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find(p => p.type === type)?.value || '';
}

export function getZonedNow(timeZone: string, now = new Date()): ZonedNow {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(now);
  const year = getPart(parts, 'year');
  const month = getPart(parts, 'month');
  const day = getPart(parts, 'day');
  const hour = getPart(parts, 'hour');
  const minute = getPart(parts, 'minute');

  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
    hour,
    minute,
  };
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isTimeReached(current: string, target: string): boolean {
  return current >= target;
}

export function isDateInRange(date: string, start: string, end: string): boolean {
  return date >= start && date <= end;
}
