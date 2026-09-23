import * as SQLite from 'expo-sqlite';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import PersistentDirectory from '../../../modules/persistent-directory';

export type Note = {
  id: string;
  title: string;
  updated_at: number;
  external_uri: string | null;
  deleted_at: number | null;
};
export type Page = { id: string; note_id: string; position: number };
export type Point = { x: number; y: number };
export type Stroke = { id: string; color: string; width: number; points: Point[] };
export type PageItem = {
  id: string;
  kind: 'text' | 'image';
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  image?: string;
  fontSize?: number;
  color?: string;
};
export type PageContent = { strokes: Stroke[]; items: PageItem[] };
type PortableNote = {
  format: 'ipad-note';
  version: 1;
  id: string;
  title: string;
  updated_at: number;
  pages: (Page & { content: PageContent })[];
};

const dbPromise = SQLite.openDatabaseAsync('notes.db').then(async (db) => {
  await db.execAsync(`PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL, external_uri TEXT, deleted_at INTEGER);
    CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, position INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS pages_note_position ON pages(note_id, position);`);
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(notes)');
  if (!columns.some((column) => column.name === 'external_uri'))
    await db.execAsync('ALTER TABLE notes ADD COLUMN external_uri TEXT');
  if (!columns.some((column) => column.name === 'deleted_at'))
    await db.execAsync('ALTER TABLE notes ADD COLUMN deleted_at INTEGER');
  return db;
});

const drawings = new Directory(Paths.document, 'drawings');
const activeFolders = new Map<string, Directory>();
const syncQueues = new Map<string, Promise<unknown>>();
let idSequence = 0;
const newId = () => `${Date.now()}-${++idSequence}`;
const drawingFile = (pageId: string) => new File(drawings, `${pageId}.json`);
const externalFile = (folder: Directory, noteId: string) =>
  new File(folder, `${noteId}.ipad-note.json`);
const emptyContent = (): PageContent => ({ strokes: [], items: [] });

export async function listNotes(): Promise<Note[]> {
  return (await dbPromise).getAllAsync<Note>(
    'SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC',
  );
}

export async function listDeletedNotes(): Promise<Note[]> {
  return (await dbPromise).getAllAsync<Note>(
    'SELECT * FROM notes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC',
  );
}

export async function getNote(id: string): Promise<Note | null> {
  return (await dbPromise).getFirstAsync<Note>('SELECT * FROM notes WHERE id = ?', id);
}

export function isNoteFolderConnected(note: Note) {
  return !note.external_uri || activeFolders.has(note.external_uri);
}

export async function pickNoteFolder(): Promise<Directory | null> {
  if (Platform.OS === 'ios' && PersistentDirectory) {
    const uri = await PersistentDirectory.pickDirectory();
    return uri ? new Directory(uri) : null;
  }
  try {
    return await Directory.pickDirectoryAsync();
  } catch (error) {
    if (String(error).toLowerCase().includes('cancel')) return null;
    throw error;
  }
}

let restoringFolders: Promise<number> | null = null;

export function restoreNoteFolders(): Promise<number> {
  if (restoringFolders) return restoringFolders;
  const pending = restoreNoteFoldersOnce();
  restoringFolders = pending;
  void pending
    .finally(() => {
      if (restoringFolders === pending) restoringFolders = null;
    })
    .catch(() => {});
  return pending;
}

async function restoreNoteFoldersOnce(): Promise<number> {
  const folders: Directory[] = [];
  const folderUris = new Set<string>();
  if (Platform.OS === 'ios') {
    if (PersistentDirectory) activeFolders.clear();
    for (const remembered of (await PersistentDirectory?.restoreDirectories()) ?? []) {
      const db = await dbPromise;
      await db.runAsync(
        'UPDATE notes SET external_uri = ? WHERE external_uri = ?',
        remembered.uri,
        remembered.savedUri,
      );
      if (!folderUris.has(remembered.uri)) {
        folders.push(new Directory(remembered.uri));
        folderUris.add(remembered.uri);
      }
    }
  } else if (Platform.OS === 'android') {
    const db = await dbPromise;
    const saved = await db.getAllAsync<{ external_uri: string }>(
      'SELECT DISTINCT external_uri FROM notes WHERE external_uri IS NOT NULL',
    );
    for (const item of saved) folders.push(new Directory(item.external_uri));
  }
  let imported = 0;
  for (const folder of folders) {
    try {
      imported += await connectNoteFolder(folder);
    } catch (error) {
      activeFolders.delete(folder.uri);
      console.warn('External note folder is unavailable', error);
    }
  }
  return imported;
}

