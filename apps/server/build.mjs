// Bundles the server and the workspace packages (TypeScript sources) into dist/main.js.
// npm dependencies stay external and are loaded from node_modules at runtime.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  plugins: [
    {
      name: 'externalize-npm-dependencies',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('@funnel/') ? undefined : { path: args.path, external: true }));
      },
    },
  ],
});
console.log('built apps/server/dist/main.js');
