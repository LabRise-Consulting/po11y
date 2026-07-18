// Pure, dependency-free helpers for the generic list tab. Imported by
// list.html (browser) and list.lib.test.mjs (node --test). No DOM here.

// Accept the three shapes a feed can arrive in and return the row array.
function rowsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;   // n8n DataTable
  if (payload && Array.isArray(payload.items)) return payload.items; // exported feed
  return [];
}

const dayOf = (v) => {
  if (!v) return 'unknown';
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);            // ISO → date-only
  return m ? m[1] : 'unknown';
};

export function normalizeRows(payload, mapping) {
  const m = mapping || {};
  return rowsOf(payload).map((r) => {
    const meta = {};
    for (const k of m.meta || []) meta[k] = r[k] ?? null;
    const scoreRaw = m.score ? r[m.score] : null;
    return {
      id: r.id ?? r[m.title] ?? null,
      title: (m.title ? r[m.title] : null) ?? '(untitled)',
      url: (m.url ? r[m.url] : null) ?? null,
      score: scoreRaw === undefined || scoreRaw === null || scoreRaw === '' ? null : Number(scoreRaw),
      meta,
      day: dayOf(m.day ? r[m.day] : null),
      raw: r,
    };
  });
}

export function sortItems(items, by) {
  const arr = items.slice();
  if (by === 'score') {
    arr.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  } else { // 'day'
    arr.sort((a, b) => {
      const av = a.day === 'unknown' ? '' : a.day;
      const bv = b.day === 'unknown' ? '' : b.day;
      return bv < av ? -1 : bv > av ? 1 : 0;
    });
  }
  return arr;
}

// Subtract n days from an ISO date-only string without touching Date.now().
function isoMinus(dayIso, n) {
  const d = new Date(dayIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function groupByDay(items, today) {
  const byDay = new Map();
  for (const it of items) {
    if (!byDay.has(it.day)) byDay.set(it.day, []);
    byDay.get(it.day).push(it);
  }
  const days = [...byDay.keys()].sort((a, b) => {
    const av = a === 'unknown' ? '' : a;
    const bv = b === 'unknown' ? '' : b;
    return bv < av ? -1 : bv > av ? 1 : 0;
  });
  const yesterday = today ? isoMinus(today, 1) : null;
  return days.map((day) => ({
    day,
    label: day === today ? 'Today' : day === yesterday ? 'Yesterday' : day,
    items: byDay.get(day),
  }));
}