function parsePortable(value: unknown, id?: string): PortableNote {
  const note = value as PortableNote;
  if (
    !note ||
    note.format !== 'ipad-note' ||
    note.version !== 1 ||
    !Array.isArray(note.pages) ||
    !/^[a-zA-Z0-9-]+$/.test(note.id) ||
    (id && note.id !== id) ||
    typeof note.title !== 'string' ||
    !Number.isFinite(note.updated_at) ||
    note.pages.some(
      (page) =>
        !/^[a-zA-Z0-9-]+$/.test(page.id) ||
        page.note_id !== note.id ||
        !Number.isFinite(page.position) ||
        !page.content ||
        !Array.isArray(page.content.strokes) ||
        !Array.isArray(page.content.items),
    )
  )
    throw new Error('外部ノートの形式が正しくありません');
  return note;
}

async function readExternal(note: Note): Promise<{ file: File; portable: PortableNote }> {
  const folder = note.external_uri && activeFolders.get(note.external_uri);
  if (!folder) throw new Error('外部フォルダを再接続してください');
  try {
    const file = externalFile(folder, note.id);
    if (!file.exists) throw new Error('外部ノートが見つかりません');
    return { file, portable: parsePortable(JSON.parse(await file.text()), note.id) };
  } catch (error) {
    throw new Error(`外部ノートを読み込めません。再読み込みしてください: ${String(error)}`);
  }
}

function serializeExternal<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = syncQueues.get(id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  syncQueues.set(id, next);
  void next
    .finally(() => {
      if (syncQueues.get(id) === next) syncQueues.delete(id);
    })
    .catch(() => {});
  return next;
}

async function mutateExternal<T>(note: Note, update: (portable: PortableNote) => T): Promise<T> {
  return serializeExternal(note.id, async () => {
    const { file, portable } = await readExternal(note);
    const result = update(portable);
    portable.updated_at = Date.now();
    file.write(JSON.stringify(portable));
    return result;
  });
}

async function indexExternal(portable: PortableNote, folder: Directory) {
  const db = await dbPromise;
  const oldPages = await listPages(portable.id);
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      'INSERT OR REPLACE INTO notes (id, title, updated_at, external_uri) VALUES (?, ?, ?, ?)',
      portable.id,
      portable.title,
      portable.updated_at,
      folder.uri,
    );
    await txn.runAsync('DELETE FROM pages WHERE note_id = ?', portable.id);
    for (const page of portable.pages)
      await txn.runAsync(
        'INSERT INTO pages (id, note_id, position) VALUES (?, ?, ?)',
        page.id,
        portable.id,
        page.position,
      );
  });
  // Old versions kept a second copy in Documents/drawings. Remove it only after the external file is readable and indexed.
  for (const page of [...oldPages, ...portable.pages]) {
    const copy = drawingFile(page.id);
    if (copy.exists) copy.delete();
  }
}

export async function reloadExternalNote(id: string) {
  const note = await getNote(id);
  if (!note?.external_uri) return;
  await syncQueues.get(id)?.catch(() => {});
  const folder = activeFolders.get(note.external_uri);
  const { portable } = await readExternal(note);
  if (!folder) throw new Error('外部フォルダを再接続してください');
  await indexExternal(portable, folder);
}

