import { build, context } from 'esbuild';
import { mkdir, rm, copyFile, readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const args = process.argv.slice(2);
const isWatch = args.includes('--watch');
const isDev = args.includes('--dev');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const srcDir = path.join(projectRoot, 'src');
const distDir = path.join(projectRoot, 'dist');
const manifestSrc = path.join(projectRoot, 'manifest.json');
const iconsDir = path.join(projectRoot, 'icons');

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const buildOptions = {
  entryPoints: [path.join(srcDir, 'main.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  outfile: path.join(distDir, 'content.js'),
  sourcemap: isDev,
  minify: !isDev,
  logLevel: 'info'
};

async function copyStaticAssets() {
  await copyFile(manifestSrc, path.join(distDir, 'manifest.json'));
  await copyDirectory(iconsDir, path.join(distDir, 'icons'));
}

async function copyDirectory(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(source, entry.name);
    const destPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath);
    }
  }
}

if (isWatch) {
  const ctx = await context(buildOptions);
  await ctx.watch({
    onRebuild(error) {
      if (error) {
        console.error('Watch build failed', error);
      } else {
        copyStaticAssets().catch(err => console.error('Static asset copy failed', err));
        console.log('🔁 Extension rebuilt');
      }
    }
  });
  await copyStaticAssets();
  console.log('👀 Watching for changes...');
} else {
  await build(buildOptions);
  await copyStaticAssets();
  console.log('✅ Extension build written to', distDir);
}
