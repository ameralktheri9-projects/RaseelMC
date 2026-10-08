// One-off: convert the high-res JPG logo/icon assets (flat light-grey background,
// no alpha) into trimmed, transparent PNGs. Chroma-keying alone would also wipe out
// the logo's internal white accent lines, so this flood-fills transparency inward
// from the image border only — pixels matching the background color that are NOT
// connected to the border (i.e. the white details enclosed within the blue shape)
// stay opaque.
const sharp = require("sharp");
const path = require("path");

const SRC_DIR = "C:\\Users\\amera\\AppData\\Local\\Temp\\claude\\C--Users-amera-Projects-raseel-mc\\835a5bc0-f689-4e91-894b-f353d20195b8\\images\\";
const OUT_DIR = path.join(__dirname, "..", "public", "images");

async function makeTransparent(srcFile, outFile, maxWidth, tolerance = 18) {
  const { data, info } = await sharp(SRC_DIR + srcFile)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const idx = (x, y) => (y * width + x) * channels;
  const bg = [data[idx(0, 0)], data[idx(0, 0) + 1], data[idx(0, 0) + 2]];
  const dist = (x, y) => {
    const o = idx(x, y);
    const dr = data[o] - bg[0], dg = data[o + 1] - bg[1], db = data[o + 2] - bg[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };

  const visited = new Uint8Array(width * height);
  const stack = [];
  for (let x = 0; x < width; x++) { stack.push([x, 0]); stack.push([x, height - 1]); }
  for (let y = 0; y < height; y++) { stack.push([0, y]); stack.push([width - 1, y]); }

  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const vIdx = y * width + x;
    if (visited[vIdx]) continue;
    if (dist(x, y) > tolerance) continue;
    visited[vIdx] = 1;
    data[idx(x, y) + 3] = 0; // alpha = 0
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }

  await sharp(data, { raw: { width, height, channels } })
    .trim()
    .resize({ width: maxWidth, withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toFile(path.join(OUT_DIR, outFile));
  const meta = await sharp(path.join(OUT_DIR, outFile)).metadata();
  const stat = require("fs").statSync(path.join(OUT_DIR, outFile));
  console.log(outFile, meta.width + "x" + meta.height, Math.round(stat.size / 1024) + "KB");
}

(async () => {
  // Max CSS display width in the UI is 160px (sidebar brand box); 700/500px source
  // comfortably covers retina (3x+) density while keeping file size reasonable.
  await makeTransparent("13.jpg", "logo.png", 700); // wide horizontal lockup — main logo
  await makeTransparent("12.jpg", "icon.png", 500); // icon only — favicon / compact spaces
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
