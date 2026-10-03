# newsflow — ニュース連続再生デジタルサイネージ

Ubuntu 26.04 LXD コンテナ内で RSS からローカルニュースを定期収集し、
ブラウザの Web Speech API で日本語 TTS として24時間ノンストップで読み上げる
フルスクリーン・サイネージの MVP です。

- バックエンド: Node.js + Express、`127.0.0.1:3364` で待受、15分ごとに RSS 取得・都道府県仕分け
  （外部公開は Tailscale Serve の HTTPS 経由）
- フロント: `public/index.html`（単一ファイル、黒背景・白文字・特大フォント）
- API: `GET /api/news`（§4.2.2 固定契約）、`GET /api/health`

## 1. Node.js の確認

```bash
node -v   # v22.23.3 を確認
npm -v    # 10.9.9 を確認
# 未導入の場合（参考）:
sudo apt-get update && sudo apt-get install -y nodejs npm
```

## 2. インストール

```bash
git clone https://github.com/hirogura/newsflow.git /opt/newsflow
cd /opt/newsflow
npm install   # postinstall で data/ を自動作成（無ければ作成。登録フィードは .gitignore で除外）
```

## 3. 起動

```bash
cd /opt/newsflow
PORT=3364 npm start
# 常駐させる場合
nohup env PORT=3364 npm start > /var/log/newsflow.log 2>&1 &
```

## 4. systemd 常駐化（24時間運用）: `/etc/systemd/system/newsflow.service`

実際に設置している unit と同一内容（`User=` は指定しない。root 実行のまま `data/` へ書き込む運用）:

```ini
[Unit]
Description=Newsflow digital signage (local news TTS)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/newsflow
Environment=PORT=3364
ExecStart=/usr/bin/node /opt/newsflow/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now newsflow
sudo systemctl --no-pager --full status newsflow
systemctl is-enabled newsflow   # => enabled
systemctl is-active newsflow    # => active
journalctl -u newsflow -n 30 --no-pager
# ログを追いかける場合
journalctl -u newsflow -f
# 自動復旧の確認（kill -9 しても Restart=always で数秒以内に復帰する）
MAINPID=$(systemctl show -p MainPID --value newsflow); echo "pid=$MAINPID"
sudo kill -9 "$MAINPID"; sleep 8
systemctl show -p MainPID --value newsflow   # => 新しい PID（元と異なる）
```

## 5. コンテナ内での確認

```bash
curl -s http://127.0.0.1:3364/api/health
curl -s http://127.0.0.1:3364/api/news | head -c 400
```

## 6. ブラウザで閲覧

- `https://<tailnet-host>:3364/` をブラウザで開きます（Tailscale Serve 経由の HTTPS 公開。手順は下記参照）。
- トップ画面の版表示 `v.1.0.0` のほか、「ニュース再生を開始する」ボタンの下に
  小さな「設定/RSSフィード管理」「アップデート」「再起動」ボタンを用意しています。

開いたら「ニュース再生を開始する」ボタンをクリックしてください
（ブラウザの自動再生規制のため1回クリックが必要です）。

## 7. ポート開放

コンテナ内 ufw は inactive のため原則不要です。
有効化している場合のみ:

```bash
sudo ufw allow 3364/tcp
```

LXD でホスト側ポートへプロキシする場合（**ホストで実行**、`<container>` はコンテナ名）:

```bash
lxc config device add <container> newsflow proxy listen=tcp:0.0.0.0:3364 connect=tcp:127.0.0.1:3364
```

## 7b. Tailscale Serve での公開（HTTPS）

サーバーは `127.0.0.1:3364` のみで待受するため、Tailnet 内からの HTTPS アクセスは
Tailscale Serve 経由で行います（`--bg` でバックグラウンド永続化）:

```bash
tailscale serve --bg --https=3364 http://127.0.0.1:3364
```

```bash
# 確認（3364 が追加され、既存の他ポートが残っていること）
tailscale serve status
curl -sk https://<tailnet-host>:3364/api/health
```

注意事項:

- 他ポートの公開には触れません。`tailscale serve reset` は実行しないでください
  （全ポートの公開が消えます）。
- 公開の停止は `tailscale serve --https=3364 off` です（3364 のみ停止。他ポートは維持）。

## 8. ブラウザ側 TTS の前提（音声が出ない場合の対処）

ブラウザが動作するマシンで日本語音声基盤を導入してください。

```bash
# Debian/Ubuntu
sudo apt-get install -y speech-dispatcher espeak-ng
# Arch 系
sudo pacman -S speech-dispatcher espeak-ng
```

導入後ブラウザを再起動してください。
`chrome://settings` の「音声合成」または OS の音声設定で
日本語音声が有効か確認してください。

## 補足: 既知の制約・改善余地

- 都道府県判定は部分一致のため誤検知があり得ます
  （例: 姓としての「山口」「香川」「長野」「石川」「千葉」）。MVP では許容します。
