// Rasterizes the SVG logo sources in public/icons into the PNGs referenced by the manifest and <head>.
//   pnpm -F @hostidian/web icons
// Dev-only (needs `sharp`); the generated PNGs are committed so builds need no image tooling.
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const dir = new URL("../public/icons/", import.meta.url);
const any = await readFile(new URL("icon.svg", dir));
const maskable = await readFile(new URL("icon-maskable.svg", dir));

/** [output file, SVG source, size in px]. Apple ignores transparency (it would turn black), so its icon is full-bleed. */
const targets = [
  ["icon-192.png", any, 192],
  ["icon-512.png", any, 512],
  ["icon-maskable-512.png", maskable, 512],
  ["apple-touch-icon.png", maskable, 180],
  ["favicon-32.png", any, 32],
  ["favicon-16.png", any, 16],
];

// Next.js serves src/app/icon.svg as the favicon; keep it identical to the logo source.
await copyFile(new URL("icon.svg", dir), new URL("../../src/app/icon.svg", dir));

for (const [name, svg, size] of targets) {
  // High density first, then downscale: sharp otherwise rasterizes at 72 dpi and small sizes look soft.
  const png = await sharp(svg, { density: Math.ceil((72 * Math.max(size, 512)) / 512) * 4 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(new URL(name, dir), png);
  console.log(`${fileURLToPath(new URL(name, dir)).split("/public/")[1]}  ${size}x${size}  ${png.length} bytes`);
}
