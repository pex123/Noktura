/* NOKTURA live layer: same presentation as premium.js, backed by the real server
   (world map pins, live location, door check-ins, chat attachments, profile). */
(function(){
const $=id=>document.getElementById(id), safe=escHtml;
const storage={get(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback}catch{return fallback}},set(key,value){try{localStorage.setItem(key,JSON.stringify(value));return true}catch{return false}}};
const CFG=window.NOKTURA_CONFIG||{};
let worldMap,worldTiles,markerLayer,worldMarkers=new Map(),dropType=null,dropPoint=null,worldFilter='all',geoWatch=null,searchResults=[],searching=false,lastSearch=0;
let worldPins=[],pinsLoaded=false,lastSentLocation=null;
function visiblePins(){return worldPins.filter(p=>worldFilter==='all'||p.type===({events:'event',friends:'friend'}[worldFilter]||worldFilter))}
function pinLabel(type){return {event:'Event',meetup:'Meet-up',friend:'Friend location'}[type]||'Place'}
function priceText(p){return p.price==null?'View event':(Number(p.price)===0?'Free · View event':'From $'+p.price+' · View event')}
async function fetchPins(){
  try{const r=await api('/api/pins');worldPins=(r.pins||[]).filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lng));pinsLoaded=true}
  catch(e){toast('Couldn’t load map pins: '+e.message,'err')}
}
function renderWorld(){
  if(!worldMap)return;
  markerLayer.clearLayers();worldMarkers.clear();
  const pins=visiblePins();
  pins.forEach(p=>{
    const icon=L.divIcon({className:'world-marker '+p.type,html:'<div><span>'+safe(p.type==='event'?'↗':p.type==='meetup'?'+':(p.by||p.title||'N')[0].toUpperCase())+'</span></div>',iconSize:[39,39],iconAnchor:[19,39]});
    const marker=L.marker([p.lat,p.lng],{icon,draggable:!!p.mine,title:p.title,keyboard:true}).addTo(markerLayer).on('click',()=>openWorldPin(p.id));
    marker.on('dragend',async()=>{const ll=marker.getLatLng().wrap();const prev=[p.lat,p.lng];p.lat=ll.lat;p.lng=ll.lng;try{await api('/api/pins/'+encodeURIComponent(p.id),{method:'PATCH',body:JSON.stringify({lat:ll.lat,lng:ll.lng})});if(!$('venueDrawer').hidden)openWorldPin(p.id);toast('Pin location updated','ok')}catch(e){[p.lat,p.lng]=prev;marker.setLatLng(prev);toast(e.message,'err')}});
    worldMarkers.set(p.id,marker);
  });
  $('mapList').replaceChildren();
  pins.forEach(p=>{const btn=document.createElement('button');btn.className='world-place '+p.type;btn.innerHTML='<span class="world-place-art">'+(p.type==='event'?'':safe(p.type==='friend'?(p.by||'N')[0].toUpperCase():'+'))+'</span><span class="world-place-copy"><strong>'+safe(p.title)+'</strong><small>'+safe(p.subtitle||pinLabel(p.type))+'</small><em>'+safe(p.mine?'Your pin · drag to move':p.type==='event'?priceText(p):p.type==='friend'?'Sharing location · @'+p.by:'Meet your people · @'+p.by)+'</em></span><span>↗</span>';btn.onclick=()=>openWorldPin(p.id,true);$('mapList').append(btn)});
  if(!pins.length)$('mapList').innerHTML='<p class="empty-inbox">Nothing here yet. Drop a pin to start a plan.</p>';
  $('worldPinCount').textContent=pins.length+' places';
  const events=worldPins.filter(p=>p.type==='event').length,friends=worldPins.filter(p=>p.type==='friend').length;
  $('mapLiveCount').textContent=events+' '+(events===1?'event':'events');$('mapFriendCount').textContent=friends+' '+(friends===1?'friend location':'friend locations');
}
let refetchTimer=null;
function scheduleRefetch(){clearTimeout(refetchTimer);refetchTimer=setTimeout(async()=>{if(!worldMap)return;await fetchPins();renderWorld();const open=$('venueDrawer');if(open&&!open.hidden&&open.dataset.pin){if(worldPins.some(p=>p.id===open.dataset.pin))openWorldPin(open.dataset.pin);else closeVenueDrawer()}},1200)}
// Live map updates over the existing realtime connection.
const baseConnect=window.connectSocket;
window.connectSocket=connectSocket=function(){baseConnect();socket.on('pins_changed',scheduleRefetch)};
window.initMap=async function(){
  if(!window.L){toast('Map library could not load. Reload this page.');return;}
  if(!worldMap){
    worldMap=L.map('mapCanvasArea',{zoomControl:false,worldCopyJump:true,minZoom:2,maxZoom:19}).setView([44.8176,20.4583],14);
    worldTiles=L.tileLayer(CFG.tileUrl||'https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:CFG.tileAttribution||'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'}).addTo(worldMap);
    let failedTiles=0;worldTiles.on('tileerror',()=>{if(++failedTiles>3)$('tileStatus').hidden=false}).on('load',()=>{if(failedTiles===0)$('tileStatus').hidden=true;failedTiles=0});
    markerLayer=L.layerGroup().addTo(worldMap);
    worldMap.on('moveend',()=>{const c=worldMap.getCenter();$('mapCoordinates').textContent=Math.abs(c.lat).toFixed(4)+'° '+(c.lat>=0?'N':'S')+' · '+Math.abs(c.wrap().lng).toFixed(4)+'° '+(c.wrap().lng>=0?'E':'W')});
    worldMap.on('click',e=>{if(!dropType)return;dropPoint=e.latlng.wrap();openNewPinForm(dropType)});
    await fetchPins();renderWorld();
  }else{await fetchPins();renderWorld()}
  setTimeout(()=>worldMap.invalidateSize(),100);
};
window.retryWorldTiles=()=>{$('tileStatus').hidden=true;worldTiles?.redraw()};
window.setMapFilter=function(btn,filter){worldFilter=filter;document.querySelectorAll('.map-fp').forEach(b=>b.classList.toggle('active',b===btn));closeVenueDrawer();renderWorld()};
window.setMapPanelTab=function(type){const value={event:'events',friend:'friends'}[type]||type;const btn=[...document.querySelectorAll('.map-fp')].find(b=>b.getAttribute('onclick').includes("'"+value+"'"));if(btn)setMapFilter(btn,value)};
window.renderMapPins=window.renderMapPanel=renderWorld;
window.loadPins=async()=>{await fetchPins();renderWorld()};
window.mapZoom=factor=>worldMap?.setZoom(worldMap.getZoom()+(factor>1?1:-1));
window.centerMap=function(){const pins=visiblePins();if(pins.length)worldMap.fitBounds(pins.map(p=>[p.lat,p.lng]),{padding:[65,65],maxZoom:15});else worldMap.setView([20,0],2)};
window.searchWorld=async function(){
  const query=$('worldSearch').value.trim();if(query.length<2){$('worldSearchResults').textContent='Enter at least 2 characters.';return}if(searching)return;
  const cached=storage.get('noktura_world_search',{});
  if(cached[query.toLowerCase()])return showSearch(cached[query.toLowerCase()]);
  if(Date.now()-lastSearch<1200){$('worldSearchResults').textContent='Please wait a moment before another search.';return}
  searching=true;lastSearch=Date.now();$('worldSearchResults').textContent='Finding your next destination…';
  try{const r=await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=4&q='+encodeURIComponent(query));if(!r.ok)throw Error('Search unavailable');const results=await r.json();const keys=Object.keys(cached);if(keys.length>40)delete cached[keys[0]];cached[query.toLowerCase()]=results;storage.set('noktura_world_search',cached);showSearch(results)}catch{$('worldSearchResults').textContent='Search is unavailable. You can still pan and zoom anywhere on the map.'}finally{searching=false}
};
function showSearch(results){searchResults=results;$('worldSearchResults').replaceChildren();if(!results.length){$('worldSearchResults').textContent='No places found. Try a city and country.';return}results.forEach((r,i)=>{const b=document.createElement('button');b.type='button';b.textContent=r.display_name;b.onclick=()=>chooseWorldPlace(i);$('worldSearchResults').append(b)})}
function chooseWorldPlace(i){const r=searchResults[i];if(!r)return;worldMap.setView([+r.lat,+r.lon],13);$('mapPanelCity').textContent=r.name||r.display_name.split(',')[0];$('worldSearchResults').replaceChildren();$('worldSearch').value='';closeVenueDrawer()}
window.startPinDropMode=function(type){if(!worldMap)return;dropType=type;$('mapCanvasArea').classList.add('dropping');$('dropHint').hidden=false;closeVenueDrawer();toast('Tap the map to place your '+(type==='friend'?'location':pinLabel(type).toLowerCase()))};
window.cancelWorldDrop=function(){dropType=null;dropPoint=null;$('mapCanvasArea').classList.remove('dropping');$('dropHint').hidden=true};
window.openNewPinForm=function(type){dropType=type;$('newPinTitle').textContent=type==='friend'?'Place your location':'New '+pinLabel(type).toLowerCase();$('pinTitleIn').value=type==='friend'?'@'+ME:'';$('pinSubtitleIn').value='';$('pinDescIn').value='';$('pinPriceIn').value='';$('pinVisibilityIn').value='all_friends';$('pinPriceRow').style.display=type==='event'?'block':'none';$('newPinOverlay').style.display='flex';setTimeout(()=>$('pinTitleIn').focus(),30)};
window.closeNewPinForm=function(){$('newPinOverlay').style.display='none';cancelWorldDrop()};
let submittingPin=false;
window.submitNewPin=async function(){
  if(submittingPin)return;
  const title=$('pinTitleIn').value.trim(),rawPrice=$('pinPriceIn').value,price=Number(rawPrice||0);if(!title){toast('Add a name for your pin');$('pinTitleIn').focus();return}if(!dropPoint)return;if(price<0||!Number.isFinite(price)){toast('Enter a valid price');return}
  const body={type:dropType,title:title.slice(0,100),subtitle:$('pinSubtitleIn').value.trim().slice(0,140),description:$('pinDescIn').value.trim().slice(0,500),lat:dropPoint.lat,lng:dropPoint.lng,visibility:$('pinVisibilityIn').value};
  if(dropType==='event'&&rawPrice!=='')body.priceUsd=price;
  submittingPin=true;
  try{const r=await api('/api/pins',{method:'POST',body:JSON.stringify(body)});worldPins=worldPins.filter(p=>p.id!==r.pin.id);worldPins.unshift(r.pin);worldFilter='all';document.querySelectorAll('.map-fp').forEach((b,i)=>b.classList.toggle('active',i===0));closeNewPinForm();renderWorld();openWorldPin(r.pin.id);toast('Pin dropped!','ok')}
  catch(e){toast(e.message,'err')}finally{submittingPin=false}
};
async function openLinkedEvent(p){
  closeVenueDrawer();await loadTicketData();
  const ev=_nativeEvents.find(e=>e.id===p.eventId)||_nativeEvents.find(e=>e.title.toLowerCase()===String(p.title).toLowerCase());
  if(ev){openEvModal(ev.id);return}
  gotoTab('tickets');const s=document.querySelector('#page-tickets input[oninput*="evSearch"]');if(s){s.value=p.title;evSearch(p.title)}
}
function openWorldPin(id,fly){
  const p=worldPins.find(p=>p.id===id);if(!p)return;
  if(fly)worldMap.flyTo([p.lat,p.lng],Math.max(worldMap.getZoom(),14),{duration:.7});
  $('venueDrawer').hidden=false;$('venueDrawer').dataset.pin=id;$('vdTag').textContent=pinLabel(p.type)+(p.mine?' / YOUR PIN':' / @'+String(p.by||'').toUpperCase());$('vdName').textContent=p.title;$('vdMeta').textContent=p.description||p.subtitle||'Your next meeting point.';
  $('vdStats').textContent=p.lat.toFixed(5)+', '+p.lng.toFixed(5)+' · '+timeAgo(p.updatedAt||p.createdAt)+(p.mine?' · Drag the marker to move it · '+({public:'Everyone',close_friends:'Close friends'}[p.visibility]||'All friends'):'');
  $('vdActions').replaceChildren();
  const action=(label,fn,primary=false)=>{const b=document.createElement('button');b.className='btn '+(primary?'btn-accent':'btn-ghost');b.textContent=label;b.onclick=fn;$('vdActions').append(b)};
  if(p.type==='event'&&!p.mine)action('View event ↗',()=>openLinkedEvent(p),true);
  if(p.type!=='event'&&!p.mine)action('Message @'+p.by,()=>openDM(p.by),true);
  action('Directions ↗',()=>window.open('https://www.openstreetmap.org/directions?to='+p.lat+'%2C'+p.lng,'_blank','noopener'));
  if(p.mine)action(p.live?'Stop sharing':'Remove pin',()=>deletePin(id));
}
window.openPinDrawer=openWorldPin;
window.closeVenueDrawer=()=>{$('venueDrawer').hidden=true};
window.deletePin=async id=>{
  const p=worldPins.find(x=>x.id===id);if(!p||!p.mine)return;
  try{
    if(p.live){if(geoWatch!==null){navigator.geolocation.clearWatch(geoWatch);geoWatch=null;$('shareLocBtn').textContent='Locate me'}await api('/api/pins/friend-location',{method:'DELETE'})}
    else await api('/api/pins/'+encodeURIComponent(id),{method:'DELETE'});
    worldPins=worldPins.filter(x=>x.id!==id);renderWorld();closeVenueDrawer();toast('Pin removed','ok');
  }catch(e){toast(e.message,'err')}
};
function metersBetween(a,b){const R=6371e3,r=Math.PI/180,dLat=(b.lat-a.lat)*r,dLng=(b.lng-a.lng)*r,x=Math.sin(dLat/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dLng/2)**2;return 2*R*Math.asin(Math.sqrt(x))}
async function sendLocation(lat,lng,force){
  const now=Date.now();
  if(!force&&lastSentLocation&&now-lastSentLocation.at<20000&&metersBetween(lastSentLocation,{lat,lng})<30)return;
  lastSentLocation={lat,lng,at:now};
  const r=await api('/api/pins/friend-location',{method:'POST',body:JSON.stringify({lat,lng,visibility:'all_friends'})});
  worldPins=worldPins.filter(p=>!(p.mine&&p.live));worldPins.unshift(r.pin);renderWorld();
}
window.toggleShareLocation=function(){
  if(geoWatch!==null){navigator.geolocation.clearWatch(geoWatch);geoWatch=null;lastSentLocation=null;$('shareLocBtn').textContent='Locate me';api('/api/pins/friend-location',{method:'DELETE'}).then(()=>{worldPins=worldPins.filter(p=>!(p.mine&&p.live));renderWorld();toast('Location sharing stopped')}).catch(e=>toast(e.message,'err'));return}
  if(!navigator.geolocation){toast('Location unavailable. Use + My location to drop a pin.');return}
  $('shareLocBtn').textContent='Locating…';let first=true;
  geoWatch=navigator.geolocation.watchPosition(pos=>{const lat=pos.coords.latitude,lng=pos.coords.longitude;sendLocation(lat,lng,first).then(()=>{if(first){worldMap?.setView([lat,lng],15);toast('Sharing your live location with friends','ok')}first=false;$('shareLocBtn').textContent='Stop sharing'}).catch(e=>toast(e.message,'err'))},()=>{if(geoWatch!==null)navigator.geolocation.clearWatch(geoWatch);geoWatch=null;$('shareLocBtn').textContent='Locate me';toast('Location access unavailable. Use + My location to place it manually.')},{enableHighAccuracy:true,timeout:15000,maximumAge:30000});
};
window.updateShareLocationBtn=()=>{};
// Messages: reuse the same conversations and send actions with a new presentation.
let inboxFilter='all',inboxQuery='';
window.renderMsgList=async function(filter){if(filter)inboxFilter=filter;try{const r=await api('/api/chats');_chatCache=r.chats||[];paintInbox()}catch{$('msgList').innerHTML='<p class="empty-inbox">Couldn’t load conversations. Open messages to try again.</p>'}};
function chatName(c){return c.type==='group'||c.type==='event'?c.name:'@'+(c.members.find(m=>m.handle!==ME)?.handle||'friend')}
function paintInbox(){
  $('inboxCount').textContent=_chatCache.length;
  const chats=[..._chatCache].filter(c=>(inboxFilter==='all'||c.type===inboxFilter)&&(chatName(c)+' '+(c.lastMessage?.text||'')).toLowerCase().includes(inboxQuery)).sort((a,b)=>(b.lastMessage?.at||0)-(a.lastMessage?.at||0));
  $('msgList').replaceChildren();chats.forEach(c=>{const b=document.createElement('button');b.className='mi-item'+(c.id===activeChatId?' active-c':'');b.setAttribute('aria-label',chatName(c));b.innerHTML='<span class="mi-av">'+safe(chatAvatarFromApi(c))+(c.members.some(m=>m.handle!==ME&&m.online)?'<i class="mi-online"></i>':'')+'</span><span class="mi-info"><span class="mi-name">'+safe(chatName(c))+'</span><span class="mi-last" style="display:block">'+safe(c.lastMessage?.text||'Start a conversation')+'</span></span><span class="mi-right"><span class="mi-time">'+safe(c.lastMessage?timeAgo(c.lastMessage.at):'')+'</span>'+(c.unread?'<span class="mi-unread">'+Number(c.unread)+'</span>':'')+'</span>';b.onclick=()=>openChat(c.id);$('msgList').append(b)});
  if(!chats.length)$('msgList').innerHTML='<p class="empty-inbox">No conversations here yet.<br>Start something with “New conversation”.</p>';
}
window.filterChats=q=>{inboxQuery=q.toLowerCase();paintInbox()};
window.msgTab=(btn,type)=>{inboxFilter=type;document.querySelectorAll('.msg-tab').forEach(b=>b.classList.toggle('active',b===btn));paintInbox()};
const baseOpenChat=window.openChat;
window.openChat=async function(id){await baseOpenChat(id);const c=_chatCache.find(c=>c.id===id);$('conversationContext').textContent=c?.type==='group'?c.members.length+' people. One great plan.':'Make a plan. Bring your people.';$('chatShareTray').hidden=true;};
window.openMessagesTab=async function(){await renderMsgList();if(activeChatId&&_chatCache.some(c=>c.id===activeChatId)){await openChat(activeChatId);return}if(innerWidth>760&&_chatCache.length)await openChat(_chatCache.find(c=>c.type==='dm')?.id||_chatCache[0].id)};
const UPLOAD_RE=/https?:\/\/[^\s<>"]+\/api\/uploads\/[a-f0-9]{32}/g;
function linkify(text){return safe(text).replace(UPLOAD_RE,u=>'<a href="'+u+'" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">Open attachment ↗</a>')}
window.renderBubble=function(m){if(m.from==='system')return '<div class="message-date">'+safe(m.text)+'</div>';const mine=m.from===ME;const date=new Date(m.at||Date.now());return '<div class="bubble-wrap '+(mine?'mine':'theirs')+'">'+(!mine?'<span class="bubble-from">@'+safe(m.from)+'</span>':'')+'<div class="bubble '+(mine?'mine':'theirs')+'">'+linkify(m.text)+'</div><span class="bubble-time">'+date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+(mine?' · Sent':'')+'</span></div>'};
window.renderMessageList=function(el,msgs){if(!msgs.length){el.innerHTML='<div class="chat-empty-state"><p>A great night starts with hello.</p></div>';return}let day='';el.innerHTML=msgs.map(m=>{const d=new Date(m.at||Date.now()).toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'});const heading=day!==d?'<div class="message-date">'+safe(d)+'</div>':'';day=d;return heading+renderBubble(m)}).join('');requestAnimationFrame(()=>el.scrollTop=el.scrollHeight)};
const baseSend=window.sendMsg;
window.sendMsg=function(){baseSend();setTimeout(()=>renderMsgList(),300)};
window.shareChatEvent=function(){if(!activeChatId){toast('Choose a conversation first');return}$('chatShareTray').hidden=!$('chatShareTray').hidden};
window.sendSharedEvent=function(){$('chatIn').value='Let’s go to Warehouse Night ↗\nFabrika, Belgrade · From $15';sendMsg();$('chatShareTray').hidden=true};
window.attachChatFile=async function(input){
  const file=input.files?.[0];if(!file)return;input.value='';
  if(!activeChatId){toast('Choose a conversation first');return}
  if(file.size>8*1024*1024){toast('Choose a file smaller than 8 MB');return}
  if(!socket||!socket.connected){toast('Not connected to server','err');return}
  toast('Uploading '+file.name+'…');
  try{
    const data=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result).split(',')[1]||'');r.onerror=()=>rej(Error('Could not read this file.'));r.readAsDataURL(file)});
    const up=await api('/api/uploads',{method:'POST',body:JSON.stringify({filename:file.name,contentType:file.type||'application/octet-stream',data,chatId:activeChatId})});
    $('chatIn').value='📎 '+file.name+'\n'+location.origin+up.url;sendMsg();
  }catch(e){toast(e.message,'err')}
};
// Door check-in: camera / image / code entry all verify against the server's guest list.
let ticketRegistry=[],cameraStream=null,cameraFrame=null,scannerOpen=false,returnFocus=null,scanBusy=false;
const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true});
async function loadEntryTickets(){
  try{const r=await api('/api/tickets/guests');ticketRegistry=r.guests||[]}catch(e){ticketRegistry=[];$('scanFeedback').textContent='Couldn’t load your guest list: '+e.message}
  $('scanGuestCount').textContent=ticketRegistry.length;$('scanCheckedCount').textContent=ticketRegistry.filter(t=>t.checked).length;
}
function renderTryButton(){const t=ticketRegistry.find(t=>!t.checked);$('demoTicketBtns').innerHTML=t?'Try a ticket from your list: <button onclick="document.getElementById(\'scanCodeInput\').value=\''+safe(t.code)+'\';document.getElementById(\'scanCodeInput\').focus()">'+safe(t.code)+' ↗</button>':''}
window.openTicketScanner=async function(){returnFocus=document.activeElement;scannerOpen=true;const overlay=$('ticketScannerOverlay');overlay.style.opacity='1';overlay.style.pointerEvents='auto';overlay.setAttribute('aria-hidden','false');scannerTab('scan');hideVerifyResult();await loadEntryTickets();renderGuestList();renderTryButton();$('scanCodeInput').focus()};
window.closeTicketScanner=function(){scannerOpen=false;stopCamera();$('ticketScannerOverlay').style.opacity='0';$('ticketScannerOverlay').style.pointerEvents='none';$('ticketScannerOverlay').setAttribute('aria-hidden','true');hideVerifyResult();returnFocus?.focus()};
window.scannerTab=function(tab){['scan','manual','list'].forEach(t=>{$('stab-'+t).classList.toggle('active',t===tab);$('spanel-'+t).hidden=t!==tab;$('spanel-'+t).style.display=t===tab?'block':'none'});if(tab!=='scan')stopCamera();if(tab==='manual')manualLookupSearch($('manualLookup').value);if(tab==='list')renderGuestList();$('scanFeedback').textContent=''};
function stopCamera(){if(cameraFrame)cancelAnimationFrame(cameraFrame);cameraFrame=null;cameraStream?.getTracks().forEach(t=>t.stop());cameraStream=null;$('scannerVideo').srcObject=null;document.querySelector('.scanner-camera').classList.remove('camera-active');$('cameraStart').hidden=false;$('cameraStatus').textContent='Bring the night into focus.'}
window.startTicketCamera=async function(){
  if(!navigator.mediaDevices?.getUserMedia){$('scanFeedback').textContent='Camera access is unavailable. Upload a QR image or enter its code.';return}
  stopCamera();$('cameraStatus').textContent='Waiting for camera permission…';
  try{const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});if(!scannerOpen||$('spanel-scan').hidden){stream.getTracks().forEach(t=>t.stop());return}cameraStream=stream;$('scannerVideo').srcObject=stream;await $('scannerVideo').play();document.querySelector('.scanner-camera').classList.add('camera-active');$('cameraStart').hidden=true;$('cameraStatus').textContent='Hold your ticket inside the frame.';readCameraFrame()}catch{$('cameraStatus').textContent='Camera unavailable';$('scanFeedback').textContent='Allow camera access in your browser, or upload a ticket image.'}
};
let lastFrameAt=0;
function readCameraFrame(){if(!cameraStream)return;const v=$('scannerVideo');if(v.readyState>=2&&Date.now()-lastFrameAt>180){lastFrameAt=Date.now();const w=Math.min(v.videoWidth,800);canvas.width=w;canvas.height=Math.round(v.videoHeight*w/v.videoWidth);context.drawImage(v,0,0,canvas.width,canvas.height);const pixels=context.getImageData(0,0,canvas.width,canvas.height);const qr=window.jsQR?.(pixels.data,pixels.width,pixels.height);if(qr){stopCamera();verifyTicketCode(qr.data);return}}cameraFrame=requestAnimationFrame(readCameraFrame)}
window.scanTicketImage=async function(input){const file=input.files?.[0];if(!file)return;try{if(file.size>20*1024*1024)throw Error('Choose an image smaller than 20 MB.');const img=await createImageBitmap(file);const scale=Math.min(1,1800/Math.max(img.width,img.height));canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale);context.drawImage(img,0,0,canvas.width,canvas.height);img.close();const pixels=context.getImageData(0,0,canvas.width,canvas.height);const qr=window.jsQR?.(pixels.data,pixels.width,pixels.height);if(!qr)throw Error('No QR code found. Try a clearer ticket image or enter its code.');verifyTicketCode(qr.data)}catch(e){$('scanFeedback').textContent=e.message||'Could not read this image.'}finally{input.value=''}};
function normalizedCode(value){let code=String(value||'').trim();try{const data=JSON.parse(code);code=data.code||data.ticketCode||code}catch{}try{const u=new URL(code);code=u.searchParams.get('code')||u.searchParams.get('ticket')||code}catch{}return String(code).trim().toUpperCase()}
window.verifyTicketCode=async function(raw){
  if(scanBusy)return;const code=normalizedCode(raw);if(!code){$('scanFeedback').textContent='Enter a ticket code first.';return}scanBusy=true;stopCamera();$('scanFeedback').textContent='Checking ticket…';
  let result;
  try{result=await api('/api/tickets/verify',{method:'POST',body:JSON.stringify({code})})}catch(e){$('scanFeedback').textContent=e.message;scanBusy=false;return}
  $('scanFeedback').textContent='';
  const ticket=result.ticket,found=result.status!=='not_found',repeat=result.status==='already';
  if(ticket){const i=ticketRegistry.findIndex(t=>t.code===ticket.code);if(i<0)ticketRegistry.push(ticket);else ticketRegistry[i]=ticket}
  const title=!found?'Ticket not found':repeat?'Already checked in.':'Welcome to the night.';
  $('verifyResultInner').innerHTML='<div class="verification-symbol">'+(!found?'?':repeat?'!':'✓')+'</div><div class="eyebrow">'+(!found?'CHECK THE CODE':repeat?'ENTRY ALREADY RECORDED':'ENTRY CONFIRMED')+'</div><h2>'+title+'</h2><p>'+(!found?'This code isn’t on the guest list for your events. Check the code and try again.':repeat?'This ticket was checked in '+new Date(ticket.checked).toLocaleString()+'.':'You’re all set. Enjoy every minute of it.')+'</p>'+(ticket?'<div class="verification-ticket"><span>'+safe(ticket.event)+'<small>'+safe(ticket.name)+'</small></span><span>'+safe(ticket.code)+'<small>Recorded on the guest list</small></span></div>':'')+'<button class="btn btn-accent" onclick="hideVerifyResult()">'+(found&&!repeat?'Scan next ticket ↗':'Try another ticket ↗')+'</button>';
  $('verifyResult').hidden=false;$('verifyResult').style.display='flex';$('scanGuestCount').textContent=ticketRegistry.length;$('scanCheckedCount').textContent=ticketRegistry.filter(t=>t.checked).length;renderGuestList();manualLookupSearch($('manualLookup').value);renderTryButton();requestAnimationFrame(()=>$('verifyResult').querySelector('button').focus());scanBusy=false;
};
window.hideVerifyResult=function(){$('verifyResult').hidden=true;$('verifyResult').style.display='none';$('scanCodeInput').value='';if(scannerOpen)$('scanCodeInput').focus()};
function guestRows(target,query=''){$(target).replaceChildren();const tickets=ticketRegistry.filter(t=>(t.name+' '+t.event+' '+t.code).toLowerCase().includes(query.toLowerCase()));tickets.forEach(t=>{const row=document.createElement('div');row.className='guest-row';row.innerHTML='<span class="guest-avatar">'+safe((t.name.replace('@','')[0]||'?').toUpperCase())+'</span><div><strong>'+safe(t.name)+'</strong><small>'+safe(t.event)+' · '+safe(t.code)+'</small></div>';if(t.checked){const status=document.createElement('span');status.className='guest-status';status.textContent='Checked in · '+new Date(t.checked).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});row.append(status)}else{const btn=document.createElement('button');btn.className='btn btn-accent';btn.textContent='Check in ↗';btn.onclick=()=>verifyTicketCode(t.code);row.append(btn)}$(target).append(row)});if(!tickets.length)$(target).innerHTML='<p class="empty-inbox">'+(ticketRegistry.length?'No matching tickets.':'No tickets yet. Tickets for your events and your own tickets appear here.')+'</p>'}
window.renderGuestList=()=>guestRows('guestListEl');window.manualLookupSearch=q=>guestRows('manualResults',q);window.renderDemoTicketBtns=()=>{};
document.addEventListener('keydown',e=>{if(!scannerOpen)return;if(e.key==='Escape'){e.preventDefault();if(!$('verifyResult').hidden)hideVerifyResult();else closeTicketScanner()}if(e.key==='Tab'){const region=$('verifyResult').hidden?$('ticketScannerOverlay'):$('verifyResult');const focus=[...region.querySelectorAll('button,input,a[href]')].filter(e=>!e.disabled&&e.getClientRects().length);const first=focus[0],last=focus.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}});
// Profile: same card, filled from the server instead of the old local mock.
window.showProfile=async function(){
  let balance=0,myFriends=0,myTickets=0;
  await Promise.all([api('/api/wallet').then(w=>balance=w.balance).catch(()=>{}),api('/api/friends').then(r=>myFriends=r.friends.length).catch(()=>{}),api('/api/tickets/mine').then(r=>myTickets=r.tickets.length).catch(()=>{})]);
  const genres=['Techno','D&B','House','Festivals'];
  $('profBody').innerHTML=`
    <div style="text-align:center;padding:20px 0 14px">
      <div style="width:64px;height:64px;border-radius:50%;background:var(--warm);border:2px solid var(--border);margin:0 auto 10px;display:flex;align-items:center;justify-content:center;font-size:1.8rem">${safe(myAvatar)}</div>
      <div style="font-family:'Inter','Arial',sans-serif;font-size:1.5rem;letter-spacing:.02em;font-weight:700">@${safe(ME)}</div>
      <div style="font-size:.78rem;color:var(--muted);font-weight:300;margin-top:2px">${safe(myCity)} · Member</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--border);margin:0 0 18px">
      ${[['$'+Number(balance).toFixed(2),'Balance'],[myFriends,'Friends'],[myTickets,'Tickets']].map(([n,l])=>`<div style="padding:10px;text-align:center;border-right:1px solid var(--border)"><div style="font-family:'Inter','Arial',sans-serif;font-size:1.3rem;letter-spacing:.02em;font-weight:700">${n}</div><div style="font-family:'Inter',sans-serif;font-size:0.66rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:700">${l}</div></div>`).join('')}
    </div>
    <div style="font-family:'Inter',sans-serif;font-size:0.66rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;padding-bottom:7px;border-bottom:1px solid var(--border);font-weight:700">Night Identity</div>
    ${genres.map((g,i)=>`<div style="display:flex;align-items:center;gap:9px;margin-bottom:7px"><span style="font-size:.75rem;color:var(--muted);width:64px">${g}</span><div style="flex:1;height:2px;background:var(--border)"><div style="height:100%;background:var(--accent);width:${[82,61,38,91][i]}%"></div></div><span style="font-family:'Inter',sans-serif;font-size:0.66rem;color:var(--muted);font-weight:700">${[82,61,38,91][i]}%</span></div>`).join('')}
    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border);font-family:'Inter',sans-serif;font-size:0.66rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;font-weight:700">Privacy</div>
    ${[['Ghost Mode',false],['Share Location',true],['Anonymous Posts',false]].map(([n,v])=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:.84rem"><span>${n}</span><input type="checkbox" ${v?'checked':''} style="accent-color:var(--accent);width:14px;height:14px;cursor:pointer" onchange="toast('${n} toggled')"></div>`).join('')}
    <div style="display:flex;gap:7px;margin-top:14px;flex-wrap:wrap">
      <button class="btn btn-md btn-ink" style="flex:1" onclick="editProfile()">Edit Profile</button>
      <button class="btn btn-md btn-ghost" onclick="copyProfileLink()">Share</button>
      <button class="btn btn-md btn-ghost" style="color:var(--accent)" onclick="logOut()">Log Out</button>
    </div>`;
  $('profModal').classList.add('open');
};
window.editProfile=async function(){
  const city=prompt('Your city',myCity);if(city===null)return;
  const avatar=prompt('Your avatar (a letter or emoji)',myAvatar);if(avatar===null)return;
  try{const {user}=await api('/api/me',{method:'PATCH',body:JSON.stringify({city,avatar})});myCity=user.city||myCity;myAvatar=user.avatar||myAvatar;const tb=$('tbAvatar');if(tb)tb.textContent=myAvatar;const ca=$('composeAv');if(ca)ca.textContent=myAvatar;clock();toast('Profile updated','ok');showProfile()}catch(e){toast(e.message,'err')}
};
window.copyProfileLink=function(){const val=location.origin+'/?u='+encodeURIComponent(ME);navigator.clipboard.writeText(val).then(()=>toast('Profile link copied!','ok')).catch(()=>toast('Link: '+val))};
// The selected accent is exact, including every legacy inline/template accent.
const baseAccent=window.setAccent;
window.setAccent=function(hex,silent){baseAccent(hex,silent);if(!_hexToRgb(hex))return;document.body.style.setProperty('--sig-ink',hex);document.body.style.setProperty('--accent-hi',hex);};
// Restore the color picker's independent swatches after normalizing old inline UI styles.
document.querySelectorAll('[onclick*="setAccent("]').forEach(el=>{const match=el.getAttribute('onclick').match(/setAccent\(['"](#[0-9a-fA-F]{3,6})/);if(match&&el.style.background)el.style.background=match[1]});
document.querySelectorAll('button[onclick="openTicketScanner()"]:not(.scan-launch)').forEach(el=>{el.classList.add('btn','btn-accent');el.style.fontFamily='var(--f-sans)';el.style.letterSpacing='0';el.style.textTransform='none'});
document.querySelectorAll('.ap-sw[data-c]').forEach(el=>{el.style.background=el.getAttribute('data-c');el.style.setProperty('--c',el.getAttribute('data-c'));});
// Live location only while this page is open: stop sharing when it closes.
window.addEventListener('pagehide',()=>{stopCamera();if(geoWatch!==null){navigator.geolocation.clearWatch(geoWatch);geoWatch=null;const t=authToken();if(t)fetch('/api/pins/friend-location',{method:'DELETE',keepalive:true,headers:{Authorization:'Bearer '+t}}).catch(()=>{})}});
})();
