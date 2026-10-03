# Issue #36 検証記録

参照画像ピッカーで同じ入力の同時生成結果を区別し、選択を保ったまま画像全体を確認できるようにした。

## 環境

- 2026-10-03、MacのCodex in-app Browserで確認。
- `git fetch origin main`で確認した基点は`d34fb45963d672e1e734d0fbfdbdcb63fc00f234`。
- 専用worktreeと`127.0.0.1:4396`、独立したサンプルデータを使用。通常の4317サーバー・LAN設定・ユーザー画像データには変更を加えていない。
- Codex CLIはリポジトリのfake fixtureを使用。画像生成ボタンは操作していない。
- サンプル写真を複数の履歴で再利用している。実生成画像の差や生成品質は未評価。
- 表示日時はブラウザーのローカル時刻。スクリーンショットに秘密やユーザー画像は含まない。

## 確認結果

- 修正前は同じ3枚の表示名とアクセシビリティ名が重複することを最新mainの実画面で再現。
- 修正後は元の同時生成番号（1 / 3枚目〜3 / 3枚目）、生成単位のID、年・秒を含む日時を表示。選択・拡大・役割の操作名にも含めた。
- 1440×900、775×774、390×844で候補一覧と拡大確認を撮影し、保存した画像を開いて確認。
- 2枚目を選択して別の候補を確認しても選択を保持。役割を「構図」に変更し、拡大・復帰後も保持。
- Enterで拡大、Escapeで候補へ復帰し、元の「大きく確認」ボタンへフォーカスが戻ることを実ブラウザーで確認。
- 検索結果が空になっても選択と役割を保持。
- 自分のサンプル画像を一時的に退避して読込失敗を再現し、エラー表示と選択保持・戻る操作を確認。検証後にサンプルを復元。
- 回帰テストで同名・同時刻の3枚、選択と役割の保持、拡大中の選択・解除、検索保持、画像読込失敗、単独生成・アップロード、削除後の番号、4枚上限、キャンセル、失敗履歴を確認。

## 自動検証

- `npm run check`：成功（frontend/server型チェック、build）。
- `npm test`：成功（server 196件、frontend 112件、追加7件を含む）。
- 最終調整後に再確認：`npm run check`、`node --test --test-concurrency=2 dist/test/*.test.js`（196件）、`npm run test:frontend -- --maxWorkers=1`（112件）。

## 証跡

| 画面 | 候補一覧 | 拡大確認 |
| --- | --- | --- |
| 1440×900 | [after-desktop.jpg](after-desktop.jpg) | [preview-desktop.jpg](preview-desktop.jpg) |
| 775×774 | [after-tablet.jpg](after-tablet.jpg) | [preview-tablet.jpg](preview-tablet.jpg) |
| 390×844 | [after-mobile.jpg](after-mobile.jpg) | [preview-mobile.jpg](preview-mobile.jpg) |

修正前：[desktop](before-desktop.jpg)、[mobile](before-mobile.jpg)。状態確認：[検索結果なし](empty-filter.jpg)、[画像読込失敗](preview-load-error.jpg)。

写真の出典は監査用サンプルと同じUnsplash素材：

- https://images.unsplash.com/photo-1500534623283-312aade485b7
- https://images.unsplash.com/photo-1485955900006-10f4d324d411
- https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05

実画像生成、課金、実アカウントの認証、実機スマホのタッチ操作、VoiceOverでの読み上げは未検証。
