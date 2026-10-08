/* Builds every raster asset from brand/notal-ai-logo.png:
   icons/notal-mark.png        the mark, transparent
   icons/notal-petals.png      mark with the centre disc cut out — this is what spins
   icons/notal-core.png        the centre disc on its own — this stays still
   icons/icon-192.png / -512   solid tiles for the PWA, maskable-safe
   icons/apple-touch-icon.png  180px, cream filled
   icons/favicon-32.png
   node make-brand-icons.js */
const fs = require("fs"), path = require("path"), zlib = require("zlib");

const SRC = path.join(__dirname, "brand", "notal-ai-logo.png");
const OUT = path.join(__dirname, "icons");
const CREAM = [0xf5, 0xf1, 0xea, 255];

/* ---------------- PNG decode (8-bit RGBA, any filter) ---------------- */
function decodePng(buf) {
  let p = 8;
  const idat = [];
  let width = 0, height = 0, depth = 0, color = 0;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    if (type === "IHDR") {
      width = buf.readUInt32BE(p + 8); height = buf.readUInt32BE(p + 12);
      depth = buf[p + 16]; color = buf[p + 17];
    }
    if (type === "IDAT") idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  if (depth !== 8 || color !== 6) throw new Error("expected 8-bit RGBA png");
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = line[x]; break;
        case 1: v = line[x] + a; break;
        case 2: v = line[x] + b; break;
        case 3: v = line[x] + ((a + b) >> 1); break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v = line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error("bad filter " + filter);
      }
      cur[x] = v & 255;
    }
  }
  return { width, height, data: out };
}

/* ---------------- PNG encode ---------------- */
function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type), len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", (() => { const b = Buffer.alloc(13);
      b.writeUInt32BE(width, 0); b.writeUInt32BE(height, 4);
      b[8] = 8; b[9] = 6; return b; })()),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* Box-filtered resize on premultiplied alpha, so edges do not fringe. */
function resize(img, size) {
  const { width, height, data } = img;
  const out = Buffer.alloc(size * size * 4);
  const sx = width / size, sy = height / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * width + xx) * 4, al = data[i + 3];
          r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al; a += al;
          n++;
        }
      }
      const o = (y * size + x) * 4;
      const alpha = a / n;
      if (alpha === 0) { out[o + 3] = 0; continue; }
      out[o] = Math.round(r / a);
      out[o + 1] = Math.round(g / a);
      out[o + 2] = Math.round(b / a);
      out[o + 3] = Math.round(alpha);
    }
  }
  return { width: size, height: size, data: out };
}

/* Flatten onto the cream tile the app uses. */
function onTile(img, size, inset) {
  const { width, height, data } = img;
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = CREAM[0]; out[i * 4 + 1] = CREAM[1];
    out[i * 4 + 2] = CREAM[2]; out[i * 4 + 3] = 255;
  }
  const span = Math.round(size * (1 - inset * 2));
  const off = Math.round((size - span) / 2);
  for (let y = 0; y < span; y++) {
    for (let x = 0; x < span; x++) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) / span) * width));
      const sy = Math.min(height - 1, Math.floor(((y + 0.5) / span) * height));
      const si = (sy * width + sx) * 4, al = data[si + 3] / 255;
      if (!al) continue;
      const o = ((y + off) * size + (x + off)) * 4;
      out[o] = Math.round(data[si] * al + out[o] * (1 - al));
      out[o + 1] = Math.round(data[si + 1] * al + out[o + 1] * (1 - al));
      out[o + 2] = Math.round(data[si + 2] * al + out[o + 2] * (1 - al));
      out[o + 3] = 255;
    }
  }
  return { width: size, height: size, data: out };
}

const src = decodePng(fs.readFileSync(SRC));
const { width, height, data } = src;
const cx = width / 2, cy = height / 2;

/* Label the opaque blobs. The artwork is four disconnected pieces — three
   petals and the centre sphere — and the sphere is the one nearest the middle,
   so a flood fill finds the cut line exactly instead of guessing a radius. */
