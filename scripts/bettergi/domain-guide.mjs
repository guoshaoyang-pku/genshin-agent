// SPDX-License-Identifier: GPL-3.0-only
// BetterGI AutoDomainTask.DevelopmentGuide.cs, c9db8b8291fe4ac25a600aee1582298005919eb2.
export const DEVELOPMENT_GUIDE = '根据提升指南选择秘境';
export const normalizeGuideDomainName = text => text.replace(/\s+/g, '').replaceAll('菫色之庭', '堇色之庭').replaceAll('董色之庭', '堇色之庭');

export async function selectDevelopmentGuideDestination(task) {
  await task.returnMainUi(); await task.input('keyPress', [task.key('OpenAdventurerHandbook', 'VK_F1')]); await task.sleep(1000);
  for (const [text, roi] of [['秘境', [.1, .2, .1, .6]], ['提升指南', [.2, .17, .18, .15]]]) {
    if (!await task.waitFor(async frame => {
      const row = (await task.relativeOcr(frame, roi)).find(row => row.text.replaceAll(' ', '') === text);
      if (!row) return false;
      await task.click(row); await task.sleep(700); return true;
    }, 12, 300)) throw new Error('提升指南：未找到' + text + '，请检查游戏语言和界面');
  }
  const known = [...(await task.domains()).keys()];
  const name = await task.waitFor(async frame => {
    const rows = (await task.relativeOcr(frame, [.39, .28, .18, .46])).sort((a, b) => a.y - b.y);
    task.host.log?.('info', '提升指南秘境OCR：' + rows.map(row => row.text).join(' | '));
    for (const row of rows) {
      const text = normalizeGuideDomainName(row.text), candidates = known.filter(name => text.includes(normalizeGuideDomainName(name)));
      if (candidates.length === 1) return candidates[0];
    }
    return null;
  }, 6, 500);
  if (!name) throw new Error('提升指南秘境名称识别或地图匹配失败；这不代表没有培养目标');
  await task.returnMainUi(); return name;
}

export async function selectDevelopmentGuideLevel(task) {
  await task.captured(frame => task.input('moveMouseTo', [frame.width / 4, frame.height / 2]));
  for (let i = 0; i < 80; i++) { await task.input('verticalScroll', [-1]); await task.sleep(20); }
  await task.sleep(600);
  const levels = await task.captured(async frame => (await task.relativeOcr(frame, [0, .14, .47, .84])).filter(row => row.text.includes('秘境'))
    .map(row => ({ row, tier: row.text.trim().match(/[IVXⅠⅡⅢⅣⅤⅥ]+$/i)?.[0] })).filter(level => level.tier).sort((a, b) => b.row.y - a.row.y));
  if (!levels.length) throw new Error('提升指南：未识别到秘境最高难度');
  for (const { row } of levels.filter(level => level.tier === levels[0].tier).sort((a, b) => a.row.y - b.row.y)) {
    await task.click(row); await task.sleep(700);
    if (await task.captured(async frame => (await task.relativeOcr(frame, [.48, .55, .5, .28])).map(row => row.text).join('').includes('需求角色'))) return row.text;
  }
  throw new Error('提升指南：最高难度没有需求角色，停止挑战');
}
