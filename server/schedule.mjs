// What a workflow's Schedule Trigger says it SHOULD do — turned into either an
// exact "most recent expected fire time" or a plain cadence, so the watchdog
// can judge staleness against the schedule instead of a flat wall-clock budget.
//
// Why this exists: a flat `staleAfterMin` has no idea when a workflow is meant
// to run. A Mon–Fri 09:00 job with a 6-hour budget alerts every Saturday
// morning, and the only workaround (a 72-hour budget) delays a genuinely
// missed Tuesday run by three days. Issue #15.
//
// SECURITY/PURITY: no network, no filesystem, no clock of its own — `now` is
// injected. Everything it reads is already in the workflow objects the sync
// stores (`nodes[]`, `settings`), so deriving a schedule costs no extra n8n
// call.
//
// Zero npm dependencies is a hard constraint for server/, so the cron parser
// and the timezone arithmetic below are hand-written. `Intl.DateTimeFormat` is
// what makes the timezone part honest without a library: it is the only
// DST-aware primitive in the standard library.

const SEC = 1_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const SCHEDULE_TRIGGER = 'n8n-nodes-base.scheduleTrigger';

// ---- timezone arithmetic ----------------------------------------------------
// `Intl.DateTimeFormat` is the only DST-aware primitive in the standard
// library, and formatters are expensive to build, so they are cached per zone.

const FORMATTERS = new Map();

function formatter(tz) {
  let f = FORMATTERS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    FORMATTERS.set(tz, f);
  }
  return f;
}

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock components of an instant in `tz`. */
function wallParts(tz, ms) {
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(ms)) {
    if (type === 'weekday') p.dow = DOW[value] ?? 0;
    else if (type !== 'literal') p[type] = Number(value);
  }
  // Intl renders midnight as hour 24 in the h23-with-hour12:false combination
  // on some ICU builds; normalise so the value is always 0..23.
  if (p.hour === 24) p.hour = 0;
  return p;
}

/** Offset of `tz` at instant `ms`, in ms east of UTC. */
function zoneOffset(tz, ms) {
  const p = wallParts(tz, ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
}

/**
 * The instant at which a wall clock in `tz` reads the given components.
 *
 * Two passes, because the offset has to be measured somewhere and the only
 * place available is a guess: the first pass measures at the wall time read as
 * UTC, the second re-measures at the corrected instant. That second pass is
 * what makes a DST boundary come out right — the offset on one side of the
 * switch is not the offset on the other.
 */
function toInstant(tz, y, mo, d, h, mi, s) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = wall - zoneOffset(tz, wall);
  const second = wall - zoneOffset(tz, first);
  return second;
}

/** Whether `tz` is a timezone this runtime understands. */
function usableZone(tz) {
  if (!tz) return false;
  try { formatter(tz); return true; } catch { return false; }
}

// ---- matching wall clocks ---------------------------------------------------
// A "wall spec" is six sorted arrays of allowed values. Sorted arrays rather
// than 0..59 scans: `0 9 * * 1-5` then costs one candidate per day instead of
// 86400, which matters because this runs for every workflow on every poll.

const range = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; };

const ALL = {
  second: range(0, 59), minute: range(0, 59), hour: range(0, 23),
  day: range(1, 31), month: range(1, 12), dow: range(0, 6),
};

/** Does this civil date satisfy the day-level matchers? */
function dayMatches(spec, y, mo, d, dow) {
  if (!spec.month.includes(mo)) return false;
  const anyDay = spec.day.length === ALL.day.length;
  const anyDow = spec.dow.length === ALL.dow.length;
  // Vixie-cron's rule: with BOTH day-of-month and day-of-week restricted the
  // two are OR-ed, not AND-ed. Anything else would make `0 0 1 * 1` (the 1st,
  // and every Monday) fire almost never instead of often.
  if (anyDay && anyDow) return true;
  if (anyDay) return spec.dow.includes(dow);
  if (anyDow) return spec.day.includes(d);
  return spec.day.includes(d) || spec.dow.includes(dow);
}

const MAX_LOOKBACK_DAYS = 400;

