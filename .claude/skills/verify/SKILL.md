---
name: verify
description: Fusen の変更をローカルで起動して実際に動かして確認する手順(wrangler dev + ブラウザ操作)
---

# Fusen 動作検証手順

## 起動

```bash
npm run dev        # wrangler dev、http://localhost:8787 で起動(数秒で Ready)
```

- ローカル D1(.wrangler/state)はシード済みのことが多い。空なら `npm run cf:seed:gen && npm run cf:migrate:local && npm run cf:seed:local`
- `.dev.vars` の SESSION_SECRET が必要(無いとログイン500)

## 操作フロー

1. http://localhost:8787/ を開く。未ログインなら /login へ飛ぶので名前を入れて「はじめる」(パスワード不要)
2. **注意: ゲストユーザーでログインしているとダッシュボードのキャンバス一覧は常に空**(IDOR対策の仕様)。一覧が空で「まだキャンバスがありません」と出たら、まずログアウト→メンバー名でログインし直す
3. キャンバス作成: 「+ 新しいキャンバス」→ URL は https://example.com が軽くて確実(check-url が通る)
4. コメント投稿: カードクリック → /p/<id> のオーバーレイ → ツールバー「コメント」モード → ページ上をクリック → 本文入力 →「ペタッと貼る」。返信・解決はピンをクリックしたスレッドポップオーバーから
5. ダッシュボードのカードのアクションボタン(共有/CSV/アーカイブ)は**ホバーで表示**

## 検証時の注意

- curl での localhost 疎通確認は権限で弾かれることがある。readiness は wrangler のログ(`Ready on http://localhost:8787`)で確認し、操作はブラウザで行う
- トーストは2.6秒で消える。撮るならクリックと同一バッチで即スクリーンショット
- ~/Downloads はサンドボックスから読めない。ダウンロード内容の検証は、ページの JS コンテキストで同じ純関数(FsnCsvFormat / FsnIssueFormat)を実行して文字列を取得するのが確実
- ブラウザのウィンドウサイズが変わると座標クリックがずれる。find で ref を取って ref クリックが安定
