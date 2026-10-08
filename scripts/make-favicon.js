// One-off: pad the trimmed icon.png onto a square transparent canvas and resize
// down to a sensible favicon size.
const sharp = require("sharp");
const path = require("path");

const SRC = path.join(__dirname, "..", "public", "images", "icon.png");
const OUT = path.join(__dirname, "..", "public", "images", "favicon.png");

(async () => {
  const meta = await sharp(SRC).metadata();
  const side = Math.max(meta.width, meta.height);
  await sharp(SRC)
    .resize(side, side, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .resize(256, 256)
    .png()
    .toFile(OUT);
  console.log("Wrote", OUT);
})();
