# flipboard

```
deno task start
```

http://localhost:8000 を開く。ポートは環境変数 `PORT` で変更できる。

部屋の状態はメモリ上にのみ保持する。Deno Deploy に置く場合はアプリの Deployment Region を `us` か `eu` のどちらか一方に固定する。
