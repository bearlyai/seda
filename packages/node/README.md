# `@bearlyai/seda-node`

Lifecycle-managed Seda sidecar for Node and Electron main processes.

```ts
import { SedaNode } from "@bearlyai/seda-node";

await SedaNode.prepare({
  profile: "balanced",
  language: "en",
  onProgress: updateDownloadUI,
});

await using seda = await SedaNode.start({
  profile: "balanced",
  language: "en",
});

const session = await seda.listen();
session.on("transcript", (update) => {
  window.webContents.send("dictation:update", update);
});
```

The child process is launched without a shell, binds a random loopback port,
uses an ephemeral token, and is stopped by async disposal. Electron renderers
should receive application-specific IPC messages from the main process rather
than raw service credentials.
