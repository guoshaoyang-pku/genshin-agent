import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importUpstream, sourceRevision, scriptRevision } from './import-upstream.mjs';

const exec = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const packages = {
  'bettergi.assets.map': { version: '1.0.24', sha256: '09f837ab983ac67d117edfcd3baffb59d35c00afde5972b818221798a9f41fbf' },
  'bettergi.assets.model': { version: '1.0.36', sha256: '7b2747754af6ab75e381100d31f138883160e4fc98671e3a237fe059c29754da' },
  'bettergi.assets.other': { version: '1.0.27', sha256: 'b929bac8bbd9b7a76defa5f698ef80c5831e186a0692aed18f1a28c9aac8acf6' },
};
const csTrees = [
  { path: 'core-1.0.5', revision: '8c52a59d6ad2fa4399b39ab06b347603658faa27' },
  { path: 'meai-1.0.2', revision: '4183cb8482355afaccd7e34c25dc155a460b1c3e' },
];
const yolo = {
  url: 'https://codeload.github.com/dme-compunet/YoloSharp/tar.gz/f970826b3ab662afcff3a5010647d51419222e75',
  commit: 'f970826b3ab662afcff3a5010647d51419222e75',
  version: '6.0.3',
  archive_sha256: '625895a94cffe30a0364d142bd7c975a9c55b4e6138691c1cf30803cc7adc2c7',
};

