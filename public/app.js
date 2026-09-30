const $ = id => document.getElementById(id);

function stored(key, fallback='') { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function rememberLocal(key, value) { try { localStorage.setItem(key, value); } catch {} }
function browserDeviceId() { const current=stored('setu-device-id'); if(current)return current; const value=globalThis.crypto?.randomUUID?.() || uuid(); rememberLocal('setu-device-id',value); return value; }
function browserDeviceName() { return stored('setu-device-name', navigator.platform ? `${navigator.platform} device` : 'Browser device').slice(0,60); }
function shortDeviceId(value) { return value ? String(value).slice(0,8).toUpperCase() : '—'; }

$('appearance').value = window.harborTheme.preference;

$('appearance').addEventListener('change', e => window.harborTheme.set(e.target.value));

const isGuest = location.pathname === '/receive';

const fragment = new URLSearchParams(location.hash.slice(1));

let state, guestState, guestToken = '', toastTimer, uploading = false;

const queue = [];

const bytes = n => { if (n === null || n === undefined) return 'Unknown'; if (!n) return '0 B'; const i = Math.max(0,Math.min(4,Math.floor(Math.log(n)/Math.log(1024)))); return `${(n/1024**i).toFixed(i>1?1:0)} ${['B','KB','MB','GB','TB'][i]}`; };

const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const date = n => new Date(n).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});

const destinationName = value => value === 'local' ? 'This PC' : 'Legacy cloud destination';

const icons = {
  file: '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h5"/></svg>',
  image: '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m5 18 5-5 3 3 2-2 4 4"/></svg>',
  video: '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>',
  folder: '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v10H3z"/></svg>',
  chevron: '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>'
};

const fileIcon = path => /\.(mp4|mov|mkv|webm)$/i.test(path) ? icons.video : /\.(jpg|jpeg|png|heic|webp)$/i.test(path) ? icons.image : icons.file;

const progressSamples = new Map();
function transferRate(key, received, total) {
  const now=Date.now(), previous=progressSamples.get(key);
  let speed=previous?.speed || 0;
  if(previous && received>=previous.received && now>previous.at) {
    const current=(received-previous.received)/((now-previous.at)/1000);
    if(current>0)speed=speed ? speed*.65+current*.35 : current;
  }
  progressSamples.set(key,{received,total,at:now,speed});
  return speed;
}
function duration(seconds) {
  if(!Number.isFinite(seconds)||seconds<0)return 'Calculating ETA';
  if(seconds<60)return `${Math.max(1,Math.ceil(seconds))} sec remaining`;
  if(seconds<3600)return `${Math.ceil(seconds/60)} min remaining`;
  const hours=Math.floor(seconds/3600),minutes=Math.ceil((seconds%3600)/60);
  return `${hours} hr${hours===1?'':'s'}${minutes?` ${minutes} min`:''} remaining`;
}
function commonFolder(paths) {
  if(!paths.length)return '';
  const folders=paths.map(value=>String(value).replaceAll('\\','/').split('/').slice(0,-1));
  const first=folders[0];let length=first.length;
  for(const parts of folders)while(length && parts.slice(0,length).join('/').toLowerCase()!==first.slice(0,length).join('/').toLowerCase())length--;
  return first.slice(0,length).join('\\');
}

function toast(text,error=false) {clearTimeout(toastTimer);$('toast').textContent=text;$('toast').classList.toggle('error',error);$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,6500);}