/**
 * The most recent instant not later than `now` at which `spec` fires.
 *
 * Walks civil days backwards, which is exact regardless of timezone, and only
 * builds instants for the handful of times of day the spec actually allows. On
 * the first day the search starts at `now`'s own wall clock, so an
 * every-second spec costs one candidate rather than a full day of them.
 *
 * @returns {number|null} ms, or null when nothing matched inside the window
 */
function previousFire(spec, tz, now) {
  const at = wallParts(tz, now);
  for (let back = 0; back <= MAX_LOOKBACK_DAYS; back++) {
    const civil = new Date(Date.UTC(at.year, at.month - 1, at.day - back));
    const y = civil.getUTCFullYear();
    const mo = civil.getUTCMonth() + 1;
    const d = civil.getUTCDate();
    if (!dayMatches(spec, y, mo, d, civil.getUTCDay())) continue;
    const today = back === 0;
    for (let hi = spec.hour.length - 1; hi >= 0; hi--) {
      const h = spec.hour[hi];
      if (today && h > at.hour) continue;
      for (let mIdx = spec.minute.length - 1; mIdx >= 0; mIdx--) {
        const mi = spec.minute[mIdx];
        if (today && h === at.hour && mi > at.minute) continue;
        for (let si = spec.second.length - 1; si >= 0; si--) {
          const s = spec.second[si];
          if (today && h === at.hour && mi === at.minute && s > at.second) continue;
          const t = toInstant(tz, y, mo, d, h, mi, s);
          if (t <= now) return t;
        }
      }
    }
  }
  return null;
}

/**
 * How often `spec` fires on average, in ms.
 *
 * Averaged over a year of civil days rather than measured as the gap to the
 * previous fire: the gap for `0 9 * * 1-5` is one day on a Tuesday and three
 * on a Monday, and a grace period that changed size with the weekday would be
 * a bug report waiting to happen.
 */
function nominalCadence(spec, tz, now) {
  const at = wallParts(tz, now);
  let days = 0;
  for (let back = 0; back < 366; back++) {
    const civil = new Date(Date.UTC(at.year, at.month - 1, at.day - back));
    if (dayMatches(spec, civil.getUTCFullYear(), civil.getUTCMonth() + 1, civil.getUTCDate(), civil.getUTCDay())) days += 1;
  }
  const perDay = spec.hour.length * spec.minute.length * spec.second.length;
  const fires = days * perDay;
  return fires > 0 ? (366 * DAY) / fires : 0;
}


// ---- cron -------------------------------------------------------------------
// Five fields (minute hour day-of-month month day-of-week) and n8n's six-field
// form with a leading seconds field. `*`, `*/n`, `a-b`, `a-b/n`, lists, and the
// three-letter month and weekday names operators actually type. Anything else
// is reported as unparseable rather than approximated: a guessed schedule
// produces a wrong budget, which is a false alert or a missed one.

const MONTH_NAMES = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const DOW_NAMES = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

