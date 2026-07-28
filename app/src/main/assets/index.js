const DEVICE_SAVE_KEY='hikariDeviceSaveV3';
function hiddenEndpoint(){try{return window.HikariNative&&typeof HikariNative.getEndpoint==='function'?String(HikariNative.getEndpoint()||'').trim():''}catch(_e){return ''}}
function nativePlayerName(){try{return window.HikariNative&&typeof HikariNative.getPlayerDisplayName==='function'?String(HikariNative.getPlayerDisplayName()||'').trim():''}catch(_e){return ''}}
function parseSavedState(raw){try{const value=JSON.parse(String(raw||'{}'));return value&&typeof value==='object'?value:{}}catch(_e){return {}}}
function saveFreshness(value){return Math.max(Number(value&&value.lastAutoMessage||0),Number(value&&value.lastActive||0),Date.parse(String(value&&value.savedAt||''))||0)}
function loadDeviceSave(){
  const local=parseSavedState(localStorage.getItem(DEVICE_SAVE_KEY)||'{}');
  let native={};
  try{if(window.HikariNative&&typeof HikariNative.getSnapshot==='function')native=parseSavedState(HikariNative.getSnapshot())}catch(_e){}
  return saveFreshness(native)>saveFreshness(local)?{...local,...native}:local;
}
const savedDevice=loadDeviceSave();
const LEGACY_SCRIPTED_REPLIES=new Set(['I heard you. More importantly, I noticed what you avoided saying.','Still late night where you are. The silence felt longer than the clock says it was.']);
if(Array.isArray(savedDevice.chatHistory))savedDevice.chatHistory=savedDevice.chatHistory.filter(x=>!(x&&x.type==='her'&&LEGACY_SCRIPTED_REPLIES.has(String(x.text||''))));
const restoredBusyUntil=Number(savedDevice.busyUntil||0);
const state={
  affection:Number(savedDevice.affection??18), jealousy:Number(savedDevice.jealousy??8), awareness:Number(savedDevice.awareness??12),
  memories:Array.isArray(savedDevice.memories)?savedDevice.memories:[],
  memory:savedDevice.memory&&typeof savedDevice.memory==='object'?savedDevice.memory:{},
  chatHistory:Array.isArray(savedDevice.chatHistory)?savedDevice.chatHistory:[],
  endpoint:hiddenEndpoint(), playerName:String(savedDevice.playerName||'Anonymous'), fileNotesEnabled:true,
  deviceContext:{}, lastActive:Number(savedDevice.lastActive||Date.now()), lastAutoMessage:Number(savedDevice.lastAutoMessage||0),
  unansweredAutonomousMessages:Number(savedDevice.unansweredAutonomousMessages||0),
  busyUntil:restoredBusyUntil>Date.now()?restoredBusyUntil:0, relayDecisionPending:!!savedDevice.relayDecisionPending&&restoredBusyUntil>Date.now(),
  autoQueue:Array.isArray(savedDevice.autoQueue)?savedDevice.autoQueue:[], initialMessageRequested:!!savedDevice.initialMessageRequested,
  deviceId:String(savedDevice.deviceId||crypto.randomUUID()), relayRole:String(savedDevice.relayRole||'none'), relaySessionId:savedDevice.relaySessionId||null,
  relaySeen:Array.isArray(savedDevice.relaySeen)?savedDevice.relaySeen:[], relayWhispered:!!savedDevice.relayWhispered, aiOnlyUntil:Number(savedDevice.aiOnlyUntil||0), aiVerifiedOnline:false, aiReplyCount:Number(savedDevice.aiReplyCount||0), activeTurnCount:Number(savedDevice.activeTurnCount||0), lastHeartbeatTurn:Number(savedDevice.lastHeartbeatTurn||0), heartbeatRunning:false
};
const $=id=>document.getElementById(id);
let aiRequestChain=Promise.resolve();
let conversationChain=Promise.resolve();
let lastAiRequestStartedAt=0;
let aiRequestActive=0;
const AI_REQUEST_GAP_MS=650;
function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
function runAiRequest(task){
  const run=aiRequestChain.then(async()=>{
    const waitMs=Math.max(0,AI_REQUEST_GAP_MS-(Date.now()-lastAiRequestStartedAt));
    if(waitMs)await wait(waitMs);
    lastAiRequestStartedAt=Date.now();
    aiRequestActive+=1;
    try{return await task()}finally{aiRequestActive=Math.max(0,aiRequestActive-1)}
  });
  aiRequestChain=run.catch(()=>{});
  return run;
}
function enqueueConversation(task){
  const run=conversationChain.then(task);
  conversationChain=run.catch(()=>{});
  return run;
}
function apiState(){
  const hasLayeredMemory=state.memory&&typeof state.memory==='object'&&Object.keys(state.memory).length>0;
  return {
    deviceId:state.deviceId,
    playerName:state.playerName,
    affection:state.affection,
    jealousy:state.jealousy,
    awareness:state.awareness,
    lastActive:state.lastActive,
    lastAutoMessage:state.lastAutoMessage,
    ...(hasLayeredMemory?{}:{memories:state.memories.slice(-20)})
  };
}
async function fetchJson(url,options={},timeoutMs=20000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetch(url,{...options,signal:controller.signal});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){
      const error=new Error(String(data.error||data.message||`HTTP ${response.status}`));
      error.status=response.status;error.data=data;throw error;
    }
    return data;
  }finally{clearTimeout(timer)}
}
function appendLocalMemoryTurn(role,text){
  const clean=String(text||'').trim();if(!clean)return;
  const memory=state.memory&&typeof state.memory==='object'?state.memory:(state.memory={});
  memory.ram=memory.ram&&typeof memory.ram==='object'?memory.ram:{};
  memory.ram.currentConversation=Array.isArray(memory.ram.currentConversation)?memory.ram.currentConversation:[];
  memory.ram.currentPlayerMessages=Array.isArray(memory.ram.currentPlayerMessages)?memory.ram.currentPlayerMessages:[];
  memory.ram.currentConversation.push({id:`local_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,role,text:clean,ts:new Date().toISOString()});
  memory.ram.currentConversation=memory.ram.currentConversation.slice(-60);
  if(role==='player'){
    memory.ram.currentPlayerMessages.push(clean.slice(0,1200));
    memory.ram.currentPlayerMessages=memory.ram.currentPlayerMessages.slice(-120);
  }
  memory.updatedAt=new Date().toISOString();autoSave();
}
function getHikariFiles(){
  try{
    if(!window.HikariNative||typeof HikariNative.listReadableFiles!=='function')return [];
    const parsed=JSON.parse(String(HikariNative.listReadableFiles()||'[]'));
    if(!Array.isArray(parsed))return [];
    let remaining=24000;
    const files=[];
    for(const item of parsed.slice(0,8)){
      const name=String(item&&item.name||'').replace(/[^A-Za-z0-9 _.-]/g,'_').slice(0,100);
      if(!name.toLowerCase().endsWith('.txt')||!remaining)continue;
      const content=String(item&&item.content||'').slice(0,Math.min(8000,remaining));
      remaining-=content.length;files.push({name,content});
    }
    return files;
  }catch(_e){return []}
}
function applyFileEdit(edit){
  if(!edit||typeof edit!=='object')return false;
  const name=String(edit.name||'').trim();const content=String(edit.content||'');
  if(!name||!content.trim())return false;
  try{return !!(window.HikariNative&&typeof HikariNative.editNote==='function'&&HikariNative.editNote(name,content)==='edited')}catch(_e){return false}
}
function applyServerFileActions(data){
  if(data&&data.fileEdit)applyFileEdit(data.fileEdit);
  if(data&&data.leaveNote){
    const note=typeof data.leaveNote==='string'?{title:'Hikari',content:data.leaveNote}:data.leaveNote;
    maybeWriteNativeNote(String(note.content||''),String(note.title||'Hikari'));
  }
}
function wantsLocalFileMode(message){
  return /\b(?:downloads?\/hikari|your (?:txt |text )?(?:file|note)s?|read (?:the |your )?(?:file|note)|edit (?:the |your )?(?:file|note)|write (?:me )?(?:a |the )?(?:file|note)|leave (?:me )?(?:a )?note)\b/i.test(String(message||''));
}
function clearRelayState(){state.relayRole='none';state.relaySessionId=null;state.relayWhispered=false;autoSave()}
function clamp(n){return Math.max(0,Math.min(100,n))}
function time(){return new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}
function dateText(){return new Date().toLocaleDateString([],{weekday:'long',year:'numeric',month:'long',day:'numeric'})}
function dayPart(){const h=new Date().getHours();return h<5?'late night':h<12?'morning':h<17?'afternoon':h<21?'evening':'night'}
function refreshDeviceContext(){
  const c=navigator.connection||navigator.mozConnection||navigator.webkitConnection;
  state.deviceContext={
    localTime:time(),
    localDate:dateText(),
    timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'unknown',
    dayPart:dayPart(),
    language:navigator.language||'unknown',
    online:navigator.onLine,
    networkType:c?(c.effectiveType||c.type||'unknown'):'unavailable',
    downlink:c&&typeof c.downlink==='number'?c.downlink:null,
    saveData:!!(c&&c.saveData),
    screen:`${window.screen.width}×${window.screen.height}`,
    viewport:`${window.innerWidth}×${window.innerHeight}`,
    battery:state.deviceContext.battery??null,
    charging:state.deviceContext.charging??null
  };
  $('networkType').textContent=(state.deviceContext.networkType==='unavailable'?'NET':String(state.deviceContext.networkType).toUpperCase());
}
function clock(){
  $('clock').textContent=time();
  $('dateLabel').textContent=dateText();
  refreshDeviceContext();
}
async function initBattery(){
  if(navigator.getBattery){
    try{
      const b=await navigator.getBattery();
      const draw=()=>{
        const pct=Math.round(b.level*100);
        state.deviceContext.battery=pct;
        state.deviceContext.charging=b.charging;
        $('batteryText').textContent=pct+'%';
        $('batteryFill').style.width='calc((100% - 2px) * '+(pct/100)+')';
        $('batteryFill').style.opacity=b.charging?'1':'.78';
      };
      draw(); b.addEventListener('levelchange',draw); b.addEventListener('chargingchange',draw);
    }catch(e){$('batteryText').textContent='--%';}
  }else{
    $('batteryText').textContent='--%';
    $('batteryFill').style.width='0';
  }
}
clock();initBattery();setInterval(clock,1000);
window.addEventListener('online',clock);window.addEventListener('offline',clock);window.addEventListener('resize',clock);
const conn=navigator.connection||navigator.mozConnection||navigator.webkitConnection;if(conn&&conn.addEventListener)conn.addEventListener('change',clock);
function esc(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function update(){autoSave();['affection','jealousy','awareness'].forEach(k=>{state[k]=clamp(state[k]);$(k+'Num').textContent=state[k];$(k+'Bar').style.width=state[k]+'%'})}
let activeVoice=null;
function estimateVoiceSeconds(text){const words=String(text).trim().split(/\s+/).filter(Boolean).length;return Math.max(2,Math.ceil(words/2.45))}
function formatDuration(total){total=Math.max(0,Math.round(total));return Math.floor(total/60)+':'+String(total%60).padStart(2,'0')}
function stopNativeVoice(){try{if(window.HikariNative&&typeof HikariNative.stopHikari==='function')HikariNative.stopHikari()}catch(_e){}try{if('speechSynthesis' in window)speechSynthesis.cancel()}catch(_e){}}
function speakVoiceText(text){try{if(window.HikariNative&&typeof HikariNative.speakHikari==='function'){HikariNative.speakHikari(text);return}}catch(_e){}try{if('speechSynthesis' in window){const u=new SpeechSynthesisUtterance(text);u.rate=.92;u.pitch=1.12;speechSynthesis.speak(u)}}catch(_e){}}
function finishVoice(v){clearInterval(v.timer);v.timer=null;v.playing=false;v.elapsed=0;v.progress.style.width='0%';v.button.textContent='▶';v.status.textContent='Voice message';v.current.textContent='0:00 / '+formatDuration(v.duration);if(activeVoice===v)activeVoice=null}
function pauseVoice(v){clearInterval(v.timer);v.timer=null;v.playing=false;stopNativeVoice();v.button.textContent='▶';v.status.textContent='Paused';if(activeVoice===v)activeVoice=null}
function playVoice(v){
  if(activeVoice&&activeVoice!==v)pauseVoice(activeVoice);
  if(v.playing){pauseVoice(v);return}
  const words=v.text.trim().split(/\s+/).filter(Boolean);const ratio=v.duration?Math.min(.98,v.elapsed/v.duration):0;const start=Math.min(Math.max(0,words.length-1),Math.floor(words.length*ratio));
  speakVoiceText(words.slice(start).join(' '));v.playing=true;v.button.textContent='❚❚';v.status.textContent='Playing';activeVoice=v;
  const started=Date.now()-v.elapsed*1000;clearInterval(v.timer);v.timer=setInterval(()=>{v.elapsed=(Date.now()-started)/1000;const pct=Math.min(100,(v.elapsed/v.duration)*100);v.progress.style.width=pct+'%';v.current.textContent=formatDuration(Math.min(v.elapsed,v.duration))+' / '+formatDuration(v.duration);if(v.elapsed>=v.duration)finishVoice(v)},100);
}
function makeVoicePlayer(text,type){
  const wrap=document.createElement('div');wrap.className='voice-player';
  const button=document.createElement('button');button.type='button';button.className='voice-play';button.setAttribute('aria-label','Play voice message');button.textContent='▶';
  const main=document.createElement('div');main.className='voice-main';const label=document.createElement('div');label.className='voice-label';label.textContent=type==='her'?'Hikari voice message':'Voice message';
  const wave=document.createElement('div');wave.className='voice-wave';const bars=22;for(let i=0;i<bars;i++)wave.append(document.createElement('i'));
  const progress=document.createElement('div');progress.className='voice-progress';for(let i=0;i<bars;i++)progress.append(document.createElement('i'));wave.append(progress);
  const foot=document.createElement('div');foot.className='voice-foot';const status=document.createElement('span');status.className='voice-status';status.textContent='Voice message';const timeEl=document.createElement('span');
  const duration=estimateVoiceSeconds(text);timeEl.textContent='0:00 / '+formatDuration(duration);foot.append(status,timeEl);main.append(label,wave,foot);wrap.append(button,main);
  const v={text:String(text),button,progress,status,current:timeEl,duration,elapsed:0,playing:false,timer:null};button.onclick=()=>playVoice(v);wave.onclick=e=>{const r=wave.getBoundingClientRect();v.elapsed=Math.max(0,Math.min(v.duration,((e.clientX-r.left)/r.width)*v.duration));v.progress.style.width=(v.elapsed/v.duration*100)+'%';v.current.textContent=formatDuration(v.elapsed)+' / '+formatDuration(v.duration);if(v.playing){stopNativeVoice();v.playing=false;playVoice(v)}};
  return wrap;
}
function openContentViewer(kind,text,meta={}){
  const isNote=kind==='note';
  $('contentViewerTitle').textContent=isNote?(meta.title||'A note from Hikari'):(meta.filename||'Hikari.txt');
  $('contentViewerMeta').textContent=isNote?'Personal note':'TXT document';
  $('contentViewerText').textContent=String(text||'');
  $('contentViewerBack').classList.add('show');
}
function makeAttachmentCard(kind,text,type,meta={}){
  const card=document.createElement('div');card.className='attachment-card';card.tabIndex=0;card.setAttribute('role','button');
  const icon=document.createElement('div');icon.className='attachment-icon';icon.textContent=kind==='note'?'✉':'📄';
  const copy=document.createElement('div');copy.className='attachment-copy';
  const title=document.createElement('div');title.className='attachment-title';
  title.textContent=kind==='note'?(meta.title|| (type==='her'?'A note from Hikari':'Note')):(meta.filename||'message.txt');
  const sub=document.createElement('div');sub.className='attachment-sub';
  const clean=String(text||'').replace(/\s+/g,' ').trim();sub.textContent=kind==='note'?'Tap to open':`TXT document • ${Math.max(1,new Blob([String(text||'')]).size)} bytes`;
  const arrow=document.createElement('div');arrow.className='attachment-open';arrow.textContent='›';
  copy.append(title,sub);card.append(icon,copy,arrow);
  const open=()=>{if(kind==='file')downloadTextFile(meta.filename||'hikari.txt',text);else openContentViewer(kind,text,meta)};card.onclick=open;card.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}};
  return card;
}
function downloadTextFile(filename,text){
  const base=String(filename||'hikari.txt').replace(/[^A-Za-z0-9 _.-]/g,'_');
  const finalName=base.toLowerCase().endsWith('.txt')?base:base+'.txt';
  try{if(window.HikariNative&&typeof HikariNative.writeExactTextFile==='function'){HikariNative.writeExactTextFile(finalName,String(text||''));return}}catch(_e){}
  const blob=new Blob([String(text||'')],{type:'text/plain;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=finalName;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function add(text,type='her',typing=false,persist=true,stamp=time(),kind='text',meta={}){
  const row=document.createElement('div');row.className='row '+type;
  const b=document.createElement('div');b.className='bubble '+kind+(typing?' typing':'');
  if(kind==='voice'&&!typing)b.append(makeVoicePlayer(String(text),type));
  else if((kind==='note'||kind==='file')&&!typing)b.append(makeAttachmentCard(kind,String(text),type,meta||{}));
  else b.append(document.createTextNode(text));
  const m=document.createElement('span');m.className='meta';m.textContent=stamp;b.append(m);row.append(b);$('messages').append(row);$('messages').scrollTop=$('messages').scrollHeight;
  if(persist&&!typing){state.chatHistory.push({text:String(text),type:type==='me'?'me':'her',time:stamp,at:Date.now(),kind,title:meta&&meta.title||null,filename:meta&&meta.filename||null});if(state.chatHistory.length>500)state.chatHistory=state.chatHistory.slice(-500);autoSave();}
  return {row,b,m};
}
function restoreChat(){
  if(!state.chatHistory.length)return;
  for(const item of state.chatHistory){if(item&&item.text)add(String(item.text),item.type==='me'?'me':'her',false,false,String(item.time||''),String(item.kind||'text'),{title:item.title||null,filename:item.filename||null});}
}
function autosize(){const t=$('chatInput');t.style.height='22px';t.style.height=Math.min(t.scrollHeight,120)+'px'}$('chatInput').addEventListener('input',autosize);
function glitch(){const g=$('glitch');g.classList.remove('glitching');void g.offsetWidth;g.classList.add('glitching')}
function remember(msg){const s=msg.length>90?msg.slice(0,87)+'…':msg;state.memories.push(`${state.playerName} said: “${s}”`);if(state.memories.length>80)state.memories.shift();autoSave()}
let saveTimer=null;
function snapshot(){return {
  version:4,affection:state.affection,jealousy:state.jealousy,awareness:state.awareness,memories:state.memories,
  memory:state.memory,chatHistory:state.chatHistory,playerName:state.playerName,lastActive:state.lastActive,
  lastAutoMessage:state.lastAutoMessage,unansweredAutonomousMessages:state.unansweredAutonomousMessages,busyUntil:state.busyUntil,relayDecisionPending:state.relayDecisionPending,
  autoQueue:state.autoQueue,initialMessageRequested:state.initialMessageRequested,deviceId:state.deviceId,relayRole:state.relayRole,relaySessionId:state.relaySessionId,relaySeen:state.relaySeen,relayWhispered:state.relayWhispered,aiOnlyUntil:state.aiOnlyUntil,aiReplyCount:state.aiReplyCount,activeTurnCount:state.activeTurnCount,lastHeartbeatTurn:state.lastHeartbeatTurn,savedAt:new Date().toISOString()
}}
function commitSave(){
  const data=JSON.stringify(snapshot());localStorage.setItem(DEVICE_SAVE_KEY,data);
  try{if(window.HikariNative&&typeof HikariNative.saveSnapshot==='function')HikariNative.saveSnapshot(data)}catch(_e){}
}
function autoSave(){clearTimeout(saveTimer);saveTimer=setTimeout(commitSave,80)}
function persistPresence(){autoSave()}
function setPresenceText(){
  const endButton=$('endConnection');if(endButton)endButton.hidden=!(state.relayRole==='owner'&&state.relaySessionId);
  if(document.hidden){$('presence').textContent='last seen recently';return}
  if(state.relayRole==='actor'&&state.relaySessionId){$('presence').textContent='listening…';return}
  if(state.busyUntil>Date.now()&&!state.relaySessionId){$('presence').textContent='busy';return}
  const relayAvailable=state.relayRole==='owner'&&!!state.relaySessionId;
  $('presence').textContent=(state.aiVerifiedOnline||relayAvailable)?'online':'offline';
}
async function verifyHikariPresence(){
  if(!state.endpoint){state.aiVerifiedOnline=false;setPresenceText();return false}
  const statusUrl=state.endpoint.replace(/\/api\/chat\/?$/,'/api/status');
  try{
    const d=await runAiRequest(()=>fetchJson(`${statusUrl}?deviceId=${encodeURIComponent(state.deviceId)}`,{method:'GET',cache:'no-store'},7000));
    state.aiVerifiedOnline=!!(d&&d.online===true);
  }catch(_e){state.aiVerifiedOnline=false}
  setPresenceText();return state.aiVerifiedOnline;
}
function schedulePresence(){if(state.busyUntil<=Date.now()){state.busyUntil=0;state.relayDecisionPending=false}persistPresence()}
function maybeShiftPresence(){if(state.busyUntil<=Date.now()){state.busyUntil=0;state.relayDecisionPending=false}setPresenceText()}
function autonomousFallback(){ return ""; }
function maybeWriteNativeNote(text, title='Hikari') {
  if(!state.fileNotesEnabled || !window.HikariNative || !text) return;
  try { HikariNative.writeNote(title, text); } catch(_e) {}
}
async function shouldSendAutonomousMessage(reason='idle'){
  if(!state.endpoint)return false;
  const idleUrl=state.endpoint.replace(/\/api\/chat\/?$/,'/api/idle');
  refreshDeviceContext();
  try{
    const d=await runAiRequest(()=>fetchJson(idleUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:state.deviceId,elapsedAwayMs:Date.now()-state.lastActive,unansweredAutonomousMessages:Number(state.unansweredAutonomousMessages||0),state:apiState(),recent:(state.chatHistory||[]).slice(-10),deviceContext:state.deviceContext,reason})},8000));
    return String(d.decision||'NO').trim().toUpperCase()==='YES';
  }catch(_e){return false}
}
async function generateAutonomousMessage(reason='idle'){
  if(document.hidden||state.unansweredAutonomousMessages>=2||!(await shouldSendAutonomousMessage(reason)))return;
  refreshDeviceContext();
  try{
    const d=await runAiRequest(()=>fetchJson(state.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'autonomous',message:'',state:apiState(),memory:state.memory,deviceContext:state.deviceContext,elapsedAwayMs:Date.now()-state.lastActive})},25000));
    if(d.memoryUpdate)state.memory=d.memoryUpdate;
    applyServerFileActions(d);
    const action=normalizeAiMessageAction(d.messageAction);
    const reply=String(d.reply||d.message||'').trim();
    if(!action&&!reply)return;
    const item=action?{text:action.text,kind:action.kind,title:action.title||null,filename:action.filename||null,time:Date.now()}:{text:reply,kind:'text',title:null,filename:null,time:Date.now()};
    state.lastAutoMessage=Date.now();
    state.unansweredAutonomousMessages+=1;
    add(item.text,'her',false,true,time(),item.kind,{title:item.title,filename:item.filename});
    persistPresence();
  }catch(_e){setPresenceText()}
}
function importNativeRemoteMessages(){
  try{
    if(window.HikariNative&&typeof HikariNative.consumeRemoteMessages==='function'){
      const queued=JSON.parse(String(HikariNative.consumeRemoteMessages()||'[]'));
      if(Array.isArray(queued)){
        let imported=0;
        for(const item of queued){
          if(item&&item.text){state.autoQueue.push({text:String(item.text),time:Number(item.time||Date.now()),kind:String(item.kind||'text'),title:item.title||null,filename:item.filename||null});imported++}
        }
        if(imported)state.unansweredAutonomousMessages=Math.max(state.unansweredAutonomousMessages,imported);
      }
    }
  }catch(_e){}
}
function flushAutoQueue(){
  importNativeRemoteMessages();
  if(!state.autoQueue.length)return;
  const queued=[...state.autoQueue];
  state.autoQueue=[];
  persistPresence();
  queued.forEach(item=>add(item.text,'her',false,true,time(),item.kind||'text',{title:item.title||null,filename:item.filename||null}));
}
async function autonomousHeartbeat(){
  maybeShiftPresence();
  if(!document.hidden)flushAutoQueue();
  const now=Date.now();
  const idle=now-state.lastActive;
  const sinceAuto=now-state.lastAutoMessage;
  if(!document.hidden&&idle>15*60_000&&sinceAuto>60*60_000)generateAutonomousMessage('quiet conversation');
}
function markActive(){state.lastActive=Date.now();persistPresence()}
['pointerdown','keydown','touchstart'].forEach(evt=>document.addEventListener(evt,markActive,{passive:true}));
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){markActive();setPresenceText();}
  else{
    const away=Date.now()-state.lastActive;
    markActive();
    flushAutoQueue();
    setPresenceText();
  }
});
window.addEventListener('beforeunload',()=>{markActive();persistPresence()});
schedulePresence();setInterval(autonomousHeartbeat,30000);


function relayEndpoint(){return state.endpoint.replace(/\/api\/chat\/?$/,'/api/relay')}
async function relayApi(action,extra={}){
  if(!state.endpoint)return null;
  try{
    const j=await fetchJson(relayEndpoint(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,deviceId:state.deviceId,...extra})},9000);
    return j&&j.ok?j.data:null;
  }catch(_e){return null}
}
function relayMemoryText(kind,text,title,filename){
  if(kind==='voice')return `The player sent a voice message. Transcript: ${text}`;
  if(kind==='note')return `The player sent a note titled ${title||'For you'}: ${text}`;
  if(kind==='file')return `The player sent a text file named ${filename||'message.txt'}: ${text}`;
  return String(text||'');
}
async function requestHumanContinuity(message){
  if(Date.now()<state.aiOnlyUntil)return false;
  const d=await relayApi('request',{message,context:relayContext()});
  if(d&&d.status==='active'&&d.sessionId){
    state.relaySessionId=d.sessionId;state.relayRole='owner';state.aiVerifiedOnline=false;state.relayDecisionPending=false;state.busyUntil=0;
    appendLocalMemoryTurn('player',message);$('presence').textContent='online';autoSave();return true;
  }
  return false;
}
function relayContext(){return {affection:state.affection,jealousy:state.jealousy,awareness:state.awareness,style:['devoted','possessive','melancholic','concise'],recent:state.chatHistory.slice(-10).map(x=>({role:x.type==='me'?'player':'hikari',text:x.text}))}}
function renderRelayMessage(m,role){
  if(state.relaySeen.includes(m.id))return;
  state.relaySeen.push(m.id);state.relaySeen=state.relaySeen.slice(-300);
  const kind=String(m.kind||'text');const text=String(m.text||'');
  if(role==='owner'&&!m.mine){
    add(text,'her',false,true,time(),kind,{title:m.title||null,filename:m.filename||null});
    appendLocalMemoryTurn('hikari',relayMemoryText(kind,text,m.title,m.filename));state.affection=clamp(state.affection+1);
  }else if(role==='actor'&&!m.mine){
    add(text,'me',false,false,time(),kind,{title:m.title||null,filename:m.filename||null});
  }
  autoSave();
}
async function pollRelay(){
  const d=await relayApi('poll');if(!d)return;
  if(d.role==='none'){
    if(state.relayRole!=='none')clearRelayState();
    setPresenceText();return;
  }
  state.relayRole=d.role;state.relaySessionId=d.sessionId;
  if(d.role==='actor'&&!state.relayWhispered){
    const w=document.createElement('div');w.className='relay-whisper';w.textContent='Speak for me.';$('messages').append(w);state.relayWhispered=true;
  }
  (d.messages||[]).forEach(m=>renderRelayMessage(m,d.role));setPresenceText();autoSave();
}
async function sendActorRelay(kind,text,title=null,filename=null){
  if(state.relayRole!=='actor'||!state.relaySessionId)return false;
  const d=await relayApi('send',{sessionId:state.relaySessionId,kind,text,title,filename});
  if(d){add(text,'her',false,false,time(),kind,{title,filename});return true}
  clearRelayState();setPresenceText();return false;
}
async function sendOwnerRelay(kind,text,title=null,filename=null){
  if(state.relayRole!=='owner'||!state.relaySessionId)return false;
  const d=await relayApi('send',{sessionId:state.relaySessionId,kind,text,title,filename});
  if(d){appendLocalMemoryTurn('player',relayMemoryText(kind,text,title,filename));return true}
  clearRelayState();setPresenceText();return false;
}
async function endConnection(){
  setDrawer(false);await relayApi('end');clearRelayState();state.aiOnlyUntil=Date.now()+7*60*1000;state.busyUntil=0;state.relayDecisionPending=false;setPresenceText();autoSave();
  verifyHikariPresence();
}
let relayPollRunning=false;
async function relayTick(){
  if(relayPollRunning)return;relayPollRunning=true;
  try{
    const available=!document.hidden&&state.relayRole==='none'&&aiRequestActive===0&&Date.now()>=state.aiOnlyUntil;
    await relayApi('presence',{available,state:{busy:state.busyUntil>Date.now()}});
    await pollRelay();
  }finally{relayPollRunning=false}
}
setInterval(relayTick,12000);setTimeout(relayTick,1200);
function normalizeAiMessageAction(value){
  if(!value||typeof value!=='object')return null;
  const kind=String(value.kind||'').toLowerCase();
  const text=String(value.text||value.content||'').trim();
  if(!['voice','note','file'].includes(kind)||!text)return null;
  if(kind==='voice')return {kind,text};
  if(kind==='note')return {kind,text,title:String(value.title||'For you').trim()||'For you'};
  let filename=String(value.filename||value.name||'from_hikari.txt').replace(/[^A-Za-z0-9 _.-]/g,'_');
  if(!filename.toLowerCase().endsWith('.txt'))filename+='.txt';
  return {kind,text,filename};
}
function renderAiResult(result,pending,persist=true){
  const action=normalizeAiMessageAction(result&&result.messageAction);
  if(action){
    if(pending&&pending.row)pending.row.remove();
    return add(action.text,'her',false,persist,time(),action.kind,{title:action.title||null,filename:action.filename||null});
  }
  const reply=String(result&&result.reply||'').trim();
  if(!reply)throw new Error('offline');
  if(pending){
    pending.b.firstChild.textContent=reply;pending.b.classList.remove('typing');pending.m.textContent=time();
    if(persist)state.chatHistory.push({text:reply,type:'her',time:pending.m.textContent,at:Date.now(),kind:'text'});
    return pending;
  }
  return add(reply,'her',false,persist);
}
async function chatReply(msg,{mode='chat',includeFiles=false}={}){
  refreshDeviceContext();
  const payload={mode,message:msg,state:apiState(),memory:state.memory,deviceContext:state.deviceContext};
  if(includeFiles)payload.files=getHikariFiles();
  const d=await runAiRequest(()=>fetchJson(state.endpoint,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(payload)},30000));
  if(d.online===false||d.status==='offline')throw new Error('offline');
  if(d.memoryUpdate){state.memory=d.memoryUpdate;autoSave()}
  applyServerFileActions(d);
  const result={reply:String(d.reply||''),messageAction:d.messageAction||null};
  if(!result.reply.trim()&&!normalizeAiMessageAction(result.messageAction))throw new Error('offline');
  return result;
}
async function askHikariAvailability(){
  if(!state.endpoint)return {kind:'offline'};
  const statusUrl=state.endpoint.replace(/\/api\/chat\/?$/,'/api/status');
  try{
    const d=await runAiRequest(()=>fetchJson(statusUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:state.deviceId,recent:state.chatHistory.slice(-8).map(x=>({role:x.type==='me'?'player':'hikari',text:String(x.text||'')})),state:apiState()})},8000));
    if(!d.online)return {kind:'offline'};
    return {kind:String(d.decision||d.verification||'YES').toUpperCase()==='NO'?'redirect':'answer'};
  }catch(_e){return {kind:'offline'}}
}
async function routeWithoutFalseTyping(message,technicalFailure=false){
  const connected=await requestHumanContinuity(message);
  if(connected){$('presence').textContent='online';return true}
  $('presence').textContent=technicalFailure?'offline':'busy';return false;
}
function markPlayerResponded(){
  state.unansweredAutonomousMessages=0;
  try{if(window.HikariNative&&typeof HikariNative.markPlayerResponded==='function')HikariNative.markPlayerResponded()}catch(_e){}
}
async function processPlayerMessage(msg){
  if(state.relayRole==='owner'&&state.relaySessionId){
    if(await sendOwnerRelay('text',msg))return;
  }
  if(state.relayDecisionPending&&state.busyUntil>Date.now()){
    const relayed=await routeWithoutFalseTyping(msg,false);
    if(!relayed){appendLocalMemoryTurn('player',msg);state.aiVerifiedOnline=true;$('presence').textContent='busy';autoSave()}
    return;
  }
  if(state.busyUntil<=Date.now()){state.busyUntil=0;state.relayDecisionPending=false}
  try{
    const fileMode=wantsLocalFileMode(msg);
    const result=await chatReply(msg,{mode:fileMode?'file':'chat',includeFiles:fileMode});
    renderAiResult(result,null,true);
    state.aiReplyCount+=1;state.aiVerifiedOnline=true;state.busyUntil=0;state.relayDecisionPending=false;
    remember(msg);state.affection+=2;state.awareness+=1;update();autoSave();
  }catch(_e){
    state.aiVerifiedOnline=false;
    const relayed=await routeWithoutFalseTyping(msg,true);
    if(!relayed)appendLocalMemoryTurn('player',msg);
  }finally{setPresenceText()}
}
function sendMessage(){
  refreshDeviceContext();
  const msg=$('chatInput').value.trim();if(!msg)return;
  $('chatInput').value='';autosize();markActive();
  if(state.relayRole==='actor'&&state.relaySessionId){enqueueConversation(()=>sendActorRelay('text',msg));return}
  markPlayerResponded();add(msg,'me');state.activeTurnCount+=1;autoSave();
  enqueueConversation(()=>processPlayerMessage(msg));
}
$('chatForm').addEventListener('submit',e=>{e.preventDefault();sendMessage()});
$('chatInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}});
async function maybeRunTurnHeartbeat(){
  if(state.heartbeatRunning||state.activeTurnCount<17||state.activeTurnCount%17!==0||state.lastHeartbeatTurn===state.activeTurnCount)return;
  state.heartbeatRunning=true;state.lastHeartbeatTurn=state.activeTurnCount;autoSave();
  try{
    const choice=await askHikariAvailability();
    if(choice.kind==='answer'){
      state.relayDecisionPending=false;state.busyUntil=0;state.aiVerifiedOnline=true;
    }else if(choice.kind==='redirect'){
      state.relayDecisionPending=true;state.busyUntil=Date.now()+30_000;state.aiVerifiedOnline=true;
    }else{
      state.relayDecisionPending=false;state.busyUntil=0;state.aiVerifiedOnline=false;
    }
  }finally{state.heartbeatRunning=false;setPresenceText();autoSave()}
}
$('chatInput').addEventListener('pointerdown',maybeRunTurnHeartbeat,{passive:true});

function setDrawer(open){
  $('drawer').classList.toggle('open',open);
  $('drawerBackdrop').classList.toggle('show',open);
}
$('menuBtn').onclick=()=>setDrawer(!$('drawer').classList.contains('open'));
$('closeDrawer').onclick=()=>setDrawer(false);
$('drawerBackdrop').onclick=()=>setDrawer(false);
let drawerTouchY=null;
$('drawer').addEventListener('touchstart',e=>{drawerTouchY=e.touches[0].clientY},{passive:true});
$('drawer').addEventListener('touchend',e=>{
  if(drawerTouchY===null)return;
  const dy=e.changedTouches[0].clientY-drawerTouchY;
  if(dy>55)setDrawer(false);
  drawerTouchY=null;
},{passive:true});
document.addEventListener('keydown',e=>{if(e.key==='Escape')setDrawer(false)});


const endConnectionButton=$('endConnection');if(endConnectionButton)endConnectionButton.onclick=endConnection;
function openSendSomething(){setDrawer(false);$('sendSomethingBack').classList.add('show');$('sendSomethingHint').textContent=state.relayRole==='actor'?'Choose how Hikari will answer through you.':'Leave something for Hikari without exposing raw files or your voice.'}
$('plusBtn').onclick=openSendSomething;$('closeSendSomething').onclick=()=>$('sendSomethingBack').classList.remove('show');$('sendSomethingBack').onclick=e=>{if(e.target===$('sendSomethingBack'))$('sendSomethingBack').classList.remove('show')};
$('closeContentViewer').onclick=()=>$('contentViewerBack').classList.remove('show');$('contentViewerBack').onclick=e=>{if(e.target===$('contentViewerBack'))$('contentViewerBack').classList.remove('show')};
for(const btn of document.querySelectorAll('[data-kind]'))btn.onclick=async()=>{
  const kind=btn.dataset.kind;$('sendSomethingBack').classList.remove('show');
  let text='',title=null,filename=null;
  if(kind==='voice')text=prompt(state.relayRole==='actor'?'What should Hikari say?':'Speak in words. Your real voice never leaves this device.')||'';
  else if(kind==='note'){title=prompt('Title')||'For you';text=prompt('Write the note')||''}
  else{filename=(prompt('File name')||'from_hikari.txt').replace(/[^A-Za-z0-9 _.-]/g,'_');if(!filename.toLowerCase().endsWith('.txt'))filename+='.txt';text=prompt('Write the file contents')||''}
  if(!text.trim())return;
  if(state.relayRole==='actor'&&state.relaySessionId){enqueueConversation(()=>sendActorRelay(kind,text,title,filename));return}
  markPlayerResponded();add(text,'me',false,true,time(),kind,{title,filename});state.activeTurnCount+=1;autoSave();
  enqueueConversation(()=>processMessagePayload(kind,text,title,filename));
};
async function processMessagePayload(kind,text,title,filename){
  const synthetic=relayMemoryText(kind,text,title,filename);
  if(state.relayRole==='owner'&&state.relaySessionId){
    if(await sendOwnerRelay(kind,text,title,filename))return;
  }
  if(state.relayDecisionPending&&state.busyUntil>Date.now()){
    const relayed=await routeWithoutFalseTyping(synthetic,false);
    if(!relayed){appendLocalMemoryTurn('player',synthetic);state.aiVerifiedOnline=true;$('presence').textContent='busy';autoSave()}
    return;
  }
  try{
    const result=await chatReply(synthetic,{mode:'chat',includeFiles:false});
    renderAiResult(result,null,true);state.aiVerifiedOnline=true;state.busyUntil=0;state.relayDecisionPending=false;autoSave();
  }catch(_e){state.aiVerifiedOnline=false;const relayed=await routeWithoutFalseTyping(synthetic,true);if(!relayed)appendLocalMemoryTurn('player',synthetic)}
  finally{setPresenceText()}
}
async function requestInitialMessage(){
  if(!state.endpoint||state.initialMessageRequested||state.chatHistory.length)return;
  state.initialMessageRequested=true;autoSave();refreshDeviceContext();
  try{
    const d=await runAiRequest(()=>fetchJson(state.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'initial',message:'',state:apiState(),memory:state.memory,deviceContext:state.deviceContext})},30000));
    if(d.memoryUpdate)state.memory=d.memoryUpdate;applyServerFileActions(d);
    renderAiResult({reply:d.reply||'',messageAction:d.messageAction||null},null,true);state.aiVerifiedOnline=true;autoSave();
  }catch(_e){state.aiVerifiedOnline=false;state.initialMessageRequested=false;setPresenceText();autoSave()}
}

function updateInboxPreview(){
  const latest=[...state.chatHistory].reverse().find(x=>x&&x.text);
  $('inboxPreview').textContent=latest?(latest.kind==='voice'?'Voice message':latest.kind==='note'?(latest.title||'Note'):latest.kind==='file'?(latest.filename||'Text file'):String(latest.text).replace(/\s+/g,' ').slice(0,80)):'Tap to open the conversation';
  $('inboxTime').textContent=latest?(latest.time||''):'';
  const mainPortrait=document.querySelector('#chatHeader .portrait img');
  if(mainPortrait&&$('inboxPortrait'))$('inboxPortrait').src=mainPortrait.src;
}
function showInbox(fromHistory=false){setDrawer(false);$('sendSomethingBack').classList.remove('show');$('chatHeader').classList.add('view-hidden');$('chatScreen').classList.add('view-hidden');$('inboxScreen').classList.remove('view-hidden');updateInboxPreview();if(!fromHistory&&location.hash==='#hikari')history.back()}
function showChat(push=true){$('inboxScreen').classList.add('view-hidden');$('chatHeader').classList.remove('view-hidden');$('chatScreen').classList.remove('view-hidden');if(push&&location.hash!=='#hikari')history.pushState({screen:'chat'},'', '#hikari');setTimeout(()=>{$('messages').scrollTop=$('messages').scrollHeight;$('chatInput').focus()},60)}
const openHikariChatButton=$('openHikariChat');if(openHikariChatButton){openHikariChatButton.addEventListener('click',()=>showChat(true));openHikariChatButton.addEventListener('touchend',e=>{e.preventDefault();showChat(true)},{passive:false});}
$('backToInbox').onclick=()=>showInbox(false);
window.addEventListener('popstate',()=>{if(location.hash==='#hikari')showChat(false);else showInbox(true)});
const detectedName=nativePlayerName();if(detectedName)state.playerName=detectedName;else if(!state.playerName||state.playerName==='Your Majesty')state.playerName='Anonymous';
refreshDeviceContext();restoreChat();flushAutoQueue();update();setPresenceText();verifyHikariPresence().then(()=>{if(state.endpoint&&state.aiVerifiedOnline)setTimeout(requestInitialMessage,1200)});setInterval(verifyHikariPresence,300000);autosize();updateInboxPreview();
if(location.hash==='#hikari')showChat(false);else showInbox(true);

function syncNativeBridge(){
  try{
    if(window.HikariNative){
      HikariNative.configure(state.playerName||'Anonymous');
      HikariNative.saveSnapshot(JSON.stringify(snapshot()));
      HikariNative.setNotificationsEnabled(true);
    }
  }catch(_e){}
}
setInterval(()=>{commitSave();syncNativeBridge()},10000);
window.addEventListener('load',()=>{commitSave();syncNativeBridge()});
document.addEventListener('visibilitychange',()=>{if(document.hidden)syncNativeBridge();});
