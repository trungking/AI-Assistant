
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const manifestPath = path.join(rootDir, 'public', 'manifest.json');
const packagePath = path.join(rootDir, 'package.json');

function bumpVersion(version) {
    const parts = version.split('.').map(Number);
    parts[2] += 1;
    return parts.join('.');
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
} else {
    console.error('Manifest file not found!');
    process.exit(1);
}