/** One field token: a number, or a name from `names`. Null when neither. */
function token(raw, names) {
  const key = String(raw).toUpperCase();
  if (names && key in names) return names[key];
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

/** One cron field as a sorted array of allowed values, or null if malformed. */
function parseField(raw, min, max, names) {
  const out = new Set();
  for (const part of String(raw).split(',')) {
    const slashed = part.split('/');
    if (slashed.length > 2) return null;
    let step = 1;
    if (slashed.length === 2) {
      if (!/^\d+$/.test(slashed[1])) return null;
      step = Number(slashed[1]);
      if (step < 1) return null;
    }
    const body = slashed[0];
    let lo;
    let hi;
    // `?` is Quartz's "no specific value"; cron has no such concept, and
    // treating it as `*` is what every implementation that accepts both does.
    if (body === '*' || body === '?') {
      lo = min; hi = max;
    } else {
      const ends = body.split('-');
      if (ends.length > 2) return null;
      const a = token(ends[0], names);
      if (a === null) return null;
      const b = ends.length === 2 ? token(ends[1], names) : null;
      if (ends.length === 2 && b === null) return null;
      lo = a;
      hi = ends.length === 2 ? b : (slashed.length === 2 ? max : a);
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let i = lo; i <= hi; i += step) out.add(i);
  }
  return out.size ? [...out].sort((a, b) => a - b) : null;
}

/**
 * A cron expression as the same six sorted arrays a wall spec carries.
 *
 * @param {string} expr
 * @returns {object|null} null when the expression cannot be parsed
 */
export function parseCron(expr) {
  const fields = String(expr ?? '').trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5 && fields.length !== 6) return null;
  const [s, mi, h, dom, mon, dowRaw] = fields.length === 6 ? fields : ['0', ...fields];

  const second = parseField(s, 0, 59, null);
  const minute = parseField(mi, 0, 59, null);
  const hour = parseField(h, 0, 23, null);
  const day = parseField(dom, 1, 31, null);
  const month = parseField(mon, 1, 12, MONTH_NAMES);
  // 0 and 7 both mean Sunday, so the field is parsed over 0..7 and folded.
  const dow7 = parseField(dowRaw, 0, 7, DOW_NAMES);
  if (!second || !minute || !hour || !day || !month || !dow7) return null;
  const dow = [...new Set(dow7.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);

  return { second, minute, hour, day, month, dow };
}

/** A wall spec from explicit component lists; anything omitted means "every". */
const wallSpec = ({ second, minute, hour, day, month, dow }) => ({
  second: second ?? [0], minute: minute ?? ALL.minute, hour: hour ?? ALL.hour,
  day: day ?? ALL.day, month: month ?? ALL.month, dow: dow ?? ALL.dow,
});

/** n8n's triggerAt* fields, clamped into range; absent means midnight. */
const atHour = (iv) => {
  const n = Number(iv.triggerAtHour);
  return [Number.isFinite(n) && n >= 0 && n <= 23 ? n : 0];
};
const atMinute = (iv) => {
  const n = Number(iv.triggerAtMinute);
  return [Number.isFinite(n) && n >= 0 && n <= 59 ? n : 0];
};


/** Cadence of one sub-day interval entry, in ms, or 0 when it is not one. */
const CADENCE_UNIT = { seconds: SEC, minutes: MIN, hours: HOUR };

/**
 * Every Schedule Trigger interval entry on a workflow, flattened.
 *
 * Every entry of every trigger, not `interval[0]` of the first one: n8n lets a
 * single trigger carry several rules, and a workflow carry several triggers.
 * The map builders read only the first entry because they render a label; a
 * budget derived from one of several rules would simply be wrong.
 */
function intervals(workflow) {
  const out = [];
  for (const n of Array.isArray(workflow?.nodes) ? workflow.nodes : []) {
    if (n?.type !== SCHEDULE_TRIGGER) continue;
    for (const iv of ((n.parameters || {}).rule || {}).interval || []) {
      if (iv && typeof iv === 'object') out.push(iv);
    }
  }
  return out;
}

/** The count n8n stores as `<field>Interval`; absent means one unit. */
const countOf = (iv) => {
  const n = Number(iv[`${iv.field}Interval`]);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

/** The ms in one unit of a calendar interval, used only for multi-unit counts. */
const CALENDAR_UNIT = { days: DAY, weeks: 7 * DAY, months: 31 * DAY };

/**
 * Classify one interval entry into a spec the calculator can use.
 *
 * A count of 1 pins the phase — "every day at 08:00" is an exact wall clock.
 * A higher count does not: n8n measures "every 3 days" from whenever the
 * workflow was last activated, which is not in the workflow object, so those
 * degrade to a cadence. The month unit is deliberately 31 days rather than an
 * average: over-estimating a budget delays an alert, under-estimating invents
 * one.
 *
 * @returns {{type: 'cadence', cadenceMs: number}
 *   | {type: 'wall', spec: object}
 *   | {type: 'unparseable', expression: string}
 *   | null}
 */
function toSpec(iv) {
  if (iv.field === 'cronExpression') {
    const expression = String(iv.expression ?? iv.cronExpression ?? '').trim();
    const spec = parseCron(expression);
    return spec ? { type: 'wall', spec, expression } : { type: 'unparseable', expression };
  }

  const unit = CADENCE_UNIT[iv.field];
  if (unit) return { type: 'cadence', cadenceMs: countOf(iv) * unit };

  const calendar = CALENDAR_UNIT[iv.field];
  if (calendar) {
    const count = countOf(iv);
    if (count !== 1) return { type: 'cadence', cadenceMs: count * calendar };
    if (iv.field === 'days') {
      return { type: 'wall', spec: wallSpec({ hour: atHour(iv), minute: atMinute(iv) }) };
    }
    if (iv.field === 'weeks') {
      const raw = Array.isArray(iv.triggerAtDay) ? iv.triggerAtDay : [iv.triggerAtDay];
      const dow = [...new Set(raw.map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
      return { type: 'wall', spec: wallSpec({ hour: atHour(iv), minute: atMinute(iv), dow: dow.length ? dow : undefined }) };
    }
    const dom = Number(iv.triggerAtDayOfMonth ?? iv.triggerAtDay);
    return {
      type: 'wall',
      spec: wallSpec({
        hour: atHour(iv), minute: atMinute(iv),
        day: Number.isFinite(dom) && dom >= 1 && dom <= 31 ? [dom] : [1],
      }),
    };
  }
  return null;
}

/**
 * The timezone a workflow's schedule is interpreted in.
 *
 * n8n resolves it the same way: the workflow's own setting, else the
 * instance-wide GENERIC_TIMEZONE, else UTC. An unknown zone name would make
 * `Intl` throw on every poll, so it falls back rather than propagates.
 */
export function resolveTimezone(workflow, instanceTimezone) {
  for (const tz of [workflow?.settings?.timezone, instanceTimezone]) {
    if (usableZone(tz)) return tz;
  }
  return 'UTC';
}

/**
 * What the watchdog needs to know about a workflow's schedule.
 *
 * `fire` carries an exact instant the workflow was expected to run, which is
 * what makes "not stale on Saturday" possible. `cadence` carries only a
 * length, for schedules whose phase the workflow object does not pin down.
 *
 * @param {object} workflow - a workflow object as stored by the sync
 * @param {{ instanceTimezone?: string, now?: number }} [opts]
 * @returns {{kind: 'none'|'cadence'|'fire', at?: number, cadenceMs?: number,
 *   timezone?: string, unparseable: (string|null)}}
 */
export function expectedSchedule(workflow, { instanceTimezone = 'UTC', now = Date.now() } = {}) {
  const tz = resolveTimezone(workflow, instanceTimezone);
  // The strictest rule wins: with several triggers, the shortest cadence is
  // the one an operator would notice missing first. Resolving every spec to a
  // cadence first is what makes a wall clock and an interval comparable.
  let best = null;
  let unparseable = null;
  for (const iv of intervals(workflow)) {
    // An interval whose `field` this module does not know at all (a unit a
    // later n8n adds) yields no spec and is not reported as a bad cron: the
    // caller's log line names an expression, and there is none.
    const spec = toSpec(iv);
    if (!spec) continue;
    if (spec.type === 'unparseable') { unparseable ??= spec.expression; continue; }
    const cadenceMs = spec.type === 'wall' ? nominalCadence(spec.spec, tz, now) : spec.cadenceMs;
    // A cadence of zero means the expression parses but matches no date there
    // is — `0 9 30 2 *`, the 30th of February. Left in, it would make every
    // poll find the workflow overdue. It is a schedule we cannot budget from,
    // which is what `unparseable` means to the caller.
    if (!(cadenceMs > 0)) { unparseable ??= spec.expression ?? String(iv.field ?? ''); continue; }
    if (!best || cadenceMs < best.cadenceMs) best = { spec, cadenceMs };
  }
  // Reported, never guessed at: the caller logs it once and falls back to the
  // flat budget. A silent skip would leave the rule quiet with no way to tell.
  if (!best) return unparseable === null ? { kind: 'none', unparseable: null } : { kind: 'unparseable', unparseable };

  if (best.spec.type === 'wall') {
    const at = previousFire(best.spec.spec, tz, now);
    if (at !== null) return { kind: 'fire', at, cadenceMs: best.cadenceMs, timezone: tz, unparseable };
  }
  return { kind: 'cadence', cadenceMs: best.cadenceMs, timezone: tz, unparseable };
}
