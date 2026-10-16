import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BetterGiHost, PROJECT_ROOT, VENDOR_ROOT } from './host.mjs';

export async function validateLive({ timeoutMs = 180000, runDir = path.join(PROJECT_ROOT, 'data/bettergi/validation', String(Date.now())) } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Live validation deadline exceeded')), timeoutMs);
  const result = { startedAt: new Date().toISOString(), runDir, checks: {}, allTasksVerified: false };
  let host, failed = false;
  try {
    await mkdir(runDir, { recursive: true });
    host = await BetterGiHost.connect({ signal: controller.signal, runDir });
    result.status = await host.game.assertConnected();
    if (!result.status.headless || result.status.pointerLock || !result.status.pointerLockGetterNative || result.status.pointerLockOwnOverride) throw new Error('Validation requires native headless state without pointer-lock overrides');
    result.sdkSha256 = host.game.options.sdkSha256;
    await host.checkpoint('before');
    await host.exclusiveTask('validate-live', async () => {
      await host.native.returnMainUi();
      if (!await host.native.isInMainUi()) throw new Error('Main game UI not observed');
      result.checks.mainUi = { passed: true };
      const angleBefore = await host.call('genshin.getCameraOrientation');
      await host.input('moveMouseBy', [300, 0], true); await host.sleep(1000);
      const angleAfter = await host.call('genshin.getCameraOrientation');
      const angleDelta = Math.abs(((angleAfter - angleBefore + 540) % 360) - 180);
      await host.checkpoint('camera-after');
      result.checks.camera = { passed: angleDelta >= 5, angleBefore, angleAfter, angleDelta, evidence: 'originalCameraOrientationOnLivePixels' };
      if (!result.checks.camera.passed) throw new Error('Camera movement not observed');
      const before = await host.call('genshin.getPositionFromMap', { args: ['Teyvat', 0] });
      try { await host.input('keyDown', ['S']); await host.sleep(1000); }
      finally { await host.input('keyUp', ['S']); }
      await host.sleep(1000);
      const after = await host.call('genshin.getPositionFromMap', { args: ['Teyvat', 0] });
      const displacement = before && after ? Math.hypot(after.x - before.x, after.y - before.y) : null;
      await host.checkpoint('walk-after');
      result.checks.walk = { passed: displacement !== null && displacement >= .5, before, after, displacement, evidence: 'originalMinimapLocalizationOnLivePixels' };
      if (!result.checks.walk.passed) throw new Error('Walking displacement not observed');
      result.checks.originalPackage = { package: '取消任务追踪', ...(await host.runScript({ scriptRoot: path.join(VENDOR_ROOT, 'scripts/repo/js/取消任务追踪'), timeoutMs: 60000 })) };
      result.checks.originalPackage.passed = await host.native.isInMainUi();
      if (!result.checks.originalPackage.passed) throw new Error('Original script did not return to main UI');
      await host.input('keyPress', ['ESCAPE']); await host.sleep(1000);
      const menuObserved = !await host.native.isInMainUi();
      await host.checkpoint('menu'); await host.native.returnMainUi();
      result.checks.menu = { passed: menuObserved && await host.native.isInMainUi() };
      if (!result.checks.menu.passed) throw new Error('Menu transition not observed');
    }, { pauseRealtime: false, signal: controller.signal });
    result.statusAfter = await host.game.status();
    if (result.statusAfter.pointerLock || !result.statusAfter.pointerLockGetterNative || result.statusAfter.pointerLockOwnOverride) throw new Error('Pointer-lock state changed during validation');
    result.passed = true; await host.checkpoint('after');
  } catch (error) {
    failed = true; result.passed = false; result.error = String(error?.message ?? error);
    if (host) await host.checkpoint('failure').catch(() => {});
  } finally {
    clearTimeout(timer);
    try { await host?.close({ ok: !failed, validation: result.checks }); }
    catch (error) { result.passed = false; result.cleanupError = String(error); }
    result.endedAt = new Date().toISOString();
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, 'validation.json'), JSON.stringify(result, null, 2));
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await validateLive(); console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
