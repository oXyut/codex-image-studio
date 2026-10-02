# フロントエンド刷新のデザイン検証

final result: passed

2026-10-02。採用した1案目の制作・履歴・系統図・テンプレートを、既存アプリの機能とデータ形式に接続して確認した。Product Designの比較・操作検証を実施し、確認範囲で未解決のP0・P1・P2はない。実アカウントでの画像生成は今回の検証範囲に含めていない。

## 比較した原案

原案は以下の画像。すべて1487 × 1058 px。

- 制作：`/Users/suzukiyuto/.codex/generated_images/01a0fbee-19ad-7c90-a8c2-2acda142d31e/exec-4e563db3-1252-4b37-925c-a2be2f664c96.png`
- 履歴：`/Users/suzukiyuto/.codex/generated_images/01a0fbee-19ad-7c90-a8c2-2acda142d31e/exec-3d644b29-8a9c-4f79-863a-a524d1a3c4f4.png`
- 系統図：`/Users/suzukiyuto/.codex/generated_images/01a0fbee-19ad-7c90-a8c2-2acda142d31e/exec-03c49561-7150-473c-89a7-5fa20f725ff6.png`
- テンプレート：`/Users/suzukiyuto/.codex/generated_images/01a0fbee-19ad-7c90-a8c2-2acda142d31e/exec-bfda5f21-fc15-4f1e-b898-35d89931aca0.png`

比較画像は原案を1440 × 1024 pxへ等比縮小し、比率の端数だけ中央で切り揃えた。実装のデスクトップ画像はCSSビューポート1440 × 1024、DPR 1、画像も1440 × 1024 px。左右を同じ大きさで一枚に配置し、全体の領域配分と、文字が読める切り出しを別々に確認した。WebPはレビュー用の形式変換で、画面の内容を描き直していない。

| 画面 | 原案と実装の比較 | 実装 |
| --- | --- | --- |
| 制作 | [左右比較](design-evidence/compare-create-final.webp)・[入力欄の比較](design-evidence/compare-create-content.webp) | [デスクトップ](design-evidence/create-desktop.webp) |
| 履歴 | [左右比較](design-evidence/compare-history-final.webp)・[詳細の比較](design-evidence/compare-history-detail.webp) | [デスクトップ](design-evidence/history-desktop.webp) |
| 系統図 | [左右比較](design-evidence/compare-lineage-final.webp)・[詳細の比較](design-evidence/compare-lineage-detail.webp) | [デスクトップ](design-evidence/lineage-desktop.webp) |
| テンプレート | [左右比較](design-evidence/compare-templates-final.webp)・[一覧の比較](design-evidence/compare-templates-content.webp) | [本文](design-evidence/templates-desktop.webp)・[履歴と差分](design-evidence/templates-history.webp) |

ナビゲーションの切り出しも各画面の `compare-*-navigation.webp` に保存した。原案の正規化コピーは `source-*-normalized.webp` にある。

## 表示データの違いと実装上の判断

検証は独立した一時データフォルダと偽CLIを使った。画面の森の写真は検証専用の素材で、プロダクトの固定画像として組み込んでいない。原案と画像、日時、タイトル、版番号、生成条件は異なる。原案の文字や写真が完全一致するという評価はしていない。

- 制作はテンプレート未選択・参照1枚・4枚生成済みの状態。原案にはテンプレート2件がある。選択時は版番号付きチップになる。
- 履歴は完成7枚／全10枚で、個別生成と2枚・4枚のバッチが混在する。検索・絞り込みと右の詳細を確認した。原案の先頭4枚バッチとは並びが異なる。
- 系統図は「鮮やか」で検索し、該当1枚と元画像を含む4ノードを表示。実線の複数参照と破線の入力再利用を実データから描画する。元データには10生成・1アップロードがあり、全体表示とズームも確認した。
- テンプレートは既存サンプル7件と選択したv2を表示。原案の9件・v3とは件数と版が異なる。
- 枚数は1〜10のSelect、参照画像は役割を変更できる行で表示する。既存の選択肢を維持し、小さい画面でも操作できる構成にした。
- 詳細は長いプロンプトや既存の注釈・参照関係を収めるためにスクロール可能。主操作を上に置き、追加操作をメニューとAccordionに収めた。

## 検証で修正した問題