async function api(url, options={}) {

  const headers={...options.headers}; if(isGuest && guestToken) headers.Authorization=`Bearer ${guestToken}`;

  let body=options.body;

  if(body && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {headers['Content-Type']='application/json';body=JSON.stringify(body);}

  const res=await fetch(url,{...options,body,headers});

  // Proxies and tunnel edges sometimes return a plain-text error page. Keep the
  // response useful to the retry loop instead of exposing a JSON parse error.
  const text=await res.text();
  let result;
  try { result=text ? JSON.parse(text) : {}; }
  catch {
    const error=new Error(res.ok ? 'The server returned an invalid response.' : `Connection error (${res.status}).`);
    error.status=res.status; error.transient=res.status>=500 || res.status===0;
    throw error;
  }

  if(!res.ok) throw Object.assign(new Error(result.error || 'Request failed.'),{status:res.status,offset:result.offset});

  return result;

}

const action = fn => async event => {try{await fn(event);}catch(e){toast(e.message,true);}};

function page(name) {

  document.querySelectorAll('.page').forEach(el=>el.hidden=el.id!==`page-${name}`);

  document.querySelectorAll('[data-page]').forEach(el=>el.classList.toggle('active',el.dataset.page===name));

  $('crumb').textContent={inbox:'Transfer',requests:'Upload links',activity:'History',settings:'Settings'}[name];

}

document.querySelectorAll('[data-page]').forEach(el=>el.addEventListener('click',()=>page(el.dataset.page)));

document.querySelectorAll('[data-go]').forEach(el=>el.addEventListener('click',()=>page(el.dataset.go)));

document.querySelectorAll('[data-workspace-action]').forEach(el=>el.addEventListener('click',()=>{
  if(el.dataset.workspaceAction==='send-link'){ $('send-link-dialog').showModal();$('send-link-input').focus();return; }
  const target=el.dataset.workspaceAction==='send'?$('owner-drop'):el.dataset.workspaceAction==='approvals'?document.querySelector('.workspace-grid'):document.querySelector('.receiver-card');
  target?.scrollIntoView({behavior:'smooth',block:'center'});
  if(el.dataset.workspaceAction==='send')$('choose-files')?.focus();
  else if(el.dataset.workspaceAction==='approvals')$('new-request')?.focus();
  else $('receive-toggle')?.focus();
}));

$('send-link-close').onclick=()=>$('send-link-dialog').close();
$('send-link-form').addEventListener('submit',e=>{e.preventDefault();const value=$('send-link-input').value.trim();let url;try{url=new URL(value);}catch{return toast('Paste a complete receiver link.',true);}if(!['http:','https:'].includes(url.protocol)||!url.pathname.endsWith('/receive'))return toast('Use a Setu receiver link ending in /receive.',true);$('send-link-dialog').close();if(window.chrome?.webview)window.chrome.webview.postMessage(`harbor-open-url:${url.href}`);else window.open(url.href,'_blank','noopener');});
function renderFiles() {
  const needle=$('file-search').value.toLowerCase();
  const openGroups=new Set([...document.querySelectorAll('.file-group[open]')].map(group=>group.dataset.group));
  const transfers=state.transfers || [];
  $('incoming-panel').hidden=!transfers.length;
  if(transfers.length) {
    const received=transfers.reduce((n,t)=>n+Number(t.receivedBytes||0),0);
    const total=transfers.reduce((n,t)=>n+Number(t.totalBytes ?? t.discoveredBytes ?? t.receivedBytes ?? 0),0);
    const receivedFiles=transfers.reduce((n,t)=>n+Number(t.receivedFiles||0),0);
    const totalFiles=transfers.reduce((n,t)=>n+Number(t.totalFiles || t.discoveredFiles || 0),0);
    const remainingFiles=Math.max(0,totalFiles-receivedFiles);
    const key=`incoming:${transfers.map(t=>t.batch).sort().join(',')}`;
    const speed=transferRate(key,received,total),percent=Math.min(100,Math.round(received/Math.max(1,total)*100));
    $('incoming-total').textContent=`${percent}%`;
    const active=transfers.length===1?transfers[0]:null;
    const activeFile=active?.activeId?`<div class="transfer-file"><strong>Current file</strong><span title="${esc(active.activePath || '')}">${esc(active.activePath || 'Preparing file')} · ${bytes(active.activeOffset||0)} / ${bytes(active.activeSize||0)}</span></div>`:'';
    $('incoming-list').innerHTML=`<div class="transfer-overview"><div class="transfer-numbers"><strong>${bytes(received)} / ${bytes(total)}</strong><span>${receivedFiles} received · ${remainingFiles} remaining</span></div><progress max="${Math.max(1,total)}" value="${received}"></progress>${activeFile}<div class="transfer-meta"><span>${transfers.length===1?`From ${esc(transfers[0].sender)}`:`${transfers.length} senders`}</span><span>${speed?`Current ${bytes(speed)}/s · ${duration((total-received)/speed)}`:'Calculating current rate and ETA'}</span></div>${transfers.length===1&&transfers[0].activeId?`<button class="text-button danger cancel-upload" data-id="${transfers[0].activeId}">Cancel current file</button>`:''}</div>`;
  } else $('incoming-list').innerHTML='';

  const files=state.uploads.filter(u=>u.status==='complete' && u.path.toLowerCase().includes(needle));
  $('file-count').textContent=state.uploads.filter(u=>u.status==='complete').length;
  const groups=[];
  for(const file of files) {
    const key=`${file.sender}:${file.batch}`, group=groups.find(g=>g.key===key);
    if(group)group.files.push(file);else groups.push({key,files:[file]});
  }
  const fileRow=u=>`<div class="file-row"><div class="file-name"><span>${fileIcon(u.path)}</span><div><strong title="${esc(u.path)}">${u.status==='complete'&&u.destination==='local'?`<button class="text-button open-saved" data-id="${u.id}" title="Open saved original">${esc(u.path.split('/').at(-1))}</button>`:esc(u.path.split('/').at(-1))}</strong><small>${date(u.created)} · ${bytes(u.size)}</small><div class="file-actions">${u.localPath&&window.chrome?.webview?`<button class="text-button reveal-saved" data-id="${u.id}">Show in folder</button>`:''}${u.localPath?`<a href="/api/files/${u.id}/download">Download a copy</a>`:''}</div></div></div><span class="destination muted">${esc(destinationName(u.destination))}</span><span><span class="pill ${u.status==='complete'?'good':''}">${u.status==='complete'?'Received':'Cancelled'}</span><button class="icon-button bin-button delete-file-choice" data-id="${u.id}" aria-label="Delete ${esc(u.path)}" title="Delete"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg></button></span></div>`;
  $('file-list').innerHTML=groups.length?groups.map(group=>{
    const roots=group.files.map(f=>f.path.split('/')[0]),folder=roots.every(root=>root===roots[0])&&group.files.some(f=>f.path.includes('/'))?roots[0]:(group.files.length===1?group.files[0].path:`Upload · ${date(group.files[0].created)}`);
    const total=group.files.reduce((n,f)=>n+f.size,0),complete=group.files.filter(f=>f.status==='complete').length;
    const location=commonFolder(group.files.map(f=>f.localPath).filter(Boolean));
    const canDeleteFiles=group.files.every(file=>file.destination==='local'&&file.localPath);
    const groupKey=group.key, expanded=needle || openGroups.has(groupKey);
    return `<details class="file-group" data-group="${esc(groupKey)}" ${expanded?'open':''}><summary><span class="group-folder">${icons.folder}</span><span class="group-title"><strong>${esc(folder)}</strong><small>${esc(group.files[0].sender)} · ${complete} of ${group.files.length} received${location?`<span title="${esc(location)}">${esc(location)}</span>`:''}</small></span><span class="group-size">${bytes(total)}</span><button class="icon-button bin-button delete-group-choice" data-batch="${group.files[0].batch}" data-name="${esc(folder)}" data-files="${group.files.length}" data-delete-files="${canDeleteFiles}" aria-label="Clear ${esc(folder)}" title="Clear upload group"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg></button><span class="group-caret">${icons.chevron}</span></summary><div class="group-files">${group.files.map(fileRow).join('')}</div></details>`;
  }).join(''):'<div class="empty">No matching uploads.</div>';

  document.querySelectorAll('.delete-file-choice').forEach(el=>el.onclick=()=>{
    const file=state.uploads.find(u=>u.id===el.dataset.id);if(!file)return;
    deleteTarget={kind:'files',id:file.id};$('delete-title').textContent='Delete file';$('delete-name').textContent=file.path;
    $('delete-record-label').textContent='Remove record only';$('delete-record-note').textContent='Keep the saved file.';
    $('delete-file-label').textContent='Delete file and record';$('delete-file-note').textContent='Permanently delete the saved file from this PC.';
    $('delete-original').hidden=!file.localPath;$('delete-dialog').showModal();
  });
  document.querySelectorAll('.delete-group-choice').forEach(el=>el.onclick=event=>{
    event.preventDefault();event.stopPropagation();
    deleteTarget={kind:'batches',id:el.dataset.batch};$('delete-title').textContent='Clear upload group';
    $('delete-name').textContent=`${el.dataset.name} · ${el.dataset.files} files`;
    $('delete-record-label').textContent='Clear group only';$('delete-record-note').textContent='Remove the group from Setu and keep every saved file.';
    $('delete-file-label').textContent='Delete files and clear group';$('delete-file-note').textContent='Permanently delete every saved file in this group from this PC.';
    $('delete-original').hidden=el.dataset.deleteFiles!=='true';$('delete-dialog').showModal();
  });
  document.querySelectorAll('.open-saved,.reveal-saved').forEach(el=>el.onclick=action(async()=>{

    if(window.chrome?.webview)window.chrome.webview.postMessage(`harbor-file:${el.classList.contains('reveal-saved')?'reveal':'open'}:${el.dataset.id}`);

    else { const saved=await api(`/api/files/${el.dataset.id}/location`,{method:'POST'});toast(`Saved at ${saved.path}. Open the Setu desktop app to open the original.`); }

  }));

  document.querySelectorAll('.cancel-upload').forEach(el=>el.onclick=action(async()=>{await api(`/api/uploads/${el.dataset.id}`,{method:'DELETE'});await refresh();}));

}

function renderOwner() {

  const on=state.receivingUntil>Date.now();

  $('receiver-light').classList.toggle('on',on);$('receiver-title').textContent=on?'Ready to receive':'Receiving is paused';

  $('receiver-sub').textContent=on?`Open until ${new Date(state.receivingUntil).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}. Approved devices only.`:'You decide when the door is open.';

  $('receive-toggle').textContent=on?'Pause receiving':'Enable receiving';
  const durationSelect=$('receive-duration');
  if(on && document.activeElement!==durationSelect) {
    durationSelect.querySelector('option[data-current]')?.remove();
    const minutes=Number(state.receivingWindowMinutes || Math.max(1,Math.ceil((state.receivingUntil-Date.now())/60000)));
    if(![...durationSelect.options].some(option=>Number(option.value)===minutes)) {
      const option=new Option(`Current window · ${minutes<60?`${minutes} min`:`${Math.floor(minutes/60)} hr${minutes%60?` ${minutes%60} min`:''}`}`,String(minutes));option.dataset.current='true';durationSelect.add(option);
    }
    durationSelect.value=String(minutes);
  }

  $('free-space').textContent=bytes(state.freeBytes);$('inbox-path').textContent=state.inbox;
  $('device-name-label').textContent=state.device?.name || 'Setu device';$('device-id-label').textContent=`ID ${state.device?.shortId || '—'}`;
  $('device-name-input').value=state.device?.name || '';$('device-id-value').textContent=state.device?.id || '—';

  if(document.activeElement!==$('inbox-input'))$('inbox-input').value=state.inbox;

  const pending=state.guests.filter(g=>g.status==='pending').length;$('pending-count').textContent=pending || '';

  $('guest-list').innerHTML=state.guests.length?state.guests.map(g=>`<div class="list-row"><div><strong>${esc(g.name)}</strong> <code>${esc(g.code)}</code><p><span class="device-tag">${esc(g.deviceName || `${g.name}'s device`)}</span> · ID ${esc(shortDeviceId(g.deviceId))} · ${esc(g.label)} · ${date(g.created)}</p></div><div class="actions"><span class="pill ${g.status==='approved'?'good':''}">${esc(g.status)}</span>${g.status!=='approved'?`<button class="text-button approve" data-id="${g.id}" data-status="approved">Approve</button>`:''}${g.status!=='denied'?`<button class="text-button danger approve" data-id="${g.id}" data-status="denied">${g.status==='approved'?'Revoke':'Deny'}</button>`:''}<button class="icon-button bin-button delete-request" data-kind="guests" data-id="${g.id}" aria-label="Delete record" title="Delete record"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg></button></div></div>`).join(''):'<div class="empty">When someone opens your link and requests access, their device appears here.</div>';

  document.querySelectorAll('.approve').forEach(el=>el.onclick=action(async()=>{await api(`/api/guests/${el.dataset.id}`,{method:'PATCH',body:{status:el.dataset.status}});await refresh();}));

  const shareBase=state.tunnelUrl || state.lanUrls[0] || state.origin;
  $('invite-list').innerHTML=state.invites.length?state.invites.map(i=>{const url=i.token?`${shareBase}/receive#invite=${i.token}`:'';return `<div class="list-row invite-row"><div class="invite-details"><strong>${esc(i.label)}</strong><p>${esc(destinationName(i.destination))} · ${bytes(i.maxBytes)} total · expires ${date(i.expires)}</p>${url?`<div class="stored-link"><input aria-label="Upload link for ${esc(i.label)}" value="${esc(url)}" readonly><button class="secondary copy-existing-link" data-url="${esc(url)}">Copy link</button></div>`:`<p class="link-unavailable">This older link cannot be shown again. Create a replacement link.</p>`}</div><div class="actions"><span class="pill">${i.revoked?'Revoked':i.expires<Date.now()?'Expired':'Approval required'}</span>${!i.revoked?`<button class="text-button danger revoke" data-id="${i.id}">Revoke link</button>`:''}<button class="icon-button bin-button delete-request" data-kind="invites" data-id="${i.id}" aria-label="Delete record" title="Delete record"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg></button></div></div>`;}).join(''):'<div class="empty">No upload requests yet. Create a link for your next collection.</div>';

  document.querySelectorAll('.revoke').forEach(el=>el.onclick=action(async()=>{await api(`/api/invites/${el.dataset.id}`,{method:'DELETE'});await refresh();}));
  document.querySelectorAll('.copy-existing-link').forEach(el=>el.onclick=action(async()=>{const input=el.previousElementSibling;try{await navigator.clipboard.writeText(el.dataset.url);}catch{input.select();document.execCommand('copy');}toast('Upload link copied.');}));

  document.querySelectorAll('.delete-request').forEach(el=>el.onclick=action(async()=>{

    if(!confirm('Delete this request record and revoke its access? Saved files will be kept.'))return;

    await api(`/api/${el.dataset.kind}/${el.dataset.id}/record`,{method:'DELETE'});await refresh();

  }));

  $('activity-list').innerHTML=state.events.length?state.events.map(e=>`<div class="list-row"><div><strong>${esc(e.action)}</strong><p>${esc(e.detail)}</p></div><span class="muted">${date(e.at)}</span></div>`).join(''):'<div class="empty">Your activity will appear here.</div>';
  $('clear-activity').hidden=!state.events.length;

  $('lan-addresses').innerHTML=state.lanUrls.length?state.lanUrls.map(url=>`<p><code>${esc(url)}</code></p>`).join(''):'<p class="muted">Localhost only. Restart in LAN mode to accept devices on your Wi-Fi.</p>';

  $('tunnel-toggle').textContent=state.tunnelRunning?'Stop tunnel':'Start temporary tunnel';

  $('tunnel-status').textContent=state.tunnelError || (state.tunnelRunning&&!state.tunnelUrl?'Starting…':'');

  $('tunnel-address').textContent=state.tunnelUrl || '';

  renderFiles();

  if(window.chrome?.webview)window.chrome.webview.postMessage('harbor-ready');

}

async function refresh() {

  if(isGuest)return refreshGuest();

  state=await api('/api/state');$('login').hidden=true;$('owner').hidden=false;renderOwner();

}

let deleteTarget=null;
$('delete-cancel').onclick=()=>$('delete-dialog').close();
$('delete-dialog').addEventListener('click',e=>{if(e.target===$('delete-dialog'))$('delete-dialog').close();});
$('delete-dialog').addEventListener('close',()=>{deleteTarget=null;});
async function deleteSelected(deleteFile) {
  if(!deleteTarget)return;
  const target=deleteTarget;
  $('delete-record-only').disabled=true;$('delete-original').disabled=true;
  try {await api(`/api/${target.kind}/${target.id}/record`,{method:'DELETE',body:{[target.kind==='batches'?'deleteFiles':'deleteFile']:deleteFile}});$('delete-dialog').close();await refresh();}
  finally {$('delete-record-only').disabled=false;$('delete-original').disabled=false;}
}
$('delete-record-only').onclick=action(()=>deleteSelected(false));
$('delete-original').onclick=action(()=>deleteSelected(true));
$('clean-empty').onclick=action(async()=>{const result=await api('/api/inbox/clean-empty',{method:'POST'});toast(`${result.removed} empty folders removed. Files were kept.`);});
$('clear-activity').onclick=action(async()=>{
  if(!confirm('Clear all activity records? Your files, upload links, and approvals will be kept.'))return;
  const result=await api('/api/events',{method:'DELETE'});toast(`${result.cleared} activity record${result.cleared===1?'':'s'} cleared.`);await refresh();
});

$('file-search').addEventListener('input',()=>state&&renderFiles());

$('login-form').addEventListener('submit',action(async e=>{e.preventDefault();await api('/api/login',{method:'POST',body:{key:$('owner-key').value}});$('owner-key').value='';await refresh();}));

$('lock').onclick=action(async()=>{await api('/api/logout',{method:'POST'});$('invite-list').innerHTML='';$('owner').hidden=true;$('login').hidden=false;state=null;});

$('device-form').addEventListener('submit',action(async e=>{e.preventDefault();const name=$('device-name-input').value.trim();const result=await api('/api/device',{method:'PATCH',body:{name}});state.device=result.device;rememberLocal('setu-device-name',name);toast('Device name saved.');await refresh();}));
$('copy-device-id').onclick=action(async()=>{const value=$('device-id-value').textContent;if(navigator.clipboard)await navigator.clipboard.writeText(value);else{$('device-id-value').select?.();}toast('Device ID copied.');});

$('receive-toggle').onclick=action(async()=>{await api('/api/receiving',{method:'POST',body:{minutes:state.receivingUntil>Date.now()?0:Number($('receive-duration').value)}});await refresh();});
$('receive-duration').onchange=action(async()=>{if(state?.receivingUntil>Date.now()){const minutes=Number($('receive-duration').value);await api('/api/receiving',{method:'POST',body:{minutes}});toast('Receiving time updated.');await refresh();}});

$('inbox-form').addEventListener('submit',action(async e=>{e.preventDefault();await api('/api/inbox',{method:'POST',body:{path:$('inbox-input').value}});toast('Inbox folder saved.');await refresh();}));

$('tunnel-toggle').onclick=action(async()=>{await api('/api/tunnel',{method:state.tunnelRunning?'DELETE':'POST'});await refresh();});

function openRequest() {

  

  const urls=[...(state.tunnelUrl?[state.tunnelUrl]:[]),...state.lanUrls,state.origin];

  $('request-base').innerHTML=urls.map(u=>`<option value="${esc(u)}">${esc(u)}${u===state.origin?' · this PC only':''}</option>`).join('');

  $('request-form').hidden=false;$('created-link').hidden=true;$('request-dialog').showModal();

}

for(const id of ['new-request','new-request-top'])$(id).onclick=openRequest;

$('close-dialog').onclick=()=>$('request-dialog').close();

$('request-dialog').addEventListener('click',e=>{if(e.target===$('request-dialog'))$('request-dialog').close();});

$('request-form').addEventListener('submit',action(async e=>{

  e.preventDefault();const result=await api('/api/invites',{method:'POST',body:{label:$('request-label').value,destination:'local',hours:Number($('request-hours').value),maxBytes:Number($('request-gb').value)*1024**3,maxFiles:10000}});

  $('share-url').value=`${$('request-base').value}/receive#invite=${result.token}`;$('request-form').hidden=true;$('created-link').hidden=false;await refresh();

}));

$('copy-link').onclick=action(async()=>{if(navigator.clipboard){await navigator.clipboard.writeText($('share-url').value);toast('Upload link copied.');}else{$('share-url').select();toast('Select and copy the link.');}});



// The file bytes stay in the File object. Only one 4 MiB chunk is read at a time.

let batch=globalThis.crypto?.randomUUID?.() || uuid();

function uuid(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const n=Math.random()*16|0;return(c==='x'?n:(n&3)|8).toString(16);});}