export async function connectNoteFolder(folder: Directory): Promise<number> {
  const entries = folder.list();
  activeFolders.set(folder.uri, folder);
  let imported = 0;
  for (const entry of entries) {
    if (!(entry instanceof File) || !entry.name.endsWith('.ipad-note.json')) continue;
    let portable: PortableNote;
    try {
      portable = parsePortable(JSON.parse(await entry.text()));
    } catch {
      continue;
    }
    if (entry.name !== `${portable.id}.ipad-note.json`) continue;
    const local = await getNote(portable.id);
    if (local?.deleted_at) continue;
    if (local?.external_uri && local.updated_at > portable.updated_at) {
      const oldPages = await listPages(portable.id);
      if (oldPages.some((page) => drawingFile(page.id).exists)) {
        portable = {
          ...portable,
          title: local.title,
          updated_at: local.updated_at,
          pages: await Promise.all(
            oldPages.map(async (page) => ({ ...page, content: await readLocalContent(page.id) })),
          ),
        };
        entry.write(JSON.stringify(portable));
      }
    }
    await indexExternal(portable, folder);
    imported++;
  }
  return imported;
}

export async function createNote(folder?: Directory): Promise<Note> {
  if (folder) activeFolders.set(folder.uri, folder);
  const note: Note = {
    id: newId(),
    title: '無題のノート',
    updated_at: Date.now(),
    external_uri: folder?.uri ?? null,
    deleted_at: null,
  };
  const page: Page = { id: newId(), note_id: note.id, position: 0 };
  if (folder)
    externalFile(folder, note.id).write(
      JSON.stringify({
        format: 'ipad-note',
        version: 1,
        ...note,
        pages: [{ ...page, content: emptyContent() }],
      }),
    );
  const db = await dbPromise;
  try {
    await db.withExclusiveTransactionAsync(async (txn) => {
      await txn.runAsync(
        'INSERT INTO notes (id, title, updated_at, external_uri) VALUES (?, ?, ?, ?)',
        note.id,
        note.title,
        note.updated_at,
        note.external_uri,
      );
      await txn.runAsync(
        'INSERT INTO pages (id, note_id, position) VALUES (?, ?, 0)',
        page.id,
        note.id,
      );
    });
  } catch (error) {
    if (folder) {
      const file = externalFile(folder, note.id);
      if (file.exists) file.delete();
    }
    throw error;
  }
  return note;
}

export async function renameNote(id: string, title: string) {
  const name = title.trim() || '無題のノート';
  const note = await getNote(id);
  if (!note) throw new Error('ノートが見つかりません');
  if (note.external_uri)
    await mutateExternal(note, (portable) => {
      portable.title = name;
    });
  await (
    await dbPromise
  ).runAsync('UPDATE notes SET title = ?, updated_at = ? WHERE id = ?', name, Date.now(), id);
}

export async function deleteNote(id: string) {
  const note = await getNote(id);
  if (!note || note.deleted_at) return;
  const now = Date.now();
  await (
    await dbPromise
  ).runAsync('UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ?', now, now, id);
}

const DELETED_NOTE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function restoreNote(id: string, now = Date.now()) {
  const result = await (
    await dbPromise
  ).runAsync(
    'UPDATE notes SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL AND deleted_at > ?',
    now,
    id,
    now - DELETED_NOTE_RETENTION_MS,
  );
  if (result.changes > 0) return true;
  await purgeExpiredDeletedNotes(now);
  return false;
}

async function permanentlyDelete(note: Note) {
  await syncQueues.get(note.id)?.catch(() => {});
  const pages = await listPages(note.id);
  if (note.external_uri) {
    const folder = activeFolders.get(note.external_uri);
    if (!folder) throw new Error('外部フォルダを再接続してください');
    const file = externalFile(folder, note.id);
    if (file.exists) file.delete();
  }
  for (const page of pages) {
    const drawing = drawingFile(page.id);
    if (drawing.exists) drawing.delete();
  }
  await (
    await dbPromise
  ).runAsync('DELETE FROM notes WHERE id = ? AND deleted_at IS NOT NULL', note.id);
}

export async function permanentlyDeleteNote(id: string) {
  const note = await getNote(id);
  if (!note?.deleted_at) throw new Error('削除済みのノートが見つかりません');
  await permanentlyDelete(note);
}

export async function emptyTrash() {
  const notes = await listDeletedNotes();
  let deleted = 0;
  let failed = 0;
  for (const note of notes) {
    try {
      await permanentlyDelete(note);
      deleted++;
    } catch {
      failed++;
    }
  }
  return { deleted, failed };
}

