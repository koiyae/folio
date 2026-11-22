// How the books stand: grouped (like a library) and ordered.
//
//   group  'none'    one shelf
//          'author'  sections by author's surname; authors with a single book share their letter's section
//          'letter'  sections by the title's first letter
//          'status'  reading now · not started · finished
//          'shelves' your own shelves, stacked as a bookcase (one shelf per book)
//   order  'added' · 'recent' · 'title' · 'author' · 'colour' · 'size' · 'progress' · 'marked' · 'manual'
//
// The first four give one row with sections (labels on the shelf's edge); 'shelves' gives a bookcase, a row
// per shelf, each shelf in its own sections if its books carry one (an added folder's subfolders). The order
// applies inside each section or shelf. Your shelves themselves are kept here too
// (names and order in localStorage; each book carries its shelf's id and name, so a book always finds its
// shelf again).

import { hexToRgb } from './textures.js';

export const GROUPS = [
  { key: 'none', label: 'None', title: 'FULL LIBRARY' },
  { key: 'author', label: 'Author', title: 'BY AUTHOR' },
  { key: 'letter', label: 'Letter', title: 'A–Z' },
  { key: 'status', label: 'Status', title: 'BY STATUS' },
  { key: 'shelves', label: 'My shelves', title: 'MY SHELVES' },
];
export const ORDERS = [
  { key: 'added', label: 'Added', short: 'ADDED' },
  { key: 'recent', label: 'Recently read', short: 'RECENT' },
  { key: 'title', label: 'Title', short: 'TITLE' },
  { key: 'author', label: 'Author', short: 'AUTHOR' },
  { key: 'colour', label: 'Colour', short: 'COLOUR' },
  { key: 'size', label: 'Size', short: 'SIZE' },
  { key: 'progress', label: 'Progress', short: 'PROGRESS' },
  { key: 'marked', label: 'Most marked', short: 'MARKED' },
  { key: 'manual', label: 'My order', short: 'MY ORDER' },
];

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const ARTICLE = /^(the|a|an|der|die|das|ein|eine|le|la|les|l'|un|une|el|los|las|il|lo|gli|de|het)\s+/i;
export const titleKey = (t) => (t || '').replace(ARTICLE, '').replace(/^[^\p{L}\p{N}]+/u, '');

// ------------------------------------------------------------------ authors
const PARTICLE = new Set(['van', 'von', 'de', 'der', 'den', 'du', 'da', 'di', 'del', 'della', 'le', 'la', 'ten', 'ter', 'zu', 'af', 'bin', 'ibn']);
const SUFFIX = /^(jr|sr|ii|iii|iv|phd|md)\.?$/i;

/** The first author of an author string ("A and B", "A; B", "A & B", "A, B and C"). */
function firstAuthor(a) {
  let s = (a || '').trim();
  if (!s) return '';
  s = s.split(/\s*(?:;|&|\band\b|\bund\b|\bet\b|\by\b|\bwith\b)\s*/i)[0];
  // "Surname, Given" stays together; "A, B, C" (several people) keeps the first
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2 && parts[0].split(/\s+/).length === 1 && parts[1].split(/\s+/).length <= 3 && !SUFFIX.test(parts[1])) return `${parts[1]} ${parts[0]}`;
  return parts[0] || s;
}

/** { surname, display } — "Henry David Thoreau" → Thoreau; "Thoreau, Henry David" → Thoreau; "Ludwig van Beethoven" → Beethoven (shown "van Beethoven"). */
export function authorName(a) {
  const full = firstAuthor(a);
  if (!full) return null;
  const words = full.replace(/\s+/g, ' ').split(' ').filter((w) => !SUFFIX.test(w));
  if (words.length === 1) return { surname: words[0], display: words[0], full };
  let i = words.length - 1;
  let display = words[i];
  while (i > 1 && PARTICLE.has(words[i - 1].toLowerCase())) display = `${words[--i]} ${display}`;
  return { surname: words[words.length - 1], display, full };
}
const authorKey = (m) => {
  const n = authorName(m.author);
  return n ? `${n.surname} ${n.full}` : '￿';
};

// ------------------------------------------------------------------ status, colour, size, marks
/** 'reading' | 'unread' | 'finished' */
export function status(m) {
  const read = (m.spread || 0) * 2;
  if (!m.openedAt || read <= 1) return 'unread';
  if (read >= (m.pages || 0) - 2) return 'finished';
  return 'reading';
}
const STATUS_ORDER = { reading: 0, unread: 1, finished: 2 };
const STATUS_LABEL = { reading: 'Reading now', unread: 'Not started', finished: 'Finished' };

