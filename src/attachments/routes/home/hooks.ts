import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { Alert, AppState } from 'react-native';
import {
  connectNoteFolder,
  createNote,
  deleteNote,
  listNotes,
  pickNoteFolder,
  purgeExpiredDeletedNotes,
  restoreNoteFolders,
  type Note,
} from '@/infra/local/notes';

export function readableFolderUri(uri: string) {
  try {
    return decodeURI(uri);
  } catch {
    return uri;
  }
}

function useNotes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setNotes(await listNotes());
      setError('');
    } catch {
      setError('ノートを読み込めませんでした');
    }
  }, []);

  const create = async (location: 'app' | 'folder') => {
    const folder = location === 'folder' ? await pickNoteFolder() : undefined;
    if (location === 'folder' && !folder) return null;
    const note = await createNote(folder ?? undefined);
    await refresh();
    return note;
  };

  const connect = async () => {
    const folder = await pickNoteFolder();
    if (!folder) return null;
    const count = await connectNoteFolder(folder);
    await purgeExpiredDeletedNotes();
    await refresh();
    return count;
  };

  const remove = async (id: string) => {
    await deleteNote(id);
    await refresh();
  };

  return { state: { notes, error }, actions: { refresh, create, connect, remove } };
}

export function useHomeScreen() {
  const router = useRouter();
  const [detailsNoteId, setDetailsNoteId] = useState<string | null>(null);
  const openingNote = useRef(false);
  const { state, actions } = useNotes();
  const { refresh, create, connect, remove } = actions;

  const restore = useCallback(async () => {
    await restoreNoteFolders();
    await purgeExpiredDeletedNotes();
    await refresh();
  }, [refresh]);

  useFocusEffect(
    useCallback(() => {
      openingNote.current = false;
      void restore().catch(console.warn);
    }, [restore]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void restore().catch(console.warn);
    });
    return () => subscription.remove();
  }, [restore]);

  const createAt = (location: 'app' | 'folder') => {
    void create(location)
      .then((note) => {
        if (note) router.push(`/notes/${note.id}`);
      })
      .catch((cause) => Alert.alert('ノートを作成できませんでした', String(cause)));
  };

  const chooseNewNoteLocation = () =>
    Alert.alert('保存先を選択', '新しいノートの保存先を選んでください', [
      { text: 'キャンセル', style: 'cancel' },
      { text: 'アプリ内に保存', onPress: () => createAt('app') },
      { text: 'フォルダを選択', onPress: () => createAt('folder') },
    ]);

  const connectFolder = () => {
    void connect()
      .then((count) => {
        if (count !== null)
          Alert.alert('フォルダを読み込みました', `${count}件のノートを読み込みました`);
      })
      .catch((cause) => Alert.alert('フォルダを読み込めませんでした', String(cause)));
  };

  const confirmDelete = (note: Note) =>
    Alert.alert(
      'ノートを削除',
      `「${note.title}」を削除しますか？\n削除したデータは7日後に完全に削除されます。`,
      [
        { text: 'キャンセル' },
        {
          text: '削除',
          style: 'destructive',
          onPress: () => {
            void remove(note.id).catch((cause) =>
              Alert.alert('ノートを削除できませんでした', String(cause)),
            );
          },
        },
      ],
    );

  const openNote = (id: string) => {
    if (openingNote.current) return;
    openingNote.current = true;
    router.push(`/notes/${id}`);
  };

  return {
    list: { notes: state.notes, error: state.error, detailsNoteId, setDetailsNoteId },
    actions: {
      openNote,
      openTrash: () => router.push('/trash'),
      chooseNewNoteLocation,
      connectFolder,
      confirmDelete,
    },
  };
}