export async function purgeExpiredDeletedNotes(now = Date.now()) {
  const db = await dbPromise;
  const expired = await db.getAllAsync<Note>(
    'SELECT * FROM notes WHERE deleted_at IS NOT NULL AND deleted_at <= ?',
    now - DELETED_NOTE_RETENTION_MS,
  );
  let purged = 0;
  for (const note of expired) {
    try {
      await permanentlyDelete(note);
    } catch {
      continue;
    }
    purged++;
  }
  return purged;
}

export async function listPages(noteId: string): Promise<Page[]> {
  return (await dbPromise).getAllAsync<Page>(
    'SELECT * FROM pages WHERE note_id = ? ORDER BY position',
    noteId,
  );
}

export async function addPage(noteId: string): Promise<Page> {
  const note = await getNote(noteId);
  if (!note) throw new Error('ノートが見つかりません');
  const db = await dbPromise;
  if (note.external_uri) {
    const page = await mutateExternal(note, (portable) => {
      const last = portable.pages.reduce((max, item) => Math.max(max, item.position), -1);
      const added = { id: newId(), note_id: noteId, position: last + 1 };
      portable.pages.push({ ...added, content: emptyContent() });
      return added;
    });
    await db.withExclusiveTransactionAsync(async (txn) => {
      await txn.runAsync(
        'INSERT INTO pages (id, note_id, position) VALUES (?, ?, ?)',
        page.id,
        noteId,
        page.position,
      );
      await txn.runAsync('UPDATE notes SET updated_at = ? WHERE id = ?', Date.now(), noteId);
    });
    return page;
  }
  const last = await db.getFirstAsync<{ position: number }>(
    'SELECT position FROM pages WHERE note_id = ? ORDER BY position DESC LIMIT 1',
    noteId,
  );
  const page = { id: newId(), note_id: noteId, position: (last?.position ?? -1) + 1 };
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      'INSERT INTO pages (id, note_id, position) VALUES (?, ?, ?)',
      page.id,
      noteId,
      page.position,
    );
    await txn.runAsync('UPDATE notes SET updated_at = ? WHERE id = ?', Date.now(), noteId);
  });
  return page;
}

export async function deletePage(noteId: string, pageId: string): Promise<Page[]> {
  const note = await getNote(noteId);
  if (!note) throw new Error('ノートが見つかりません');
  const db = await dbPromise;
  if (note.external_uri) {
    const remaining = await mutateExternal(note, (portable) => {
      const index = portable.pages.findIndex((page) => page.id === pageId);
      if (index < 0) throw new Error('ページが見つかりません');
      portable.pages.splice(index, 1);
      if (!portable.pages.length)
        portable.pages.push({ id: newId(), note_id: noteId, position: 0, content: emptyContent() });
      return portable.pages.map(({ content: _content, ...page }) => page);
    });
    await db.withExclusiveTransactionAsync(async (txn) => {
      await txn.runAsync('DELETE FROM pages WHERE note_id = ?', noteId);
      for (const page of remaining)
        await txn.runAsync(
          'INSERT INTO pages (id, note_id, position) VALUES (?, ?, ?)',
          page.id,
          noteId,
          page.position,
        );
      await txn.runAsync('UPDATE notes SET updated_at = ? WHERE id = ?', Date.now(), noteId);
    });
    const copy = drawingFile(pageId);
    if (copy.exists) copy.delete();
    return remaining;
  }
  await db.withExclusiveTransactionAsync(async (txn) => {
    const count = await txn.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM pages WHERE note_id = ?',
      noteId,
    );
    const result = await txn.runAsync(
      'DELETE FROM pages WHERE id = ? AND note_id = ?',
      pageId,
      noteId,
    );
    if (result.changes !== 1) throw new Error('Page not found');
    if (count?.count === 1)
      await txn.runAsync(
        'INSERT INTO pages (id, note_id, position) VALUES (?, ?, 0)',
        newId(),
        noteId,
      );
    await txn.runAsync('UPDATE notes SET updated_at = ? WHERE id = ?', Date.now(), noteId);
  });
  const file = drawingFile(pageId);
  if (file.exists) file.delete();
  return listPages(noteId);
}

