# flipboard

Web上で使えるフリップボードです。

## 使い方

https://flipboard.ruskrusk.workers.dev にアクセスする。

## 自分でビルドする場合

Cloudflare Workers + Durable Objects で動く。

```
npm install
npm run dev
```

http://localhost:8787 を開く。

公開は `npm run deploy`（初回のみ `npx wrangler login`）。
