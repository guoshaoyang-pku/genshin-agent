// SPDX-License-Identifier: GPL-3.0-or-later
// Port of BetterGI Core/BgiVision at c9db8b8291fe4ac25a600aee1582298005919eb2.

export function createBvTypes({ caseObject, list, rect, recognition, capture, input, sleep, loadAsset, getMetrics = () => ({ width: 1920, height: 1080 }), now = () => performance.now(), throwIfCancelled = () => {} }) {
  const positive = (value, name) => {
    if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} 必须是大于 0 的整数`);
    return value;
  };
  const delay = async milliseconds => {
    if (!Number.isInteger(milliseconds) || milliseconds < 0) throw new RangeError("milliseconds 不能小于 0");
    await sleep(milliseconds);
  };
  const check = token => {
    throwIfCancelled();
    if (token?.isCancellationRequested === true || token?.IsCancellationRequested === true) {
      const error = new Error("取消自动任务"); error.name = "OperationCanceledException"; throw error;
    }
  };
  const cloneRecognition = source => {
    const values = Object.fromEntries(Object.entries(source).filter(([, value]) => typeof value !== "function"));
    const key = Object.keys(values).find(name => name.toLowerCase() === "regionofinterest");
    if (key) { const r = values[key]; values[key] = rect(r.x ?? r.X, r.y ?? r.Y, r.width ?? r.Width, r.height ?? r.Height); }
    return recognition(values);
  };
  const kind = ro => {
    const value = ro.recognitionType ?? ro.RecognitionType;
    return typeof value === "number" ? ["none", "templatematch", "colormatch", "ocrmatch", "ocr", "colorrangeandocr", "detect"][value] : String(value).toLowerCase();
  };
  const collection = (values, name, validate) => {
    if (values == null || typeof values === "string" || typeof values[Symbol.iterator] !== "function") throw new TypeError(`${name} 必须是集合或 JS Array`);
    const items = Array.from(values);
    if (!items.length) throw new TypeError(`${name} 不能为空`);
    if (items.some(value => !validate(value))) throw new TypeError(`${name} 包含不支持的元素类型`);
    return items;
  };
  const roi = value => value ?? rect();
  const keyboardInput = (method, key) => {
    const value = typeof key === "string" ? key.toUpperCase().replace(/^VK_/, "") : key;
    const button = ({ 1: "left", 2: "right", 4: "middle", LBUTTON: "left", RBUTTON: "right", MBUTTON: "middle" })[value];
    if ([5, 6, "XBUTTON1", "XBUTTON2"].includes(value)) throw new Error("BetterGI API is not migrated: IMouseInput.XButton");
    return button ? input(`${button}Button${method.slice(3) === "Press" ? "Click" : method.slice(3)}`, []) : input(method, [key]);
  };
  const center = region => {
    const area = region.convertSelfPositionToGameCaptureRegion();
    return [(area.x ?? area.X) + (area.width ?? area.Width) / 2, (area.y ?? area.Y) + (area.height ?? area.Height) / 2];
  };
  const nameOf = locator => locator._anyTexts.length ? `文字[${locator._anyTexts.join("|")}]` : kind(locator.recognitionObject) === "ocr" ? `文字[${locator.recognitionObject.text ?? ""}]` : kind(locator.recognitionObject) === "templatematch" ? `图像[${locator.recognitionObject.name ?? ""}]` : "识别元素";
  const describe = (targets, disappear) => `${targets.length === 1 ? nameOf(targets[0]) : `目标[${targets.map(nameOf).join(" | ")}]`}${disappear ? "消失" : "出现"}`;

  class BvImage {
    constructor(templateAsset, area = rect(), threshold = 0.8) {
      if (typeof templateAsset !== "string" || templateAsset.split(":").length !== 2) throw new TypeError("BvImage requires feature:asset");
      const [feature, asset] = templateAsset.split(":");
      this.recognitionObject = recognition({ name: templateAsset, recognitionType: "TemplateMatch", templateImageMat: loadAsset(feature, asset), regionOfInterest: area, threshold });
      return caseObject(this, "BvImage");
    }
    toRecognitionObject() { return this.recognitionObject; }
  }

  class BvLocator {
    static defaultTimeout = 10000;
    static defaultRetryInterval = 250;
    constructor(recognitionObject, cancellationToken, anyTexts = []) {
      if (!recognitionObject || typeof recognitionObject !== "object") throw new TypeError("recognitionObject is required");
      this.recognitionObject = cloneRecognition(recognitionObject);
      this.retryAction = null;
      this._token = cancellationToken;
      this._anyTexts = [...anyTexts];
      this._timeout = null;
      this._retryInterval = null;
      return caseObject(this, "BvLocator");
    }
    clone() { return new BvLocator(this.recognitionObject, this._token, this._anyTexts); }
    findAll(screen) {
      check(this._token);
      const ownScreen = !screen;
      screen ??= capture();
      try {
        if (kind(this.recognitionObject) === "templatematch") {
          const region = screen.find(this.recognitionObject);
          return list(region.isExist() ? [region] : []);
        }
        if (kind(this.recognitionObject) === "ocr") {
          const results = Array.from(screen.findMulti(this.recognitionObject));
          const text = this.recognitionObject.text ?? "";
          return list(results.filter(region => this._anyTexts.length ? this._anyTexts.some(value => region.text.includes(value)) : !text || region.text.includes(text)));
        }
        throw new Error(`不被 Locator 支持的识别类型: ${this.recognitionObject.recognitionType}`);
      } finally { if (ownScreen) screen.dispose(); }
    }
    isExist() { return this.findAll().length > 0; }
    async click(timeout) { return (await this.waitFor(timeout))[0].click(); }
    async doubleClick(timeout) { return (await this.waitFor(timeout))[0].doubleClick(); }
    async clickUntilDisappears(timeout) {
      const region = (await this.waitFor(timeout))[0].click();
      await this.clone().withRetryAction(results => results[0].click()).waitForDisappear();
      return region;
    }
    async _wait(timeout, disappear) {
      const actualTimeout = timeout ?? this._timeout ?? BvLocator.defaultTimeout;
      const interval = this._retryInterval ?? BvLocator.defaultRetryInterval;
      if (!Number.isInteger(actualTimeout)) throw new TypeError("timeout 必须是整数");
      positive(interval, "retryInterval");
      const attempts = Math.max(1, Math.floor(actualTimeout / interval));
      for (let i = 0; i < attempts; i++) {
        check(this._token);
        await delay(interval);
        check(this._token);
        const results = this.findAll();
        if (disappear ? results.length === 0 : results.length > 0) return results;
        if (this.retryAction) await this.retryAction(results);
      }
      const error = new Error(`识别${nameOf(this)}在 ${actualTimeout}ms 后超时未${disappear ? "消失" : "出现"}！`); error.name = "TimeoutException"; throw error;
    }
    waitFor(timeout) { return this._wait(timeout, false); }
    async tryWaitFor(timeout) { try { return await this.waitFor(timeout); } catch { return list(); } }
    async waitForDisappear(timeout) { await this._wait(timeout, true); }
    async tryWaitForDisappear(timeout) { try { await this.waitForDisappear(timeout); } catch {} }
    withRoi(value) {
      const metrics = getMetrics();
      this.recognitionObject.regionOfInterest = typeof value === "function" ? value(rect(0, 0, metrics.width, metrics.height)) : value;
      return this;
    }
    withRetryAction(action) { if (action != null && typeof action !== "function") throw new TypeError("action must be a function"); this.retryAction = action; return this; }
    withTimeout(timeout) { this._timeout = positive(timeout, "timeout"); return this; }
    withRetryInterval(interval) { this._retryInterval = positive(interval, "retryInterval"); return this; }
  }

  class BvPage {
    constructor(cancellationToken) {
      this._token = cancellationToken;
      this.defaultTimeout = 10000;
      this.defaultRetryInterval = 1000;
      const keyboard = {};
      for (const method of ["keyDown", "keyUp", "keyPress"]) keyboard[method] = key => { check(this._token); keyboardInput(method, key); return this.keyboard; };
      keyboard.sleep = ms => { sleep(ms); return this.keyboard; };
      this.keyboard = caseObject(keyboard, "IKeyboardInput");
      const mouse = {};
      for (const method of ["moveMouseBy", "leftButtonDown", "leftButtonUp", "leftButtonClick", "rightButtonDown", "rightButtonUp", "rightButtonClick", "middleButtonDown", "middleButtonUp", "middleButtonClick", "verticalScroll"]) mouse[method] = (...args) => { check(this._token); input(method, args); return this.mouse; };
      mouse.moveMouseTo = (x, y) => {
        check(this._token);
        const metrics = getMetrics();
        input("moveMouseTo", [x * metrics.width / 65535, y * metrics.height / 65535], true);
        return this.mouse;
      };
      for (const action of ["Down", "Up", "Click"]) mouse[`xButton${action}`] = () => { throw new Error("BetterGI API is not migrated: IMouseInput.XButton"); };
      mouse.sleep = ms => { sleep(ms); return this.mouse; };
      this.mouse = caseObject(mouse, "IMouseInput");
      return caseObject(this, "BvPage");
    }
    flow() { return new BvFlow(this, this.defaultTimeout, this.defaultRetryInterval); }
    screenshot() { check(this._token); return capture(); }
    async wait(milliseconds) { check(this._token); await delay(milliseconds); return this; }
    throwIfCancellationRequested() { check(this._token); }
    locator(value, area = rect()) {
      if (value instanceof BvImage) value = value.toRecognitionObject();
      else if (typeof value === "string") value = recognition({ recognitionType: "Ocr", regionOfInterest: area, text: value });
      return new BvLocator(value, this._token);
    }
    getByText(text = "", area = rect()) { return this.locator(text, area); }
    getByAnyText(texts, area = rect()) {
      const candidates = collection(texts, "texts", value => typeof value === "string");
      if (candidates.some(value => !value.trim())) throw new TypeError("候选文本不能包含空字符串或纯空白字符串");
      return new BvLocator(recognition({ recognitionType: "Ocr", regionOfInterest: area }), this._token, [...new Set(candidates)]);
    }
    getByImage(image) { return this.locator(image); }
    ocr(area = rect()) { return this.locator("", area).findAll(); }
    click(x, y) { check(this._token); input("click", [x, y], true); }
  }

  class BvFlow {
    constructor(page, timeout, interval) {
      this._page = page;
      this.defaultTimeout = positive(timeout, "defaultTimeout");
      this.defaultRetryInterval = positive(interval, "defaultRetryInterval");
      this._steps = []; this._started = false; this._running = false;
      return caseObject(this, "BvFlow");
    }
    withDefaultTimeout(milliseconds) { if (this._steps.length) throw new Error("添加流程步骤后不能修改流程默认配置"); this.defaultTimeout = positive(milliseconds, "milliseconds"); return this; }
    withDefaultRetryInterval(milliseconds) { if (this._steps.length) throw new Error("添加流程步骤后不能修改流程默认配置"); this.defaultRetryInterval = positive(milliseconds, "milliseconds"); return this; }
    _add(description, action) { if (this._started) throw new Error("BvFlow 已经开始执行，不能再添加步骤"); this._steps.push({ description, action }); return this; }
    _action(description, action) { if (this._started) throw new Error("BvFlow 已经开始执行，不能再添加步骤"); return new BvFlowAction(this, description, action); }
    _targets(targets) { return collection(targets, "targets", value => value instanceof BvLocator).map(value => value.clone()); }
    _point(args, context) {
      if (args.length) { if (args.length !== 2) throw new TypeError("Expected x and y"); return args; }
      if (!context.lastCenter) throw new Error("没有可用的上一步识别位置，无法执行隐式坐标操作");
      return context.lastCenter;
    }
    _pointAction(method, args) { return this._action(`${method}(${args.length ? args.join(", ") : "previous"})`, context => { const point = this._point(args, context); input("moveMouseTo", point, true); if (method !== "MoveTo") input({ Click: "leftButtonClick", RightClick: "rightButtonClick", MiddleClick: "middleButtonClick" }[method], []); }); }
    do(action) { if (typeof action !== "function") throw new TypeError("action must be a function"); return this._action("Do", () => action()); }
    keyPress(key) { return this._action(`KeyPress(${key})`, () => keyboardInput("keyPress", key)); }
    click(...args) { return this._pointAction("Click", args); }
    rightClick(...args) { return this._pointAction("RightClick", args); }
    middleClick(...args) { return this._pointAction("MiddleClick", args); }
    moveTo(...args) { return this._pointAction("MoveTo", args); }
    async _drag(from, to, duration) {
      input("moveMouseTo", from, true); input("leftButtonDown", []);
      try { const firstDelay = Math.floor(duration / 2); await this._page.wait(firstDelay); input("moveMouseTo", to, true); await this._page.wait(duration - firstDelay); }
      finally { input("leftButtonUp", []); }
    }
    drag(fromX, fromY, toX, toY, duration = 300) { positive(duration, "duration"); return this._action("Drag", () => this._drag([fromX, fromY], [toX, toY], duration)); }
    dragTo(toX, toY, duration = 300) { positive(duration, "duration"); return this._action("DragTo", context => this._drag(this._point([], context), [toX, toY], duration)); }
    dragFrom(fromX, fromY, duration = 300) { positive(duration, "duration"); return this._action("DragFrom", context => this._drag([fromX, fromY], this._point([], context), duration)); }
    _find(targets, disappear) {
      const screen = this._page.screenshot();
      try {
        for (const target of targets) {
          const found = target.findAll(screen);
          if (found.length) return disappear ? { succeeded: false } : { succeeded: true, match: found[0] };
        }
        return { succeeded: disappear };
      } finally { screen.dispose(); }
    }
    _wait(targets, disappear, timeout, retryInterval) {
      timeout = timeout == null ? this.defaultTimeout : positive(timeout, "timeout");
      retryInterval = retryInterval == null ? this.defaultRetryInterval : positive(retryInterval, "retryInterval");
      const description = describe(targets, disappear);
      return this._add(`WaitUntil ${description}`, async context => {
        const started = now();
        while (true) {
          this._page.throwIfCancellationRequested();
          if (now() - started >= timeout) throw timeoutError(`等待 ${description} 超时（${timeout}ms）`);
          const result = this._find(targets, disappear);
          this._page.throwIfCancellationRequested();
          if (now() - started >= timeout) throw timeoutError(`等待 ${description} 超时（${timeout}ms）`);
          if (result.succeeded) { context.lastCenter = result.match ? center(result.match) : null; return; }
          await this._page.wait(Math.min(retryInterval, Math.max(1, Math.ceil(timeout - (now() - started)))));
        }
      });
    }
    waitUntilText(text, area = rect(), timeout, interval) { return this.waitUntil(this._page.getByText(text, roi(area)), timeout, interval); }
    waitUntilAnyText(texts, area = rect(), timeout, interval) { return this.waitUntil(this._page.getByAnyText(texts, roi(area)), timeout, interval); }
    waitUntil(target, timeout, interval) { return this._wait(this._targets([target]), false, timeout, interval); }
    waitUntilAny(targets, timeout, interval) { return this._wait(this._targets(targets), false, timeout, interval); }
    waitUntilDisappear(target, timeout, interval) { return this._wait(this._targets([target]), true, timeout, interval); }
    waitUntilAllDisappear(targets, timeout, interval) { return this._wait(this._targets(targets), true, timeout, interval); }
    wait(milliseconds) { if (!Number.isInteger(milliseconds) || milliseconds < 0) throw new RangeError("milliseconds 不能小于 0"); return this._add(`Wait(${milliseconds})`, () => this._page.wait(milliseconds)); }
    async _retryAction(action, targets, disappear, timeout, interval, context) {
      const started = now(); let attempts = 0;
      const fail = () => timeoutError(`动作 ${action._description} 执行 ${attempts} 次后，等待 ${describe(targets, disappear)} 超时（${timeout}ms）`);
      while (true) {
        this._page.throwIfCancellationRequested(); attempts++; await action._callback(context);
        const remaining = timeout - (now() - started);
        if (remaining <= 0) throw fail();
        await this._page.wait(Math.min(interval, Math.max(1, Math.ceil(remaining))));
        if (now() - started >= timeout) throw fail();
        const result = this._find(targets, disappear);
        this._page.throwIfCancellationRequested();
        if (now() - started >= timeout) throw fail();
        if (result.succeeded) { context.lastCenter = result.match ? center(result.match) : null; return; }
      }
    }
    async run() {
      if (this._running) throw new Error("同一个 BvFlow 不能并发执行");
      this._running = true; this._started = true;
      try {
        const context = { lastCenter: null };
        for (const [index, step] of [...this._steps].entries()) {
          try { this._page.throwIfCancellationRequested(); await step.action(context); }
          catch (error) { if (["OperationCanceledException", "NormalEndException", "AbortError"].includes(error.name)) throw error; throw new Error(`BvFlow 第 ${index + 1} 步执行失败：${step.description}: ${error.message}`, { cause: error }); }
        }
        return this._page;
      } finally { this._running = false; }
    }
  }

  class BvFlowAction {
    constructor(flow, description, action) { this._flow = flow; this._description = description; this._callback = action; this._timeout = null; this._interval = null; this._completed = false; return caseObject(this, "BvFlowAction"); }
    _ensure() { if (this._completed) throw new Error("当前动作已经设置完成条件，不能再次修改或添加"); }
    withTimeout(milliseconds) { const value = positive(milliseconds, "milliseconds"); this._ensure(); this._timeout = value; return this; }
    withRetryInterval(milliseconds) { const value = positive(milliseconds, "milliseconds"); this._ensure(); this._interval = value; return this; }
    _once() {
      this._ensure();
      if (this._timeout != null || this._interval != null) throw new Error("一次性动作不支持 WithTimeout 或 WithRetryInterval，请使用 Until 系列方法设置重试条件");
      this._completed = true; return this._flow._add(this._description, this._callback);
    }
    _until(targets, disappear) {
      this._ensure(); const cloned = this._flow._targets(targets); this._completed = true;
      const timeout = this._timeout ?? this._flow.defaultTimeout, interval = this._interval ?? this._flow.defaultRetryInterval;
      return this._flow._add(this._description, context => this._flow._retryAction(this, cloned, disappear, timeout, interval, context));
    }
    untilText(text, area = rect()) { return this.until(this._flow._page.getByText(text, roi(area))); }
    untilAnyText(texts, area = rect()) { return this.until(this._flow._page.getByAnyText(texts, roi(area))); }
    until(target) { return this._until([target], false); }
    untilAny(targets) { return this._until(targets, false); }
    untilDisappear(target) { return this._until([target], true); }
    untilAllDisappear(targets) { return this._until(targets, true); }
    run() { return this._once().run(); }
  }
  for (const method of ["do", "keyPress", "click", "rightClick", "middleClick", "moveTo", "drag", "dragTo", "dragFrom", "waitUntilText", "waitUntilAnyText", "waitUntil", "waitUntilAny", "waitUntilDisappear", "waitUntilAllDisappear", "wait"]) {
    BvFlowAction.prototype[method] = function (...args) {
      if (method === "do" && typeof args[0] !== "function") throw new TypeError("action must be a function");
      if (["drag", "dragTo", "dragFrom"].includes(method)) positive(args[method === "drag" ? 4 : 2] ?? 300, "duration");
      if (method === "wait" && (!Number.isInteger(args[0]) || args[0] < 0)) throw new RangeError("milliseconds 不能小于 0");
      if (method.startsWith("waitUntil")) {
        const offset = ["waitUntilText", "waitUntilAnyText"].includes(method) ? 2 : 1;
        for (const value of args.slice(offset)) if (value != null) positive(value, "wait option");
        if (["waitUntil", "waitUntilDisappear"].includes(method)) this._flow._targets([args[0]]);
        if (["waitUntilAny", "waitUntilAllDisappear"].includes(method)) this._flow._targets(args[0]);
        if (method === "waitUntilAnyText") this._flow._page.getByAnyText(args[0], roi(args[1]));
      }
      return this._once()[method](...args);
    };
  }
  function timeoutError(message) { const error = new Error(message); error.name = "TimeoutException"; return error; }
  return Object.fromEntries(Object.entries({ BvPage, BvLocator, BvImage, BvFlow, BvFlowAction }).map(([name, value]) => [name, caseObject(value, name)]));
}
