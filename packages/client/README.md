# `@bearlyai/seda`

Typed client for an authenticated local Seda service.

```ts
import { Seda } from "@bearlyai/seda";

const seda = await Seda.connect({
  baseUrl: service.address,
  token: service.token,
});

const session = await seda.listen({ language: "en" });
session.on("transcript", (update) => editor.show(update));

const final = await session.commit();
```

The client works in modern browsers and Node 22+. Applications using an older
Node runtime can inject a WebSocket implementation with `webSocket`.