const label = new Int32Array(width * height).fill(-1);
const blobs = [];
for (let i = 0; i < width * height; i++) {
  if (label[i] !== -1 || data[i * 4 + 3] <= 8) continue;
  const id = blobs.length;
  const pixels = [];
  const queue = [i];
  label[i] = id;
  while (queue.length) {
    const cur = queue.pop();
    pixels.push(cur);
    const x = cur % width, y = (cur / width) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = ny * width + nx;
      if (label[n] === -1 && data[n * 4 + 3] > 8) { label[n] = id; queue.push(n); }
    }
  }
  let mx = 0, my = 0;
  for (const p of pixels) { mx += p % width; my += (p / width) | 0; }
  blobs.push({ id, pixels, cx: mx / pixels.length, cy: my / pixels.length });
}
const sphere = blobs.reduce((best, b) =>
  Math.hypot(b.cx - cx, b.cy - cy) < Math.hypot(best.cx - cx, best.cy - cy) ? b : best);
for (const b of blobs) console.log("blob", b.id, b.pixels.length, "at",
  Math.round(b.cx) + "," + Math.round(b.cy));
console.log("blobs", blobs.length, "sphere centroid",
  Math.round(sphere.cx), Math.round(sphere.cy), "of", width, "px", sphere.pixels.length);

/* Where the petals balance. Spinning them about this point is what makes the
   triskelion turn in place instead of wobbling around the sphere. */
let pmx = 0, pmy = 0, pn = 0;
for (const b of blobs) {
  if (b === sphere || b.pixels.length < 1000) continue;
  pmx += b.cx * b.pixels.length; pmy += b.cy * b.pixels.length; pn += b.pixels.length;
}
const petalsCx = pmx / pn, petalsCy = pmy / pn;
console.log("petals balance", Math.round(petalsCx) + "," + Math.round(petalsCy), "of", pn, "px");

const byBlob = new Uint8Array(width * height);
for (const b of blobs) for (const p of b.pixels) byBlob[p] = b.id + 1;

const layer = (keepSphere) => {
  const out = Buffer.from(data);
  for (let p = 0; p < width * height; p++)
    if ((byBlob[p] === sphere.id + 1) !== keepSphere) out[p * 4 + 3] = 0;
  return { width, height, data: out };
};

const petals = layer(false);
const core = layer(true);

/* One square frame for every asset so the static mark and the two animated
   layers line up pixel for pixel. The petals spin about the artwork's
   three-fold balance point, which is not the frame centre, so the generator
   prints the transform-origin the CSS has to use. */
let bx0 = width, by0 = height, bx1 = 0, by1 = 0;
for (const b of blobs) {
  if (b.pixels.length < 1000) continue;
  for (const p of b.pixels) {
    const x = p % width, y = (p / width) | 0;
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
    if (y < by0) by0 = y; if (y > by1) by1 = y;
  }
}
const fx = (bx0 + bx1) / 2, fy = (by0 + by1) / 2;
const side = Math.round(Math.max(bx1 - bx0, by1 - by0) * 1.06);
const ox = Math.round(fx - side / 2), oy = Math.round(fy - side / 2);
const spinX = ((petalsCx - ox) / side * 100).toFixed(1);
const spinY = ((petalsCy - oy) / side * 100).toFixed(1);
console.log("frame", side, "at", ox + "," + oy, "-> transform-origin:", spinX + "% " + spinY + "%");

function cropSquare(img) {
  const out = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y++) {
    const sy = oy + y;
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < side; x++) {
      const sx = ox + x;
      if (sx < 0 || sx >= width) continue;
      img.data.copy(out, (y * side + x) * 4, (sy * width + sx) * 4, (sy * width + sx) * 4 + 4);
    }
  }
  return { width: side, height: side, data: out };
}
const art = cropSquare(src);

const write = (name, img) => {
  fs.writeFileSync(path.join(OUT, name), encodePng(img));
  console.log(name, img.width + "x" + img.height);
};

write("notal-mark.png", resize(art, 256));
write("notal-petals.png", resize(cropSquare(petals), 256));
write("notal-core.png", resize(cropSquare(core), 256));
write("icon-512.png", onTile(resize(art, 512), 512, 0));
write("icon-192.png", onTile(resize(art, 192), 192, 0));
write("icon-maskable-512.png", onTile(resize(art, 512), 512, 0.18));
write("apple-touch-icon.png", onTile(resize(art, 180), 180, 0.06));
write("favicon-32.png", resize(art, 32));
