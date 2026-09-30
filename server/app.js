import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHUNK, token, hash, seal, unseal, fail, integer, safePath, inside, body, jsonBody } from './core.js';
import { loadSecrets } from './secrets.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const loopback = ip => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
const GIB = 1024 ** 3;
export async function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.LOCAL_DATA_DIR || 'data');
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const secrets = await loadSecrets(dataDir);
  const db = new DatabaseSync(path.join(dataDir, 'harbor.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY,hash TEXT UNIQUE,secret TEXT,label TEXT,destination TEXT,expires INTEGER,maxBytes INTEGER,maxFiles INTEGER,revoked INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS guests(id TEXT PRIMARY KEY,invite TEXT REFERENCES invites(id),hash TEXT UNIQUE,name TEXT,code TEXT,status TEXT,created INTEGER,deviceId TEXT,deviceName TEXT);
    CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,guest TEXT,invite TEXT,path TEXT,batch TEXT,batchFiles INTEGER,batchBytes INTEGER,size INTEGER,offset INTEGER DEFAULT 0,destination TEXT,checksum TEXT,status TEXT,created INTEGER,localPath TEXT);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,at INTEGER,action TEXT,detail TEXT);
  `);
  for (const [table,column,type] of [['invites','hidden','INTEGER DEFAULT 0'],['invites','secret','TEXT'],['guests','hidden','INTEGER DEFAULT 0'],['guests','deviceId','TEXT'],['guests','deviceName','TEXT'],['uploads','hidden','INTEGER DEFAULT 0'],['uploads','savedRelative','TEXT'],['uploads','batchFiles','INTEGER'],['uploads','batchBytes','INTEGER'],['uploads','sourceModified','INTEGER']]) {
    if(!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  const getSetting = (key, fallback) => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? fallback;
  const setSetting = (key, value) => db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  const deviceId = getSetting('deviceId', randomUUID());
  if (!getSetting('deviceId', '')) setSetting('deviceId', deviceId);
  let deviceName = getSetting('deviceName', os.hostname() || 'Setu device').trim().slice(0,60) || 'Setu device';
  if (!getSetting('deviceName', '')) setSetting('deviceName', deviceName);
  const deviceView = () => ({id:deviceId, shortId:deviceId.slice(0,8).toUpperCase(), name:deviceName});
  let inbox = path.resolve(options.inbox || process.env.INBOX_DIR || getSetting('inbox', process.env.DEFAULT_INBOX_DIR || path.join(process.cwd(), 'inbox')));
  await fs.mkdir(inbox, { recursive: true });
  inbox = await fs.realpath(inbox);
  const staging = path.join(dataDir, 'partial'); await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  let receivingUntil = 0, receivingWindowMinutes = 0, origin = '', tunnel = null, tunnelUrl = '', tunnelError = '';
  const sessions = new Map(), locks = new Set(), rates = new Map();
  const audit = (action, detail = '') => {
    db.prepare('INSERT INTO events(at,action,detail) VALUES(?,?,?)').run(Date.now(), action, detail.slice(0,500));
    db.prepare('DELETE FROM events WHERE id < (SELECT MAX(id)-1000 FROM events)').run();
  };
  const localOwnerRequest = req => loopback(req.socket.remoteAddress) && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${req.headers.host}`).hostname) && !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'] && !req.headers.forwarded;
  const owner = req => {
    if (!localOwnerRequest(req)) return false;
    const value = req.headers.cookie?.match(/(?:^|; )harbor=([A-Za-z0-9_-]+)/)?.[1];
    return value && (sessions.get(hash(value)) || 0) > Date.now();
  };
  const requireOwner = req => { if (!owner(req)) fail(401, 'Open the owner dashboard on this PC and unlock it.'); };
  const requireReceiving = () => { if (receivingUntil <= Date.now()) fail(409, 'Receiving is paused. Ask the owner to enable it.'); };
  const guest = req => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '') || '';
    const g = db.prepare('SELECT * FROM guests WHERE hash=?').get(hash(bearer));
    if (!g) fail(401, 'Open your upload link and request access first.');
    const invite = db.prepare('SELECT * FROM invites WHERE id=?').get(g.invite);
    if (invite.revoked || invite.expires <= Date.now()) fail(403, 'This upload link has expired or was revoked.');
    return { g, invite };
  };
  const principal = req => {
    if (owner(req)) return { id: 'owner' };
    const { g, invite } = guest(req);
    if (g.status !== 'approved') fail(403, 'The owner has not approved this device.');
    return { id: g.id, invite };
  };
  const rate = (key, max) => {
    const now = Date.now(), prev = rates.get(key);
    const r = prev && prev.reset > now ? prev : { n: 0, reset: now + 60000 };
    if (++r.n > max) fail(429, 'Too many requests. Try again in a minute.');
    rates.set(key, r);
  };
  function send(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
  const uploadView = u => ({ id: u.id, path: u.path, batch: u.batch, batchFiles:u.batchFiles, batchBytes:u.batchBytes, size: u.size, offset: u.offset, destination: u.destination, status: u.status, created: u.created, checksum: u.checksum });
  const shrinkBatch = (batch, guestId, size) => db.prepare(`UPDATE uploads SET
    batchFiles=CASE WHEN batchFiles>1 THEN batchFiles-1 ELSE 1 END,
    batchBytes=CASE WHEN batchBytes>=? THEN batchBytes-? ELSE 0 END
    WHERE batch=? AND guest IS ?`).run(size,size,batch,guestId);
  async function safeDirectories(root, relative) {
    let current = root;
    for (const part of relative.split('/')) {
      current = inside(root, path.relative(root, path.join(current, part)));
      await fs.mkdir(current).catch(e => { if (e.code !== 'EEXIST') throw e; });
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail(400, 'Destination contains a link or is not a directory.');
    }
  }
  async function finishLocal(u) {
    const partial = path.join(staging, u.id);
    const stat = await fs.stat(partial);
    if (stat.size !== u.size) fail(409, 'The file is incomplete. Resume it first.');
    async function digestFile(file) {
      const digest = createHash('sha256'), input = await fs.open(file, 'r');
      try { for await (const chunk of input.createReadStream()) digest.update(chunk); }
      finally { await input.close(); }
      return digest.digest('hex');
    }
    const checksum = await digestFile(partial);
    const matches = db.prepare("SELECT id,localPath FROM uploads WHERE destination='local' AND status='complete' AND size=? AND checksum=? ORDER BY created DESC").all(u.size,checksum);
    for(const match of matches) {
      const actual = match.localPath ? await fs.realpath(match.localPath).catch(()=>null) : null;
      if(!actual || actual!==match.localPath)continue;
      const existing = await fs.stat(actual).catch(()=>null);
      if(!existing?.isFile() || existing.size!==u.size || await digestFile(actual)!==checksum)continue;
      shrinkBatch(u.batch,u.guest,u.size);
      db.prepare('DELETE FROM uploads WHERE id=?').run(u.id);
      await fs.unlink(partial).catch(()=>{});
      audit('Duplicate skipped',`${u.path} · already saved as ${match.id}`);
      return {duplicate:true,existingId:match.id};
    }
    const relative = u.savedRelative || `${u.invite || 'personal'}/${u.batch}/${u.path}`;
    await safeDirectories(inbox, relative.split('/').slice(0,-1).join('/'));
    const target = inside(inbox, relative);
    // Exclusive copy works even when data and inbox are on different Windows drives.
    try { await fs.copyFile(partial, target, 1); }
    catch(e) {
      if (e.code !== 'EEXIST') throw e;
      const existing = await fs.lstat(target);
      // A process restart after copying but before recording completion must be recoverable.
      if (existing.isSymbolicLink() || !existing.isFile() || existing.size !== u.size || await digestFile(target) !== checksum) {
        fail(409, 'A different file already exists in this batch. Start a new batch to keep both.');
      }
    }
    const handle = await fs.open(target, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    db.prepare("UPDATE uploads SET status='complete',localPath=?,checksum=? WHERE id=?").run(target, checksum, u.id);
    await fs.unlink(partial).catch(() => {});
    audit('File received', `${u.path} · ${u.size} bytes · PC`);
  }
  function stopTunnel() { if (tunnel) tunnel.kill(); tunnel = null; tunnelUrl = ''; }
  const timer = setInterval(() => {
    if (receivingUntil && receivingUntil <= Date.now()) { receivingUntil = 0; receivingWindowMinutes=0; stopTunnel(); audit('Receiving window ended'); }
    for (const [key, value] of rates) if (value.reset < Date.now()) rates.delete(key);
    for (const [key, value] of sessions) if (value < Date.now()) sessions.delete(key);
  }, 1000); timer.unref();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host || '';
      const lan = Object.values(os.networkInterfaces()).flat().filter(Boolean).map(i => i.address);
      const url = new URL(req.url, `http://${host}`);
      const allowed = ['127.0.0.1','localhost','[::1]', ...lan];
      if (tunnelUrl) allowed.push(new URL(tunnelUrl).hostname);
      if (!allowed.includes(url.hostname)) fail(403, 'Unknown host.');
      if (!['GET','HEAD'].includes(req.method)) {
        const requestOrigin = req.headers.origin;
        if (!requestOrigin || ![origin, origin.replace('127.0.0.1','localhost'), `http://${host}`, tunnelUrl].includes(requestOrigin)) fail(403, 'Request origin is not allowed.');
        if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Cross-site requests are not allowed.');
      }
      const route = url.pathname;
      const ip = req.socket.remoteAddress;
      if (route === '/api/login' && req.method === 'POST') {
        if (!localOwnerRequest(req)) fail(403, 'Owner access is only available on this PC.');
        rate(`login:${ip}`, 10);
        const input = await jsonBody(req);
        const supplied = hash(String(input.key || '')), expected = hash(secrets.owner);
        if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) fail(401, 'Incorrect owner key. Use the dashboard link from the terminal.');
        const session = token(); sessions.set(hash(session), Date.now() + 12 * 3600000);
        res.setHeader('Set-Cookie', `harbor=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
        return send(res, 200, { ok: true });
      }
      if (route === '/api/logout' && req.method === 'POST') {
        const value = req.headers.cookie?.match(/(?:^|; )harbor=([A-Za-z0-9_-]+)/)?.[1];
        if (value) sessions.delete(hash(value));
        res.setHeader('Set-Cookie', 'harbor=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return send(res, 200, { ok: true });
      }
      if (route === '/api/state' && req.method === 'GET') {
        requireOwner(req);
        const disk = await fs.statfs(inbox);
        const invites=db.prepare('SELECT id,label,destination,expires,maxBytes,maxFiles,revoked,secret FROM invites WHERE hidden=0 ORDER BY expires DESC LIMIT 100').all().map(invite=>{
          let inviteToken=null;
          if(invite.secret)try{inviteToken=unseal(invite.secret,Buffer.from(secrets.key,'base64'));}catch{}
          return {id:invite.id,label:invite.label,destination:invite.destination,expires:invite.expires,maxBytes:invite.maxBytes,maxFiles:invite.maxFiles,revoked:invite.revoked,token:inviteToken};
        });
        return send(res, 200, { inbox, receivingUntil, receivingWindowMinutes, chunkSize: CHUNK, origin,
          lanUrls: options.lan ? lan.filter(a => /^\d+\./.test(a) && !a.startsWith('127.')).map(a => `http://${a}:${server.address().port}`) : [],
          freeBytes: disk.bavail * disk.bsize, tunnelUrl, tunnelRunning: Boolean(tunnel), tunnelError,
          invites,
          device: deviceView(),
          guests: db.prepare('SELECT g.id,g.name,g.code,g.status,g.created,g.deviceId,g.deviceName,i.label FROM guests g JOIN invites i ON i.id=g.invite WHERE g.hidden=0 ORDER BY g.created DESC LIMIT 100').all(),
          uploads: db.prepare('SELECT u.*,g.name sender FROM uploads u LEFT JOIN guests g ON g.id=u.guest WHERE u.hidden=0 ORDER BY u.created DESC LIMIT 100').all().map(u => ({...uploadView(u), sender:u.sender || 'You',localPath:u.localPath || null})),
          transfers: db.prepare(`SELECT u.batch,COALESCE(g.name,'You') sender,MAX(u.batchFiles) totalFiles,MAX(u.batchBytes) totalBytes,
            COUNT(*) discoveredFiles,SUM(u.size) discoveredBytes,SUM(CASE WHEN u.status='complete' THEN 1 ELSE 0 END) receivedFiles,
            MAX(CASE WHEN u.status='uploading' THEN u.id END) activeId,
            MAX(CASE WHEN u.status='uploading' THEN u.path END) activePath,
            MAX(CASE WHEN u.status='uploading' THEN u.size END) activeSize,
            MAX(CASE WHEN u.status='uploading' THEN u.offset END) activeOffset,
            SUM(CASE WHEN u.status='complete' THEN u.size ELSE u.offset END) receivedBytes,MAX(u.created) updated
            FROM uploads u LEFT JOIN guests g ON g.id=u.guest WHERE u.hidden=0 GROUP BY u.batch,u.guest
            HAVING SUM(CASE WHEN u.status='uploading' THEN 1 ELSE 0 END)>0 ORDER BY updated DESC`).all(),
          events: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 30').all() });
      }
      if (route === '/api/events' && req.method === 'DELETE') {
        requireOwner(req);
        const result=db.prepare('DELETE FROM events').run();
        return send(res,200,{ok:true,cleared:result.changes});
      }
      if (route === '/api/receiving' && req.method === 'POST') {
        requireOwner(req); const { minutes } = await jsonBody(req);
        integer(minutes,0,10080,'Minutes'); receivingWindowMinutes=minutes; receivingUntil = minutes ? Date.now() + minutes * 60000 : 0;
        if (!minutes) stopTunnel();
        audit(minutes ? 'Receiving enabled' : 'Receiving paused', `${minutes} minutes`);
        return send(res,200,{receivingUntil,receivingWindowMinutes});
      }
      if (route === '/api/device' && req.method === 'PATCH') {
        requireOwner(req); const input = await jsonBody(req);
        const next = String(input.name || '').trim().slice(0,60);
        if (!next) fail(400,'Enter a device name.');
        deviceName = next; setSetting('deviceName',deviceName); audit('Device name changed',deviceName);
        return send(res,200,{device:deviceView()});
      }
      if (route === '/api/inbox' && req.method === 'POST') {
        requireOwner(req);
        if (locks.size || db.prepare("SELECT id FROM uploads WHERE status='uploading' LIMIT 1").get()) fail(409, 'Finish or cancel pending uploads before changing the inbox.');
        const input = await jsonBody(req);
        if (typeof input.path !== 'string' || !path.isAbsolute(input.path)) fail(400, 'Enter an absolute folder path.');
        await fs.mkdir(input.path,{recursive:true}); inbox = await fs.realpath(input.path); setSetting('inbox',inbox);
        audit('Inbox folder changed'); return send(res,200,{inbox});
      }
      if (route === '/api/invites' && req.method === 'POST') {
        requireOwner(req); const input = await jsonBody(req);
        const label = String(input.label || '').trim().slice(0,80);
        if (!label) fail(400,'Name this upload request.');
        if (input.destination !== 'local') fail(400,'Setu saves new receiving links to This PC.');
        const hours = integer(input.hours,1,168,'Hours'), maxBytes = integer(input.maxBytes,1,1024*GIB,'Byte limit'), maxFiles = integer(input.maxFiles,1,10000,'File limit');
        const id = randomUUID(), secret = token();
        db.prepare('INSERT INTO invites(id,hash,secret,label,destination,expires,maxBytes,maxFiles) VALUES(?,?,?,?,?,?,?,?)').run(id,hash(secret),seal(secret,Buffer.from(secrets.key,'base64')),label,input.destination,Date.now()+hours*3600000,maxBytes,maxFiles);
        audit('Upload link created',label); return send(res,201,{id,token:secret});
      }
      if (/^\/api\/(guests|invites)\/[\w-]+\/record$/.test(route) && req.method==='DELETE') {
        requireOwner(req);const [, , table,id]=route.split('/');
        const field=table==='guests'?'guest':'invite';
        if(db.prepare(`SELECT id FROM uploads WHERE ${field}=? AND status='uploading'`).get(id))fail(409,'Finish or cancel this sender’s pending transfers first.');
        if(table==='guests')db.prepare("UPDATE guests SET hidden=1,status='denied' WHERE id=?").run(id);
        else {db.prepare('UPDATE invites SET hidden=1,revoked=1 WHERE id=?').run(id);db.prepare("UPDATE guests SET hidden=1,status='denied' WHERE invite=?").run(id);}
        audit('Request record removed',table);return send(res,200,{ok:true});
      }
      if(route==='/api/inbox/clean-empty' && req.method==='POST') {
        requireOwner(req);
        if(locks.size || db.prepare("SELECT id FROM uploads WHERE status='uploading'").get())fail(409,'Finish or cancel pending transfers before cleaning folders.');
        let removed=0;
        async function clean(dir) {
          for(const entry of await fs.readdir(dir,{withFileTypes:true})) {
            if(!entry.isDirectory() || entry.isSymbolicLink())continue;
            const child=inside(inbox,path.relative(inbox,path.join(dir,entry.name)));
            if(await fs.realpath(child)!==child)continue;
            await clean(child);
            try{await fs.rmdir(child);removed++;}catch(e){if(!['ENOTEMPTY','EEXIST'].includes(e.code))throw e;}
          }
        }
        await clean(inbox);audit('Empty folders cleaned',String(removed));return send(res,200,{removed});
      }
      if(/^\/api\/batches\/[a-f0-9-]{36}\/record$/.test(route) && req.method==='DELETE') {
        requireOwner(req);const batch=route.split('/')[3],input=await jsonBody(req);
        const rows=db.prepare('SELECT * FROM uploads WHERE batch=? AND hidden=0').all(batch);
        if(!rows.length)fail(404,'Upload group not found.');
        if(rows.some(u=>u.status==='uploading'||locks.has(u.id)))fail(409,'Finish or cancel this upload group first.');
        let deletedFiles=0;
        if(input.deleteFiles) {
          if(rows.some(u=>u.destination!=='local'))fail(400,'This legacy file is not stored in Setu’s local inbox.');
          const targets=[];
          for(const u of rows) {
            if(!u.localPath)continue;
            const actual=await fs.realpath(u.localPath).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
            if(actual && actual!==u.localPath)fail(409,`The saved path changed for ${u.path}.`);
            if(actual)targets.push(actual);
          }
          for(const target of new Set(targets)){await fs.unlink(target);deletedFiles++;}
        }
        db.prepare('UPDATE uploads SET hidden=1 WHERE batch=?').run(batch);
        audit(input.deleteFiles?'Upload group files deleted':'Upload group cleared',`${rows.length} records`);
        return send(res,200,{ok:true,records:rows.length,deletedFiles});
      }
      if(/^\/api\/files\/[\w-]+\/record$/.test(route) && req.method==='DELETE') {
        requireOwner(req);const id=route.split('/')[3], input=await jsonBody(req);
        const u=db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
        if(!u)fail(404,'File record not found.');
        if(u.status==='uploading'||locks.has(id))fail(409,'Cancel this pending transfer first.');
        if(input.deleteFile) {
          if(u.destination!=='local'||!u.localPath)fail(400,'This legacy file is not stored in Setu’s local inbox.');
          const actual=await fs.realpath(u.localPath).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
          if(actual && actual!==u.localPath)fail(409,'The saved path has changed.');
          if(actual)await fs.unlink(actual);
        }
        db.prepare('UPDATE uploads SET hidden=1 WHERE id=?').run(id);
        audit(input.deleteFile?'Saved file deleted':'File record removed',u.path);return send(res,200,{ok:true});
      }
      if (route.match(/^\/api\/invites\/[\w-]+$/) && req.method === 'DELETE') {
        requireOwner(req); db.prepare('UPDATE invites SET revoked=1 WHERE id=?').run(route.split('/').at(-1));
        audit('Upload link revoked'); return send(res,200,{ok:true});
      }
      if (route.match(/^\/api\/guests\/[\w-]+$/) && req.method === 'PATCH') {
        requireOwner(req); const {status} = await jsonBody(req);
        if (!['approved','denied'].includes(status)) fail(400,'Choose approve or deny.');
        db.prepare('UPDATE guests SET status=? WHERE id=?').run(status,route.split('/').at(-1));
        audit(`Guest ${status}`); return send(res,200,{ok:true});
      }
      if (route === '/api/guest/request' && req.method === 'POST') {
        rate(`guest:${ip}`,15); const input = await jsonBody(req);
        const invite = db.prepare('SELECT * FROM invites WHERE hash=?').get(hash(String(input.token || '')));
        if (!invite || invite.revoked || invite.expires <= Date.now()) fail(404,'This upload link is unavailable. Ask for a new link.');
        rate(`invite:${invite.id}`,30);
        const name = String(input.name || '').trim().slice(0,80); if (!name) fail(400,'Enter your name.');
        const guestDeviceId = String(input.deviceId || '').trim().slice(0,80) || `browser-${token().slice(0,12)}`;
        const guestDeviceName = String(input.deviceName || '').trim().slice(0,60) || `${name}'s device`.slice(0,60);
        const id = randomUUID(), secret = token(), code = randomBytes(3).toString('hex').toUpperCase();
        db.prepare('INSERT INTO guests(id,invite,hash,name,code,status,created,deviceId,deviceName) VALUES(?,?,?,?,?,?,?,?,?)').run(id,invite.id,hash(secret),name,code,'pending',Date.now(),guestDeviceId,guestDeviceName);
        audit('Access requested',`${name} · ${guestDeviceName} · ${guestDeviceId.slice(0,8).toUpperCase()} · ${code}`); return send(res,201,{token:secret,code,deviceId:guestDeviceId,deviceName:guestDeviceName});
      }
      if (route === '/api/guest/inspect' && req.method === 'POST') {
        rate(`inspect:${ip}`,30); const input=await jsonBody(req);
        const invite=db.prepare('SELECT * FROM invites WHERE hash=?').get(hash(String(input.token || '')));
        if (!invite || invite.revoked || invite.expires <= Date.now()) fail(404,'This upload link is unavailable. Ask the owner for a new link.');
        return send(res,200,{label:invite.label,destination:invite.destination,expires:invite.expires,maxBytes:invite.maxBytes,receiving:receivingUntil>Date.now()});
      }
      if (route === '/api/guest/status' && req.method === 'GET') {
        const {g,invite}=guest(req);
        return send(res,200,{id:g.id,name:g.name,code:g.code,status:g.status,deviceId:g.deviceId || '',deviceName:g.deviceName || `${g.name}'s device`,label:invite.label,destination:invite.destination,
          receiving:receivingUntil>Date.now(),expires:invite.expires,maxBytes:invite.maxBytes,
          uploads:db.prepare('SELECT * FROM uploads WHERE guest=? ORDER BY created DESC LIMIT 100').all(g.id).map(uploadView)});
      }
      if (route === '/api/uploads' && req.method === 'POST') {
        requireReceiving(); const p = principal(req); rate(`upload:${p.id}`,120);
        const input = await jsonBody(req), filePath = safePath(input.path), size = integer(input.size,0,1024*GIB,'File size');
        const batchFiles=integer(input.batchFiles ?? 1,1,10000,'Batch file count');
        const batchBytes=integer(input.batchBytes ?? size,0,1024*GIB,'Batch size');
        const sourceModified=integer(input.modified ?? 0,0,Number.MAX_SAFE_INTEGER,'Modified time');
        if (!/^[a-f0-9-]{36}$/.test(input.batch || '')) fail(400,'Invalid batch.');
        const destination = p.invite?.destination || input.destination;
        if (locks.has('create')) fail(409,'Another upload is starting. Try again.');
        locks.add('create');
        let id;
        try {
        if(sourceModified) {
          const existing=db.prepare("SELECT * FROM uploads WHERE destination=? AND path=? AND size=? AND sourceModified=? AND status IN ('uploading','complete') ORDER BY CASE status WHEN 'uploading' THEN 0 ELSE 1 END,created DESC LIMIT 1").get(destination,filePath,size,sourceModified);
            const available=existing?.localPath && await fs.realpath(existing.localPath).then(actual=>actual===existing.localPath,()=>false);
            if(existing?.status==='complete' && available) {
              shrinkBatch(input.batch,p.id,size);
              audit('Duplicate skipped',`${filePath} · matched an earlier selection`);
              return send(res,200,{duplicate:true,existingId:existing.id});
            }
            if(existing?.status==='uploading' && destination==='local') {
              const partial=path.join(staging,existing.id), partialStat=await fs.stat(partial).catch(()=>null);
              if(partialStat?.isFile() && partialStat.size===existing.offset && existing.offset<existing.size) {
                db.prepare('UPDATE uploads SET guest=?,invite=?,created=? WHERE id=?').run(p.id,p.invite?.id || null,Date.now(),existing.id);
                audit('Upload resumed',`${filePath} · ${existing.offset} bytes saved`);
                return send(res,200,{id:existing.id,offset:existing.offset,chunkSize:CHUNK,resumed:true});
              }
            }
          }
          if (p.invite) {
            const reserved = db.prepare("SELECT COALESCE(SUM(size),0) bytes, COUNT(*) files FROM uploads WHERE invite=? AND status!='cancelled'").get(p.invite.id);
            if (reserved.bytes+size>p.invite.maxBytes || reserved.files>=p.invite.maxFiles) fail(413,'This upload request has reached its allowance.');
          }
          if (destination !== 'local') fail(400,'Setu saves files to This PC only. Create a new local upload link.');
          const disk = await fs.statfs(inbox), tempDisk = await fs.statfs(staging);
          const reserved = db.prepare("SELECT COALESCE(SUM(size-offset),0) bytes FROM uploads WHERE destination='local' AND status='uploading'").get().bytes;
          // Reserve room for staging plus final copy. Conservative even across separate volumes.
          if (Math.min(disk.bavail*disk.bsize,tempDisk.bavail*tempDisk.bsize) < (reserved+size)*2+128*1024*1024) fail(507,'Not enough free disk space for this upload.');
          requireReceiving(); principal(req);
          id = randomUUID();
          db.prepare('INSERT INTO uploads(id,guest,invite,path,batch,batchFiles,batchBytes,size,destination,status,created,sourceModified) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,p.id,p.invite?.id || null,filePath,input.batch,batchFiles,batchBytes,size,'local','uploading',Date.now(),sourceModified);
          const sender=p.id==='owner'?null:db.prepare('SELECT name,code FROM guests WHERE id=?').get(p.id);
          const name=(sender?.name || 'My uploads').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,60) || 'Sender';
          const folder=sender?`${name} (${sender.code})`:'My uploads';
          let relative=safePath(`${folder}/${filePath}`);
          if(await fs.lstat(inside(inbox,relative)).then(()=>true,()=>false) || db.prepare('SELECT id FROM uploads WHERE savedRelative=?').get(relative)) {
            const parsed=path.posix.parse(relative);relative=`${parsed.dir}/${parsed.name.slice(0,140)} (${id.slice(0,8)})${parsed.ext}`;
          }
          db.prepare('UPDATE uploads SET savedRelative=? WHERE id=?').run(relative,id);
          await fs.writeFile(path.join(staging,id),'',{flag:'wx',mode:0o600});
          audit('Upload started',`${filePath} · PC · ${ip}`);
          return send(res,201,{id,offset:0,chunkSize:CHUNK});
        } catch(e) {
          if (id) { db.prepare("UPDATE uploads SET status='cancelled' WHERE id=?").run(id); await fs.unlink(path.join(staging,id)).catch(()=>{}); }
          throw e;
        } finally {locks.delete('create');}
      }
      if (/^\/api\/uploads\/[\w-]+(?:\/finish)?$/.test(route)) {
        const p=principal(req), id=route.split('/')[3];
        const u=db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
        if (!u || (p.id!=='owner' && u.guest!==p.id)) fail(404,'Upload not found.');
        if (req.method==='GET') return send(res,200,uploadView(u));
        if (locks.has(id)) fail(409,'This upload is busy. Retry shortly.');
        if (locks.size>=4) fail(429,'The receiver is busy. Try again shortly.');
        locks.add(id);
        try {
          if (req.method==='DELETE') {
            if (u.status==='complete') fail(409,'Completed files are kept. Delete them from their storage destination.');
            db.prepare("UPDATE uploads SET status='cancelled' WHERE id=?").run(id);
            await fs.unlink(path.join(staging,id)).catch(()=>{});
            audit('Upload cancelled',u.path); return send(res,200,{ok:true});
          }
          requireReceiving();
          if(u.status==='complete') return send(res,200,uploadView(u));
          if(u.status!=='uploading') fail(409,'This upload was cancelled. Start again.');
          if(req.method==='POST' && route.endsWith('/finish')) {
            if(u.destination!=='local') fail(410,'This legacy cloud upload is no longer supported.');
            if(u.offset!==u.size) fail(409,'The file is incomplete.');
            const finished=await finishLocal(u);
            if(finished?.duplicate)return send(res,200,finished);
            return send(res,200,uploadView(db.prepare('SELECT * FROM uploads WHERE id=?').get(id)));
          }
          if(req.method==='PUT' && !route.endsWith('/finish')) {
            const offset=Number(req.headers['upload-offset']);
            if(!Number.isSafeInteger(offset) || offset!==u.offset) return send(res,409,{error:'Offset changed. Resume from the current position.',offset:u.offset});
            const bytes=await body(req,CHUNK);
            requireReceiving(); principal(req);
            if(!bytes.length || bytes.length!==Math.min(CHUNK,u.size-u.offset)) fail(400,'Unexpected chunk size.');
            if(u.destination!=='local') fail(410,'This legacy cloud upload is no longer supported.');
            const fd=await fs.open(path.join(staging,id),'r+');
            try { await fd.truncate(u.offset); let written=0; while(written<bytes.length) { const result=await fd.write(bytes,written,bytes.length-written,u.offset+written); written+=result.bytesWritten; } await fd.sync(); }
            finally {await fd.close();}
            db.prepare('UPDATE uploads SET offset=? WHERE id=?').run(u.offset+bytes.length,id);
            return send(res,200,uploadView(db.prepare('SELECT * FROM uploads WHERE id=?').get(id)));
          }
          fail(405,'Method not allowed.');
        } finally {locks.delete(id);}
      }
      if (/^\/api\/files\/[\w-]+\/location$/.test(route) && req.method==='POST') {
        requireOwner(req);
        const u=db.prepare("SELECT * FROM uploads WHERE id=? AND status='complete' AND destination='local'").get(route.split('/')[3]);
        if(!u?.localPath) fail(404,'Saved local file not found.');
        const actual=await fs.realpath(u.localPath).catch(()=>null);
        if(!actual) fail(404,'This file was moved or deleted from its saved location.');
        if(actual!==u.localPath) fail(409,'The saved file path has changed.');
        if(!(await fs.stat(actual)).isFile()) fail(409,'The saved location is no longer a file.');
        return send(res,200,{path:actual});
      }
      if (/^\/api\/files\/[\w-]+\/download$/.test(route) && req.method==='GET') {
        requireOwner(req);
        const u=db.prepare("SELECT * FROM uploads WHERE id=? AND status='complete'").get(route.split('/')[3]);
        if(!u || u.destination!=='local') fail(404,'Local file not found.');
        const actual=await fs.realpath(u.localPath);
        if(actual!==u.localPath) fail(409,'The file path has changed. Open it directly from your inbox.');
        const fd=await fs.open(actual,'r');
        res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':(await fd.stat()).size,
          'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(u.path.split('/').at(-1))}`});
        const stream=fd.createReadStream();stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return;
      }
      if(route==='/api/shutdown' && req.method==='POST') {
        requireOwner(req);
        if(!options.onShutdown) fail(400,'Close the application process to stop this instance.');
        send(res,200,{ok:true});setTimeout(()=>options.onShutdown(),100);return;
      }
      if(route==='/api/tunnel' && req.method==='POST') {
        requireOwner(req); requireReceiving();
        if(tunnel) return send(res,200,{url:tunnelUrl});
        tunnelError='';
        const child=spawn(process.env.CLOUDFLARED_PATH || 'cloudflared',['tunnel','--url',origin,'--no-autoupdate'],{windowsHide:true,stdio:['ignore','pipe','pipe']}); tunnel=child;
        const read=bytes=>{
          const match=bytes.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
          if(match && tunnel===child) {tunnelUrl=match[0];audit('Remote receiving enabled');}
        }; child.stdout.on('data',read);child.stderr.on('data',read);
        child.on('error',()=>{if(tunnel===child){tunnel=null;tunnelUrl='';tunnelError='Install cloudflared and restart Setu to enable remote links.';}});
        child.on('exit',()=>{if(tunnel===child){tunnel=null;tunnelUrl='';tunnelError='Tunnel stopped. You can start it again.';}});
        return send(res,202,{starting:true});
      }
      if(route==='/api/tunnel' && req.method==='DELETE') {requireOwner(req);stopTunnel();audit('Remote receiving stopped');return send(res,200,{ok:true});}
      if(route.startsWith('/api/')) fail(404,'Endpoint not found.');
      if(!['GET','HEAD'].includes(req.method)) fail(405,'Method not allowed.');
      const file = {'/':'index.html','/receive':'index.html','/app.js':'app.js','/theme.js':'theme.js','/style.css':'style.css','/icon.svg':'icon.svg'}[route];
      if(!file) fail(404,'Page not found.');
      const content=await fs.readFile(path.join(publicDir,file));
      res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8'});
      return res.end(req.method==='HEAD'?undefined:content);
    } catch(e) {
      if(res.headersSent) return res.destroy();
      const status=e.status || 500;
      if(status===500) console.error('Request failed:',e.code || e.name); // Never log tokens, URLs or request bodies.
      send(res,status,{error:status===500?'Something went wrong. Check disk access and try again.':e.message});
    }
  });
  server.requestTimeout=150000; server.headersTimeout=15000;
  return {
    server, db, secrets, dataDir,
    async listen(port=4783,host=options.lan?'0.0.0.0':'127.0.0.1') {
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
      origin=`http://127.0.0.1:${server.address().port}`;return origin;
    },
    async close() {clearInterval(timer);stopTunnel();server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));db.close();}
  };
}
