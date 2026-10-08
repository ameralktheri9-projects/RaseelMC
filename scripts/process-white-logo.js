// One-off: trim and optimize the user-supplied white logo (already correct color,
// just needs the transparent padding trimmed and the file size kept reasonable).
const sharp = require("sharp");
const path = require("path");

const SRC = "C:\\Users\\amera\\AppData\\Local\\Temp\\claude\\C--Users-amera-Projects-raseel-mc\\835a5bc0-f689-4e91-894b-f353d20195b8\\images\\17.png";
const OUT = path.join(__dirname, "..", "public", "images", "logo-white.png");

(async () => {
  await sharp(SRC)
    .trim()
    .resize({ width: 700, withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toFile(OUT);
  const meta = await sharp(OUT).metadata();
  console.log("Wrote", OUT, meta.width + "x" + meta.height);
})();
