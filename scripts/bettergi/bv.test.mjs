import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createBvTypes } from "./bv.mjs";

function caseObject(target) {
  return new Proxy(target, {
    get(object, key, receiver) {
      if (typeof key !== "string" || key in object) return Reflect.get(object, key, receiver);
      let source = object;
      while (source) {
        const name = Object.getOwnPropertyNames(source).find(value => value.toLowerCase() === key.toLowerCase());
        if (name) return Reflect.get(object, name, receiver);
        source = Object.getPrototypeOf(source);
      }
    },
    set(object, key, value, receiver) { const name = Object.keys(object).find(value => value.toLowerCase() === String(key).toLowerCase()); return Reflect.set(object, name ?? key, value, receiver); },
  });
}
const rect = (x = 0, y = 0, width = 0, height = 0) => caseObject({ x, y, width, height });
const list = (items = []) => { Object.defineProperties(items, { Count: { get: () => items.length }, count: { get: () => items.length } }); return items; };
const recognition = values => caseObject({ recognitionType: "TemplateMatch", regionOfInterest: rect(), text: "", ...values });
function fixture({ find = () => [], sleepError } = {}) {
  const events = []; let clock = 0, frames = 0, disposed = 0;
  const region = (text = "", area = rect(100, 200, 20, 40)) => ({
    text, isExist: () => true, convertSelfPositionToGameCaptureRegion: () => area,
    click() { events.push(["regionClick", text]); return this; },
    doubleClick() { events.push(["regionDoubleClick", text]); return this; },
  });
  const capture = () => {
    const frame = ++frames; events.push(["capture", frame]);
    return {
      find: ro => { const values = find(ro, frame, region); events.push(["find", frame, ro.name]); return values[0] ?? { isExist: () => false }; },
      findMulti: ro => { events.push(["ocr", frame, ro.text]); return list(find(ro, frame, region)); },
      dispose: () => { disposed++; events.push(["dispose", frame]); },
    };
  };
  const types = createBvTypes({
    caseObject, rect, list, recognition, capture, now: () => clock,
    input: (method, args, canonical = false) => events.push(["input", method, args, canonical]),
    sleep: ms => { events.push(["sleep", ms]); clock += ms; if (sleepError) throw sleepError; },
    loadAsset: (feature, asset) => { events.push(["asset", feature, asset]); return { handle: 17 }; },
  });
  return { ...types, events, region, get frames() { return frames; }, get disposed() { return disposed; }, get clock() { return clock; } };
}

test("BvPage OCR keeps original ordinal substring filtering and releases each screenshot", () => {
  const host = fixture({ find: (_ro, _frame, r) => [r("每日委托奖励"), r("委托"), r("每日委託"), r("领取")] });
  const page = new host.BvPage();
  assert.deepEqual(page.GetByText("委托").FindAll().map(value => value.text), ["每日委托奖励", "委托"]);
  assert.deepEqual(page.GetByAnyText(["委托", "领取", "委托"]).FindAll().map(value => value.text), ["每日委托奖励", "委托", "领取"]);
  assert.equal(page.Ocr().Count, 4);
  assert.equal(host.frames, 3); assert.equal(host.disposed, 3);
  for (const invalid of [[], "委托", [""], ["  "], [1], null]) assert.throws(() => page.GetByAnyText(invalid));
  const unsupported = page.Locator(recognition({ recognitionType: "OcrMatch" }));
  assert.throws(() => unsupported.FindAll(), /不被 Locator 支持/);
  assert.equal(host.disposed, 4);
});

