import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type Note } from '@/infra/local/notes';
import { useTrashScreen } from '../hooks';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function remainingDays(note: Note) {
  if (!note.deleted_at) return 0;
  return Math.max(0, Math.ceil((note.deleted_at + RETENTION_MS - Date.now()) / 86_400_000));
}

export function TrashScreen() {
  const { list, actions } = useTrashScreen();

  const restore = (note: Note) => {
    void actions
      .restore(note.id)
      .then((restored) => {
        if (!restored) Alert.alert('復元できませんでした', '保存期限を過ぎたため削除されました');
      })
      .catch((cause) => Alert.alert('ノートを復元できませんでした', String(cause)));
  };

  const remove = (note: Note) =>
    Alert.alert(
      '完全に削除',
      `「${note.title}」を完全に削除しますか？\nこの操作は取り消せません。`,
      [
        { text: 'キャンセル' },
        {
          text: '完全に削除',
          style: 'destructive',
          onPress: () => {
            void actions
              .remove(note.id)
              .catch((cause) => Alert.alert('完全に削除できませんでした', String(cause)));
          },
        },
      ],
    );

  const empty = () =>
    Alert.alert(
      'ゴミ箱を空にする',
      'ゴミ箱内のノートをすべて完全に削除しますか？\nこの操作は取り消せません。',
      [
        { text: 'キャンセル' },
        {
          text: 'すべて削除',
          style: 'destructive',
          onPress: () => {
            void actions
              .empty()
              .then(({ failed }) => {
                if (failed > 0)
                  Alert.alert(
                    '一部を削除できませんでした',
                    `${failed}件の外部フォルダを再接続して、もう一度お試しください。`,
                  );
              })
              .catch((cause) => Alert.alert('ゴミ箱を空にできませんでした', String(cause)));
          },
        },
      ],
    );

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Pressable hitSlop={12} onPress={actions.back}>
          <Text style={styles.back}>‹ ノート</Text>
        </Pressable>
        <Text style={styles.heading}>ゴミ箱</Text>
        <Pressable disabled={list.busy || list.notes.length === 0} hitSlop={8} onPress={empty}>
          <Text
            style={[styles.emptyTrash, (list.busy || list.notes.length === 0) && styles.disabled]}
          >
            ゴミ箱を空にする
          </Text>
        </Pressable>
      </View>
      <Text style={styles.description}>削除したノートは7日後に完全に削除されます。</Text>
      {!!list.error && <Text style={styles.error}>{list.error}</Text>}
      <FlatList
        data={list.notes}
        keyExtractor={(note) => note.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={styles.empty}>ゴミ箱は空です。</Text>}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.details}>
              <Text style={styles.title}>{item.title}</Text>
              <Text style={styles.date}>完全削除まで残り{remainingDays(item)}日</Text>
            </View>
            <View style={styles.actions}>
              <Pressable disabled={list.busy} style={styles.restore} onPress={() => restore(item)}>
                <Text style={styles.restoreText}>復元</Text>
              </Pressable>
              <Pressable disabled={list.busy} hitSlop={8} onPress={() => remove(item)}>
                <Text style={styles.delete}>完全削除</Text>
              </Pressable>
            </View>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f4f3ef' },
  header: {
    paddingHorizontal: 32,
    paddingTop: 20,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  back: { color: '#314f72', fontSize: 18, fontWeight: '600' },
  heading: { color: '#252927', fontSize: 28, fontWeight: '700' },
  emptyTrash: { color: '#a34a4a', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  description: { color: '#777', marginHorizontal: 32, marginBottom: 16 },
  list: { paddingHorizontal: 24, paddingBottom: 32 },
  card: {
    alignItems: 'center',
    backgroundColor: 'white',
    borderColor: '#e0dfd9',
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 6,
    padding: 18,
  },
  details: { flex: 1 },
  title: { color: '#252927', fontSize: 17, fontWeight: '600' },
  date: { color: '#777', marginTop: 6 },
  actions: { alignItems: 'center', flexDirection: 'row', gap: 14, marginLeft: 16 },
  restore: {
    backgroundColor: '#314f72',
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  restoreText: { color: 'white', fontWeight: '700' },
  delete: { color: '#a34a4a', fontWeight: '600' },
  empty: { color: '#777', fontSize: 16, margin: 16, textAlign: 'center' },
  error: { color: '#a34a4a', marginHorizontal: 32, marginBottom: 8 },
});
