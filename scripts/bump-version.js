
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
if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const newVersion = bumpVersion(manifest.version);
    manifest.version = newVersion;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`Bumped manifest version to ${newVersion}`);

    // Update Package.json to match
    if (fs.existsSync(packagePath)) {
        const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
        pkg.version = newVersion;
        fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
        console.log(`Synced package.json version to ${newVersion}`);
    }
} else {
    console.error('Manifest file not found!');
    process.exit(1);
}
