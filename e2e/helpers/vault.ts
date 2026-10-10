import { deflateSync } from "node:zlib";
import { zipSync, unzipSync, strFromU8, strToU8 } from "fflate";

/** A 1x1 red PNG: the smallest valid image, for upload and attachment tests. */
export const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * A larger solid-colour PNG (so screenshots show something). Generated, not stored: a single-colour image
 * compresses to almost nothing.
 */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const idat = deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array()),
  ]);
}

/** Build a zip from `{ "Folder/Note.md": "text" | Buffer }`, the way an Obsidian vault export looks. */
export function buildVault(files: Record<string, string | Uint8Array>): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) entries[name] = typeof content === "string" ? strToU8(content) : content;
  return Buffer.from(zipSync(entries));
}

/** Read a zip into `{ path: bytes }` (folders are omitted). */
export function readZip(zip: Buffer | Uint8Array): Record<string, Uint8Array> {
  return unzipSync(new Uint8Array(zip));
}

export function zipText(zip: Buffer | Uint8Array): Record<string, string> {
  return Object.fromEntries(
    Object.entries(readZip(zip))
      .filter(([name]) => name.endsWith(".md"))
      .map(([name, bytes]) => [name, strFromU8(bytes)]),
  );
}