function resumeStore(){try{return JSON.parse(localStorage.getItem('harbor-resume') || '{}');}catch{return {};}}

function remember(key,value){const all=resumeStore();if(value)all[key]=value;else delete all[key];try{localStorage.setItem('harbor-resume',JSON.stringify(all));}catch{/* File transfer still works if browser storage is unavailable. */}}

function renderQueue() {
  const el=$(isGuest?'guest-queue':'queue');
  const latest=queue.at(-1)?.batch,items=queue.filter(q=>q.batch===latest&&!q.skipped);
  if(!items.length){el.innerHTML='';return;}
  const total=items.reduce((n,q)=>n+q.file.size,0),received=items.reduce((n,q)=>n+(q.done?q.file.size:q.offset),0);
  const done=items.filter(q=>q.done).length,remaining=items.length-done,errors=items.filter(q=>q.error);
  const speed=transferRate(`sending:${latest}`,received,total),active=items.find(q=>!q.done),activeNote=active?.note||'';
  el.innerHTML=`<div class="transfer-overview"><div class="transfer-numbers"><strong>${bytes(received)} / ${bytes(total)}</strong><span>${done} received · ${remaining} remaining</span></div><progress max="${Math.max(1,total)}" value="${received}"></progress><div class="transfer-meta"><span>${done===items.length?'Received and size verified':errors.length?'Transfer needs attention':activeNote||'Uploading'}</span><span>${done===items.length?'Complete':speed?`${bytes(speed)}/s · ${duration((total-received)/speed)}`:'Calculating speed and ETA'}</span></div>${errors.map(q=>{const i=queue.indexOf(q);return `<div class="transfer-error"><span>${esc(q.path)} · ${esc(q.error)}</span><button class="text-button retry" data-index="${i}">Retry</button><button class="text-button danger discard" data-index="${i}">Cancel</button></div>`}).join('')}</div>`;
  el.querySelectorAll('.retry').forEach(b=>b.onclick=()=>{queue[b.dataset.index].error='';runQueue();});

  el.querySelectorAll('.discard').forEach(b=>b.onclick=action(async()=>{const q=queue[b.dataset.index];if(q.id)await api(`/api/uploads/${q.id}`,{method:'DELETE'});remember(q.key,null);queue.splice(Number(b.dataset.index),1);renderQueue();}));

}

