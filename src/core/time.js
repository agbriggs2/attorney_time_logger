// Time helpers shared by the main process (Node) and the renderer (browser).
// All timestamps are epoch milliseconds; "day keys" are local-time YYYY-MM-DD.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TimeCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;

  const pad = (n) => String(n).padStart(2, '0');

  // Billing rounds up to the next increment (0.1 hr = 6 minutes by default).
  function billableHours(ms, increment = 0.1) {
    if (!(ms > 0)) return 0;
    const units = Math.ceil(ms / (increment * HOUR) - 1e-9);
    return Number((units * increment).toFixed(4));
  }

  function hoursDecimals(increment) {
    const s = String(increment);
    const i = s.indexOf('.');
    return Math.max(1, i < 0 ? 0 : s.length - i - 1);
  }

  function formatHours(hours, increment = 0.1) {
    return hours.toFixed(hoursDecimals(increment));
  }

  function dateKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function parseKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return [y, m - 1, d];
  }

  function dayStart(key) {
    const [y, m, d] = parseKey(key);
    return new Date(y, m, d).getTime();
  }

  function dayEnd(key) {
    const [y, m, d] = parseKey(key);
    return new Date(y, m, d + 1).getTime();
  }

  function addDays(key, n) {
    const [y, m, d] = parseKey(key);
    return dateKey(new Date(y, m, d + n).getTime());
  }

  // "HH:MM" (24h) on the given local day -> epoch ms.
  function parseClockOnDay(key, hhmm) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    if (!match) return NaN;
    const [y, m, d] = parseKey(key);
    return new Date(y, m, d, Number(match[1]), Number(match[2])).getTime();
  }

  // Value for <input type="time">.
  function timeInputValue(ms) {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function minutesOfDay(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + m;
  }

  function formatClock(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function formatDuration(ms, withSeconds = false) {
    const total = Math.floor(Math.max(0, ms) / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return withSeconds ? `${h}:${pad(m)}:${pad(total % 60)}` : `${h}:${pad(m)}`;
  }

  function formatMinutes(ms) {
    const m = Math.round(ms / MINUTE);
    if (m < 60) return `${m} min`;
    return m % 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m / 60} hr`;
  }

  return {
    MINUTE, HOUR, billableHours, formatHours, dateKey, dayStart, dayEnd, addDays,
    parseClockOnDay, timeInputValue, minutesOfDay, formatClock, formatDuration, formatMinutes,
  };
});
