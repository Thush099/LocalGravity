import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// LocalGravity brand mark: a white "G" on an Apple-blue squircle. Rendered from
// vector (ImageMagick) so every size stays crisp, then packed into an .icns.
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1a90ff"/>
      <stop offset="0.5" stop-color="#0a84ff"/>
      <stop offset="1" stop-color="#0068e0"/>
    </linearGradient>
  </defs>
  <rect x="34" y="34" width="956" height="956" rx="228" ry="228" fill="url(#bg)"/>
  <g transform="translate(512,512) scale(22) translate(-24,-24)">
    <path d="M32 16.2 A11.2 11.2 0 1 0 34.6 24.4 H25.2" stroke="#ffffff" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;

function hasMagick() {
  try {
    execFileSync('magick', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const outIcns = process.argv[2] || path.resolve('build/AppIcon.icns');
if (!hasMagick()) {
  console.error('ImageMagick (magick) is required to regenerate the icon: brew install imagemagick');
  console.error('The committed build/AppIcon.icns is used as-is when present.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(outIcns), { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-icon-'));
const svgPath = path.join(tmpDir, 'icon.svg');
fs.writeFileSync(svgPath, ICON_SVG);

const iconsetDir = path.join(tmpDir, 'AppIcon.iconset');
fs.mkdirSync(iconsetDir);

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
  execFileSync('magick', ['-background', 'none', svgPath, '-resize', `${px}x${px}`, `PNG32:${path.join(iconsetDir, name)}`], {
    stdio: 'ignore',
  });
}

execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', outIcns]);
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`Generated ${outIcns}`);