function addFiles(items) {

  if(isGuest?guestState?.status!=='approved':!state)return toast('Wait for approval before uploading.',true);
  if(isGuest && !guestState.receiving)return toast('Receiving is paused. Ask the owner to enable it before choosing files.',true);

  const destination=isGuest?guestState.destination:'local';

  for(const item of items) {

    const file=item.file || item,relative=item.path || file.webkitRelativePath || file.name;

    const key=JSON.stringify([isGuest?guestState.id:'owner',destination,relative,file.size,file.lastModified]);

    if(queue.some(q=>q.key===key&&!q.done))continue;

    const saved=resumeStore()[key];

    queue.push({file,path:relative,key,destination,batch:saved?.batch || batch,id:saved?.id,offset:0,error:'',done:false});

  }

  renderQueue();runQueue();

}

async function sendFile(q) {

  if(isGuest && (!guestState || guestState.status!=='approved'))throw new Error('Approval is required before sending.');
  if(isGuest && !guestState.receiving)throw new Error('Receiving is paused. Ask the owner to enable it before retrying.');

  if(q.id){

    try{const previous=await api(`/api/uploads/${q.id}`);if(previous.status==='cancelled'){q.id=null;}else{q.offset=previous.offset;if(previous.status==='complete'){q.done=true;remember(q.key,null);return;}}}

    catch(e){if(e.status===404){q.id=null;}else throw e;}

  }

  if(!q.id){const items=queue.filter(item=>item.batch===q.batch&&!item.skipped),created=await api('/api/uploads',{method:'POST',body:{path:q.path,size:q.file.size,modified:q.file.lastModified||0,batch:q.batch,batchFiles:items.length,batchBytes:items.reduce((n,item)=>n+item.file.size,0),destination:q.destination}});if(created.duplicate){q.done=true;q.skipped=true;remember(q.key,null);toast(`${q.path} was already received and removed from the queue.`);return;}q.id=created.id;q.offset=Number(created.offset||0);q.note=created.resumed?'Resuming saved transfer…':'';remember(q.key,{id:q.id,batch:q.batch});}

  const started=Date.now(),startOffset=q.offset;

  while(q.offset<q.file.size){

    const chunk=q.file.slice(q.offset,q.offset+4*1024*1024);

    let result;

    // Keep a transfer alive through tunnel reconnects and background-tab
    // throttling. Permanent request errors still stop immediately.
    let lastError;
    for(let attempt=0;attempt<60;attempt++){

      try{result=await api(`/api/uploads/${q.id}`,{method:'PUT',headers:{'Upload-Offset':String(q.offset)},body:chunk});break;}

      catch(e){
        lastError=e;

        if(e.status===409 && Number.isSafeInteger(e.offset)){q.offset=e.offset;break;}

        if([400,401,403,409,413,507].includes(e.status))throw e;

        const wait=Math.min(30000,attempt<1?2000:attempt<2?5000:10000*Math.pow(2,Math.min(attempt-2,1)));
        q.note=`Connection interrupted. Retrying in ${Math.ceil(wait/1000)}s (${attempt+1}/60)…`;renderQueue();
        await new Promise(r=>setTimeout(r,wait));

      }

    }

    if(!result && q.offset < q.file.size) throw lastError || new Error('Transfer retry limit reached.');

    if(result){q.offset=result.offset;if(result.status==='complete')q.done=true;}

    const speed=(q.offset-startOffset)/Math.max(1,(Date.now()-started)/1000);

    q.note=`${bytes(q.offset)} of ${bytes(q.file.size)} · ${bytes(speed)}/s`;renderQueue();

  }

  if(q.destination==='local'){q.note='Verifying and saving…';renderQueue();const finished=await api(`/api/uploads/${q.id}/finish`,{method:'POST'});if(finished.duplicate){q.done=true;q.skipped=true;remember(q.key,null);toast(`${q.path} matched a saved file and was removed from the queue.`);return;}}

  q.done=true;q.note='Received and size verified';remember(q.key,null);

}

