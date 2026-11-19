import {chromium} from 'playwright';
import {readFileSync,mkdirSync} from 'node:fs';
const evidence=JSON.parse(readFileSync(new URL('../../docs/bai4/chat-evidence.json',import.meta.url),'utf8'));
mkdirSync(new URL('../../docs/screenshots/',import.meta.url),{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try {
 const page=await browser.newPage({viewport:{width:1600,height:1100},deviceScaleFactor:1});
 for(const [label,id] of [['success',evidence.success[0].traceId],['error',evidence.error?.traceId]]){
  if(!id)continue;
  await page.goto('http://localhost:16686/trace/'+id,{waitUntil:'networkidle'});
  await page.getByText('POST /mcp',{exact:false}).first().waitFor();
  console.log((await page.locator('body').innerText()).slice(0,6500));
  console.log('BUTTONS',JSON.stringify(await page.locator('button').evaluateAll(es=>es.map(e=>({text:e.innerText,title:e.title,label:e.getAttribute('aria-label')})))));
  await page.screenshot({path:new URL(`../../docs/screenshots/bai4-${label}.png`,import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
 }
}finally{await browser.close();}
