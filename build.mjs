import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

/** @type {esbuild.BuildOptions} */
const cliConfig = {
  entryPoints: ['src/cli.ts'],
  bundle: true,
  outfile: 'dist/cli.js',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

/** @type {esbuild.BuildOptions} */
const testConfig = {
  entryPoints: ['src/test/runTests.ts'],
  bundle: true,
  outfile: 'dist/runTests.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

async function build() {
  if (isWatch) {
    const ctx1 = await esbuild.context(extensionConfig);
    const ctx2 = await esbuild.context(cliConfig);
    await ctx1.watch();
    await ctx2.watch();
    console.log('Watching for changes...');
  } else {
    await esbuild.build(extensionConfig);
    await esbuild.build(cliConfig);
    await esbuild.build(testConfig);
    console.log('Build completed successfully.');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
