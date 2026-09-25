/* Generates icons/icon-<size>.png: terracotta tile, cream Notal triangle. */
const fs = require("fs"), path = require("path"), zlib = require("zlib");

const BG = [0xd9, 0x77, 0x57, 255];
const FG = [0xfd, 0xfb, 0xf7, 255];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type), len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, t, data, (() => {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return c;
  })()]);
}

function trianglePng(size) {
  // geometry in a 24-unit design grid, inset for the maskable safe zone
  const inset = 0.20, scale = (size * (1 - inset * 2)) / 24;
  const ox = (size - 24 * scale) / 2, oy = (size - 24 * scale) / 2;
  const V = [[5, 7], [19, 7], [12, 17.5]].map(([x, y]) => [ox + x * scale, oy + y * scale]);

  const row = Buffer.alloc(1 + size * 4);
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      let inside = false;
      for (let i = 0, j = 2; i < 3; j = i++) {
        const [xi, yi] = V[i], [xj, yj] = V[j];
        if ((yi > cy) !== (yj > cy) && cx < ((xj - xi) * (cy - yi)) / (yj - yi) + xi) inside = !inside;
      }
      const p = 1 + x * 4, c = inside ? FG : BG;
      row[p] = c[0]; row[p + 1] = c[1]; row[p + 2] = c[2]; row[p + 3] = c[3];
    }
    row.copy(raw, y * (1 + size * 4));
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const dir = path.join(__dirname, "icons");
fs.mkdirSync(dir, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(dir, `icon-${size}.png`);
  fs.writeFileSync(file, trianglePng(size));
  console.log("wrote", path.basename(file), fs.statSync(file).size, "bytes");
}
