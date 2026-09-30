import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { token } from './core.js';

function dpapi(input, protect) {
  const command = `Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); ${protect
    ? "$b=[Text.Encoding]::UTF8.GetBytes($v); [Console]::Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))"
    : "$b=[Convert]::FromBase64String($v); [Console]::Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))"}`;
  const result = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{input,encoding:'utf8',windowsHide:true,timeout:15000});
  if(result.status!==0)throw new Error('Windows could not unlock Setu credentials for this user.');
  return result.stdout;
}
export async function loadSecrets(dataDir) {
  const windows=process.platform==='win32';
  const file=path.join(dataDir,windows?'secrets.dpapi':'secrets.json');
  try {const saved=await fs.readFile(file,'utf8');return JSON.parse(windows?dpapi(saved,false):saved);}
  catch(e){if(e.code!=='ENOENT')throw e;}
  const secrets={owner:token(),key:randomBytes(32).toString('base64')};
  const value=JSON.stringify(secrets);
  await fs.writeFile(file,windows?dpapi(value,true):value,{flag:'wx',mode:0o600});
  return secrets;
}