- ただし「東京都」→「京都府」の誤判定のみは必須で回避しています
  （京都府の判定に `/(?<!東)京都/` を使用）。
- 本文取得に失敗した記事はタイトルのみ読み上げます（サーバーは落とさず継続）。
  `og:description` / `meta[name=description]` が無いページでは `<p>` 抽出に
  フォールバックしますが、ナビ・メニュー等のノイズが混じる場合があります。
- 類似判定は閾値依存です。過剰統合（別ニュースの統合）や未統合があれば
  `areSimilarTitles()` の複合ルール（内容語トークンの Jaccard＋包含率）と
  `isDateNumericToken()` の除外集合で調整してください。
  日付・数字トークン（例: `10月` `1日`）だけの一致では統合されません。

## RSS 管理画面

- `http://<host>:3364/admin.html` をブラウザで開きます（Tailscale Serve 経由の場合は
  `https://<tailnet-host>:3364/admin.html`。サイネージのヘッダー「RSS管理」リンクや
  トップの「設定/RSSフィード管理」ボタンからも移動可）。
- 登録中のフィード一覧（取得状態 OK/失敗・件数・無効表示・種別 RSS/Webサイト）、追加フォーム（名前・URL）、
  削除ボタン（確認後に削除）、各フィード行の「再取得」ボタン（`POST /api/feeds/:id/refresh` で個別再取得）、
  「今すぐ再取得する」ボタン（`POST /api/feeds/refresh` で一括再取得）を提供します。
- Webサイト追加（v2.4.0〜）：RSSを配信していないサイトは「Webサイトを追加」からトップページ等の
  URLを登録すると、記事リンクを自動抽出（同一ホスト・最大50件）して取得します
  （例: `https://example.com/news/`）。本文・写真は記事ページから追いかけ取得します。
- 話題別フィード：特定のURLのフィードは、タイトル中の地名にかかわらず話題バケット
  （「国際」「IT」「科学」「海外」）に振り分けられ、地域ニュースの後に再生されます。
- フィード定義は `data/feeds.json` に永続化されます。削除時は store をクリアして
  再取得するため、削除したフィード由来の記事は一覧から消えます（件数は取得周期で回復）。
- 登録フィード（`data/feeds.json` 等の個人データ）は `.gitignore` で除外されており、
  リポジトリにはコミットされません。初期状態はフィード未登録（空）です。
  利用者自身で管理画面または `POST /api/feeds` で追加してください。
- エクスポート: `GET /api/feeds/export`（管理画面のボタンで JSON 保存）。
- インポート: `POST /api/feeds/import`（`{ feeds, mode: "replace"|"merge" }`）。
- 表示・読み上げ設定: `GET/PUT /api/settings`
  （取得間隔 5〜180分 / N時間以内の表示 1〜168時間 / 読み上げ On-Off / 速度5段階 0.8,1.0,1.2,1.4,1.6 / 画面テーマ dark・light・light-modern）。
  テーマはサーバーに保持され、サイネージ画面と管理画面の両方に反映されます。

## トップ画面の操作ボタン

- 「設定/RSSフィード管理」: `/admin.html` を表示します。
- 「アップデート」: `POST /api/update` で `git pull` → `npm install` → サービス再起動を
  実行します（再起動時に自動再取得）。完了まで数十秒かかるため、画面の案内に従ってリロードしてください。
- 「再起動」: `POST /api/restart` で systemd サービス `newsflow` を再起動します。
- 制御系 API は環境変数 `DISABLE_CONTROL=1` で無効化できます（無効時は 403 を返します）。
- バージョンは `GET /api/version`（`{ version, display: "v.1.0.0" }`）でも取得できます。

## ライセンス

MIT License (Copyright (c) 2026 hirogura)。詳細は `LICENSE` を参照してください。

## 操作方法（サイネージ画面）

- 開いたら「ニュース再生を開始する」をクリック（ブラウザの自動再生規制のため1回必要）。
- `→` キーで次の記事へスキップ、`←` キーで前の記事へ戻ります（連打可。手動移動後も自動再生を継続）。
- ヘッダーの `⏸` で一時停止、`▶` で再開します（再開は現在の記事の先頭から読み直し。`スペース` キーでも切替可）。
- ヘッダーの「RSS管理」の右にある「タイトル」はトップページ（`/`）へのリンクです。
- 再生中は約60秒ごとに `/api/news` を取得し、新着記事だけを現在位置の数個先に差し込みます（再生位置は動きません）。
- 右ペインのタイトル一覧は読み上げ中の行がハイライトされ、常に中央付近に自動スクロールします。
- 左ペイン中央に都道府県バッジ・タイトル・本文（長い場合は省略表示）・媒体/日時・関連記事を表示し、
   「タイトル。本文3行程度」を読み上げます（都道府県名・【...】で囲まれた部分は画面表示のみで読み上げません）。
- 記事に写真がある場合はタイトル下に表示します（RSSの画像・`og:image` 等。無い場合は表示なし）。

## 本文取得

