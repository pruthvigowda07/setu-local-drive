import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createApp } from '../server/app.js';
import { CHUNK, safePath, seal, unseal } from '../server/core.js';

test('file paths reject traversal and Windows special names',()=>{
  for(const p of ['../a','/a','C:\\x','x/../a','NUL.txt','a:b','foo.','a//b','a\u0000b']) assert.throws(()=>safePath(p));
  assert.equal(safePath('Trip\\Day 1\\video.mp4'),'Trip/Day 1/video.mp4');
});
test('encrypted tokens authenticate ciphertext',()=>{
  const key=Buffer.alloc(32,7), value=seal('secret',key);assert.equal(unseal(value,key),'secret');
  const modified=Buffer.from(value,'base64');modified[20]^=1;assert.throws(()=>unseal(modified.toString('base64'),key));
});
test('local receiver authorization, quotas, resumability and integrity',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-test-'));
  const options={dataDir:path.join(root,'data'),inbox:path.join(root,'inbox'),clientId:''};
  let app=await createApp(options), origin=await app.listen(0), cookie;
  async function request(route,{method='GET',data,token,owner=true,raw,extra={}}={}){
    const headers={Origin:origin,...extra};
    if(owner&&cookie)headers.Cookie=cookie;
    if(token)headers.Authorization=`Bearer ${token}`;
    if(data)headers['Content-Type']='application/json';
    const res=await fetch(origin+route,{method,headers,body:raw || (data?JSON.stringify(data):undefined)});
    const result=await res.json();return {status:res.status,data:result,res};
  }
  async function login(){const r=await request('/api/login',{method:'POST',data:{key:app.secrets.owner},owner:false});assert.equal(r.status,200);cookie=r.res.headers.get('set-cookie').split(';')[0];}
  try {
    await t.test('owner routes require a key and reject cross-site requests',async()=>{
      assert.equal((await request('/api/state')).status,401);
      assert.equal((await request('/api/login',{method:'POST',data:{key:'bad'}})).status,401);
      await login();
      assert.equal((await request('/api/state')).status,200);
      await request('/api/receiving',{method:'POST',data:{minutes:10080}});
      assert.equal((await request('/api/state')).data.receivingWindowMinutes,10080);
      assert.equal((await request('/api/receiving',{method:'POST',data:{minutes:10},extra:{Origin:'https://untrusted.example'}})).status,403);
      assert.equal((await request('/api/state',{extra:{'X-Forwarded-For':'1.2.3.4'}})).status,401);
    });
    await t.test('cloud destinations are disabled',async()=>{
      assert.equal((await request('/api/google/connect',{method:'POST'})).status,404);
      assert.equal((await request('/api/google/credentials',{method:'POST',data:{}})).status,404);
      await request('/api/receiving',{method:'POST',data:{minutes:10}});
      assert.equal((await request('/api/uploads',{method:'POST',data:{path:'cloud.txt',size:1,batch:randomUUID(),destination:'drive:auto'}})).status,400);
      await request('/api/receiving',{method:'POST',data:{minutes:0}});
    });
    let invitation,guest,guestId;
    await t.test('link possession requests approval but cannot upload',async()=>{
      invitation=(await request('/api/invites',{method:'POST',data:{label:'Trip',destination:'local',hours:2,maxBytes:CHUNK+10,maxFiles:4}})).data;
      const storedInvite=app.db.prepare('SELECT secret FROM invites WHERE id=?').get(invitation.id);
      assert.notEqual(storedInvite.secret,invitation.token);
      assert.equal(unseal(storedInvite.secret,Buffer.from(app.secrets.key,'base64')),invitation.token);
      assert.equal((await request('/api/state')).data.invites.find(i=>i.id===invitation.id).token,invitation.token);
      guest=(await request('/api/guest/request',{method:'POST',owner:false,data:{token:invitation.token,name:'Alice'}})).data.token;
      guestId=app.db.prepare('SELECT id FROM guests').get().id;
      await request('/api/receiving',{method:'POST',data:{minutes:10}});
      assert.equal((await request('/api/uploads',{method:'POST',owner:false,token:guest,data:{path:'photo.jpg',size:1,batch:randomUUID()}})).status,403);
      assert.equal((await request('/api/state',{owner:false,token:guest})).status,401);
      await request(`/api/guests/${guestId}`,{method:'PATCH',data:{status:'approved'}});
    });
    let upload,saved;const content=Buffer.alloc(CHUNK+9,123);const batch=randomUUID();
    await t.test('approval binds destination and concurrent reservations enforce total allowance',async()=>{
      const r=await request('/api/uploads',{method:'POST',owner:false,token:guest,data:{path:'Trip/video.mp4',size:content.length,modified:123456789,batch,destination:'local'}});
      assert.equal(r.status,201);upload=r.data.id;
      assert.equal(app.db.prepare('SELECT destination FROM uploads WHERE id=?').get(upload).destination,'local');
      assert.equal((await request('/api/uploads',{method:'POST',owner:false,token:guest,data:{path:'too-large.jpg',size:2,batch}})).status,413);
      assert.equal((await request('/api/uploads',{method:'POST',data:{path:'../escape',size:1,batch,destination:'local'}})).status,400);
    });
    await t.test('chunks require correct offsets and exact bounded size',async()=>{
      assert.equal((await request(`/api/uploads/${upload}`,{method:'PUT',owner:false,token:guest,raw:Buffer.from('x'),extra:{'Upload-Offset':'0'}})).status,400);
      const r=await request(`/api/uploads/${upload}`,{method:'PUT',owner:false,token:guest,raw:content.subarray(0,CHUNK),extra:{'Upload-Offset':'0'}});
      assert.equal(r.status,200);assert.equal(r.data.offset,CHUNK);
      const stale=await request(`/api/uploads/${upload}`,{method:'PUT',owner:false,token:guest,raw:content.subarray(0,CHUNK),extra:{'Upload-Offset':'0'}});
      assert.equal(stale.status,409);assert.equal(stale.data.offset,CHUNK);
    });
    await t.test('restart preserves offsets and starts with receiving paused',async()=>{
      await app.close();app=await createApp(options);origin=await app.listen(0);await login();
      assert.equal((await request('/api/state')).data.receivingUntil,0);
      assert.equal((await request('/api/state')).data.receivingWindowMinutes,0);
      assert.equal((await request(`/api/uploads/${upload}`,{owner:false,token:guest})).data.offset,CHUNK);
      assert.equal((await request(`/api/uploads/${upload}`,{method:'PUT',owner:false,token:guest,raw:content.subarray(CHUNK),extra:{'Upload-Offset':String(CHUNK)}})).status,409);
      await request('/api/receiving',{method:'POST',data:{minutes:10}});
    });
    await t.test('completed nested file matches original and download is owner-only',async()=>{
      assert.equal((await request(`/api/uploads/${upload}`,{method:'PUT',owner:false,token:guest,raw:content.subarray(CHUNK),extra:{'Upload-Offset':String(CHUNK)}})).status,200);
      const r=await request(`/api/uploads/${upload}/finish`,{method:'POST',owner:false,token:guest});
      assert.equal(r.status,200);assert.equal(r.data.status,'complete');
      assert.equal(r.data.checksum,createHash('sha256').update(content).digest('hex'));
      saved=app.db.prepare('SELECT localPath FROM uploads WHERE id=?').get(upload).localPath;assert.match(saved,/Alice/);assert.deepEqual(await fs.readFile(saved),content);
      assert.equal((await request(`/api/files/${upload}/location`,{method:'POST'})).data.path,await fs.realpath(saved));
      assert.equal((await request(`/api/files/${upload}/location`,{method:'POST',owner:false,token:guest})).status,401);
      assert.equal((await request('/api/state')).data.uploads.find(u=>u.id===upload).localPath,await fs.realpath(saved));
      assert.equal((await request('/api/guest/status',{owner:false,token:guest})).data.uploads.find(u=>u.id===upload).localPath,undefined);
      await fs.rename(saved,saved+'.moved');
      assert.equal((await request(`/api/files/${upload}/location`,{method:'POST'})).status,404);
      await fs.rename(saved+'.moved',saved);
      const download=await fetch(`${origin}/api/files/${upload}/download`,{headers:{Cookie:cookie}});
      assert.deepEqual(Buffer.from(await download.arrayBuffer()),content);
      assert.equal((await request(`/api/files/${upload}/download`,{owner:false,token:guest})).status,401);
    });
    await t.test('duplicate selections are skipped early and matching bytes never create a second saved copy',async()=>{
      const before=app.db.prepare("SELECT COUNT(*) count FROM uploads WHERE status='complete'").get().count;
      const fast=await request('/api/uploads',{method:'POST',owner:false,token:guest,data:{path:'Trip/video.mp4',size:content.length,modified:123456789,batch:randomUUID(),destination:'local'}});
      assert.equal(fast.status,200);assert.equal(fast.data.duplicate,true);
      assert.equal(app.db.prepare("SELECT COUNT(*) count FROM uploads WHERE status='complete'").get().count,before);

      const duplicate=(await request('/api/uploads',{method:'POST',data:{path:'Copy/video-copy.mp4',size:content.length,modified:987654321,batch:randomUUID(),destination:'local'}})).data;
      await request(`/api/uploads/${duplicate.id}`,{method:'PUT',raw:content.subarray(0,CHUNK),extra:{'Upload-Offset':'0'}});
      await request(`/api/uploads/${duplicate.id}`,{method:'PUT',raw:content.subarray(CHUNK),extra:{'Upload-Offset':String(CHUNK)}});
      const finished=await request(`/api/uploads/${duplicate.id}/finish`,{method:'POST'});
      assert.equal(finished.status,200);assert.equal(finished.data.duplicate,true);
      assert.equal(app.db.prepare('SELECT id FROM uploads WHERE id=?').get(duplicate.id),undefined);
      assert.deepEqual(await fs.readFile(saved),content);
      await assert.rejects(fs.stat(path.join(options.inbox,'My uploads','Copy','video-copy.mp4')),{code:'ENOENT'});
    });
    await t.test('another approved sender resumes the same incomplete local upload',async()=>{
      const resumePath='Trip/shared-resume.mp4',resumeModified=246813579,resumeContent=Buffer.alloc(CHUNK+7,77);
      const resumeInvite=(await request('/api/invites',{method:'POST',data:{label:'Resume test',destination:'local',hours:2,maxBytes:resumeContent.length*3,maxFiles:4}})).data;
      const firstToken=(await request('/api/guest/request',{method:'POST',owner:false,data:{token:resumeInvite.token,name:'Resume first'}})).data.token;
      const firstGuestId=app.db.prepare("SELECT id FROM guests WHERE name='Resume first'").get().id;
      await request(`/api/guests/${firstGuestId}`,{method:'PATCH',data:{status:'approved'}});
      const first=(await request('/api/uploads',{method:'POST',owner:false,token:firstToken,data:{path:resumePath,size:resumeContent.length,modified:resumeModified,batch:randomUUID(),destination:'local'}})).data;
      await request(`/api/uploads/${first.id}`,{method:'PUT',owner:false,token:firstToken,raw:resumeContent.subarray(0,CHUNK),extra:{'Upload-Offset':'0'}});
      const second=(await request('/api/guest/request',{method:'POST',owner:false,data:{token:resumeInvite.token,name:'Resume sender'}})).data.token;
      const secondId=app.db.prepare("SELECT id FROM guests WHERE name='Resume sender'").get().id;
      await request(`/api/guests/${secondId}`,{method:'PATCH',data:{status:'approved'}});
      const resumed=await request('/api/uploads',{method:'POST',owner:false,token:second,data:{path:resumePath,size:resumeContent.length,modified:resumeModified,batch:randomUUID(),destination:'local'}});
      assert.equal(resumed.status,200);assert.equal(resumed.data.id,first.id);assert.equal(resumed.data.offset,CHUNK);assert.equal(resumed.data.resumed,true);
      assert.equal((await request(`/api/uploads/${first.id}`,{owner:false,token:firstToken})).status,404);
      await request(`/api/uploads/${first.id}`,{method:'PUT',owner:false,token:second,raw:resumeContent.subarray(CHUNK),extra:{'Upload-Offset':String(CHUNK)}});
      const finished=await request(`/api/uploads/${first.id}/finish`,{method:'POST',owner:false,token:second});
      assert.equal(finished.status,200);assert.equal(finished.data.status,'complete');
      assert.deepEqual(await fs.readFile(app.db.prepare('SELECT localPath FROM uploads WHERE id=?').get(first.id).localPath),resumeContent);
    });
    await t.test('another approved guest cannot access an upload',async()=>{
      const other=(await request('/api/guest/request',{method:'POST',owner:false,data:{token:invitation.token,name:'Bob'}})).data.token;
      const id=app.db.prepare("SELECT id FROM guests WHERE name='Bob'").get().id;
      await request(`/api/guests/${id}`,{method:'PATCH',data:{status:'approved'}});
      assert.equal((await request(`/api/uploads/${upload}`,{owner:false,token:other})).status,404);
    });
    await t.test('revoked links block existing guest sessions',async()=>{
      await request(`/api/invites/${invitation.id}`,{method:'DELETE'});
      assert.equal((await request('/api/guest/status',{owner:false,token:guest})).status,403);
    });
    await t.test('empty local files complete and cancellation releases pending uploads',async()=>{
      const create=()=>request('/api/uploads',{method:'POST',data:{path:'empty.txt',size:0,batch:randomUUID(),destination:'local'}});
      const a=await create();assert.equal(a.status,201);
      assert.equal((await request(`/api/uploads/${a.data.id}/finish`,{method:'POST'})).status,200);
      const b=await create();assert.equal((await request(`/api/uploads/${b.data.id}`,{method:'DELETE'})).status,200);
      assert.equal((await request(`/api/uploads/${b.data.id}/finish`,{method:'POST'})).status,409);
    });
    await t.test('expired invitation and paused receiver deny new transfers',async()=>{
      const expired=(await request('/api/invites',{method:'POST',data:{label:'Expired',destination:'local',hours:1,maxBytes:100,maxFiles:1}})).data;
      app.db.prepare('UPDATE invites SET expires=0 WHERE id=?').run(expired.id);
      assert.equal((await request('/api/guest/request',{method:'POST',owner:false,data:{token:expired.token,name:'Late'}})).status,404);
      await request('/api/receiving',{method:'POST',data:{minutes:0}});
      assert.equal((await request('/api/uploads',{method:'POST',data:{path:'late.txt',size:1,batch:randomUUID(),destination:'local'}})).status,409);
    });
    await t.test('finalization recovers an already-copied file without overwriting different bytes',async()=>{
      await request('/api/receiving',{method:'POST',data:{minutes:10}});
      const batch=randomUUID();
      const first=(await request('/api/uploads',{method:'POST',data:{path:'recovery.txt',size:3,batch,destination:'local'}})).data;
      await request(`/api/uploads/${first.id}`,{method:'PUT',raw:Buffer.from('abc'),extra:{'Upload-Offset':'0'}});
      app.db.prepare('UPDATE uploads SET savedRelative=NULL WHERE id=?').run(first.id);
      const dir=path.join(options.inbox,'personal',batch);await fs.mkdir(dir,{recursive:true});
      await fs.writeFile(path.join(dir,'recovery.txt'),'abc');
      assert.equal((await request(`/api/uploads/${first.id}/finish`,{method:'POST'})).status,200);
      const second=(await request('/api/uploads',{method:'POST',data:{path:'recovery.txt',size:3,batch,destination:'local'}})).data;
      app.db.prepare('UPDATE uploads SET savedRelative=NULL WHERE id=?').run(second.id);
      await request(`/api/uploads/${second.id}`,{method:'PUT',raw:Buffer.from('xyz'),extra:{'Upload-Offset':'0'}});
      assert.equal((await request(`/api/uploads/${second.id}/finish`,{method:'POST'})).status,409);
      assert.equal(await fs.readFile(path.join(dir,'recovery.txt'),'utf8'),'abc');
    });
    await t.test('whole upload groups can be cleared while keeping files or deleted with their files',async()=>{
      async function completedGroup(prefix,values) {
        const group=randomUUID(),paths=[];
        for(let index=0;index<values.length;index++) {
          const value=Buffer.from(values[index]),created=(await request('/api/uploads',{method:'POST',data:{path:`${prefix}/file-${index}.txt`,size:value.length,modified:1000+index,batch:group,batchFiles:values.length,batchBytes:values.join('').length,destination:'local'}})).data;
          await request(`/api/uploads/${created.id}`,{method:'PUT',raw:value,extra:{'Upload-Offset':'0'}});
          await request(`/api/uploads/${created.id}/finish`,{method:'POST'});
          paths.push(app.db.prepare('SELECT localPath FROM uploads WHERE id=?').get(created.id).localPath);
        }
        return {group,paths};
      }
      const kept=await completedGroup('Keep group',['k','e']);
      assert.equal((await request(`/api/batches/${kept.group}/record`,{method:'DELETE',owner:false,data:{deleteFiles:false}})).status,401);
      const cleared=await request(`/api/batches/${kept.group}/record`,{method:'DELETE',data:{deleteFiles:false}});
      assert.equal(cleared.status,200);assert.equal(cleared.data.records,2);assert.equal(cleared.data.deletedFiles,0);
      for(const file of kept.paths)assert.ok((await fs.stat(file)).isFile());
      assert.equal(app.db.prepare('SELECT COUNT(*) count FROM uploads WHERE batch=? AND hidden=0').get(kept.group).count,0);

      const removed=await completedGroup('Delete group',['x','y']);
      const deleted=await request(`/api/batches/${removed.group}/record`,{method:'DELETE',data:{deleteFiles:true}});
      assert.equal(deleted.status,200);assert.equal(deleted.data.records,2);assert.equal(deleted.data.deletedFiles,2);
      for(const file of removed.paths)await assert.rejects(fs.stat(file),{code:'ENOENT'});
    });
    await t.test('record deletion preserves files and quotas, revokes access, and empty-folder cleanup keeps files',async()=>{
      const u=app.db.prepare('SELECT * FROM uploads WHERE id=?').get(upload);
      assert.equal((await request(`/api/files/${upload}/record`,{method:'DELETE',owner:false,data:{}})).status,401);
      assert.equal((await request(`/api/files/${upload}/record`,{method:'DELETE',data:{deleteFile:false}})).status,200);
      assert.deepEqual(await fs.readFile(u.localPath),content);
      assert.ok(app.db.prepare('SELECT * FROM uploads WHERE id=?').get(upload));
      assert.ok(!(await request('/api/state')).data.uploads.some(x=>x.id===upload));
      assert.equal((await request(`/api/guests/${guestId}/record`,{method:'DELETE'})).status,200);
      assert.equal(app.db.prepare('SELECT status FROM guests WHERE id=?').get(guestId).status,'denied');
      assert.equal((await request(`/api/invites/${invitation.id}/record`,{method:'DELETE'})).status,200);
      assert.ok(!(await request('/api/state')).data.invites.some(x=>x.id===invitation.id));
      const pending=app.db.prepare("SELECT id FROM uploads WHERE status='uploading'").all();
      for(const row of pending)await request(`/api/uploads/${row.id}`,{method:'DELETE'});
      await fs.mkdir(path.join(options.inbox,'empty-test','nested'),{recursive:true});
      const clean=await request('/api/inbox/clean-empty',{method:'POST'});assert.equal(clean.status,200);assert.ok(clean.data.removed>=2);
      assert.deepEqual(await fs.readFile(u.localPath),content);
      assert.equal((await request(`/api/files/${upload}/record`,{method:'DELETE',data:{deleteFile:true}})).status,200);
      await assert.rejects(fs.stat(u.localPath),{code:'ENOENT'});
    });
    await t.test('activity records are owner-only and can be cleared without creating another event',async()=>{
      assert.ok(app.db.prepare('SELECT COUNT(*) count FROM events').get().count>0);
      assert.equal((await request('/api/events',{method:'DELETE',owner:false})).status,401);
      const cleared=await request('/api/events',{method:'DELETE'});
      assert.equal(cleared.status,200);assert.ok(cleared.data.cleared>0);
      assert.equal(app.db.prepare('SELECT COUNT(*) count FROM events').get().count,0);
      assert.deepEqual((await request('/api/state')).data.events,[]);
    });
  } finally {
    await app.close();
    if(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep) && path.basename(root).startsWith('harbor-test-'))await fs.rm(root,{recursive:true,force:true});
  }
});
