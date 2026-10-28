import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, type Config } from './config';

/** Bundles the mainframe UI and the child SDK into dist/p<port>/. The SDK gets the mainframe origin as a build-time constant. */
export async function buildAssets(cfg: Config) {
  const web = path.join(cfg.distDir, 'web');
  fs.mkdirSync(web, { recursive: true });
  await build({
    entryPoints: [path.join(ROOT, 'src/web/main.ts')],
    outfile: path.join(web, 'main.js'),
    bundle: true,
    format: 'iife', // an IIFE keeps module-level state (the token closure) off the global object
    target: 'es2020',
    sourcemap: false,
    logLevel: 'warning',
  });
  fs.copyFileSync(path.join(ROOT, 'src/web/index.html'), path.join(web, 'index.html'));
  fs.copyFileSync(path.join(ROOT, 'src/web/style.css'), path.join(web, 'style.css'));
  await build({
    entryPoints: [path.join(ROOT, 'src/sdk/childSdk.ts')],
    outfile: path.join(cfg.distDir, 'sdk', 'sdk.js'),
    bundle: true,
    format: 'iife',
    target: 'es2020',
    define: { __HOST_ORIGIN__: JSON.stringify(cfg.mainOrigin) },
    logLevel: 'warning',
  });
}

// `npm run build` (after the type check)
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'src/server/build.ts')) {
  const cfg = loadConfig();
  buildAssets(cfg).then(() => console.log('Built into', cfg.distDir));
}
