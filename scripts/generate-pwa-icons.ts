/**
 * PWA icon generator
 *
 * Derives every installable-app icon from the 4500px crest at `public/logo.png`.
 *
 * Usage: npm run pwa:icons
 *
 * The crest is transparent and runs almost edge to edge, so it can't be used as-is everywhere:
 * - Android "maskable" icons are cropped to a circle/squircle that keeps only the centre 80%, so
 *   the crest is shrunk to ~70% and laid on a solid plate.
 * - iOS renders transparency on home-screen icons as black, so the apple-touch-icon gets the
 *   same solid plate.
 * The outputs are committed; re-run only when the crest changes.
 *
 * `sharp` is not a direct dependency — it ships with Next for image optimisation and is resolved
 * from node_modules here.
 */

import sharp from "sharp";
import { mkdirSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "public", "logo.png");
const ICON_DIR = path.join(ROOT, "public", "icons");

/** slate-900 — the nav surface and the start/end colour of every page gradient. */
const PLATE = { r: 15, g: 23, b: 42, alpha: 1 };
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

/** The crest scaled to `size` square, transparent around it. */
async function crest(size: number): Promise<Buffer> {
  return sharp(SOURCE)
    .resize(size, size, { fit: "contain", background: TRANSPARENT })
    .png()
    .toBuffer();
}

/** The crest at `scale` of `size`, centred on a solid slate plate. */
async function plated(size: number, scale: number): Promise<sharp.Sharp> {
  const inner = Math.round(size * scale);
  return sharp({ create: { width: size, height: size, channels: 4, background: PLATE } }).composite([
    { input: await crest(inner), gravity: "centre" },
  ]);
}

async function main() {
  mkdirSync(ICON_DIR, { recursive: true });

  const outputs: Array<[string, Promise<sharp.Sharp>]> = [
    [path.join(ICON_DIR, "icon-192.png"), crest(192).then((b) => sharp(b))],
    [path.join(ICON_DIR, "icon-512.png"), crest(512).then((b) => sharp(b))],
    // 70% keeps the crest inside the 80% maskable safe zone with a little air.
    [path.join(ICON_DIR, "maskable-512.png"), plated(512, 0.7)],
    [path.join(ICON_DIR, "maskable-192.png"), plated(192, 0.7)],
    // iOS rounds the corners itself and shows no mask, so the crest can sit larger.
    [path.join(ROOT, "src", "app", "apple-icon.png"), plated(180, 0.84)],
    // The favicon/`<link rel="icon">` Next emits from this file was the raw 4500px crest (~300 KB).
    [path.join(ROOT, "src", "app", "icon.png"), crest(512).then((b) => sharp(b))],
  ];

  for (const [file, pipeline] of outputs) {
    await (await pipeline).png({ compressionLevel: 9 }).toFile(file);
    console.log(`  ✓ ${path.relative(ROOT, file)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
