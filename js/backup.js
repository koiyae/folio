// The whole library as one file, to carry it to another device (or keep it safe) and bring it back.
//
// A .folio file is
//   "FOLIOLIB"  (8 bytes)
//   version     uint32, little-endian
//   headerLen   uint32, little-endian
//   header      UTF-8 JSON: { app, version, createdAt, shelves[], books: [{ meta, file, cover, marks }] }
//   data        the PDFs and covers one after another; header.books[i].file / .cover = { off, len, type }
//               point into it (from the start of the data)
// Marks travel inside the header as they are stored ({ page, strokes }).
//
// Books are matched across devices by their PDF's fingerprint (ids differ from one device to another). A
// book already here takes the file's state (place, flags, marks, look, shelf) when it was opened there more
// recently than here; otherwise it stays as it is. Books not here yet are added.

import * as store from './store.js';

const MAGIC = 'FOLIOLIB';
const VERSION = 1;
export const BACKUP_EXT = '.folio';

/** The library as a Blob (the PDFs stay on disk until the file is written). */
export async function exportLibrary(metas, shelves, onProgress) {
  const parts = [];
  let off = 0;
  const put = (blob) => {
    if (!blob) return null;
    const ref = { off, len: blob.size, type: blob.type || '' };
    parts.push(blob);
    off += blob.size;
    return ref;
  };
  const books = [];
  const missing = [];
  for (let i = 0; i < metas.length; i++) {
    const meta = metas[i];
    onProgress && onProgress(i, metas.length, meta.title);
    const file = await store.getFile(meta.id);
    if (!file) {
      missing.push(meta.title);
      continue;
    }
    const cover = await store.getCover(meta.id).catch(() => null);
    const marks = await store.getMarks(meta.id).catch(() => new Map());
    books.push({
      meta,
      file: put(file),
      cover: put(cover),
      marks: [...marks].map(([page, strokes]) => ({ page, strokes })),
    });
  }
  const header = new TextEncoder().encode(JSON.stringify({ app: 'folio', version: VERSION, createdAt: Date.now(), shelves, books }));
  const head = new Uint8Array(16);
  head.set(new TextEncoder().encode(MAGIC), 0);
  const dv = new DataView(head.buffer);
  dv.setUint32(8, VERSION, true);
  dv.setUint32(12, header.length, true);
  return { blob: new Blob([head, header, ...parts], { type: 'application/octet-stream' }), count: books.length, missing };
}

/** Read a .folio file's header (the PDFs are only sliced out when they are stored). */
export async function readBackup(file) {
  const bad = () => new Error('This is not a Folio library file.');
  if (file.size < 16) throw bad();
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (new TextDecoder().decode(head.slice(0, 8)) !== MAGIC) throw bad();
  const dv = new DataView(head.buffer);
  const version = dv.getUint32(8, true);
  if (version > VERSION) throw new Error('This library file comes from a newer Folio.');
  const len = dv.getUint32(12, true);
  if (16 + len > file.size) throw bad();
  let header;
  try {
    header = JSON.parse(await file.slice(16, 16 + len).text());
  } catch {
    throw bad();
  }
  if (!header || header.app !== 'folio' || !Array.isArray(header.books)) throw bad();
  const base = 16 + len;
  const slice = (ref, fallbackType) => {
    if (!ref || !(ref.off >= 0) || !(ref.len > 0) || base + ref.off + ref.len > file.size) return null;
    return file.slice(base + ref.off, base + ref.off + ref.len, ref.type || fallbackType);
  };
  return { header, slice };
}

/**
 * Bring a library file into this one.
 * @returns {{ added: number, updated: number, kept: number, failed: string[], lastId: string|null }}
 */
export async function importLibrary(file, metas, shelves, onProgress) {
  const { header, slice } = await readBackup(file);
  // shelves: the same shelf (by id, else by name) is one shelf; the others join the list
  const shelfMap = new Map();
  let shelvesChanged = false;
  for (const s of Array.isArray(header.shelves) ? header.shelves : []) {
    if (!s || !s.id || !s.name) continue;
    const mine = shelves.find((x) => x.id === s.id) || shelves.find((x) => x.name.trim().toLowerCase() === s.name.trim().toLowerCase());
    if (mine) shelfMap.set(s.id, mine);
    else {
      const add = { id: s.id, name: s.name };
      shelves.push(add);
      shelfMap.set(s.id, add);
      shelvesChanged = true;
    }
  }
  const onShelf = (meta) => {
    const s = meta.shelf ? shelfMap.get(meta.shelf) : null;
    return { shelf: s ? s.id : null, shelfName: s ? s.name : null, section: s ? meta.section || null : null };
  };

  const byPrint = new Map(metas.filter((m) => m.fingerprint).map((m) => [m.fingerprint, m]));
  const ids = new Set(metas.map((m) => m.id));
  const out = { added: 0, updated: 0, kept: 0, failed: [], lastId: null, shelvesChanged, restyled: [] };
  const list = header.books;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const meta = b && b.meta;
    if (!meta || !meta.id) continue;
    onProgress && onProgress(i, list.length, meta.title);
    try {
      const mine = (meta.fingerprint && byPrint.get(meta.fingerprint)) || null;
      if (mine) {
        if ((meta.openedAt || 0) > (mine.openedAt || 0)) {
          // read more recently on the other device: its place, flags, marks and looks
          const next = { ...meta, ...onShelf(meta), id: mine.id, addedAt: mine.addedAt };
          await store.restoreBook(next, null, null, Array.isArray(b.marks) ? b.marks : []);
          out.updated++;
          out.restyled.push(mine.id);
          out.lastId = mine.id;
        } else if (!mine.shelf && meta.shelf && shelfMap.has(meta.shelf)) {
          // kept as it is here, but put on the shelf it stands on there
          await store.putBook({ ...mine, ...onShelf(meta) });
          out.updated++;
        } else out.kept++;
        continue;
      }
      const pdf = slice(b.file, 'application/pdf');
      if (!pdf) throw new Error('missing file');
      const id = ids.has(meta.id) ? 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) : meta.id;
      const next = { ...meta, ...onShelf(meta), id };
      await store.restoreBook(next, pdf, slice(b.cover, 'image/jpeg'), Array.isArray(b.marks) ? b.marks : []);
      ids.add(id);
      if (next.fingerprint) byPrint.set(next.fingerprint, next);
      out.added++;
      out.lastId = id;
    } catch (err) {
      console.error('library import', meta.title, err);
      out.failed.push(meta.title || meta.fileName || '?');
    }
  }
  return out;
}

/** A file name for today's backup. */
export function backupName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Folio library ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}${BACKUP_EXT}`;
}
