import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractArchive, fetchResources, sha256 } from './fetch-resources.mjs';

const exec = promisify(execFile);
const fixtures = String.raw`
import io, pathlib, sys, tarfile, zipfile
root = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(root/'valid.nupkg', 'w') as z:
    z.writestr('test.nuspec', '<package/>')
    z.writestr('contentFiles/any/any/Assets/Model/smoke.txt', 'model')
    z.writestr('tools/install.ps1', 'must not be extracted or executed')
with zipfile.ZipFile(root/'traversal.nupkg', 'w') as z:
    z.writestr('../escape', 'bad')
with zipfile.ZipFile(root/'symlink.nupkg', 'w') as z:
    i = zipfile.ZipInfo('contentFiles/any/any/Assets/link')
    i.create_system = 3
    i.external_attr = 0o120777 << 16
    z.writestr(i, '/tmp/escape')
with tarfile.open(root/'valid.tar.gz', 'w:gz') as t:
    content = b'license'
    i = tarfile.TarInfo('repo/LICENSE')
    i.size = len(content)
    t.addfile(i, io.BytesIO(content))
with tarfile.open(root/'link.tar.gz', 'w:gz') as t:
    i = tarfile.TarInfo('repo/link')
    i.type = tarfile.SYMTYPE
    i.linkname = '../escape'
    t.addfile(i)
`;

async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'genshin-resource-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec(process.env.GENSHIN_PYTHON || 'python3', ['-c', fixtures, root]);
  return root;
}

test('archive SHA256 is computed from its complete bytes', async t => {
  const root = await directory(t);
  const filename = path.join(root, 'hash.txt');
  await writeFile(filename, 'abc');
  assert.equal(await sha256(filename), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('NuGet extraction includes content assets and specification, excluding install scripts', async t => {
  const root = await directory(t);
  const output = path.join(root, 'output');
  await extractArchive(path.join(root, 'valid.nupkg'), output, 'nuget', 'package');
  assert.equal(await readFile(path.join(output, 'package/Assets/Model/smoke.txt'), 'utf8'), 'model');
  assert.equal(await readFile(path.join(output, 'package.nuspec'), 'utf8'), '<package/>');
  assert.deepEqual((await readdir(output)).sort(), ['package', 'package.nuspec']);
});

test('NuGet traversal and symlinks are rejected before writing any files', async t => {
  const root = await directory(t);
  for (const fixture of ['traversal', 'symlink']) {
    const output = path.join(root, fixture);
    await assert.rejects(extractArchive(path.join(root, `${fixture}.nupkg`), output, 'nuget', 'package'), /Unsafe archive path|symlink refused/);
    assert.deepEqual(await readdir(output), []);
  }
});

test('tar extraction strips one root and refuses links', async t => {
  const root = await directory(t);
  await extractArchive(path.join(root, 'valid.tar.gz'), path.join(root, 'valid'), 'tar');
  assert.equal(await readFile(path.join(root, 'valid/LICENSE'), 'utf8'), 'license');
  await assert.rejects(extractArchive(path.join(root, 'link.tar.gz'), path.join(root, 'invalid'), 'tar'), /links and special files refused/);
  assert.deepEqual(await readdir(path.join(root, 'invalid')), []);
});

test('an existing incomplete destination is preserved without starting a download', async t => {
  const root = await directory(t);
  const destination = path.join(root, 'existing');
  await mkdir(destination);
  await writeFile(path.join(destination, 'local.txt'), 'preserve me');
  await assert.rejects(fetchResources({ destination, cache: path.join(root, 'unused-cache') }), /ENOENT/);
  assert.deepEqual(await readdir(destination), ['local.txt']);
  assert.equal(await readFile(path.join(destination, 'local.txt'), 'utf8'), 'preserve me');
  await assert.rejects(readdir(path.join(root, 'unused-cache')), /ENOENT/);
});
