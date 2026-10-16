import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptFiles } from './script-files.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bettergi-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scriptRoot = path.join(root, 'script'), stateRoot = path.join(root, 'state');
  fs.mkdirSync(scriptRoot); fs.mkdirSync(path.join(scriptRoot, 'assets'));
  fs.writeFileSync(path.join(scriptRoot, 'assets/status.json'), '{"original":true}');
  return { root, scriptRoot, stateRoot, files: new ScriptFiles({ scriptRoot, stateRoot, rpc: () => {} }) };
}
test('copy-on-write append persists and leaves original resources unchanged', t => {
  const { scriptRoot, stateRoot, files } = fixture(t);
  assert.equal(files.readTextSync('assets\\status.json'), '{"original":true}');
  assert.equal(files.writeTextSync('assets/status.json', '\nnext', true), true);
  assert.equal(files.readTextSync('assets/status.json'), '{"original":true}\nnext');
  assert.equal(fs.readFileSync(path.join(scriptRoot, 'assets/status.json'), 'utf8'), '{"original":true}');
  assert.equal(new ScriptFiles({ scriptRoot, stateRoot }).readTextSync('assets/status.json'), '{"original":true}\nnext');
  assert.equal(files.writeTextSync('blocked.js', 'code'), false);
});
test('merged directory lists, file/directory rename and persisted source hiding', t => {
  const { scriptRoot, stateRoot, files } = fixture(t);
  assert.equal(files.createDirectory('logs/sub'), true);
  assert.equal(files.writeTextSync('logs/a.txt', 'one'), true);
  assert.deepEqual(new Set(files.readPathSync('.')), new Set(['assets', 'logs']));
  assert.deepEqual(files.readPathSync('missing'), []);
  assert.equal(files.renamePathSync('assets', 'moved'), true);
  assert.equal(files.isExists('assets/status.json'), false);
  assert.equal(files.readTextSync('moved/status.json'), '{"original":true}');
  assert.equal(files.renamePathSync('logs/a.txt', 'renamed.txt'), true);
  assert.equal(files.isFile('renamed.txt'), true);
  assert.equal(files.isFile('logs/a.txt'), false);
  const reopened = new ScriptFiles({ scriptRoot, stateRoot });
  assert.equal(reopened.isExists('assets'), false);
  assert.equal(fs.existsSync(path.join(scriptRoot, 'assets/status.json')), true);
});
test('read and write callbacks use the original error-first signature', async t => {
  const { files } = fixture(t); const calls = [];
  assert.equal(await files.readText('assets/status.json', (...args) => calls.push(args)), '{"original":true}');
  assert.deepEqual(calls.shift(), [null, '{"original":true}']);
  assert.equal(await files.readText('missing.txt', (...args) => calls.push(args)), '');
  assert.equal(typeof calls[0][0], 'string'); assert.equal(calls.shift()[1], null);
  assert.equal(await files.writeText('a.txt', 'ok', (...args) => calls.push(args)), true);
  assert.deepEqual(calls.shift(), [null, true]);
});
test('absolute/traversal/symlink paths cannot escape either resource or overlay roots', t => {
  const { root, scriptRoot, stateRoot, files } = fixture(t);
  fs.symlinkSync(root, path.join(scriptRoot, 'escape'));
  fs.symlinkSync(root, path.join(stateRoot, 'files/escape'));
  for (const name of ['../state/p.txt', '/tmp/p.txt', 'C:\\p.txt', 'escape/p.txt', 'a\0.txt']) {
    assert.throws(() => files.readTextSync(name), /escapes|Absolute|nonempty/);
    assert.throws(() => files.writeTextSync(name, 'bad'), /escapes|Absolute|nonempty/);
  }
  fs.symlinkSync(root, path.join(stateRoot, 'files/state-escape'));
  assert.throws(() => files.writeTextSync('state-escape/p.txt', 'bad'), /symlink escapes/);
});
test('image write defaults to png and missing reads use an empty Mat', t => {
  const { scriptRoot, stateRoot } = fixture(t); const calls = [];
  const files = new ScriptFiles({ scriptRoot, stateRoot, rpc: (op,args) => { calls.push({op,args}); return {handle:9}; } });
  assert.equal(files.writeImageSync('shots/frame', {handle:7}), true);
  assert.equal(path.extname(calls[0].args.path), '.png');
  assert.equal(calls[0].args.handle, 7);
  assert.deepEqual(files.readImageMatSync('absent.png'), {handle:9});
  assert.equal(calls.at(-1).args.method, 'New');
});
