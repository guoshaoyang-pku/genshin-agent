import { click, ocr, out, pageInfo, press, shot, withPage } from '../lib/core.mjs';

export async function run(name, args = {}) {
  if (!['mail', 'commissions'].includes(name)) throw new Error('menu: mail | commissions');
  await withPage(async (page) => {
    const info = await pageInfo(page);
    if (new URL(info.url).hostname !== 'ys.mihoyo.com' || info.dpr !== 1)
      throw new Error('需要云原神页面和 DPR=1');
    const video = page.locator('video.game-player__video');
    if (await video.count() !== 1) throw new Error('未找到唯一游戏视频；请先进入游戏');
    const box = await video.boundingBox();
    if (!box || !info.videos.some(v => v.readyState === 4 && v.w === 1920))
      throw new Error('视频尚未就绪');
    const evidence = [];
    const start = Date.now();
    async function observe(label) {
      if (Date.now() - start > 90000) throw new Error('菜单流程超过 90 秒，停止');
      const s = await shot(page, `menu-${start}-${label}`);
      evidence.push(s.path);
      return ocr(s.path, 0.7);
    }
    const has = (items, text) => items.some(i => i.text.includes(text));
    async function point(x, y) {
      await click(page, box.x + x * box.width / 1680, box.y + y * box.height / 944, { waitAfter: 1000 });
    }
    async function textClick(items, text) {
      const hits = items.filter(i => i.text === text);
      if (hits.length !== 1) throw new Error(`按钮不唯一或不可见: ${text}`);
      const h = hits[0];
      await click(page, (h.x1 + h.x2) / 2, (h.y1 + h.y2) / 2, { waitAfter: 2500 });
    }
    let items = await observe('before');
    const paimon = list => has(list, '冒险等阶') && has(list, '队伍配置');
    const mail = list => has(list, '邮件数') && has(list, '全部领取');
    if (!(name === 'mail' && mail(items)) && !paimon(items)) {
      if (!has(items, 'UID') || !has(items, 'Enter'))
        throw new Error('起点必须为游戏主画面、派蒙菜单或邮箱；未发送输入');
      await press(page, 'Escape', { waitAfter: 1000 });
      items = await observe('paimon');
      if (!paimon(items)) throw new Error('Escape 后未确认派蒙菜单');
    }
    if (name === 'mail') {
      if (!mail(items)) {
        await point(41, 530);
        items = await observe('mail');
      }
      if (!mail(items)) throw new Error('未确认邮箱');
      if (args.claim !== true) return out(true, { status: 'mail_open', evidence });
      await textClick(items, '全部领取');
      items = await observe('claim');
      if (!(has(items, '获得') && has(items, '邮件附件'))) {
        process.exitCode = 1;
        return out(false, { status: 'claim_unconfirmed', evidence }, '可能没有附件可领；不将无变化视作成功，不重试');
      }
      const rewards = items.map(i => i.text);
      await point(836, 655);
      items = await observe('after');
      if (!mail(items)) throw new Error('领取后未返回邮箱');
      return out(true, { status: 'claimed', rewards, evidence });
    }
    await textClick(items, '冒险之证');
    items = await observe('handbook');
    if (!has(items, '见闻') || !has(items, '委托')) throw new Error('未确认冒险之证');
    await textClick(items, '委托');
    items = await observe('commissions');
    if (!has(items, '每日委托奖励') || !has(items, '长效历练点')) throw new Error('未确认委托页');
    return out(true, { status: 'commissions_observed', items, evidence }, '只读取；领取奖励按钮可能是导航入口');
  });
}
