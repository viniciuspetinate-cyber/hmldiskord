const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.AIQ_PLAYWRIGHT || 'playwright');
const root=path.resolve(__dirname,'../public');
const records=new Map();
const errors=[];
const report=[];
const evidence=process.env.AIQ_TEST_OUTPUT || path.resolve(__dirname,'../test-results');
fs.mkdirSync(evidence,{recursive:true});
const server=http.createServer((request,response)=>{
  const url=new URL(request.url,'http://localhost');
  let file=url.pathname==='/'?'index.html':url.pathname.slice(1);
  if(!path.extname(file))file+='.html';
  const absolute=path.resolve(root,file);
  if(!absolute.startsWith(root+path.sep)||!fs.existsSync(absolute)){response.writeHead(404);response.end();return;}
  let content=fs.readFileSync(absolute);
  if(file==='sala.js')content=Buffer.from(content.toString().replace(/\}\)\(\);\s*$/, 'window.__AIQ_TEST={VOICE,PORTAO,state,SID,joinVoice,leaveVoice,startScreen,stopScreen,voiceTick,loadMessages,sendMessage,definirPerfilTela,ac:()=>AC};\n})();'));
  response.writeHead(200,{'Content-Type':({'.js':'text/javascript','.css':'text/css','.html':'text/html','.wasm':'application/wasm','.ico':'image/x-icon'})[path.extname(file)]||'text/plain','Cache-Control':'no-store'});
  response.end(content);
});
function selectRecords(url){
  let rows=[...records.values()];
  for(const [key,value]of url.searchParams){
    if(!['key','updated_at'].includes(key))continue;
    const column=key;
    if(value.startsWith('eq.'))rows=rows.filter(r=>r[column]===value.slice(3));
    if(value.startsWith('like.'))rows=rows.filter(r=>r[column].startsWith(value.slice(5).replace(/\*$/,'')));
    if(value.startsWith('lt.'))rows=rows.filter(r=>r[column]<value.slice(3));
    if(value.startsWith('gt.'))rows=rows.filter(r=>r[column]>value.slice(3));
    if(value.startsWith('in.')){const keys=value.slice(4,-1).split(',').map(s=>decodeURIComponent(s.replace(/^"|"$/g,'')));rows=rows.filter(r=>keys.includes(r[column]));}
  }
  if(url.searchParams.has('order'))rows.sort((a,b)=>b.updated_at.localeCompare(a.updated_at)||b.key.localeCompare(a.key));
  return rows;
}
async function main(){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,executablePath:process.env.AIQ_BROWSER || undefined,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
  try{
    const context=await browser.newContext({viewport:{width:1365,height:900},permissions:['microphone','camera']});
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin===address)return route.continue();
      const headers={'access-control-allow-origin':'*','access-control-expose-headers':'content-range,date','content-type':'application/json','date':new Date().toUTCString()};
      if(url.hostname.includes('supabase.co')&&url.pathname==='/rest/v1/room_kv'){
        if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:{...headers,'access-control-allow-headers':'*','access-control-allow-methods':'*'}});
        if(request.method()==='POST'){
          const record=JSON.parse(request.postData());records.set(record.key,record);return route.fulfill({status:201,headers,body:''});
        }
        const rows=selectRecords(url);
        if(request.method()==='DELETE'){rows.forEach(r=>records.delete(r.key));return route.fulfill({status:204,headers});}
        const limited=rows.slice(0,Number(url.searchParams.get('limit'))||rows.length);
        headers['content-range']=`0-${Math.max(0,limited.length-1)}/${rows.length}`;
        return route.fulfill({status:200,headers,body:JSON.stringify(limited)});
      }
      if(url.hostname.startsWith('sala-turn-api.'))return route.fulfill({status:200,headers,body:JSON.stringify({iceServers:[{urls:'stun:localhost:9'}],ttl:3600})});
      return route.abort();
    });
    async function participant(name){
      const page=await context.newPage();
      page.on('pageerror',error=>errors.push(name+': '+error.message));
      page.on('console',message=>{if(message.type()==='error')fs.appendFileSync(path.join(evidence,'console.txt'),name+': '+message.text()+'\n');});
      await page.addInitScript(({name})=>{
        // This suite exercises the P2P fallback. The SFU transport has its own
        // real Cloudflare media test in work/aiqcall-sfu/tests/live-sfu.cjs.
        window.__AIQ_DISABLE_SFU=true;
        localStorage.setItem('local:devsala:sessao',JSON.stringify({usuario:name,apelido:name,token:'offline-test',exp:Math.floor(Date.now()/1000)+3600}));
        const Native=window.RTCPeerConnection;
        window.RTCPeerConnection=class extends Native{constructor(options){super({...options,iceServers:[]});}};
        navigator.mediaDevices.getDisplayMedia=async options=>{
          window.__captureOptions=options;
          const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;window.__captureCanvas=canvas;
          const ctx=canvas.getContext('2d');let n=0;
          const draw=()=>{ctx.fillStyle=n++%2?'#13556a':'#15819c';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='white';ctx.lineWidth=12;ctx.strokeRect(6,6,canvas.width-12,canvas.height-12);ctx.fillStyle='white';ctx.font='48px sans-serif';ctx.fillText('Tela de teste '+n,100,150);};
          draw();const timer=setInterval(draw,100),stream=canvas.captureStream(30);
          const track=stream.getVideoTracks()[0],stop=track.stop.bind(track);
          track.stop=()=>{clearInterval(timer);stop();};
          window.__lastCapture=stream;return stream;
        };
      },{name});
      await page.goto(address+'/devsala');
      await page.waitForFunction(()=>window.__AIQ_TEST&&document.querySelector('#app').style.display==='flex');
      await page.locator('[data-vchan="voz-geral"]').waitFor();
      return page;
    }
    const alice=await participant('Alice'),bob=await participant('Bob');
    await Promise.all([alice.locator('[data-vchan="voz-geral"]').click(),bob.locator('[data-vchan="voz-geral"]').click()]);
    for(const page of [alice,bob])await page.waitForFunction(()=>Object.values(window.__AIQ_TEST.VOICE.peers).some(p=>p.pc?.connectionState==='connected'),{},{timeout:40000});
    report.push('Two actual local WebRTC peers connect with Trickle ICE and synthetic microphones.');
    assert.equal(await alice.locator('#portao').isVisible(),false);
    await alice.locator('#audio-settings-toggle').click();
    await alice.locator('#portao').waitFor({state:'visible'});
    assert.equal(await alice.evaluate(()=>window.__AIQ_TEST.PORTAO.grafo.mode),'neural');
    report.push('Bundled RNNoise WASM initializes by default and the audio settings panel starts collapsed.');
    await alice.locator('#mic-calibrate').click();
    await alice.waitForFunction(()=>!document.querySelector('#mic-calibrate').disabled,{},{timeout:10000});
    report.push('Calibration completes in the real AudioWorklet.');
    await alice.locator('#share-btn').click();await alice.locator('[data-modo="tela"]').click();
    await bob.locator('#convite-btn').waitFor({state:'visible',timeout:15000});
    assert.equal(await alice.evaluate(()=>window.__captureOptions.audio),false);
    assert.equal(await alice.evaluate(()=>Object.values(window.__AIQ_TEST.VOICE.peers)[0].send.scrV.track),null);
    await bob.locator('#convite-btn').click();
    await alice.waitForFunction(()=>!!Object.values(window.__AIQ_TEST.VOICE.peers)[0].send.scrV.track,{},{timeout:15000});
    await bob.waitForFunction(async()=>{const p=Object.values(window.__AIQ_TEST.VOICE.peers)[0];const stats=await p.pc.getStats();return [...stats.values()].some(s=>s.type==='inbound-rtp'&&s.kind==='video'&&s.bytesReceived>0);},{},{timeout:15000});
    await bob.screenshot({path:path.join(evidence,'receiving-screen.png')});
    await alice.evaluate(()=>{window.__captureCanvas.width=1280;window.__captureCanvas.height=1024;});
    await bob.waitForFunction(()=>{const v=document.querySelector('#stage-video');return v.videoHeight>0&&Math.abs(v.videoWidth/v.videoHeight-1.25)<.01;},{},{timeout:15000});
    await bob.evaluate(()=>{window.__viewedStream=document.querySelector('#stage-video').srcObject;});
    assert.equal(await bob.locator('#stage-video').evaluate(v=>getComputedStyle(v).objectFit),'contain');
    await bob.screenshot({path:path.join(evidence,'5x4-original.png')});
    await bob.locator('#stage-fit').selectOption('esticar');
    assert.equal(await bob.locator('#stage-video').evaluate(v=>getComputedStyle(v).objectFit),'fill');
    assert.equal(await bob.evaluate(()=>document.querySelector('#stage-video').srcObject===window.__viewedStream),true);
    assert.equal(await bob.locator('#stage-fit-full').inputValue(),'esticar');
    assert.equal(await bob.evaluate(()=>localStorage.getItem('local:devsala:screen-fit')),'esticar');
    await bob.screenshot({path:path.join(evidence,'5x4-esticar.png')});
    await bob.locator('#stage-full').click();
    await bob.waitForFunction(()=>document.fullscreenElement?.id==='stage-video-wrap');
    await bob.locator('#stage-fit-full').waitFor({state:'visible'});
    assert.equal(await bob.locator('#stage-video').evaluate(v=>getComputedStyle(v).objectFit),'fill');
    await bob.screenshot({path:path.join(evidence,'5x4-fullscreen.png')});
    await bob.locator('#stage-fit-full').selectOption('original');
    assert.equal(await bob.locator('#stage-video').evaluate(v=>getComputedStyle(v).objectFit),'contain');
    assert.equal(await bob.locator('#stage-fit').inputValue(),'original');
    await bob.evaluate(()=>document.exitFullscreen());
    await bob.setViewportSize({width:390,height:844});
    await bob.screenshot({path:path.join(evidence,'fit-mobile.png')});
    assert.equal(await bob.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await bob.setViewportSize({width:1280,height:900});
    report.push('Live 16:9 to 5:4 source change, Original/Stretch display, synced fullscreen controls and mobile layout preserve the active media stream.');
    await alice.locator('#screen-profile').selectOption('fluido');
    await alice.waitForFunction(()=>Object.values(window.__AIQ_TEST.VOICE.peers)[0].send.scrV.getParameters().encodings[0].maxBitrate===2000000);
    await bob.locator('#stage-hide').click();
    await alice.waitForFunction(()=>Object.values(window.__AIQ_TEST.VOICE.peers)[0].send.scrV.track===null,{},{timeout:15000});
    assert.ok(await alice.evaluate(()=>!!Object.values(window.__AIQ_TEST.VOICE.peers)[0].send.mic.track));
    report.push('Screen media is sent only after Watch, received as real RTP, and removed on close while voice remains. Movement profile applies 2 Mbps cap.');
    await Promise.all([alice.locator('#msg-input').fill('Mensagem simultânea Alice'),bob.locator('#msg-input').fill('Mensagem simultânea Bob')]);
    await Promise.all([alice.locator('#send-btn').click(),bob.locator('#send-btn').click()]);
    for(const page of [alice,bob])await page.waitForFunction(()=>document.querySelector('#messages').textContent.includes('Mensagem simultânea Alice')&&document.querySelector('#messages').textContent.includes('Mensagem simultânea Bob'));
    assert.equal([...records.keys()].filter(k=>k.startsWith('devsala:msg:geral:')).length,2);
    for(let i=0;i<201;i++){
      const ts=Date.now()+i,record={key:'devsala:msg:geral:test-'+i,value:JSON.stringify({id:'test-'+i,author:'Teste',text:'Histórico '+i,ts}),updated_at:new Date(ts).toISOString()};records.set(record.key,record);
    }
    await bob.waitForFunction(()=>document.querySelector('#messages').textContent.includes('Histórico 200'),{},{timeout:15000});
    const ts=Date.now()+1000;records.set('devsala:msg:geral:tail',{key:'devsala:msg:geral:tail',value:JSON.stringify({id:'tail',author:'Teste',text:'NOVA APÓS LIMITE',ts}),updated_at:new Date(ts).toISOString()});
    await bob.waitForFunction(()=>document.querySelector('#messages').textContent.includes('NOVA APÓS LIMITE'),{},{timeout:15000});
    report.push('Concurrent chat messages persist independently and incoming messages refresh beyond 200 items.');
    await alice.locator('#quality-indicator').click();await alice.locator('#diagnostic-data').waitFor();
    await alice.screenshot({path:path.join(evidence,'diagnostic.png')});
    await alice.locator('#diagnostic-modal button').click();
    await alice.setViewportSize({width:390,height:844});
    await alice.locator('#menu-btn').click();
    await alice.waitForFunction(()=>document.body.classList.contains('menu-aberto')&&document.querySelector('#members-panel').classList.contains('hidden'));
    await alice.locator('#audio-settings-toggle').scrollIntoViewIfNeeded();
    await alice.screenshot({path:path.join(evidence,'mobile-audio.png'),animations:'disabled'});
    const overflow=await alice.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false);
    report.push('Desktop diagnostics and 390px mobile controls render without page horizontal overflow.');
    await Promise.all([alice.evaluate(()=>window.__AIQ_TEST.leaveVoice()),bob.evaluate(()=>window.__AIQ_TEST.leaveVoice())]);
    assert.equal(await alice.evaluate(()=>window.__lastCapture.getVideoTracks()[0].readyState),'ended');
    await alice.evaluate(()=>window.__AIQ_TEST.startScreen('tela',false));
    assert.equal(await alice.evaluate(()=>window.__AIQ_TEST.VOICE.joined&&!!window.__AIQ_TEST.VOICE.screenVideoTrack),true);
    await alice.evaluate(()=>window.__AIQ_TEST.leaveVoice());
    await alice.evaluate(()=>{
      const native=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia=async options=>{
        const stream=await native(options);window.__lateMic=stream;
        await new Promise(resolve=>{window.__releaseMic=resolve;});return stream;
      };
      window.__joinPromise=window.__AIQ_TEST.joinVoice('voz-geral');
    });
    await alice.waitForFunction(()=>!!window.__releaseMic);
    await alice.evaluate(async()=>{
      await window.__AIQ_TEST.leaveVoice();window.__releaseMic();await window.__joinPromise;
    });
    assert.equal(await alice.evaluate(()=>window.__AIQ_TEST.VOICE.joined),false);
    assert.equal(await alice.evaluate(()=>window.__lateMic.getAudioTracks()[0].readyState),'ended');
    report.push('Sharing outside a call starts voice; leaving releases capture; canceling a pending microphone keeps the call closed and stops the late track.');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed:report,errors,scope:'Real local Chromium WebRTC/AudioWorklet with synthetic media and isolated in-memory backend; no production traffic.'},null,2));
    console.log(JSON.stringify({passed:report,errors},null,2));
  }finally{await browser.close();server.close();}
}
main().catch(error=>{console.error(error);console.error('Page errors:',errors);server.close();process.exitCode=1;});