/** Spine colour as a sort key: around the colour wheel, greys and near-blacks/whites last by lightness. */
function hueKey(hex) {
  const [r, g, b] = hexToRgb(hex || '#888888').map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.14 || l < 0.12 || l > 0.9) return 10 + (1 - l); // neutrals at the end, light to dark
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = ((h * 60 + 360) % 360) / 360;
  // start the wheel at red-violet so reds sit together
  return (h + 0.04) % 1;
}

function compare(order, marks) {
  const by = (f) => (a, b) => collator.compare(f(a), f(b));
  switch (order) {
    case 'title':
      return by((x) => titleKey(x.title));
    case 'author':
      return (a, b) => collator.compare(authorKey(a), authorKey(b)) || collator.compare(titleKey(a.title), titleKey(b.title));
    case 'recent':
      return (a, b) => (b.openedAt || 0) - (a.openedAt || 0) || b.addedAt - a.addedAt;
    case 'colour':
      return (a, b) => hueKey(a.look && a.look.cloth) - hueKey(b.look && b.look.cloth) || collator.compare(titleKey(a.title), titleKey(b.title));
    case 'size':
      // tall to short, then thick to thin: a tidy shelf
      return (a, b) => (a.aspect || 0.7) - (b.aspect || 0.7) || (b.pages || 0) - (a.pages || 0);
    case 'progress': {
      const frac = (m) => (m.pages ? Math.min(1, ((m.spread || 0) * 2) / m.pages) : 0);
      return (a, b) => STATUS_ORDER[status(a)] - STATUS_ORDER[status(b)] || frac(b) - frac(a) || (b.openedAt || 0) - (a.openedAt || 0);
    }
    case 'marked': {
      const score = (m) => (marks.get(m.id) || 0) + (m.bookmarks ? m.bookmarks.length : 0);
      return (a, b) => score(b) - score(a) || (b.openedAt || 0) - (a.openedAt || 0);
    }
    case 'manual':
      return (a, b) => (a.order ?? a.addedAt) - (b.order ?? b.addedAt);
    default:
      return (a, b) => a.addedAt - b.addedAt;
  }
}

export function sortBooks(list, order, reverse = false, marks = new Map()) {
  const out = [...list].sort(compare(order, marks));
  return reverse ? out.reverse() : out;
}