- RSS には本文が無いため、記事ページを `fetch`（ブラウザ相当 UA・10秒タイムアウト・同時5件・ベストエフォート）して抽出しています。
  優先度: `og:description`（Yahooなど）→ `meta[name=description]`（47NEWSなど）→ JSON-LD `NewsArticle.description` → 長めの `<p>`。
- 取得した本文は `link` をキーにキャッシュし、読み上げ用に先頭3文・上限文字数で丸めた
  `summary` / `bodyExcerpt` を `/api/news` で配信します。本文が無い記事はタイトルのみ読み上げます。
- 環境変数 `BODY_FETCH=0` で記事本文の取得を無効化できます。

## 緊急地震速報 (EEW / Wolfx Open API)

- サーバーが Wolfx Open API の WebSocket（既定 `wss://ws-api.wolfx.jp/jma_eew`、気象庁の緊急地震速報）を購読します。
  追加の依存パッケージは不要です（Node 標準のグローバル `WebSocket` を使用）。
- heartbeat 受信時は `pong` を返し、切断時は指数バックオフ（5秒→最大60秒）で再接続します。
  約50秒ごとに `ping` を送り、heartbeat が3分以上途絶えた場合も張り直します。
- 受信した速報は正規化 (`normalizeEew`) のうえ、ブラウザへ SSE (`GET /api/eew/stream`、`EventSource` で購読) で push します。
  メイン画面は受信時に画面最上部へ警告バー (`#eewBar`、震源・最大震度・マグニチュード等) を表示し、受信から1分後に自動で消します。
- `GET /api/eew` で最新状態（接続状態・最終 heartbeat・最新の速報）を取得できます。
- `POST /api/eew/mock` で模擬発報ができます（表示確認用。制御系 API と同じく `DISABLE_CONTROL=1` で無効化）。
  例: `curl -X POST http://127.0.0.1:3364/api/eew/mock`

## 類似記事グループ化

- タイトル類似度は内容語トークン（文字バイグラム＋語彙。日付・時刻・数字のみのトークンは除外）の
  Jaccard 係数 `J` と包含率 `cont` の複合ルール `areSimilarTitles()` で判定します。
  完全一致・8文字以上の包含・同一 link は類似とみなします。
- グループ化は貪欲クラスタリング（代表との比較のみ。連鎖巨大クラスタなし）で行い、
  再生用 `playlist` は同一 `groupId` が連続しないよう分散配置します（`interleaveAvoidSameGroup`）。
- 調整方法: `SIMILARITY_THRESHOLD` 環境変数ではなくコード内の複合ルール
  （`j >= 0.3` / `j >= 0.12 && cont >= 0.24 && inter >= 3`＋内容語 2 件以上の必須条件）の
  閾値・件数を変更し、`npm test` と本番 `groups` の全走査で確認します。

## 環境変数一覧

| 変数 | 既定 | 意味 |
|---|---|---|
| `PORT` | `3364` | 待受ポート |
| `FETCH_INTERVAL_MS` | `900000` | 取得間隔（15 分。現行はコード内定数） |
| `MAX_PER_PREF` | `10` | 県あたり保持件数（現行はコード内定数） |
| `BODY_FETCH` | `1` | 記事本文の取得（`0` で無効。現行は常時取得） |
| `BODY_READ_CHARS` | `220` | 読み上げ本文の最大文字数（3 行相当の目安） |
| `SIMILARITY_THRESHOLD` | `0.5` | 類似判定しきい値の目安（現行は複合ルールで等価管理） |
| `BODY_CACHE_MAX` | `2000` | 本文キャッシュ最大件数（現行は 1000 件で古いものから破棄） |
| `EEW_ENABLED` | `1` | 緊急地震速報の購読（`0`/`false`/`off`/`no` で無効。既定は有効） |
| `EEW_WS_URL` | `wss://ws-api.wolfx.jp/jma_eew` | EEW 購読先の WebSocket URL |

## アンインストール

```bash
# 1. Tailscale Serve の公開を停止（3364 のみ。他ポートは維持）
tailscale serve --https=3364 off
tailscale serve status   # 3364 が消え、他ポートが残っていることを確認

# 2. systemd サービスの停止・無効化・unit 削除
sudo systemctl disable --now newsflow
sudo rm /etc/systemd/system/newsflow.service
sudo systemctl daemon-reload

# 3. LXD プロキシを設定していた場合（ホストで実行）
lxc config device remove <container> newsflow

# 4. ufw で開放していた場合
sudo ufw delete allow 3364/tcp

# 5. 本体とログの削除
sudo rm -rf /opt/newsflow
sudo rm -f /var/log/newsflow.log
```

注意事項:

- `tailscale serve reset` は使わないでください（他サービスの公開まで消えます）。
- Tailscale 本体は他サービスが使っているため残します。
- `data/feeds.json` 等の登録データは `.gitignore` 対象の個人データです。
  残したい場合は削除前に `GET /api/feeds/export` でエクスポートしてください。
