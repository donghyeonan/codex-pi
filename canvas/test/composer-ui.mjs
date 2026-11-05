// Browser geometry regression: single-line Safari input must not reserve scrollbar space.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../server.mjs';
const {chromium,webkit}=await import(process.argv[2]||'playwright-core');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'canvas-composer-'));
const app=await startServer({workspace:root,port:0,codexCommand:[process.execPath,new URL('./fake-codex.mjs',import.meta.url).pathname]});
const engines=[['chromium',chromium,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],['webkit',webkit,process.argv[3]]];
await fs.mkdir('/tmp/canvas-composer-check',{recursive:true});
try{for(const [name,engine,executablePath]of engines){
 const browser=await engine.launch({executablePath,headless:true});
 try{for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.url);await page.locator('#connection').filter({hasText:'연결됨'}).waitFor({state:'attached',timeout:5000});
  assert.equal(await page.locator('body').getAttribute('data-tool'),'hand');
  async function check(short=true){const g=await page.locator('#prompt').evaluate(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect(),chat=document.getElementById('chat').getBoundingClientRect();return{height:e.clientHeight,scrollH:e.scrollHeight,width:e.clientWidth,scrollW:e.scrollWidth,line:parseFloat(s.lineHeight),pad:parseFloat(s.paddingTop)+parseFloat(s.paddingBottom),overflow:s.overflowY,inputBottom:r.bottom,chatBottom:chat.bottom,viewport:window.visualViewport?.height||innerHeight}});assert.ok(g.height>=g.line+g.pad,JSON.stringify(g));assert.ok(g.scrollW<=g.width+1,JSON.stringify(g));assert.ok(g.chatBottom<=g.viewport-8,JSON.stringify(g));assert.ok(g.inputBottom<=g.chatBottom,JSON.stringify(g));if(short){assert.ok(g.scrollH<=g.height+1,JSON.stringify(g));assert.equal(g.overflow,'hidden')}return g}
  await check();assert.equal(await page.locator('#attachments').isVisible(),false);
  await page.locator('#prompt').fill('분당 출근 자료');await check();
  await page.locator('#prompt').fill('여러 줄 입력도 잘리지 않아야 합니다.\n'.repeat(30));const long=await check(false);assert.ok(long.height<=180);assert.equal(long.overflow,'auto');
  await page.locator('#prompt').fill('');await check();
  await page.screenshot({path:`/tmp/canvas-composer-check/${name}-${width}.png`});
  await page.locator('#toggle-chat').click();await check();await page.locator('#toggle-chat').click();await check();
  assert.deepEqual(errors,[]);await page.close();console.log(`${name} ${width}px: one-line, multiline, shrink, panel toggle and bottom clearance passed`);
 }}finally{await browser.close()}
}}finally{await app.close();await fs.rm(root,{recursive:true,force:true})}
