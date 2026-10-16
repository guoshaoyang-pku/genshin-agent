import { Worker } from 'node:worker_threads';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MAILBOX_BYTES = 16 * 1024 * 1024;

export async function runScript({ scriptRoot, callHost, settings = {}, config = {}, signal, timeoutMs = 120000, entry, allowedRoots = [], stateRoot, userPathingRoot, userFightRoot, serverTimeZoneOffsetMs = 28800000 }) {
  if (typeof callHost !== 'function') throw new TypeError('callHost is required');
  signal?.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be positive');
  scriptRoot = await realpath(scriptRoot);
  stateRoot ??= fileURLToPath(new URL('../../data/bettergi/script-state/' + createHash('sha256').update(scriptRoot).digest('hex').slice(0, 24), import.meta.url));
  const manifest = JSON.parse(await readFile(path.join(scriptRoot, 'manifest.json'), 'utf8'));
  const buffer = new SharedArrayBuffer(MAILBOX_BYTES + 16);
  const header = new Int32Array(buffer, 0, 4);
  const data = new Uint8Array(buffer, 16);
  const worker = new Worker(new URL('./script-worker.mjs', import.meta.url), {
    execArgv: ['--experimental-vm-modules'],
    workerData: { scriptRoot, manifest, settings, config, entry, allowedRoots, stateRoot, userPathingRoot, userFightRoot, serverTimeZoneOffsetMs, buffer },
  });
  const scope = new AbortController();
  let activeCall = Promise.resolve(), settled = false, complete;
  const result = new Promise((resolve, reject) => {
    complete = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
  });
  const abort = () => {
    const error = signal?.reason instanceof Error ? signal.reason : new Error('BetterGI script aborted');
    scope.abort(error);
    complete(error);
    void worker.terminate();
  };
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => {
    const error = new Error(`BetterGI script exceeded ${timeoutMs}ms`);
    scope.abort(error);
    complete(error);
    void worker.terminate();
  }, timeoutMs);
  worker.on('message', message => {
    if (message.type === 'call') {
      if (settled) return;
      activeCall = (async () => {
        let response;
        try {
          scope.signal.throwIfAborted();
          response = { result: await callHost(message.op, message.args, scope.signal) };
        } catch (error) {
          response = { error: { name: error.name, message: error.message, stack: error.stack } };
        }
        if (settled) return;
        let encoded;
        try { encoded = Buffer.from(JSON.stringify(response)); } catch (error) { encoded = Buffer.from(JSON.stringify({ error: { name: error.name, message: error.message } })); }
        if (encoded.length > data.length) encoded = Buffer.from(JSON.stringify({ error: { name: 'RangeError', message: 'BetterGI host result exceeds 16 MiB mailbox' } }));
        data.set(encoded);
        Atomics.store(header, 1, encoded.length);
        Atomics.store(header, 0, 1);
        Atomics.notify(header, 0);
      })();
    } else if (message.type === 'done') complete(null, message.result);
    else if (message.type === 'error') {
      const error = new Error(message.error.message);
      Object.assign(error, message.error);
      complete(error);
    }
  });
  worker.on('error', error => complete(error));
  worker.on('exit', code => { if (!settled) complete(new Error(`BetterGI script worker exited without a result (${code})`)); });
  try { return await result; } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    scope.abort(new Error('BetterGI script scope ended'));
    await worker.terminate();
    await activeCall;
  }
}
