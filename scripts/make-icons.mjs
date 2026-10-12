// language: JavaScript, file: scripts/make-icons.mjs
//
// The app icons, generated instead of committed as opaque binaries. Run it from
// hypercord/:
//
//   node scripts/make-icons.mjs
//
// It writes, and then re-reads to check:
//
//   build/icon.png    512x512 RGBA  - Linux (`build.linux.icon`) and the tray
//   build/icon.ico    multi-size    - Windows (`build.win.icon`)
//   build/icon.icns   multi-size    - macOS (`build.mac.icon`)
//
// Nothing here needs an image library or the network: a small PNG encoder
// (zlib.deflateSync + CRC32), the ICO container, and the icns container are all
// written by hand. The drawing is procedural too - one rounded black tile with a
// bold white "H" - so the logo cannot drift out of sync with a binary file
// nobody can diff, and re-running is byte-for-byte idempotent (which is why the
// PNGs carry no timestamp).
//
// The mark is black on purpose, and the H is white on purpose: on a black tile a
// dark mark would be invisible, so the contrast is carried by the letter. The rim
// is a fixed dark grey rather than the gradient's own edge lightened, because a
// tile that is black edge to edge would lose its silhouette on a black desktop
// background - the rim is the only thing that says where the tile stops.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const build = path.join(root, "build");

/* ---- CRC32 and the PNG container ---------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const type4 = Buffer.from(type, "latin1");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  type4.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([type4, data])), 8 + data.length);
  return out;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([PNG_MAGIC, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/* ---- the drawing: a rounded gradient tile with a bold H ------------------ */

// Everything is expressed in 0..1 of the tile, so the same geometry renders at
// every size and the small icons are the large one, not a different shape.
const MARGIN = 0.02;
const RADIUS = 0.22;
const BORDER = 0.007;
const H_WIDTH = 0.46;
const H_HEIGHT = 0.47;
const STEM = 0.125;
const BAR = 0.125;
const TOP = [0, 0, 0]; // #000000 - the tile is black
// Flat black, not a barely-off-black gradient: the owner asked for the logo to be black,
// and a tile that is #09090c at one edge reads as dark grey next to a flat black client.
const BOTTOM = [0, 0, 0]; // #000000 - the same black as the top, so the tile is flat
const RIM = [42, 44, 52]; // #2a2c34 - the hairline that keeps the silhouette on black
const MARK = [255, 255, 255]; // the H has to carry the contrast on a black tile
const SS = 4; // supersamples per axis, which is where the anti-aliasing comes from

function insideRounded(x, y) {
  const lo = MARGIN;
  const hi = 1 - MARGIN;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const cx = Math.min(Math.max(x, lo + RADIUS), hi - RADIUS);
  const cy = Math.min(Math.max(y, lo + RADIUS), hi - RADIUS);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}

// how far inside the tile a point is: 0 on the boundary, larger further in
function edgeDepth(x, y) {
  const lo = MARGIN;
  const hi = 1 - MARGIN;
  const cx = Math.min(Math.max(x, lo + RADIUS), hi - RADIUS);
  const cy = Math.min(Math.max(y, lo + RADIUS), hi - RADIUS);
  const dx = x - cx;
  const dy = y - cy;
  if (dx !== 0 || dy !== 0) return RADIUS - Math.hypot(dx, dy);
  return Math.min(x - lo, hi - x, y - lo, hi - y);
}

function insideH(x, y) {
  const halfWidth = H_WIDTH / 2;
  const halfHeight = H_HEIGHT / 2;
  if (y < 0.5 - halfHeight || y > 0.5 + halfHeight) return false;
  if (x < 0.5 - halfWidth || x > 0.5 + halfWidth) return false;
  const leftStem = x <= 0.5 - halfWidth + STEM;
  const rightStem = x >= 0.5 + halfWidth - STEM;
  const bar = y >= 0.5 - BAR / 2 && y <= 0.5 + BAR / 2;
  return leftStem || rightStem || bar;
}

// one subpixel: [r, g, b, alpha 0..1]
function sample(x, y) {
  if (!insideRounded(x, y)) return [0, 0, 0, 0];
  const t = Math.min(1, Math.max(0, (y - MARGIN) / (1 - 2 * MARGIN)));
  let r = TOP[0] + (BOTTOM[0] - TOP[0]) * t;
  let g = TOP[1] + (BOTTOM[1] - TOP[1]) * t;
  let b = TOP[2] + (BOTTOM[2] - TOP[2]) * t;
  if (insideH(x, y)) {
    [r, g, b] = MARK;
  } else if (edgeDepth(x, y) < BORDER) {
    // a hairline just inside the edge, so a black tile still reads as a tile on a
    // black background without a heavy outline
    [r, g, b] = RIM;
  }
  return [r, g, b, 1];
}

function renderTile(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = SS * SS;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let ra = 0;
      let ga = 0;
      let ba = 0;
      let alpha = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const c = sample((x * SS + sx + 0.5) / (size * SS), (y * SS + sy + 0.5) / (size * SS));
          ra += c[0] * c[3];
          ga += c[1] * c[3];
          ba += c[2] * c[3];
          alpha += c[3];
        }
      }
      const i = (y * size + x) * 4;
      if (alpha > 0) {
        // averaged premultiplied and then divided back out, so edges do not get
        // a dark fringe from the transparent samples beside them
        rgba[i] = Math.round(ra / alpha);
        rgba[i + 1] = Math.round(ga / alpha);
        rgba[i + 2] = Math.round(ba / alpha);
        rgba[i + 3] = Math.round((alpha / samples) * 255);
      }
    }
  }
  return rgba;
}

