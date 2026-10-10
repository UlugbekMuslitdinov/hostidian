// Copies the emoji data the picker needs from the `emojibase-data` devDependency into public/emoji, so the app
// serves it itself. frimousse (the emoji picker) otherwise downloads it from cdn.jsdelivr.net at runtime, which
// would make a self-hosted install talk to a third party and fail offline.
//
//   pnpm -F @hostidian/web emoji
//
// Dev-only; the generated files are committed so builds need nothing but the repo. Re-run after bumping
// `emojibase-data`. The picker is English-only, so only the `en` locale is copied. The service worker precaches
// everything in public/ (see app/serwist/[path]/route.ts), which is what makes the picker work offline.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageDir = dirname(require.resolve("emojibase-data/package.json"));
const outDir = fileURLToPath(new URL("../public/emoji/", import.meta.url));
const LOCALES = ["en"];
const FILES = ["data.json", "messages.json"];

for (const locale of LOCALES) {
  await mkdir(join(outDir, locale), { recursive: true });
  for (const file of FILES) {
    // Round-trip through JSON.parse/stringify: validates the file and strips whitespace.
    const json = JSON.parse(await readFile(join(packageDir, locale, file), "utf8"));
    const text = JSON.stringify(json);
    await writeFile(join(outDir, locale, file), text);
    console.log(`emoji/${locale}/${file}  ${text.length} bytes`);
  }
}
// MIT requires the notice to travel with the data.
await copyFile(join(packageDir, "LICENSE"), join(outDir, "LICENSE.txt"));
const { version } = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
console.log(`emoji/LICENSE.txt  (emojibase-data ${version})`);