export async function restoreDeletedPage(
  noteId: string,
  page: Page,
  content: PageContent,
  replacementPageId?: string,
): Promise<Page[]> {
  const note = await getNote(noteId);
  if (!note) throw new Error('ノートが見つかりません');
  const db = await dbPromise;
  if (note.external_uri) {
    const restored = await mutateExternal(note, (portable) => {
      if (portable.pages.some((candidate) => candidate.id === page.id))
        throw new Error('ページはすでに復元されています');
      if (replacementPageId)
        portable.pages = portable.pages.filter((candidate) => candidate.id !== replacementPageId);
      portable.pages.push({ ...page, content });
      portable.pages.sort((left, right) => left.position - right.position);
      return portable.pages.map(({ content: _content, ...candidate }) => candidate);
    });
    await db.withExclusiveTransactionAsync(async (txn) => {
      if (replacementPageId)
        await txn.runAsync(
          'DELETE FROM pages WHERE id = ? AND note_id = ?',
          replacementPageId,
          noteId,
        );
      await txn.runAsync(
        'INSERT INTO pages (id, note_id, position) VALUES (?, ?, ?)',
        page.id,
        noteId,
        page.position,
      );
      await txn.runAsync('UPDATE notes SET updated_at = ? WHERE id = ?', Date.now(), noteId);
    });
    return restored;
  }
  if (!drawings.exists) drawings.create();
  drawingFile(page.id).write(JSON.stringify(content));
  await db.withExclusiveTransactionAsync(async (txn) => {
    if (replacementPageId)
      await txn.runAsync(
        'DELETE FROM pages WHERE id = ? AND note_id = ?',
        replacementPageId,
        noteId,
      );
    await txn.runAsync(
      'INSERT INTO pages (id, note_id, position) VALUES (?, ?, ?)',
      page.id,
      noteId,
      page.position,
    );
    await txn.runAsync('UPDATE notes SET updated_at = ? WHERE id = ?', Date.now(), noteId);
  });
  if (replacementPageId) {
    const replacement = drawingFile(replacementPageId);
    if (replacement.exists) replacement.delete();
  }
  return listPages(noteId);
}

async function readLocalContent(pageId: string): Promise<PageContent> {
  const file = drawingFile(pageId);
  if (!file.exists) return emptyContent();
  try {
    const value: unknown = JSON.parse(await file.text());
    if (Array.isArray(value)) return { strokes: value as Stroke[], items: [] };
    if (value && typeof value === 'object' && 'strokes' in value) {
      const content = value as PageContent;
      return {
        strokes: Array.isArray(content.strokes) ? content.strokes : [],
        items: Array.isArray(content.items) ? content.items : [],
      };
    }
  } catch {
    /* A damaged local page remains empty until edited. */
  }
  return emptyContent();
}

export async function loadPageContent(pageId: string): Promise<PageContent> {
  const db = await dbPromise;
  const page = await db.getFirstAsync<Page>('SELECT * FROM pages WHERE id = ?', pageId);
  if (!page) throw new Error('ページが見つかりません');
  const note = await getNote(page.note_id);
  if (!note) throw new Error('ノートが見つかりません');
  if (!note.external_uri) return readLocalContent(pageId);
  await syncQueues.get(note.id)?.catch(() => {});
  const { portable } = await readExternal(note);
  const content = portable.pages.find((item) => item.id === pageId)?.content;
  if (!content) throw new Error('外部ファイルにページがありません。再読み込みしてください');
  return content;
}

export async function savePageContent(noteId: string, pageId: string, content: PageContent) {
  const note = await getNote(noteId);
  if (!note) throw new Error('ノートが見つかりません');
  if (note.external_uri) {
    await mutateExternal(note, (portable) => {
      const page = portable.pages.find((item) => item.id === pageId);
      if (!page) throw new Error('外部ファイルにページがありません');
      page.content = content;
    });
  } else {
    if (!drawings.exists) drawings.create();
    drawingFile(pageId).write(JSON.stringify(content));
  }
  await (
    await dbPromise
  ).runAsync('UPDATE notes SET updated_at = ? WHERE id = ?', Date.now(), noteId);
}
