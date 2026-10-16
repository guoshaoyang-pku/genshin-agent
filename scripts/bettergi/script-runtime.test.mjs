import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript } from './script-runtime.mjs';

const vendor = fileURLToPath(new URL('../../third_party/bettergi/', import.meta.url));
const descriptor = (type, handle, extra = {}) => ({ __bgiType: type, handle, x: 0, y: 0, width: 1920, height: 1080, globalX: 0, globalY: 0, text: '', ...extra });
async function fixture(t, source, extra = {}, manifest = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bettergi-script-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ name: 'fixture', main: 'main.js', ...manifest }));
  await writeFile(path.join(directory, 'main.js'), source);
  for (const [relative, content] of Object.entries(extra)) { await mkdir(path.dirname(path.join(directory, relative)), { recursive: true }); await writeFile(path.join(directory, relative), content); }
  return directory;
}
test('unmodified original cancellation package preserves sync host calls and disposed geometry', async () => {
  const calls = []; let finds = 0;
  const callHost = async (op, args) => {
    calls.push({ op, args }); await new Promise(resolve => setTimeout(resolve, 1));
    if (op === 'image.load') return descriptor('Mat', 1, { width: 44, height: 22 });
    if (op === 'capture') return descriptor('ImageRegion', 2 + finds);
    if (op === 'image.find') return ++finds === 1 ? descriptor('Region', 0, { x: 10, y: 20, width: 30, height: 40, globalX: 110, globalY: 220 }) : descriptor('Region', 0, { width: 0, height: 0 });
  };
  const result = await runScript({ scriptRoot: path.join(vendor, 'scripts/repo/js/取消任务追踪'), callHost });
  assert.equal(result.package, '取消任务追踪');
  assert.equal(finds, 2);
  assert.deepEqual(calls.filter(call => call.op === 'input').map(call => call.args), [{ method: 'keyPress', args: ['J'], canonical: false }, { method: 'click', args: [125, 240], canonical: true }]);
  assert.equal(calls.filter(call => call.op === 'genshin.returnMainUi').length, 2);
  assert.equal(calls.filter(call => call.op === 'image.dispose').length, 3);
  assert.equal(calls.find(call => call.op === 'image.find').args.recognition.templateImageMat.handle, 1);
});
test('mixed case members, setters, lists and nested crop globals', async t => {
  const scriptRoot = await fixture(t, `(async function () {
    const ro = new RecognitionObject(); ro.THRESHOLD = 0.93; ro.RegexMatchText.Add('abc');
    const screen = captureGameRegion();
    const crop = screen.DeriveCrop(10,20,400,200);
    const words = crop.FindMulti(ro);
    if (words.Count !== 2 || words.count !== 2 || [...words].length !== 2) throw Error('list ABI');
    words[0].Click(); crop.Dispose(); screen.Dispose(); words[0].Click();
    if (new Region(1,0,0,0).IsEmpty()) throw Error('empty ABI');
  })();`);
  const clicks = [];
  await runScript({ scriptRoot, callHost: async (op, args) => {
    if (op === 'capture') return descriptor('ImageRegion', 1);
    if (op === 'image.crop') return descriptor('ImageRegion', 2, { x: 10, y: 20, globalX: 10, globalY: 20, width: 400, height: 200 });
    if (op === 'image.findMulti') { assert.equal(args.recognition.threshold, 0.93); assert.deepEqual(args.recognition.regexMatchText, ['abc']); return [descriptor('Region', 0, { x: 4, y: 6, width: 20, height: 10, globalX: 14, globalY: 26 }), descriptor('Region', 0)]; }
    if (op === 'input') clicks.push(args);
  } });
  assert.deepEqual(clicks.map(click => click.args), [[24,31],[24,31]]);
});
test('ESM imports retain original images, text JSON and package paths; entry awaits IIFE', async t => {
  const scriptRoot = await fixture(t, `import { value } from '../../../packages/lib.js';
import json from './assets/config.json';
import image from './assets/a.png';
(async function () { if(value!==7 || JSON.parse(json).ok!==true || image.Width!==12) throw Error('import ABI'); await sleep(2); log.info('finished'); })();`, { 'packages/lib.js': 'export const value=7;', 'assets/config.json': '{"ok":true}', 'assets/a.png': 'fixture bytes' });
  const events = [];
  const result = await runScript({ scriptRoot, callHost: async (op,args) => { events.push({op,args}); if(op==='image.load') return descriptor('Mat',1,{width:12}); } });
  assert.equal(result.modules, 4);
  assert.equal(events.at(-1).args.text, 'finished');
});
test('settings defaults merged and Windows file separators normalized', async t => {
  const scriptRoot = await fixture(t, `(async function(){ if(settings.check!==true || settings.choice!=='override' || settings.multi.length!==0) throw Error('settings'); if(file.ReadTextSync('assets\\\\a.txt')!=='hello') throw Error('path'); })();`, { 'settings.json': JSON.stringify([{name:'check',type:'checkbox',default:true},{name:'choice',type:'select',default:'default'},{name:'multi',type:'multi-checkbox'}]), 'assets/a.txt': 'hello' }, {settings_ui:'settings.json'});
  await runScript({scriptRoot,settings:{choice:'override'},callHost:async()=>{}});
});
test('BvPage and BvImage use the real worker recognition and synchronous asset bridge', async t => {
  const scriptRoot = await fixture(t, `(async function(){
    const page=new BvPage();
    const text=page.GetByText('领取');
    if(text.FindAll().Count!==1) throw Error('Bv OCR bridge');
    const icon=new BvImage('Common/Element:paimon_menu.png');
    page.GetByImage(icon).FindAll()[0].Click();
  })();`);
  const events=[];
  await runScript({scriptRoot,callHost:async(op,args)=>{
    events.push({op,args});
    if(op==='capture') return descriptor('ImageRegion',1);
    if(op==='asset.load') return descriptor('Mat',2,{width:20,height:20});
    if(op==='image.findMulti') return [descriptor('Region',0,{text:'领取奖励',width:40,height:20}),descriptor('Region',0,{text:'取消',width:30,height:20})];
    if(op==='image.find') return descriptor('Region',0,{x:10,y:20,globalX:10,globalY:20,width:30,height:40});
  }});
  assert.deepEqual(events.find(event=>event.op==='asset.load').args,{feature:'Common/Element',file:'paimon_menu.png'});
  assert.deepEqual(events.find(event=>event.op==='input').args,{method:'click',args:[25,40],canonical:true});
  assert.equal(events.filter(event=>event.op==='image.dispose').length,2);
});
test('path escape, missing API and host error fail explicitly', async t => {
  for (const [source,pattern] of [['file.ReadTextSync("../outside.txt");', /escapes|ENOENT/], ['new PostMessage();', /not migrated: PostMessage/], ['captureGameRegion();', /host failure/]]) {
    const scriptRoot=await fixture(t,source);
    await assert.rejects(runScript({scriptRoot,callHost:async op=>{if(op==='capture')throw Error('host failure');}}),pattern);
  }
});
test('original timer/config/task constructors expose properties and pathing corpus reads', async t => {
  const userPathingRoot = await mkdtemp(path.join(os.tmpdir(), 'bettergi-user-routes-'));
  t.after(() => rm(userPathingRoot, { recursive: true, force: true }));
  await writeFile(path.join(userPathingRoot, 'route.json'), '{"positions":[]}');
  const scriptRoot = await fixture(t, `(async function(){
    const config=new AutoSkipConfig();
    if(!config.Enabled || !config.IsClickFirstChatOption()) throw Error('skip defaults');
    config.ClickChatOption='不选择选项';
    if(!config.IsClickNoneChatOption()) throw Error('skip methods');
    const timer=new RealtimeTimer('AutoSkip', config);
    timer.Interval=100; dispatcher.addTimer(timer);
    let rejected=false;try{new RealtimeTimer('AutoSkip',{});}catch{rejected=true;}
    if(!rejected) throw Error('skip constructor type');
    await dispatcher.runTask(new SoloTask('AutoCook',{test:true}));
    if(ServerTime.GetServerTimeZoneOffset()!==28800000) throw Error('server timezone');
    if(!pathingScript.IsFile('route.json') || pathingScript.ReadPathSync().Count!==1) throw Error('user routes');
    await pathingScript.RunFileFromUser('route.json');
  })();`);
  const calls=[];
  await runScript({scriptRoot,userPathingRoot,callHost:async(op,args)=>calls.push({op,args})});
  const timer=calls.find(call=>call.op==='dispatcher.addTimer').args.args[0];
  assert.equal(timer.name,'AutoSkip'); assert.equal(timer.interval,100);
  assert.equal(timer.config.clickChatOption,'不选择选项');
  assert.deepEqual(calls.find(call=>call.op==='dispatcher.runTask').args.args[0],{name:'AutoCook',config:{test:true}});
  const route=calls.find(call=>call.op==='pathingScript.run').args;
  assert.equal(route.filename,path.join(await realpath(userPathingRoot),'route.json'));
  assert.equal(route.fileContext.scriptRoot,await realpath(userPathingRoot));
});
test('YOLO detector is lazy, case insensitive, idempotently disposed and retains result geometry', async t => {
  const scriptRoot=await fixture(t, `(async function(){
    const unused=yolo.CreatePredictor('model.onnx'); unused.Dispose(); unused.Dispose();
    let stopped=false; try{unused.Detect();}catch{stopped=true;}
    if(!stopped)throw Error('disposed predictor');
    const predictor=yolo.createPredictor('model.onnx',{Confidence:.4});
    const regions=predictor.DETECT({IoU:.2});
    if(regions.Count!==1 || regions[0].Detection.Name.Name!=='ore')throw Error('YOLO ABI');
    predictor.Dispose(); predictor.Dispose(); regions[0].Click();
  })();`, {'model.onnx':'offline model fixture'});
  const calls=[];
  await runScript({scriptRoot,callHost:async(op,args)=>{
    calls.push({op,args});
    if(op==='yolo.create')return {predictor:7};
    if(op==='yolo.detect')return [descriptor('YoloRegion',0,{x:30,y:20,width:40,height:10,globalX:130,globalY:220,detection:{name:{id:0,name:'ore'},confidence:.8}})];
  }});
  assert.deepEqual(calls.filter(call=>call.op.startsWith('yolo.')).map(call=>call.op),['yolo.create','yolo.detect','yolo.dispose']);
  assert.deepEqual(calls.find(call=>call.op==='yolo.create').args,{path:path.join(await realpath(scriptRoot),'model.onnx'),options:{Confidence:.4},requireDetection:true});
  assert.deepEqual(calls.find(call=>call.op==='input').args.args,[150,225]);
});
test('task parameters retain source defaults, methods and list semantics through the real worker RPC', async t => {
  const userFightRoot = await mkdtemp(path.join(os.tmpdir(), 'bettergi-user-fights-'));
  t.after(() => rm(userFightRoot, { recursive: true, force: true }));
  await writeFile(path.join(userFightRoot, 'rotation.json'), '{}');
  const scriptRoot = await fixture(t, `(async function(){
    const fight = new AutoFightParam();
    if(fight.timeout!==37 || fight.FinishDetectConfig.PaimonEndCheckDelay!==.2) throw Error('fight config');
    const strategy=AutoFightParam.resolvestrategypath('rotation');
    if(strategy.Item2!=='json') throw Error('JSON strategy precedence');
    fight.Timeout=9; fight.setdefault();
    if(fight.Timeout!==37) throw Error('config reload');
    const domain=new AutoDomainParam(2);
    domain.setresinprioritylist('原粹树脂'); domain.RESINPRIORITYLIST.Add('浓缩树脂');
    if(domain.ResinPriorityList.Count!==2 || domain.DomainRoundNum!==2) throw Error('domain params');
    const inventory=new CountInventoryItemParam();
    inventory.ItemNames.Add('清水玉'); inventory.GridScreenName=GridScreenName.Materials;
    inventory.IconRecognitionMode=ItemIconRecognitionMode.GridIcon; inventory.VALIDATE();
    await dispatcher.RunAutoFightTask(fight);
    await dispatcher.RunAutoDomainTask(domain);
    await dispatcher.RunCountInventoryItemTask(inventory);
    log.info(strategy.Item1);
  })();`);
  const calls=[];
  await runScript({scriptRoot,userFightRoot,config:{AutoFightConfig:{Timeout:37}},callHost:async(op,args)=>calls.push({op,args})});
  const fight=calls.find(call=>call.op==='dispatcher.RunAutoFightTask').args.args[0];
  assert.equal(fight.Timeout,37); assert.equal(fight.FinishDetectConfig.PaimonEndCheckDelay,.2);
  assert.equal(fight.__bgiType,undefined); assert.equal(fight.args,undefined);
  const domain=calls.find(call=>call.op==='dispatcher.RunAutoDomainTask').args.args[0];
  assert.deepEqual(domain.ResinPriorityList,['原粹树脂','浓缩树脂']);
  assert.equal(domain.CombatStrategyPath,userFightRoot);
  const inventory=calls.find(call=>call.op==='dispatcher.RunCountInventoryItemTask').args.args[0];
  assert.deepEqual(inventory.ItemNames,['清水玉']); assert.equal(inventory.GridScreenName,4); assert.equal(inventory.IconRecognitionMode,0);
  assert.equal(calls.at(-1).args.text,path.join(userFightRoot,'rotation.json'));
});
test('script deadline aborts an active host call before returning', async t => {
  const scriptRoot=await fixture(t,'(async function(){ await sleep(60000); })();');
  let active=false,stopped=false;
  await assert.rejects(runScript({scriptRoot,timeoutMs:200,callHost:async(op,args,signal)=>{
    if(op!=='sleep')return;
    active=true;
    try{await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});signal.throwIfAborted();});}
    finally{stopped=true;}
  }}),/exceeded/);
  assert.equal(active,true);assert.equal(stopped,true);
});
test('infinite synchronous script is terminated on abort and timeout', async t => {
  const scriptRoot = await fixture(t,'while(true) {}');
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(new Error('test abort')),100);
  await assert.rejects(runScript({scriptRoot,callHost:async()=>{},signal:controller.signal}),/test abort/); clearTimeout(timer);
  await assert.rejects(runScript({scriptRoot,callHost:async()=>{},timeoutMs:100}),/exceeded/);
});