| 段階 | 問題 | 重要度 | 修正と再確認 |
| --- | --- | --- | --- |
| 初回比較 | 制作の見出し・入力領域・画像とサムネイルの大きさが原案から外れていた | P2 | 共通ヘッダー、416pxの入力パネル、3:2のプレビュー枠、4枚の大きいサムネイルに調整。[初回](design-evidence/create-desktop-initial.webp)→[修正後](design-evidence/create-desktop.webp) |
| 初回比較 | ダウンロードが重複し、詳細の操作群が長く設定を押し下げていた | P2 | ダウンロードを一本化。履歴は参照追加と入力復元、系統図は参照して編集と参照追加を主操作にした。[初回](design-evidence/history-desktop-initial.webp)→[修正後](design-evidence/history-desktop.webp) |
| 操作確認 | 小さい幅でテンプレートのナビゲーション名が欠けた | P1 | 4等分したアイコンと文字の縦配置に変更。320px幅で全ラベルと生成操作を確認 |
| 操作確認 | キャンセル済みジョブのerrorがnullだと結果表示が例外になった | P1 | nullの判定を追加。3枚の停止後にキャンセル表示と入力保持を確認。回帰テストを追加 |
| 操作確認 | バッチの残りが1枚になると一括停止を表示できず、欠けた兄弟の番号が詰まった | P1 | 選択画像の状態に依存せず残件数で停止を表示。実際のbatch.indexを使用。回帰テストを追加 |
| 操作確認 | ポーリングと生成要求が重なると直前の画像が一時的に再選択された | P2 | 受付済み結果を即時反映し、変更後は進行中の取得を待って新しく取得するようにした |
| 操作確認 | プレビューの参照操作後もダイアログが残った | P2 | 制作への移動時に閉じるように修正。参照追加後、入力を保持して制作が見えることを確認 |
| 操作確認 | 参照選択の一時キャッシュから削除済みアップロードが再表示され得た | P1 | サーバー側で受け取った画像を一時キャッシュから外す。削除と復元を確認 |
| 操作確認 | 下流削除の確認画面で各画像のタイトルを正しく表示できなかった | P1 | 削除計画専用の型で表示。3生成・1アップロードの計画と4件復元を確認。[確認画面](design-evidence/delete-confirm.webp) |
| 防御的確認 | localStorageのアクセス自体が拒否されると初期表示できない可能性があった | P1 | getterも例外処理の中へ移動し、保存が使えない状態のテストを追加 |
| 最終比較 | OSのダーク設定がライトのトークンと混ざり、入力欄が灰色になった | P2 | dark variantを明示的なクラス方式へ変更。ライトの配色と16pxの入力文字をcomputed styleと画像で再確認 |
| 最終比較 | テンプレート名・本文抜粋の文字が小さく、選択タブが枠で表示された | P2 | 名前16px・抜粋14pxと選択行の左線を追加。タブを下線表示に変更。[修正後](design-evidence/compare-templates-content.webp) |

本文色は#18181b、補助文字は#52525bを使用。デスクトップのナビゲーションは16px、プロンプト入力は16px。フォーカスの枠を表示し、図の背景はキーボードでも移動できる。原案のアイコンの細部やブラウザー依存の字形はP3の差として残る。

## 操作・画面幅の確認

ブラウザーで制作→履歴→系統図→テンプレートを往復し、編集した下書きが保持されることを確認した。履歴から元の入力を読み込み、再読み込み後にも「元に戻す」で以前の下書きへ戻れる。単に参照へ追加する操作では現在の入力を置き換えない。

テンプレート選択と管理の分離、編集のv2保存、v1を使った下書きの保持、本文差分、参照選択の取消と反映、PNGアップロード、拡大表示、系統図の祖先保持検索、下流削除の確認と復元、3枚生成と一括キャンセルをブラウザーで確認した。競合時の入力保持・過去版の利用・復元・アーカイブ・元設定での再生成・CSRFの再取得は画面／APIテストでも確認した。

| CSSビューポート | 確認内容 | 画像 |
| --- | --- | --- |
| 390 × 844 | 制作、4画面の移動、固定した生成操作、テンプレート一覧と詳細、履歴の詳細Sheet | [制作](design-evidence/create-mobile.webp)・[テンプレート一覧](design-evidence/templates-mobile.webp)・[本文](design-evidence/templates-mobile-detail.webp)・[履歴Sheet](design-evidence/history-mobile-detail.webp) |
| 320 × 844 | 4ナビゲーションの文字の折り返し、横にはみ出さない入力と生成操作 | [制作](design-evidence/create-mobile-320.webp) |
| 720 × 512 | 1440px幅の200%表示に相当する再配置で、スクロールしながら入力と生成操作を使える | [再配置](design-evidence/create-reflow.webp) |

720 × 512はビューポートによる再配置の確認で、ブラウザーのズームそのものを変更した検証ではない。DPRは1。モバイルの画像はCodexのプレビュー領域で等比縮小されるため、CSSビューポートとPNG/WebPのピクセル寸法が異なる。横スクロールの検査では390px幅のscrollWidthは375、320px幅は305、720px幅は705で、いずれも表示幅以内だった。

最終版のコンソールで新規のerror・warnは確認されなかった。途中のキャンセル表示エラーは修正前のbundleのログとして残っており、修正後のbundleと回帰テストで再発しないことを確認した。

## 自動検証と実行上の制約

- `npm run check`：JavaScript構文、TypeScript、Viteビルドが成功。
- `npm test`：既存のNodeテスト164件、Vitestの画面／下書き／APIテスト43件がすべて成功。
- `git diff --check`：成功。
- テストのHTTPサーバーはsandbox内ではlistenが拒否されるため、ローカルHTTPを許可した実行で全件成功を確認した。

実アカウントの生成権限・利用枠・実画像の品質は未検証。生成・認証・保存のバックエンドを維持し、公式Codex CLIのapp-serverを利用する。認証ファイルの直接読取やAPI課金への自動切替は追加していない。起動にはNode.js 22.12以上が必要で、初回は `npm ci`、その後は `npm run dev`。起動時にフロントエンドをビルドする。
