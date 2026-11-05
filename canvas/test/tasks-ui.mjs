// Browser task lifecycle: topbar task, 새 작업, selector reopen, delete dialog cancel/Esc/confirm, busy error.
// node canvas/test/tasks-ui.mjs /path/to/playwright-core/index.mjs [webkit-executable] — temp workspace and fake Codex only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {startServer} from '../server.mjs';
const {chromium,webkit}=await import(process.argv[2]||process.env.PLAYWRIGHT_MODULE||'playwright-core');
const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'canvas-tasks-ui-')));
await fs.mkdir(path.join(root,'.canvas/artifacts'),{recursive:true});
await fs.writeFile(path.join(root,'.canvas/artifacts/legacy.json'),JSON.stringify({title:'Legacy analysis',type:'markdown',content:'# kept'}));
await fs.writeFile(path.join(root,'source.txt'),'workspace source');
const app=await startServer({workspace:root,port:0,backend:'codex',codexCommand:[process.execPath,new URL('./fake-codex.mjs',import.meta.url).pathname]});
const browser=await (process.argv[3]?webkit:chromium).launch({executablePath:process.argv[3]||process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const exists=p=>fs.lstat(p).then(()=>true,()=>false);
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[],deletes=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().endsWith('/api/tasks/delete'))deletes.push(r.postData())});
 await page.goto(app.url);await page.locator('.card[data-id=legacy]').waitFor();
 const title=page.locator('#task-title');assert.equal(await title.innerText(),'기본 작업');
 await page.getByRole('button',{name:'새 작업',exact:true}).click();await title.filter({hasText:'새 작업'}).waitFor();
 assert.equal(await page.locator('.card').count(),0);assert.equal(await page.locator('#empty').isVisible(),true);
 const id=app.task,dir=path.join(root,'.canvas/tasks',id);assert.match(id,/^[a-f0-9]{16}$/);
 await page.locator('#task-menu > summary').click();await page.locator('#task-list > button').nth(1).waitFor();
 assert.equal(await page.locator('#task-list > button[aria-current=true]').count(),1);
 await page.locator('#task-list > button').filter({hasText:'기본 작업'}).click();await page.locator('.card[data-id=legacy]').waitFor();assert.equal(await title.innerText(),'기본 작업');
 await page.locator('#task-menu > summary').click();await page.locator('#task-list > button').filter({hasText:'새 작업'}).click();await title.filter({hasText:'새 작업'}).waitFor();assert.equal(await page.locator('.card').count(),0);
 const dialog=page.locator('#delete-task-dialog');
 await page.getByRole('button',{name:'작업 삭제',exact:true}).click();await dialog.waitFor();
 const text=await dialog.innerText();for(const part of ['새 작업','영구 삭제','산출물','첨부 파일','배치','메모','대화 기록','Pi 세션 파일','워크스페이스 원본','~/.codex'])assert.ok(text.includes(part),part);
 assert.equal(await page.evaluate(()=>document.activeElement.id),'cancel-delete-task','cancel is focused by default');
 await page.getByRole('button',{name:'취소',exact:true}).click();await dialog.waitFor({state:'hidden'});
 await page.getByRole('button',{name:'작업 삭제',exact:true}).click();await dialog.waitFor();await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 assert.deepEqual(deletes,[],'cancel and Escape send no delete request');assert.equal(await exists(dir),true);assert.equal(await title.innerText(),'새 작업');
 await page.getByRole('button',{name:'작업 삭제',exact:true}).click();await page.getByRole('button',{name:'삭제',exact:true}).click();
 await title.filter({hasText:'기본 작업'}).waitFor();await page.locator('.card[data-id=legacy]').waitFor();
 assert.deepEqual(deletes.map(d=>JSON.parse(d)),[{id}]);assert.equal(await exists(dir),false);
 assert.equal(await fs.readFile(path.join(root,'source.txt'),'utf8'),'workspace source');assert.equal(await exists(path.join(root,'.canvas/artifacts/legacy.json')),true);
 await page.locator('#prompt').fill('HANG please');await page.locator('#send').click();await page.locator('#stop').waitFor();
 await page.getByRole('button',{name:'작업 삭제',exact:true}).click();await page.locator('#notice').filter({hasText:'에이전트'}).waitFor();assert.equal(await dialog.isVisible(),false);
 await page.locator('#notice').click();await page.getByRole('button',{name:'새 작업',exact:true}).click();await page.locator('#notice').filter({hasText:'409'}).waitFor();
 assert.equal(await title.innerText(),'기본 작업');assert.equal(await exists(path.join(root,'.canvas/tasks',id)),false);
 await page.locator('#stop').click();await page.locator('#stop').waitFor({state:'hidden'});
 await fs.mkdir('/tmp/canvas-tasks-ui',{recursive:true});await page.screenshot({path:'/tmp/canvas-tasks-ui/desktop.png'});
 await page.getByRole('button',{name:'작업 삭제',exact:true}).click();await dialog.waitFor();await page.screenshot({path:'/tmp/canvas-tasks-ui/dialog.png'});await page.keyboard.press('Escape');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/canvas-tasks-ui/mobile.png'});
 const bar=await page.locator('.document-bar').boundingBox(),nav=await page.locator('.view-nav').boundingBox();assert.ok(bar.x+bar.width<=nav.x,'mobile topbar does not slide under the view switch');
 if(await page.locator('#notice').isVisible())await page.locator('#notice').click();
 await page.locator('#task-menu > summary').click();assert.equal(await page.locator('#notice').isVisible(),false);for(const name of ['새 작업','작업 삭제']){const b=await page.locator('.task-menu-actions button').filter({hasText:name}).boundingBox();assert.ok(b&&b.x>=0&&b.x+b.width<=390,`${name} reachable on mobile`)}
 const list=await page.locator('#task-list').boundingBox();assert.ok(list.x>=0&&list.x+list.width<=390);await page.screenshot({path:'/tmp/canvas-tasks-ui/mobile-menu.png'});
 await page.locator('.task-menu-actions button').filter({hasText:'작업 삭제'}).click();await dialog.waitFor();await page.getByRole('button',{name:'취소',exact:true}).click();assert.deepEqual(deletes.length,1);
 assert.deepEqual(errors,[]);console.log('PASS browser: topbar task, new empty task, selector reopen, delete cancel/Esc without request, confirmed delete, busy errors');
}finally{await browser.close();await app.close();await fs.rm(root,{recursive:true,force:true})}