async function runQueue(){

  if(uploading)return;uploading=true;

  for(const q of queue){if(q.done||q.error)continue;try{await sendFile(q);}catch(e){q.error=e.message;}renderQueue();}

  uploading=false;batch=globalThis.crypto?.randomUUID?.() || uuid();

  try{await refresh();}catch{}

}

for(const id of ['choose-files','guest-files']){const el=$(id);if(el)el.onclick=e=>{e.stopPropagation();$('files').click();};}

for(const id of ['choose-folder','guest-folder']){const el=$(id);if(el)el.onclick=e=>{e.stopPropagation();$('folder').click();};}

for(const id of ['files','folder'])$(id).addEventListener('change',e=>{addFiles([...e.target.files]);e.target.value='';});

async function walk(entry,prefix='') {

  if(entry.isFile)return [{file:await new Promise((resolve,reject)=>entry.file(resolve,reject)),path:prefix+entry.name}];

  const reader=entry.createReader();let entries=[],part;

  do{part=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));entries.push(...part);}while(part.length);

  const result=[];for(const child of entries)result.push(...await walk(child,`${prefix}${entry.name}/`));return result;

}

for(const id of ['owner-drop','guest-drop']){

  const drop=$(id);if(!drop)continue;
  drop.onclick=e=>{if(!e.target.closest('button'))$('files').click();};drop.onkeydown=e=>{if(e.target===drop&&['Enter',' '].includes(e.key)){e.preventDefault();$('files').click();}};

  drop.ondragover=e=>{e.preventDefault();drop.classList.add('over');};drop.ondragleave=()=>drop.classList.remove('over');

  drop.ondrop=action(async e=>{e.preventDefault();drop.classList.remove('over');const entries=[...e.dataTransfer.items].map(i=>i.webkitGetAsEntry?.());if(entries.length&&entries.every(Boolean)){const items=[];for(const entry of entries)items.push(...await walk(entry));addFiles(items);}else addFiles([...e.dataTransfer.files]);});

}

