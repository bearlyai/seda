import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const packageManager = process.env.npm_execpath;
if (!packageManager) {
  throw new Error("Run this check through pnpm.");
}

const rootPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const clientPackage = JSON.parse(await readFile(new URL("../packages/client/package.json", import.meta.url), "utf8"));
const packageManagerVersion = rootPackage.packageManager;
const packageVersion = clientPackage.version;
const directory = await mkdtemp(join(tmpdir(), "seda-package-install-"));
const packedDirectory = join(directory, "packed");

const runPnpm = (args, cwd = new URL("..", import.meta.url)) => {
  const result = spawnSync(process.execPath, [packageManager, ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error([result.stdout, result.stderr].filter(Boolean).join("\n"));
  }
};

try {
  await mkdir(packedDirectory);
  for (const packageName of [
    "@bearlyai/seda",
    "@bearlyai/seda-browser",
    "@bearlyai/seda-node",
  ]) {
    runPnpm(["--filter", packageName, "pack", "--pack-destination", packedDirectory]);
  }

  const packages = ["bearlyai-seda", "bearlyai-seda-browser", "bearlyai-seda-node"];
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify(
      {
        name: "seda-package-install-check",
        private: true,
        type: "module",
        packageManager: packageManagerVersion,
        dependencies: Object.fromEntries(
          packages.map((name) => [
            name === "bearlyai-seda"
              ? "@bearlyai/seda"
              : `@bearlyai/${name.replace("bearlyai-seda-", "seda-")}`,
            `file:${join(packedDirectory, `${name}-${packageVersion}.tgz`)}`,
          ]),
        ),
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(directory, "pnpm-workspace.yaml"),
    "blockExoticSubdeps: true\nstrictDepBuilds: true\n",
  );

  runPnpm(["install"], directory);
  const imported = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'await Promise.all([import("@bearlyai/seda"), import("@bearlyai/seda-browser"), import("@bearlyai/seda-node")]);',
    ],
    { cwd: directory, encoding: "utf8", stdio: "pipe" },
  );
  if (imported.status !== 0) {
    throw new Error([imported.stdout, imported.stderr].filter(Boolean).join("\n"));
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
