#!/usr/bin/env node

/**
 * Custom packaging script for Electron app with pnpm workspaces.
 * Temporarily removes workspace symlinks that cause electron-builder issues.
 * On Windows, skips native module rebuild (uses prebuilt binaries).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const isWindows = process.platform === 'win32';
const nodeModulesPath = path.join(__dirname, '..', 'node_modules');

// Save symlink targets for restoration
const workspacePackages = [
  { scope: '@accomplish_ai', name: 'agent-core' },
  { scope: '@accomplish', name: 'web' },
];
const symlinkTargets = [];

try {
  // Check and remove workspace symlinks
  for (const pkg of workspacePackages) {
    const scopePath = path.join(nodeModulesPath, pkg.scope);
    const pkgPath = path.join(scopePath, pkg.name);
    if (fs.existsSync(pkgPath)) {
      const stats = fs.lstatSync(pkgPath);
      if (stats.isSymbolicLink()) {
        symlinkTargets.push({
          scope: pkg.scope,
          name: pkg.name,
          path: pkgPath,
          target: fs.readlinkSync(pkgPath),
        });
        console.log('Temporarily removing workspace symlink:', pkgPath);
        fs.unlinkSync(pkgPath);

        try {
          fs.rmdirSync(scopePath);
        } catch {
          // Directory not empty or doesn't exist, ignore
        }
      }
    }
  }

  // Get command line args (everything after 'node scripts/package.js')
  const args = process.argv.slice(2).join(' ');

  // On Windows, skip native module rebuild (use prebuilt binaries)
  // This avoids issues with node-pty's winpty.gyp batch file handling
  const npmRebuildFlag = isWindows ? ' --config.npmRebuild=false' : '';

  // Use npx to run electron-builder to ensure it's found in node_modules
  const command = `npx electron-builder ${args}${npmRebuildFlag}`;

  console.log('Running:', command);
  if (isWindows) {
    console.log('(Skipping native module rebuild on Windows - using prebuilt binaries)');
  }
  execSync(command, { stdio: 'inherit', cwd: path.join(__dirname, '..') });
} finally {
  // Restore the symlinks
  if (symlinkTargets.length > 0) {
    console.log('Restoring workspace symlinks');

    for (const pkg of symlinkTargets) {
      const scopePath = path.join(nodeModulesPath, pkg.scope);
      const pkgPath = pkg.path;
      const target = pkg.target;

      if (!fs.existsSync(scopePath)) {
        fs.mkdirSync(scopePath, { recursive: true });
      }

      // On Windows, use junction instead of symlink (doesn't require admin privileges)
      // The target needs to be an absolute path for junctions
      const absoluteTarget = path.isAbsolute(target)
        ? target
        : path.resolve(path.dirname(pkgPath), target);

      if (isWindows) {
        fs.symlinkSync(absoluteTarget, pkgPath, 'junction');
      } else {
        fs.symlinkSync(target, pkgPath);
      }
      console.log('  Restored:', pkgPath);
    }
  }
}