async function refreshGuest(){

  if(!guestToken)return;

  guestState=await api('/api/guest/status');$('guest-form').hidden=true;

  const approved=guestState.status==='approved';$('guest-wait').hidden=approved;$('guest-upload').hidden=!approved;

  $('pair-code').textContent=guestState.code;

  $('guest-device-summary').innerHTML=`<strong>${esc(guestState.deviceName || `${guestState.name}'s device`)}</strong><span>Device ID ${esc(shortDeviceId(guestState.deviceId))}</span>`;

  $('guest-status-title').textContent=guestState.status==='denied'?'Access has been declined.':'One quick check.';

  $('guest-status-copy').textContent=guestState.status==='denied'?'Contact the owner if you still need to send files.':'Share this pairing code with the owner so they can approve your device.';

  $('guest-description').textContent=`${guestState.label} · ${bytes(guestState.maxBytes)} total allowance`;

  $('guest-label').textContent=guestState.receiving?'Ready to receive':'Receiving is paused';

  $('guest-destination').textContent=`Destination: ${destinationName(guestState.destination)}. ${guestState.receiving?'Choose files to get started.':'Ask the owner to enable receiving, then retry.'}`;
  $('guest-drop').classList.toggle('disabled-drop',!guestState.receiving);
  $('guest-files').disabled=!guestState.receiving;$('guest-folder').disabled=!guestState.receiving;

  $('guest-receipts').innerHTML=guestState.uploads.filter(u=>u.status==='complete').map(u=>`<div class="receipt">${esc(u.path)} <span class="muted">· ${bytes(u.size)} received</span></div>`).join('');

}

