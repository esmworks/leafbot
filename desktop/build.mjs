// Bundles the Electron main process and preload script into dist/.
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  // ws (under socket.io-client) loads these optional speedups only if present. node-datachannel
  // loads a native build, so it stays in node_modules (unpacked from the asar archive when packaged).
  external: ['electron', 'bufferutil', 'utf-8-validate', 'node-datachannel'],
  sourcemap: true,
};
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs' });
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs' });

// On macOS, the small helper that moves the mouse and types for a bot allowed to use this Mac.
// Swift ships with Xcode's command-line tools; without them the app builds anyway and the feature
// is not offered.
if (process.platform === 'darwin') {
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('swiftc', ['-O', 'native/person-computer.swift', '-o', 'dist/person-computer'], {
      stdio: 'inherit',
    });
  } catch (err) {
    console.warn(`The person-computer helper was not built: ${err.message}`);
  }
}
