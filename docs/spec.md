# 作成するもの
ipad用ノートアプリ。タッチペンでの操作を基本とするが、Apple Pencilには特別対応しない。
保存は全て端末にする。

# 技術スタック

| 用途          | 技術                                   |
| ----------- | ------------------------------------ |
| 基盤          | **Expo + React Native + TypeScript** |
| 描画          | **React Native Skia**                |
| ペン・タッチ入力    | **React Native Gesture Handler**     |
| 描画中の高速な状態更新 | **React Native Reanimated**          |
| 画面遷移        | **Expo Router**                      |
| アプリ状態       | **Zustand**                          |
| ノート・ページ管理   | **expo-sqlite**                      |
| 描画データ・画像等   | **expo-file-system**                 |
