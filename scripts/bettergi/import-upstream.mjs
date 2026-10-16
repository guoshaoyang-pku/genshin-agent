import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const sourceRevision = 'c9db8b8291fe4ac25a600aee1582298005919eb2';
export const scriptRevision = '4fef2c7a70b64f36eddb831ee6fe955276092176';
const exec = promisify(execFile);
const packages = {
  'bettergi.assets.map': { version: '1.0.24', sha256: '09f837ab983ac67d117edfcd3baffb59d35c00afde5972b818221798a9f41fbf' },
  'bettergi.assets.model': { version: '1.0.36', sha256: '7b2747754af6ab75e381100d31f138883160e4fc98671e3a237fe059c29754da' },
  'bettergi.assets.other': { version: '1.0.27', sha256: 'b929bac8bbd9b7a76defa5f698ef80c5831e186a0692aed18f1a28c9aac8acf6' },
};
async function revision(directory, expected) {
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: directory });
  if (stdout.trim() !== expected) throw new Error(`Unexpected source revision in ${directory}: ${stdout.trim()}`);
  const dirty = await exec('git', ['diff', '--name-only', 'HEAD'], { cwd: directory });
  if (dirty.stdout.trim()) throw new Error(`Upstream source has tracked edits: ${directory}`);
}
async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const relative = path.posix.join(prefix, entry.name);
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in upstream resources: ${filename}`);
    if (entry.isDirectory()) result.push(...await files(filename, relative));
    else if (entry.isFile()) {
      const bytes = await readFile(filename);
      result.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
export async function importUpstream({ source, resources, nuget, destination }) {
  await revision(source, sourceRevision);
  await revision(resources, scriptRevision);
  try {
    await stat(destination);
    throw new Error(`Import destination already exists; preserve local edits and choose a new directory: ${destination}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const [name, metadata] of Object.entries(packages)) {
    const bytes = await readFile(path.join(nuget, `${name}.${metadata.version}.nupkg`));
    if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw new Error(`Downloaded package hash changed: ${name}`);
  }
  await mkdir(destination, { recursive: true });
  await cp(source, path.join(destination, 'source'), { recursive: true, filter: entry => path.basename(entry) !== '.git', force: false, errorOnExist: true });
  await cp(resources, path.join(destination, 'scripts'), { recursive: true, filter: entry => path.basename(entry) !== '.git', force: false, errorOnExist: true });
  await mkdir(path.join(destination, 'assets'));
  for (const [name, metadata] of Object.entries(packages)) {
    await cp(path.join(nuget, name), path.join(destination, 'assets', name), { recursive: true, force: false, errorOnExist: true });
    await cp(path.join(nuget, `${name}.${metadata.version}.nuspec`), path.join(destination, 'assets', `${name}.${metadata.version}.nuspec`));
  }
  const manifest = {
    importedAt: new Date().toISOString(),
    source: { url: 'https://github.com/babalae/better-genshin-impact', revision: sourceRevision, license: 'GPL-3.0', files: await files(path.join(destination, 'source')) },
    scripts: { url: 'https://github.com/babalae/bettergi-scripts-list', revision: scriptRevision, license: 'Per-package; root repository has no uniform license', files: await files(path.join(destination, 'scripts')) },
    packages: { ...packages, upstreamHashIndependentlyVerified: false, note: 'SHA256 records locally downloaded packages; upstream catalog hash was unavailable.' },
    assets: await files(path.join(destination, 'assets')),
  };
  await writeFile(path.join(destination, 'provenance.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { destination, source: manifest.source.files.length, scripts: manifest.scripts.files.length, assets: manifest.assets.length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, resources, nuget, destination] = process.argv.slice(2);
  if (![source, resources, nuget, destination].every(Boolean)) throw new Error('Usage: node import-upstream.mjs SOURCE_CHECKOUT SCRIPT_CHECKOUT NUGET_DIRECTORY NEW_DESTINATION');
  console.log(JSON.stringify(await importUpstream({ source, resources, nuget, destination })));
}
