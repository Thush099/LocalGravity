import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function renderIconRgba(size) {
  const buf = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const pad = size * 0.08;
  const rCorner = size * 0.22;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const ax = Math.abs(x - half) - (half - pad - rCorner);
      const ay = Math.abs(y - half) - (half - pad - rCorner);
      const sqDist = Math.hypot(Math.max(ax, 0), Math.max(ay, 0)) + Math.min(Math.max(ax, ay), 0) - rCorner;
      const alpha = 1 - smoothstep(-1.5, 1.5, sqDist);
      if (alpha <= 0.001) {
        buf[idx + 3] = 0;
        continue;
      }

      const t = (x * 0.35 + y * 0.65) / size;
      let r = 16 + t * 14;
      let g = 22 + t * 20;
      let b = 34 + t * 30;

      const distCenter = Math.hypot(x - half, y - half);
      // Outer cobalt orbital ring
      const ringDist = Math.abs(distCenter - size * 0.27);
      const ringMix = 1 - smoothstep(size * 0.015, size * 0.035, ringDist);
      r = r * (1 - ringMix) + 59 * ringMix;
      g = g * (1 - ringMix) + 130 * ringMix;
      b = b * (1 - ringMix) + 246 * ringMix;

      // Center bright sphere
      const coreMix = 1 - smoothstep(size * 0.095, size * 0.115, distCenter);
      r = r * (1 - coreMix) + 147 * coreMix;
      g = g * (1 - coreMix) + 197 * coreMix;
      b = b * (1 - coreMix) + 253 * coreMix;

      // Satellite node at top-right orbital ring
      const satX = half + Math.cos(-Math.PI / 4) * size * 0.27;
      const satY = half + Math.sin(-Math.PI / 4) * size * 0.27;
      const satMix = 1 - smoothstep(size * 0.045, size * 0.058, Math.hypot(x - satX, y - satY));
      r = r * (1 - satMix) + 34 * satMix;
      g = g * (1 - satMix) + 197 * satMix;
      b = b * (1 - satMix) + 94 * satMix;

      buf[idx] = Math.min(255, Math.round(r));
      buf[idx + 1] = Math.min(255, Math.round(g));
      buf[idx + 2] = Math.min(255, Math.round(b));
      buf[idx + 3] = Math.min(255, Math.round(alpha * 255));
    }
  }
  return buf;
}

const outIcns = process.argv[2] || path.resolve('build/AppIcon.icns');
fs.mkdirSync(path.dirname(outIcns), { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-icon-'));
const iconsetDir = path.join(tmpDir, 'AppIcon.iconset');
fs.mkdirSync(iconsetDir);

const basePng = path.join(tmpDir, 'base-1024.png');
fs.writeFileSync(basePng, encodePng(1024, 1024, renderIconRgba(1024)));

const specs = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

for (const [name, px] of specs) {
  execFileSync('sips', ['-z', String(px), String(px), basePng, '--out', path.join(iconsetDir, name)], {
    stdio: 'ignore',
  });
}

execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', outIcns]);
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`Generated ${outIcns}`);