test("BvImage loads original feature asset and locator clones ROI without duplicating Mat", () => {
  const host = fixture(); const page = new host.BvPage();
  const image = new host.BvImage("Common:paimon_menu.png", rect(1, 2, 30, 40), 0.91);
  const locator = page.GetByImage(image);
  image.RecognitionObject.RegionOfInterest.x = 77;
  assert.equal(locator.RecognitionObject.RegionOfInterest.x, 1);
  assert.equal(locator.RecognitionObject.TemplateImageMat.handle, 17);
  assert.equal(locator.RecognitionObject.Threshold, 0.91);
  locator.WithRoi(screen => rect(screen.Width - 100, 0, 100, screen.Height));
  assert.equal(locator.RecognitionObject.RegionOfInterest.x, 1820);
  assert.deepEqual(host.events, [["asset", "Common", "paimon_menu.png"]]);
  assert.throws(() => new host.BvImage("missing"), /feature:asset/);
});

test("Locator preserves delay-first fixed attempts and awaits async retry callbacks", async () => {
  const host = fixture({ find: (_ro, frame, r) => frame >= 2 ? [r("领取")] : [] });
  const locator = new host.BvPage().GetByText("领取").WithTimeout(500).WithRetryInterval(200).WithRetryAction(async results => {
    await Promise.resolve(); host.events.push(["retry", results.Count]);
  });
  const result = await locator.WaitFor();
  assert.equal(result.Count, 1);
  assert.deepEqual(host.events.map(value => value[0]), ["sleep", "capture", "ocr", "dispose", "retry", "sleep", "capture", "ocr", "dispose"]);
  assert.equal(host.clock, 400);
  const missing = fixture();
  const never = new missing.BvPage().GetByText("领取").WithTimeout(100).WithRetryInterval(200);
  await assert.rejects(never.WaitFor(), error => error.name === "TimeoutException");
  assert.equal(missing.frames, 1); assert.equal(missing.clock, 200);
  await assert.rejects(never.WaitFor(0), error => error.name === "TimeoutException");
  assert.equal(missing.frames, 2);
  assert.equal((await never.TryWaitFor()).length, 0);
  await never.TryWaitForDisappear();
  assert.throws(() => locator.WithTimeout(0), /大于 0/);
});

test("Locator ClickUntilDisappears clones default retry configuration from upstream", async () => {
  const host = fixture({ find: (_ro, frame, r) => frame < 3 ? [r("关闭")] : [] });
  host.BvLocator.DefaultTimeout = 1000; host.BvLocator.DefaultRetryInterval = 250;
  const target = new host.BvPage().GetByText("关闭").WithRetryInterval(50);
  await target.ClickUntilDisappears(100);
  assert.deepEqual(host.events.filter(value => value[0] === "sleep").map(value => value[1]), [50, 250, 250]);
  assert.equal(host.events.filter(value => value[0] === "regionClick").length, 2);
});

test("Flow evaluates alternatives on one screenshot and uses frozen target ROI for implicit clicks", async () => {
  const host = fixture({ find: (ro, _frame, r) => ro.text === "second" ? [r("second", rect(ro.regionOfInterest.x, 200, 20, 40))] : [] });
  const page = new host.BvPage(); const first = page.GetByText("first"), second = page.GetByText("second", rect(100, 0, 50, 50));
  const flow = page.Flow().WaitUntilAny([first, second], 500, 50).Click().Wait(20);
  second.WithRoi(rect(999, 0, 50, 50));
  assert.equal(await flow.Run(), page);
  assert.equal(host.frames, 1); assert.equal(host.disposed, 1);
  assert.deepEqual(host.events.filter(value => value[0] === "input"), [["input", "moveMouseTo", [110, 220], true], ["input", "leftButtonClick", [], false]]);
  assert.throws(() => flow.Wait(1), /不能再添加步骤/);
  const absent = page.GetByText("never");
  await assert.rejects(page.Flow().WaitUntilAllDisappear([absent]).Click().Run(), /没有可用的上一步识别位置/);
});