// ------------------------------------------------------------------ your shelves
const SHELVES_KEY = 'folio.shelves';
export function loadShelves() {
  try {
    const v = JSON.parse(localStorage.getItem(SHELVES_KEY) || '[]');
    return Array.isArray(v) ? v.filter((s) => s && s.id && s.name) : [];
  } catch {
    return [];
  }
}
export function saveShelves(list) {
  try {
    localStorage.setItem(SHELVES_KEY, JSON.stringify(list));
  } catch {
    /* not remembered */
  }
}
/** Shelves named on books but missing from the list (storage cleared, say) come back, at the end. */
export function reconcileShelves(shelves, metas) {
  const known = new Set(shelves.map((s) => s.id));
  let changed = false;
  for (const m of metas)
    if (m.shelf && !known.has(m.shelf)) {
      shelves.push({ id: m.shelf, name: m.shelfName || 'Shelf' });
      known.add(m.shelf);
      changed = true;
    }
  return changed;
}
export function newShelfId() {
  return 's-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ------------------------------------------------------------------ the layout
/**
 * What stands where. Returns { mode: 'row' | 'case', rows: [{ key, label, metas, sections }] } where sections
 * are [{ label, from, to }] (indices into metas, `to` exclusive), only for grouped rows.
 */
export function layout(metas, { group = 'none', order = 'added', reverse = false, shelves = [], marks = new Map() } = {}) {
  const sort = (list) => sortBooks(list, order, reverse, marks);
  if (group === 'shelves') {
    const rows = shelves.map((s) => shelfRow(s, metas.filter((m) => m.shelf === s.id), sort));
    const loose = metas.filter((m) => !m.shelf || !shelves.some((s) => s.id === m.shelf));
    if (loose.length || !rows.length) rows.push({ key: 'shelf:none', shelfId: null, label: shelves.length ? 'Not on a shelf' : 'All books', metas: sort(loose) });
    return { mode: 'case', rows };
  }
  if (group === 'none') return { mode: 'row', rows: [{ key: 'all', label: '', metas: sort(metas), sections: null }] };

  // grouped: [label, sortKey, metas]
  const groups = new Map();
  const add = (key, label, sortKey, m) => {
    if (!groups.has(key)) groups.set(key, { label, sortKey, metas: [] });
    groups.get(key).metas.push(m);
  };
  if (group === 'status') {
    for (const m of metas) {
      const s = status(m);
      add(s, STATUS_LABEL[s], String(STATUS_ORDER[s]), m);
    }
  } else if (group === 'letter') {
    for (const m of metas) {
      const c = titleKey(m.title).charAt(0).toUpperCase();
      const L = /\p{L}/u.test(c) ? c.normalize('NFD').charAt(0) : '#';
      add(L, L, L === '#' ? '￿' : L, m);
    }
  } else {
    // authors with two or more books get a section; the rest share their letter's
    const byAuthor = new Map();
    for (const m of metas) {
      const n = authorName(m.author);
      // the same person written two ways ("G. W. F. Hegel", "Georg Wilhelm Friedrich Hegel"): surname + initial
      const k = n ? `${n.surname.toLowerCase()}|${n.full.charAt(0).toLowerCase()}` : '';
      if (!byAuthor.has(k)) byAuthor.set(k, { n, metas: [] });
      byAuthor.get(k).metas.push(m);
    }
    for (const { n, metas: ms } of byAuthor.values()) {
      if (!n) {
        for (const m of ms) add('?', 'No author', '￿', m);
        continue;
      }
      const L = n.surname.charAt(0).toUpperCase().normalize('NFD').charAt(0);
      if (ms.length >= 2) for (const m of ms) add(`a:${n.surname.toLowerCase()}|${n.full.charAt(0).toLowerCase()}`, n.display, `${L} 1 ${n.surname} ${n.full}`, m);
      else add(`l:${L}`, L, `${L} 0`, ms[0]);
    }
  }
  const sorted = [...groups.values()].sort((a, b) => collator.compare(a.sortKey, b.sortKey));
  const out = [];
  const sections = [];
  for (const g of sorted) {
    // inside an author's or letter's section, author order means by surname, then title
    const inner = sortBooks(g.metas, order, reverse, marks);
    sections.push({ label: g.label, from: out.length, to: out.length + inner.length });
    out.push(...inner);
  }
  return { mode: 'row', rows: [{ key: 'all', label: '', metas: out, sections }] };
}

/**
 * One of your shelves, in its sections (a folder's subfolders, or named by hand): books with no section stand
 * first, unlabelled, then the sections by name ("01 …", "02 …" in number order). The order applies inside each.
 */
function shelfRow(s, list, sort) {
  const bySec = new Map();
  for (const m of list) {
    const k = (m.section || '').trim();
    if (!bySec.has(k)) bySec.set(k, []);
    bySec.get(k).push(m);
  }
  const names = [...bySec.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : collator.compare(a, b)));
  const metas = [];
  const sections = [];
  for (const k of names) {
    const inner = sort(bySec.get(k));
    sections.push({ label: k, from: metas.length, to: metas.length + inner.length });
    metas.push(...inner);
  }
  const named = sections.some((x) => x.label);
  return { key: `shelf:${s.id}`, shelfId: s.id, label: s.name, metas, sections: named ? sections : null, editableSections: true };
}

/** The sections on one of your shelves, by name. */
export function sectionsOf(metas, shelfId) {
  const set = new Set();
  for (const m of metas) if (m.shelf === shelfId && m.section) set.add(m.section);
  return [...set].sort((a, b) => collator.compare(a, b));
}

/** Give every book an order number following `metas` (when "My order" is first chosen). */
export function seedManualOrder(metas) {
  const changed = [];
  metas.forEach((m, i) => {
    const o = (i + 1) * 1024;
    if (m.order !== o) {
      m.order = o;
      changed.push(m);
    }
  });
  return changed;
}

/** Order number for a book placed between `prev` and `next` (either may be missing). */
export function orderBetween(prev, next) {
  const p = prev ? prev.order ?? prev.addedAt : null;
  const n = next ? next.order ?? next.addedAt : null;
  if (p == null && n == null) return 1024;
  if (p == null) return n - 1024;
  if (n == null) return p + 1024;
  return (p + n) / 2;
}
