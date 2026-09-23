import { useCallback, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  emptyTrash,
  listDeletedNotes,
  permanentlyDeleteNote,
  purgeExpiredDeletedNotes,
  restoreNote,
  restoreNoteFolders,
  type Note,
} from '@/infra/local/notes';

export function useTrashScreen() {
  const router = useRouter();
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      await restoreNoteFolders();
      await purgeExpiredDeletedNotes();
      setNotes(await listDeletedNotes());
      setError('');
    } catch {
      setError('ゴミ箱を読み込めませんでした');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const restore = async (id: string) => {
    setBusy(true);
    try {
      const restored = await restoreNote(id);
      await refresh();
      return restored;
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await permanentlyDeleteNote(id);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const empty = async () => {
    setBusy(true);
    try {
      const result = await emptyTrash();
      await refresh();
      return result;
    } finally {
      setBusy(false);
    }
  };

  return {
    list: { notes, error, busy },
    actions: { back: () => router.back(), restore, remove, empty },
  };
}