test("Flow action retries after delay, then transfers matched coordinates to the next action", async () => {
  const host = fixture({ find: (_ro, frame, r) => frame > 1 ? [r("委托")] : [] });
  const page = new host.BvPage();
  await page.Flow().KeyPress("VK_F1").WithTimeout(500).WithRetryInterval(100).UntilText("委托").Click().Run();
  assert.equal(host.clock, 200);
  assert.equal(host.events.filter(value => value[0] === "input" && value[1] === "keyPress").length, 2);
  assert.equal(host.events.filter(value => value[0] === "input" && value[1] === "leftButtonClick").length, 1);
  const action = page.Flow().KeyPress("J");
  action.UntilText("委托");
  assert.throws(() => action.WithTimeout(1), /已经设置完成条件/);
  assert.throws(() => page.Flow().KeyPress("J").WithTimeout(1).Run(), /一次性动作不支持/);
  assert.throws(() => page.Flow().Wait(0).WithDefaultTimeout(200), /添加流程步骤后/);
});

test("Flow wait and action deadlines reject a match at the deadline", async () => {
  const host = fixture({ find: () => [] }); const page = new host.BvPage();
  await assert.rejects(page.Flow().WaitUntilText("missing", null, 250, 100).Run(), /第 1 步.*超时/);
  assert.equal(host.clock, 250); assert.equal(host.frames, 3);
  const action = fixture({ find: () => [] });
  await assert.rejects(new action.BvPage().Flow().KeyPress("J").WithTimeout(250).WithRetryInterval(100).UntilText("missing").Run(), /执行 3 次后.*超时/);
  assert.equal(action.clock, 250); assert.equal(action.frames, 2);
});

test("Flow rejects concurrent execution and releases held mouse when drag is cancelled", async () => {
  const host = fixture(); let resolve;
  const flow = new host.BvPage().Flow().Do(() => new Promise(done => { resolve = done; }));
  const running = flow.Run();
  assert.throws(() => flow.Run(), /当前动作已经设置完成条件/);
  const completedFlow = flow._flow;
  await assert.rejects(completedFlow.Run(), /不能并发执行/);
  resolve(); await running;
  const cancellation = new Error("cancel drag"); cancellation.name = "AbortError";
  const cancelled = fixture({ sleepError: cancellation });
  await assert.rejects(new cancelled.BvPage().Flow().Drag(1, 2, 3, 4, 301).Run(), error => error === cancellation);
  assert.deepEqual(cancelled.events.filter(value => value[0] === "input").map(value => value[1]), ["moveMouseTo", "leftButtonDown", "leftButtonUp"]);
});

test("Page keyboard/mouse chaining preserves original normalized absolute mouse units", () => {
  const host = fixture(); const page = new host.BvPage();
  assert.equal(page.Keyboard.KeyDown("W").KeyUp("W"), page.Keyboard);
  assert.equal(page.Mouse.MoveMouseTo(32767.5, 32767.5).LeftButtonClick(), page.Mouse);
  assert.deepEqual(host.events.filter(value => value[0] === "input").at(-2), ["input", "moveMouseTo", [960, 540], true]);
  assert.throws(() => page.Mouse.XButtonClick(1), /not migrated/);
  page.Keyboard.KeyPress("VK_LBUTTON");
  assert.deepEqual(host.events.at(-1), ["input", "leftButtonClick", [], false]);
});

test("untouched AutoCommissionNova OCR module executes through BvPage", async () => {
  const source = await readFile(new URL("../../third_party/bettergi/scripts/repo/js/AutoCommissionNova/src/vision/ocr-utils.js", import.meta.url), "utf8");
  const host = fixture({ find: (_ro, _frame, r) => [r(" 委托完成 "), r("长效历练点")] });
  const previous = globalThis.BvPage;
  globalThis.BvPage = host.BvPage;
  try {
    const original = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    assert.equal(original.bvPageOcrRegion(rect(880, 165, 160, 45)).Count, 2);
    assert.equal(original.bvPageOcrRegionText(), "委托完成");
    assert.equal(host.frames, 2); assert.equal(host.disposed, 2);
  } finally { if (previous === undefined) delete globalThis.BvPage; else globalThis.BvPage = previous; }
});
