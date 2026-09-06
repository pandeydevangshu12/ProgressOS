import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.resolve(rootDir, 'dist/client');

console.log('📦 Building ProgressOS frontend assets for Cloudflare...');

// 1. Clean output directory
if (fs.existsSync(outDir)) {
  fs.rmSync(outDir, { recursive: true, force: true });
}
fs.mkdirSync(outDir, { recursive: true });

// 2. Define allowed public files and directories
const filesToCopy = [
  'index.html',
  'u.html',
  'report.html',
  'manifest.json',
  'sw.js',
];

const dirsToCopy = [
  'icons',
  'js',
  'trackers',
  'career-studio',
];

// Helper to copy directory recursively
function copyDirSync(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Copy top-level files
let fileCount = 0;
for (const file of filesToCopy) {
  const src = path.join(rootDir, file);
  const dest = path.join(outDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    fileCount++;
  }
}

// Copy subdirectories
for (const dir of dirsToCopy) {
  const src = path.join(rootDir, dir);
  const dest = path.join(outDir, dir);
  copyDirSync(src, dest);
}

// 3. Generate static directory fallback for /app
const appDir = path.join(outDir, 'app');
fs.mkdirSync(appDir, { recursive: true });
fs.copyFileSync(path.join(rootDir, 'index.html'), path.join(appDir, 'index.html'));

// 4. Write Cloudflare Pages / Worker static asset _redirects
const redirectsContent = `# Cloudflare Static Routing Rules
/app           /index.html               200
/u/*           /u.html                   200
/career-studio /career-studio/index.html 200
`;
fs.writeFileSync(path.join(outDir, '_redirects'), redirectsContent, 'utf-8');

console.log(`✅ Static assets built successfully into ${outDir}`);
console.log(`   Top-level files: ${fileCount}`);
console.log(`   Directories: ${dirsToCopy.join(', ')}`);
console.log(`   _redirects created.`);
