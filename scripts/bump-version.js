
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const manifestPath = path.join(rootDir, 'public', 'manifest.json');
const distManifestPath = path.join(rootDir, 'dist', 'manifest.json');
const packagePath = path.join(rootDir, 'package.json');

function bumpVersion(version) {
    // Missing or non-numeric parts count as 0 (e.g. "1.2" -> "1.2.1")
    const parts = String(version).split('.').map(part => Number.parseInt(part, 10) || 0);
    while (parts.length < 3) parts.push(0);
    parts[2] += 1;
    return parts.join('.');
}

// The build runs before this script, so dist/ already holds a copy of the old
// public/manifest.json. Refresh it so the built extension carries the new version.
function syncDistManifest() {
    if (fs.existsSync(path.dirname(distManifestPath))) {
        fs.copyFileSync(manifestPath, distManifestPath);
        console.log('Copied updated manifest to dist/manifest.json');
    }
}

// Update Manifest
if (fs.existsSync(manifestPath) && fs.existsSync(packagePath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));

    // Check if package.json was manually updated (different from manifest)
    // We assume if they differ, package.json is the source of truth for the new version
    if (pkg.version !== manifest.version) {
        console.log(`Detected manual version change in package.json (${pkg.version}). Syncing manifest...`);
        manifest.version = pkg.version;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
        console.log(`Synced manifest version to ${manifest.version}`);
    } else {
        // Normal auto-bump behavior
        const newVersion = bumpVersion(manifest.version);
        manifest.version = newVersion;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
        console.log(`Bumped manifest version to ${newVersion}`);

        pkg.version = newVersion;
        fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
        console.log(`Synced package.json version to ${newVersion}`);
    }
    syncDistManifest();
} else {
    console.error('Manifest file not found!');
    process.exit(1);
}