/* ---- the containers ----------------------------------------------------- */

// PNG-in-ICO is valid from Vista on, and it is what every current build tool
// produces for 256x256 entries.
const ICO_SIZES = [256, 128, 64, 48, 32, 16];

function makeIco(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach((image, index) => {
    const at = index * 16;
    dir[at] = image.size >= 256 ? 0 : image.size; // 0 means 256
    dir[at + 1] = image.size >= 256 ? 0 : image.size;
    dir[at + 2] = 0; // palette colours
    dir[at + 3] = 0; // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(image.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += image.png.length;
  });
  return Buffer.concat([head, dir, ...images.map((image) => image.png)]);
}

// the icns types macOS actually asks for, and the pixel size each one carries
const ICNS_TYPES = [
  ["ic11", 32], // 16x16@2x
  ["ic12", 64], // 32x32@2x
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
];

function makeIcns(pngBySize) {
  const chunks = ICNS_TYPES.map(([type, size]) => {
    const png = pngBySize.get(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, "latin1");
    head.writeUInt32BE(png.length + 8, 4); // the length includes this header
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "latin1");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/* ---- verification: read back what was written --------------------------- */

function pngSizeOf(buf, where) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error(where + ": not a PNG");
  if (buf.subarray(12, 16).toString("latin1") !== "IHDR") throw new Error(where + ": no IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function verifyPng(file, expected) {
  const buf = fs.readFileSync(file);
  const { width, height } = pngSizeOf(buf, file);
  if (width !== expected || height !== expected) throw new Error(file + ": " + width + "x" + height + ", expected " + expected);
  const tail = buf.subarray(buf.length - 8, buf.length - 4).toString("latin1");
  if (tail !== "IEND") throw new Error(file + ": does not end with IEND");
  return buf.length;
}

function verifyIco(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error(file + ": bad ICO header");
  const count = buf.readUInt16LE(4);
  if (count !== ICO_SIZES.length) throw new Error(file + ": " + count + " entries, expected " + ICO_SIZES.length);
  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    const declared = buf[at] === 0 ? 256 : buf[at];
    const bytes = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    if (buf[at + 1] !== buf[at]) throw new Error(file + ": entry " + i + " is not square");
    if (offset + bytes > buf.length) throw new Error(file + ": entry " + i + " runs past the end of the file");
    const inner = pngSizeOf(buf.subarray(offset, offset + bytes), file + " entry " + i);
    if (inner.width !== declared || inner.height !== declared) throw new Error(file + ": entry " + i + " says " + declared + " but carries " + inner.width);
    sizes.push(declared);
  }
  return { bytes: buf.length, sizes };
}

function verifyIcns(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 4).toString("latin1") !== "icns") throw new Error(file + ": bad icns magic");
  if (buf.readUInt32BE(4) !== buf.length) throw new Error(file + ": declared length " + buf.readUInt32BE(4) + " but the file is " + buf.length + " bytes");
  const sizes = [];
  let at = 8;
  while (at + 8 <= buf.length) {
    const type = buf.subarray(at, at + 4).toString("latin1");
    const length = buf.readUInt32BE(at + 4);
    if (length < 8 || at + length > buf.length) throw new Error(file + ": chunk " + type + " has a bad length");
    const known = ICNS_TYPES.find((entry) => entry[0] === type);
    if (!known) throw new Error(file + ": unexpected chunk type " + type);
    const inner = pngSizeOf(buf.subarray(at + 8, at + length), file + " chunk " + type);
    if (inner.width !== known[1]) throw new Error(file + " chunk " + type + ": carries " + inner.width + ", expected " + known[1]);
    sizes.push(inner.width);
    at += length;
  }
  if (at !== buf.length) throw new Error(file + ": " + (buf.length - at) + " trailing byte(s)");
  return { bytes: buf.length, sizes };
}

/* ---- run ---------------------------------------------------------------- */

let problems = 0;

try {
  fs.mkdirSync(build, { recursive: true });

  const pngBySize = new Map();
  for (const size of [512, ...ICO_SIZES]) {
    if (pngBySize.has(size)) continue;
    pngBySize.set(size, encodePng(size, size, renderTile(size)));
  }

  const iconPng = path.join(build, "icon.png");
  const iconIco = path.join(build, "icon.ico");
  const iconIcns = path.join(build, "icon.icns");
  fs.writeFileSync(iconPng, pngBySize.get(512));
  fs.writeFileSync(iconIco, makeIco(ICO_SIZES.map((size) => ({ size, png: pngBySize.get(size) }))));
  fs.writeFileSync(iconIcns, makeIcns(pngBySize));

  const pngBytes = verifyPng(iconPng, 512);
  console.log("icon.png    512x512            " + pngBytes + " bytes");
  const ico = verifyIco(iconIco);
  console.log("icon.ico    " + ico.sizes.join("/") + "  " + ico.bytes + " bytes");
  const icns = verifyIcns(iconIcns);
  console.log("icon.icns   " + icns.sizes.join("/") + "        " + icns.bytes + " bytes");
} catch (err) {
  problems += 1;
  console.log("FAIL " + String((err && err.message) || err));
}

console.log("");
console.log(problems ? "ICONS FAILED (" + problems + " problem(s))" : "ICONS OK");
process.exit(problems ? 1 : 0);
