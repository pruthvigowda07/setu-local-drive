import { createApp } from './app.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
let app, stopping=false;
async function stop(){
  if(stopping)return;stopping=true;
  const deadline=setTimeout(()=>process.exit(0),5000);deadline.unref();
  await app.close();await fs.unlink(path.join(app.dataDir,'running.pid')).catch(()=>{});process.exit(0);
}
app = await createApp({lan:process.argv.includes('--lan'),onShutdown:stop});
const origin = await app.listen(Number(process.env.PORT || 4783));
await fs.writeFile(path.join(app.dataDir,'running.pid'),String(process.pid));
console.log(process.argv.includes('--quiet')?`Setu is running at ${origin}. Receiving starts paused.`:`\nSetu is running.\n\nOwner dashboard (keep this link private):\n${origin}/#key=${app.secrets.owner}\n\nReceiving starts paused. Close this process to stop Setu.\n`);
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,stop);
