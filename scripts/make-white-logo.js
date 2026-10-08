// One-off: produce a solid-white version of the logo (keeping its alpha channel as the
// shape mask), for use directly on the dark navy brand panel without a white box behind it.
const sharp = require("sharp");
const path = require("path");

const OUT_DIR = path.join(__dirname, "..", "public", "images");

async function makeWhite(srcFile, outFile) {
  const src = path.join(OUT_DIR, srcFile);
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  for (let i = 0; i < data.length; i += channels) {
    data[i] = 255; // R
    data[i + 1] = 255; // G
    data[i + 2] = 255; // B
    // alpha (data[i+3]) untouched — preserves the shape mask
  }
  await sharp(data, { raw: { width, height, channels } })
    .png({ compressionLevel: 9 })
    .toFile(path.join(OUT_DIR, outFile));
  console.log("Wrote", outFile);
}

(async () => {
  await makeWhite("logo.png", "logo-white.png");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
