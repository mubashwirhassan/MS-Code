const esbuild = require('esbuild');
const watch = process.argv.includes('--watch');

esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode'],
  outfile: 'dist/extension.js',
}).then(c => {
  if (watch) {
    c.watch();
    console.log('[esbuild] watching...');
  } else {
    return c.rebuild().then(() => c.dispose());
  }
}).catch(() => process.exit(1));
