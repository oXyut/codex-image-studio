# Issue #30 検証記録

2026-10-03、fetchで確認した `origin/main = d34fb45963d672e1e734d0fbfdbdcb63fc00f234` から独立worktreeで改修した。

成功9件・失敗3件、6系統の専用サンプルをlocalhost:4330で表示。PNGはプログラムで描いた家の図案のみ。生成を拒否するテストadapterを使用し、実生成・課金・ユーザー画像・通常の4317サーバー・LAN設定は扱っていない。

## 変更と確認

- 最初は選択した画像の系統、未選択なら最新の系統を表示する。個別系統の自動倍率は75%以上。定期更新で系統や移動位置を変更しない。
- 「全系統の概要」は独立系統を横にも配置する。縮尺に左右されない系統一覧と切替メニューを用意した。同時作成の仲間は一緒に移動できるが、参照関係は追加しない。
- 390×844ではリストを初期表示する。画像・タイトル・状態・同時作成番号・参照元／入力元を表示し、共通ビューアへ渡す。
- 図／リスト、概要、選択への移動、ズームを図の上に配置。図のサイズ変更後にも倍率を合わせ直す。
- 概要から海辺の系統へ切替、共通矢印1本→3枚の個別展開で3本→再収納で1本を実画面で確認。
- 右クリック、Shift+F10、Escape、Enterでのプレビュー、矢印キーでの移動を確認。右クリックだけでプレビューは開かない。
- スマホのリストから失敗画像を選択し、詳細を閉じて「選択へ」で戻れることを確認。存在しない検索語の空状態と解除操作も確認。空履歴は回帰テストで確認。

| 画面 | 確認結果 | 証拠 |
| --- | --- | --- |
| 1440×900・変更前 | 全体33%、タイトルがほぼ読めない | [before-desktop.jpg](before-desktop.jpg) |
| 390×844・変更前 | 全体25%、操作が下部に押し出される | [before-mobile.jpg](before-mobile.jpg) |
| 1440×900・初期表示 | 最新の失敗系統を100%で識別できる | [after-desktop-initial.jpg](after-desktop-initial.jpg) |
| 1440×900・概要 | 全体約73%、全12件の配置と系統一覧を表示 | [after-desktop-overview.jpg](after-desktop-overview.jpg) |
| 1440×900・個別系統 | 4件の画像・失敗状態・共通矢印を読める | [after-desktop-family.jpg](after-desktop-family.jpg) |
| 1440×900・個別展開 | 参照元から各画像への矢印を復元 | [after-desktop-expanded.jpg](after-desktop-expanded.jpg) |
| 1440×900・右クリック | 対象画像のメニューを維持 | [after-desktop-context-menu.jpg](after-desktop-context-menu.jpg) |
| 775×774 | 約81%で画像・タイトル・共通矢印と上部操作を確認 | [after-tablet-family.jpg](after-tablet-family.jpg) |
| 390×844・初期表示 | 系統切替・表示形式・選択操作が最初の画面内 | [after-mobile-initial.jpg](after-mobile-initial.jpg) |
| 390×844・リスト | タイトル・番号・参照元を読める | [after-mobile-list.jpg](after-mobile-list.jpg) |
| 390×844・失敗 | 成功と失敗をリスト内で識別できる | [after-mobile-list-failure.jpg](after-mobile-list-failure.jpg) |
| 390×844・図 | 選択した失敗ノードへ移動し、ズームと系統切替に到達できる | [after-mobile-graph.jpg](after-mobile-graph.jpg) |
| 390×844・空検索 | 空状態の説明と解除ボタンを表示 | [after-mobile-empty-search.jpg](after-mobile-empty-search.jpg) |

スクリーンショットはすべて今回撮影し、保存した画像を開いて画面の配置・可読性を確認した。図の最低倍率を維持するため、長い系統や個別展開時には移動が必要になる。スマホのリストは縮小されない。

## 自動検証

- `npm run check`: フロントエンド／サーバーの型チェック、サーバーbuild、Vite buildが成功。
- `VITEST_MAX_WORKERS=2 npm test`: サーバーテスト196件、フロントエンド114件、計310件が成功。
- `git diff --check`: 成功。
- 追加回帰テスト: 初期系統の選定、同時作成と下流の切替、概要配置の非重複・相対位置維持、選択への移動、検索の全系統化、外部の同時作成指定、スマホ初期リストとキーボードメニュー、失敗・空状態、描画域変更後のfit。

実生成・実認証・実スマホのタッチ操作、大規模履歴、他監査Issueとの統合後の画面は未検証。#29/#34がナビや画面配分を変更する場合は、統合時に775×774と390×844を再確認する。共有の `app.tsx`、provider、`shared/lineage-utils.ts`、画像ビューアは変更していない。