export async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function exists(filename) {
  try { return await lstat(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

async function inventory(directory, prefix = '') {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name === '.git') continue;
    const relative = path.posix.join(prefix, item.name);
    const filename = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error(`Unexpected symlink: ${filename}`);
    if (item.isDirectory()) result.push(...await inventory(filename, relative));
    else if (item.isFile()) result.push({ path: relative, bytes: (await lstat(filename)).size, sha256: await sha256(filename) });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

async function download(url, filename, expected) {
  if (!await exists(filename)) {
    const temporary = await mkdtemp(path.join(path.dirname(filename), '.download-'));
    try {
      const output = path.join(temporary, 'archive');
      console.log(`Downloading ${path.basename(filename)}`);
      await exec('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '2', '--connect-timeout', '25', '--max-time', '900', '--output', output, url], { maxBuffer: 1024 * 1024 });
      if (await sha256(output) !== expected) throw new Error(`SHA256 mismatch for ${path.basename(filename)}; refusing import`);
      await rename(output, filename);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  if ((await lstat(filename)).isSymbolicLink() || await sha256(filename) !== expected) throw new Error(`Cached archive failed SHA256: ${filename}`);
}

async function checkout(url, revision, cache) {
  const directory = path.join(cache, revision);
  if (!await exists(directory)) {
    const temporary = await mkdtemp(path.join(cache, '.git-'));
    try {
      console.log(`Fetching ${url} @ ${revision.slice(0, 12)}`);
      await exec('git', ['init', '--quiet', temporary]);
      await exec('git', ['-C', temporary, '-c', 'core.autocrlf=false', 'fetch', '--quiet', '--depth=1', url, revision], { maxBuffer: 4 * 1024 * 1024 });
      await exec('git', ['-C', temporary, '-c', 'core.autocrlf=false', 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
      await rename(temporary, directory);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  if ((await lstat(directory)).isSymbolicLink()) throw new Error(`Refusing symlinked source cache: ${directory}`);
  const actual = await exec('git', ['rev-parse', 'HEAD'], { cwd: directory });
  const dirty = await exec('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: directory, maxBuffer: 4 * 1024 * 1024 });
  if (actual.stdout.trim() !== revision || dirty.stdout.trim()) throw new Error(`Cached checkout differs from pinned revision: ${directory}`);
  return directory;
}

const extractor = String.raw`
import pathlib, shutil, stat, sys, tarfile, zipfile
archive, destination, kind, package = sys.argv[1:]
root = pathlib.Path(destination)
root.mkdir(parents=True, exist_ok=True)
def safe(name):
    p = pathlib.PurePosixPath(name)
    if not name or chr(92) in name or p.is_absolute() or '..' in p.parts or ':' in name or chr(0) in name:
        raise ValueError('Unsafe archive path: ' + repr(name))
    return p
def copy(source, relative):
    output = root.joinpath(*safe(relative).parts)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('xb') as target:
        shutil.copyfileobj(source, target)
if kind == 'nuget':
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        if len(entries) > 60000 or sum(i.file_size for i in entries) > 3 * 1024**3:
            raise ValueError('Archive exceeds resource extraction limit')
        for i in entries:
            safe(i.filename)
            if stat.S_ISLNK(i.external_attr >> 16):
                raise ValueError('Archive symlink refused')
        specification = 0
        assets = 0
        for i in entries:
            if i.is_dir():
                continue
            if i.filename.startswith('contentFiles/any/any/Assets/'):
                with z.open(i) as source:
                    copy(source, package + '/' + i.filename[len('contentFiles/any/any/'):])
                assets += 1
            elif '/' not in i.filename and i.filename.lower().endswith('.nuspec'):
                with z.open(i) as source:
                    copy(source, package + '.nuspec')
                specification += 1
        if not assets or specification != 1:
            raise ValueError('NuGet package missing assets or unique specification')
elif kind == 'tar':
    with tarfile.open(archive, 'r:gz') as t:
        entries = t.getmembers()
        if len(entries) > 60000 or sum(i.size for i in entries) > 3 * 1024**3:
            raise ValueError('Archive exceeds resource extraction limit')
        prefixes = set()
        for i in entries:
            p = safe(i.name)
            prefixes.add(p.parts[0])
            if not (i.isdir() or i.isfile()):
                raise ValueError('Archive links and special files refused')
        if len(prefixes) != 1:
            raise ValueError('Expected single archive root')
        for i in entries:
            if i.isfile():
                relative = pathlib.PurePosixPath(i.name).parts[1:]
                if not relative:
                    raise ValueError('File at archive root')
                with t.extractfile(i) as source:
                    copy(source, '/'.join(relative))
else:
    raise ValueError('Unknown archive kind')
`;

export async function extractArchive(archive, destination, kind, packageName = '') {
  await exec(process.env.GENSHIN_PYTHON || 'python3', ['-c', extractor, archive, destination, kind, packageName], { maxBuffer: 1024 * 1024 });
}

export async function verifyResources(destination) {
  if ((await lstat(destination)).isSymbolicLink()) throw new Error('Resource destination must not be a symlink');
  const manifest = JSON.parse(await readFile(path.join(destination, 'provenance.json'), 'utf8'));
  if (manifest.source?.revision !== sourceRevision || manifest.scripts?.revision !== scriptRevision) throw new Error('Resource revision differs from pinned release');
  for (const [name, expected] of Object.entries(packages)) {
    if (manifest.packages?.[name]?.sha256 !== expected.sha256 || manifest.packages?.[name]?.version !== expected.version) throw new Error(`Resource package differs from pin: ${name}`);
  }
  const dependencyManifest = JSON.parse(await readFile(path.join(destination, 'resource-bootstrap.json'), 'utf8'));
  if (dependencyManifest.csTrees?.map(p => p.revision).join() !== csTrees.map(p => p.revision).join() || dependencyManifest.yolo?.archive_sha256 !== yolo.archive_sha256) throw new Error('Dependency revision differs from pin');
  const trees = { source: manifest.source.files, scripts: manifest.scripts.files, assets: manifest.assets, dependencies: dependencyManifest.files };
  let count = 0;
  for (const [name, expected] of Object.entries(trees)) {
    const actual = await inventory(path.join(destination, name));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Resource tree differs from provenance: ${name}`);
    count += actual.length;
  }
  return { destination, filesVerified: count, sourceRevision, scriptRevision };
}

export async function fetchResources({ destination = path.join(project, 'third_party/bettergi'), cache = path.join(project, 'data/bettergi/downloads') } = {}) {
  destination = path.resolve(destination);
  cache = path.resolve(cache);
  if (await exists(destination)) {
    console.log('Resources already exist; checking hashes without replacing files.');
    return verifyResources(destination);
  }
  if (cache === destination || cache.startsWith(destination + path.sep)) throw new Error('Cache must be outside the resource destination');
  await mkdir(cache, { recursive: true });
  if ((await lstat(cache)).isSymbolicLink()) throw new Error('Resource cache must not be a symlink');
  await mkdir(path.dirname(destination), { recursive: true });
  const work = await mkdtemp(path.join(path.dirname(destination), '.bettergi-import-'));
  try {
    const source = await checkout('https://github.com/babalae/better-genshin-impact.git', sourceRevision, cache);
    const resources = await checkout('https://github.com/babalae/bettergi-scripts-list.git', scriptRevision, cache);
    const nuget = path.join(work, 'nuget');
    await mkdir(nuget);
    for (const [name, pin] of Object.entries(packages)) {
      const filename = `${name}.${pin.version}.nupkg`;
      const archive = path.join(cache, filename);
      await download(`https://api.nuget.org/v3-flatcontainer/${name}/${pin.version}/${filename}`, archive, pin.sha256);
      await cp(archive, path.join(nuget, filename));
      await extractArchive(archive, nuget, 'nuget', name);
      await rename(path.join(nuget, `${name}.nuspec`), path.join(nuget, `${name}.${pin.version}.nuspec`));
    }
    const staged = path.join(work, 'bettergi');
    await importUpstream({ source, resources, nuget, destination: staged });
    const dependencies = path.join(staged, 'dependencies');
    for (const pin of csTrees) {
      const source = await checkout('https://github.com/FishmanTheMurloc/CsTrees.git', pin.revision, cache);
      await cp(source, path.join(dependencies, 'CsTrees', pin.path), { recursive: true, filter: entry => path.basename(entry) !== '.git' });
    }
    const archive = path.join(cache, `YoloSharp-${yolo.commit}.tar.gz`);
    await download(yolo.url, archive, yolo.archive_sha256);
    await extractArchive(archive, path.join(dependencies, 'YoloSharp'), 'tar');
    await writeFile(path.join(dependencies, 'YoloSharp/download.json'), JSON.stringify(yolo, null, 2) + '\n');
    await writeFile(path.join(dependencies, 'CsTrees/provenance.json'), JSON.stringify({ repository: 'https://github.com/FishmanTheMurloc/CsTrees', license: 'MIT', packages: csTrees }, null, 2) + '\n');
    await writeFile(path.join(staged, 'resource-bootstrap.json'), JSON.stringify({ csTrees, yolo, files: await inventory(dependencies) }, null, 2) + '\n');
    await verifyResources(staged);
    if (await exists(destination)) throw new Error('Resource destination was created while downloading; refusing to replace it');
    await rename(staged, destination);
    return { destination, sourceRevision, scriptRevision, verified: true };
  } finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  let verify = false;
  try {
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === '--verify') verify = true;
      else if (['--destination', '--cache'].includes(arg) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) options[arg.slice(2)] = path.resolve(process.argv[++i]);
      else throw new Error('Usage: node scripts/bettergi/fetch-resources.mjs [--verify] [--destination DIR] [--cache DIR]');
    }
    console.log(JSON.stringify(await (verify ? verifyResources(options.destination || path.join(project, 'third_party/bettergi')) : fetchResources(options))));
  } catch (error) {
    console.error(`Resource setup failed: ${error.message}`);
    console.error('Existing resources and cached downloads were preserved. Choose a new --destination for a fresh import.');
    process.exitCode = 1;
  }
}