$('guest-form').addEventListener('submit',action(async e=>{e.preventDefault();const invite=sessionStorage.getItem('harbor-invite');if(!invite)throw new Error('Open the complete upload link supplied by the owner.');const deviceName=$('guest-device-name').value.trim();rememberLocal('setu-device-name',deviceName);const r=await api('/api/guest/request',{method:'POST',body:{token:invite,name:$('guest-name').value,deviceId:browserDeviceId(),deviceName}});guestToken=r.token;sessionStorage.setItem('harbor-guest',guestToken);await refreshGuest();}));

$('guest-reset').onclick=()=>{sessionStorage.removeItem('harbor-guest');sessionStorage.removeItem('harbor-invite');location.reload();};

async function boot(){

  if(isGuest){

    $('guest').hidden=false;
    $('guest-device-name').value=browserDeviceName();

    if(fragment.get('invite')){if(sessionStorage.getItem('harbor-invite')!==fragment.get('invite'))sessionStorage.removeItem('harbor-guest');sessionStorage.setItem('harbor-invite',fragment.get('invite'));history.replaceState(null,'','/receive');}

    guestToken=sessionStorage.getItem('harbor-guest') || '';

    if(guestToken){try{await refreshGuest();}catch(e){$('guest-form').hidden=true;toast(e.message,true);}}
    else if(sessionStorage.getItem('harbor-invite')){try{const check=await api('/api/guest/inspect',{method:'POST',body:{token:sessionStorage.getItem('harbor-invite')}});$('guest-description').textContent=`Link verified · ${check.label} · ${bytes(check.maxBytes)} total allowance`;$('guest-status-copy').textContent=check.receiving?'Request approval from the owner before choosing files.':'The link is valid, but receiving is currently paused by the owner.';}catch(e){$('guest-form').hidden=true;toast(e.message,true);}}

  } else {

    const key=fragment.get('key');if(key){history.replaceState(null,'','/');await api('/api/login',{method:'POST',body:{key}});}

    try{await refresh();}catch(e){if(e.status===401){$('login').hidden=false;}else throw e;}

  }

}

boot().catch(e=>{toast(e.message,true);if(!isGuest)$('login').hidden=false;});

setInterval(async()=>{if(document.hidden||(!isGuest&&!state)||(isGuest&&!guestToken))return;try{await refresh();}catch(e){if(e.status===401&&!isGuest){state=null;$('owner').hidden=true;$('login').hidden=false;}}},1500);

window.addEventListener('beforeunload',e=>{if(uploading){e.preventDefault();e.returnValue='';}});

