// One-time build helper: copies only the Latin (IBM Plex Sans) and Arabic
// (IBM Plex Sans Arabic) subsets we actually need, weights 400/500/600, from
// the @fontsource packages into public/fonts/ as a single self-hosted
// stylesheet — avoids pulling in cyrillic/greek/vietnamese subsets we don't
// use, and avoids a Google Fonts CDN dependency (this app must work with no
// internet access on the clinic's internal network).
const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(__dirname, "..", "public", "fonts");
fs.mkdirSync(OUT_DIR, { recursive: true });

const jobs = [
  { pkg: "ibm-plex-sans", subset: "latin", family: "IBM Plex Sans" },
  { pkg: "ibm-plex-sans-arabic", subset: "arabic", family: "IBM Plex Sans Arabic" },
];

let combinedCss = "/* Self-hosted IBM Plex Sans / IBM Plex Sans Arabic (latin + arabic subsets only). */\n";

for (const { pkg, subset } of jobs) {
  for (const weight of [400, 500, 600]) {
    const cssPath = path.join(__dirname, "..", "node_modules", "@fontsource", pkg, `${subset}-${weight}.css`);
    let css = fs.readFileSync(cssPath, "utf-8");

    const filesDir = path.join(__dirname, "..", "node_modules", "@fontsource", pkg, "files");
    const fileRefs = [...css.matchAll(/url\(\.\/files\/([^)]+)\)/g)].map((m) => m[1]);
    for (const file of fileRefs) {
      fs.copyFileSync(path.join(filesDir, file), path.join(OUT_DIR, file));
    }
    css = css.replace(/\.\/files\//g, "./");
    combinedCss += `\n${css}`;
  }
}

fs.writeFileSync(path.join(OUT_DIR, "fonts.css"), combinedCss);
console.log("Wrote", path.join(OUT_DIR, "fonts.css"), "and", fs.readdirSync(OUT_DIR).length - 1, "font files.");
