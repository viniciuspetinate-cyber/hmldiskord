const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname,'../public');
const app = fs.readFileSync(path.join(root,'sala.js'),'utf8');
function extract(name){
  const start=new RegExp('^  (?:async )?function '+name+'\\([^\\n]*','m').exec(app);
  assert.ok(start,name);
  if(start[0].endsWith('}'))return start[0];
  const ending=/^  }$/gm;ending.lastIndex=start.index+start[0].length;
  const end=ending.exec(app);
  return app.slice(start.index,end.index+end[0].length);
}
function load(names,globals){
  const ctx=vm.createContext({console:{warn(){},error(){},info(){}},...globals});
  vm.runInContext(names.map(extract).join('\n'),ctx);
  return ctx;
}
test('all application scripts parse and pages share the same code',()=>{
  for(const name of ['sala.js','storage.js','audio-engine.js','sfu-client.js','gate-worklet.js','novidades.js'])new vm.Script(fs.readFileSync(path.join(root,name),'utf8'));
  const a=fs.readFileSync(path.join(root,'sala.html'),'utf8'),b=fs.readFileSync(path.join(root,'devsala.html'),'utf8');
  assert.equal(a.replace('data-ambiente="producao"',''),b.replace('data-ambiente="devsala"',''));
  assert.match(a,/sfu-client\.js/);
  assert.doesNotMatch(a,/id="mic-mode"/);
  assert.match(a,/id="audio-settings-toggle"/);
  assert.match(app,/localStorage\.getItem\('local:' \+ \(window\.__SALA_NS \|\| ''\) \+ 'sessao'\)/);
  assert.match(app,/audioToggle\.getAttribute\('aria-expanded'\) !== 'true'/);
});
test('microphone returned after timeout is stopped',async()=>{
  let stopped=false;
  const ctx=load(['comPrazo','pararStream'],{setTimeout,clearTimeout});
  const pending=new Promise(resolve=>setTimeout(()=>resolve({getTracks:()=>[{stop(){stopped=true;}}]}),20));
  const result=await ctx.comPrazo(pending,1,'test',ctx.pararStream);
  assert.equal(result.__prazo,true);
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(stopped,true);
});

test('screen capture arriving after cancellation is stopped without joining',async()=>{
  let stopped=false;
  const ctx=load(['instalarTela','pararStream'],{VOICE:{screenOperation:2},joinVoice(){throw new Error('must not join');}});
  await ctx.instalarTela({getTracks:()=>[{stop(){stopped=true;}}]},'monitor',1);
  assert.equal(stopped,true);
});

test('screen capture failure releases an unadopted stream',async()=>{
  let stopped=false;
  const stream={getTracks:()=>[{stop(){stopped=true;}}],getAudioTracks:()=>[],getVideoTracks:()=>[{getSettings:()=>({displaySurface:'monitor'})}]};
  const ctx=load(['startScreen','pararStream','suportaIsolamentoTela','filtrarAudioTela'],{VOICE:{screenOperation:0,screenProfile:'texto'},SCREEN_PROFILES:{texto:{width:1920,height:1080,fps:30}},
    navigator:{mediaDevices:{async getDisplayMedia(){return stream;}}},async instalarTela(){throw new Error('test');},showToast(){}});
  await ctx.startScreen('tela',false);
  assert.equal(stopped,true);assert.equal(ctx.VOICE.screenPending,false);
});

test('screen audio is checked before publication and unisolated system audio is stopped',async()=>{
  const scenarios=[
    {surface:'monitor',supported:false,isolated:false,mode:'tela',include:true,keep:false,requestAudio:false},
    {surface:'monitor',supported:true,isolated:false,mode:'tela',include:true,keep:false,requestAudio:true},
    {surface:'monitor',supported:true,isolated:true,mode:'tela',include:true,keep:true,requestAudio:true},
    {surface:'window',supported:true,isolated:false,mode:'tela',include:true,keep:false,requestAudio:true},
    {surface:'desconhecido',supported:true,isolated:false,mode:'tela',include:true,keep:false,requestAudio:true},
    {surface:'browser',supported:false,isolated:false,mode:'aba',include:false,keep:true,requestAudio:true},
    {surface:'monitor',supported:true,isolated:false,mode:'aba',include:false,keep:false,requestAudio:true},
    {surface:'monitor',supported:true,isolated:true,mode:'tela',include:false,keep:false,requestAudio:false},
  ];
  for(const scenario of scenarios){
    let stopped=false,options,published=false;
    const audio={getSettings:()=>({restrictOwnAudio:scenario.isolated}),stop(){stopped=true;}};
    let tracks=[audio];
    const stream={getTracks:()=>tracks,getAudioTracks:()=>tracks.slice(),removeTrack:t=>{tracks=tracks.filter(x=>x!==t);},getVideoTracks:()=>[{getSettings:()=>({displaySurface:scenario.surface})}]};
    const ctx=load(['startScreen','pararStream','suportaIsolamentoTela','filtrarAudioTela'],{
      VOICE:{screenOperation:0,screenProfile:'texto'},SCREEN_PROFILES:{texto:{width:1920,height:1080,fps:30}},
      navigator:{mediaDevices:{getSupportedConstraints:()=>({restrictOwnAudio:scenario.supported}),async getDisplayMedia(value){options=value;return stream;}}},
      async instalarTela(value){published=true;assert.equal(value.getAudioTracks().length,scenario.keep?1:0);},showToast(){},
    });
    await ctx.startScreen(scenario.mode,scenario.include);
    assert.equal(published,true,JSON.stringify(scenario));
    assert.equal(stopped,!scenario.keep);
    assert.equal(!!options.audio,scenario.requestAudio);
    if(options.audio&&scenario.supported)assert.equal(options.audio.restrictOwnAudio,true);
    if(!scenario.supported)assert.equal(options.systemAudio,'exclude');
  }
});
test('rendering notices changed content when both lists have 200 messages',()=>{
  const box={innerHTML:'',scrollHeight:100,scrollTop:0,clientHeight:30};
  const ctx=load(['renderMessages','escapeHtml'],{state:{activeChannelId:'geral'},document:{getElementById:()=>box},colorFor:()=>'',initials:()=>'',timeFmt:()=>''});
  const arr=Array.from({length:200},(_,id)=>({id:String(id),text:'m'+id,author:'A',ts:id}));
  ctx.renderMessages(arr,false);const old=box.innerHTML;
  ctx.renderMessages([...arr.slice(1),{id:'201',text:'new-tail',author:'A',ts:201}],false);
  assert.notEqual(box.innerHTML,old);assert.ok(box.innerHTML.includes('new-tail'));
});
test('parallel messages use distinct database keys',async()=>{
  const db=new Map();
  function client(name){
    const input={value:name,focus(){}},button={};
    return load(['sendMessage'],{CHAT_SENDING:false,CHAT_CACHE:new Map(),state:{activeChannelId:'geral',nickname:name},crypto:require('node:crypto').webcrypto,
      document:{getElementById:id=>id==='msg-input'?input:button},window:{agoraServidor:()=>Date.now()},
      async safeSet(key,value){db.set(key,value);return true;},async loadMessages(){},showToast(){}});
  }
  await Promise.all([client('Alice').sendMessage(),client('Bob').sendMessage()]);
  assert.equal(db.size,2);assert.deepEqual([...db.values()].map(s=>JSON.parse(s).author).sort(),['Alice','Bob']);
});
test('invalid presence cannot inject markup or prototype names',()=>{
  const ctx=load(['idValido','presencaValida'],{CANAIS_VOZ:[{id:'voz-geral'}]});
  const value={session:'abc123',chan:'voz-geral',name:'A',ts:Date.now(),inc:1};
  assert.equal(ctx.presencaValida(value),true);
  for(const session of ['bad" data-extra="yes','__proto__','constructor','prototype',''])assert.equal(ctx.presencaValida({...value,session}),false);
  assert.equal(ctx.presencaValida({...value,screenMode:'sfu',screenPublication:'capability',screenNetworkLevel:2}),true);
  assert.equal(ctx.presencaValida({...value,screenNetworkLevel:3}),false);
  assert.equal(ctx.presencaValida({...value,screenMode:'sfu',screenPublication:'x'.repeat(4097)}),false);
});
test('screen subscription controls video/audio while leaving the microphone attached',async()=>{
  const calls=[];
  const sender=()=>({track:null,async replaceTrack(t){this.track=t;calls.push(t);}});
  const pc={signalingState:'stable'},p={sid:'remote',pc,send:{mic:sender(),scrA:sender(),scrV:sender()}};
  const voice={peers:{remote:p},bySession:{remote:{protocol:6,watching:null}},micTrack:{id:'mic'},screenVideoTrack:{id:'video'},screenAudioTrack:{id:'audio'}};
  const ctx=load(['applyLocalTracks','querMinhaTela'],{VOICE:voice,SID:'local',async tuneScreenSender(){},showToast(){}});
  await ctx.applyLocalTracks(p);assert.equal(p.send.mic.track.id,'mic');assert.equal(p.send.scrV.track,null);
  voice.bySession.remote.watching='local';await ctx.applyLocalTracks(p);assert.equal(p.send.scrV.track.id,'video');assert.equal(p.send.scrA.track.id,'audio');
  voice.bySession.remote.watching=null;await ctx.applyLocalTracks(p);assert.equal(p.send.scrV.track,null);assert.equal(p.send.mic.track.id,'mic');
});
test('SFU startup keeps a temporary direct screen path only while the selected viewer is waiting',async()=>{
  const sender=()=>({track:null,async replaceTrack(t){this.track=t;}});
  const p={sid:'remote',pc:{signalingState:'stable'},send:{mic:sender(),scrA:sender(),scrV:sender()}};
  const voice={peers:{remote:p},bySession:{remote:{protocol:6,watching:'local',screenFallback:true}},micTrack:{},screenVideoTrack:{id:'video'},screenAudioTrack:null,sfuPublication:'publication'};
  const ctx=load(['applyLocalTracks','querMinhaTela'],{VOICE:voice,SID:'local',SFU_TELA:true,async tuneScreenSender(){},showToast(){}});
  await ctx.applyLocalTracks(p);assert.equal(p.send.scrV.track.id,'video');
  voice.bySession.remote.screenFallback=false;
  await ctx.applyLocalTracks(p);assert.equal(p.send.scrV.track,null);
});
test('failed SFU subscription retries the selected publication',()=>{
  let scheduled,delay,retried=0;
  const p={sid:'remote'};
  const voice={peers:{remote:p},bySession:{remote:{screenPublication:'publication-2'}}};
  const ctx=load(['reagendarAssinaturaSFU'],{
    VOICE:voice,Date,setTimeout(fn,ms){scheduled=fn;delay=ms;return 1;},clearTimeout(){},
    assistirSid:()=> 'remote',sincronizarAssinaturaSFU(){retried++;}
  });
  ctx.reagendarAssinaturaSFU(p,'publication-2',1200);
  assert.equal(delay,1200);assert.ok(p.sfuRetryAt>Date.now());
  scheduled();
  assert.equal(retried,1);assert.equal(p.sfuRetryPublication,null);
});
test('sender promise failures are handled',async()=>{
  const p={sid:'remote',pc:{signalingState:'stable'},send:{mic:{track:null,replaceTrack:()=>Promise.reject(new TypeError('test'))}}};
  const ctx=load(['applyLocalTracks','querMinhaTela'],{VOICE:{peers:{remote:p},bySession:{},micTrack:{}},SID:'local',async tuneScreenSender(){},showToast(){}});
  await ctx.applyLocalTracks(p);assert.equal(p.mediaError,'TypeError');
});

test('persistent CPU limitation lowers video quality and stable samples recover it',async()=>{
  let limited=true,updates=0;
  const p={name:'Peer',send:{scrV:{track:{}}},pc:{signalingState:'stable',connectionState:'connected',async getStats(){
    return new Map([['video',{id:'video',type:'outbound-rtp',kind:'video',qualityLimitationReason:limited?'cpu':'none'}]]);
  }}};
  const ctx=load(['colherDiagnostico'],{STATS_BUSY:false,VOICE:{joined:true,peers:{remote:p},screenProfile:'texto'},PORTAO:{grafo:null},window:{},
    document:{getElementById:id=>id==='quality-indicator'?{}:null},PERDA_AUDIO_ALTA:12,assistirSid:()=>null,async protegerVozPorPerda(){},async protegerRecepcaoPorPerda(){},async applyLocalTracks(){updates++;}});
  for(let i=0;i<3;i++)await ctx.colherDiagnostico();
  assert.equal(p.adaptLevel,1);assert.equal(updates,1);
  limited=false;
  for(let i=0;i<10;i++)await ctx.colherDiagnostico();
  assert.equal(p.adaptLevel,0);assert.equal(updates,2);
});
test('loss across multiple audio peers temporarily lowers the local screen bitrate',async()=>{
  let updates=0; const notices=[];
  const voice={screenVideoTrack:{},screenProfile:'texto',peers:{remote:{}},audioLossAdaptLevel:0,audioLossBadSamples:0,audioLossGoodSamples:0};
  const ctx=load(['qualidadeTelaEfetiva','atualizarLimiteTelaPorRede','protegerVozPorPerda'],{
    VOICE:voice, SCREEN_PROFILES:{texto:{bitrate:3000000,fps:30,degradation:'maintain-resolution'}},
    ESCALAS_TELA:[1,1.5,2], PERDA_AUDIO_ALTA:12, PERDA_AUDIO_NORMAL:3, Number,
    async applyLocalTracks(){updates++;}, showToast:message=>notices.push(message)
  });
  const ruim=[{perdaAudioPct:36},{perdaAudioPct:42},{perdaAudioPct:1}];
  await ctx.protegerVozPorPerda(ruim); await ctx.protegerVozPorPerda(ruim);
  assert.equal(voice.audioLossAdaptLevel,1);assert.equal(updates,1);assert.match(notices[0],/Perda alta/);
  for(let i=0;i<12;i++)await ctx.protegerVozPorPerda([{perdaAudioPct:0},{perdaAudioPct:1}]);
  assert.equal(voice.audioLossAdaptLevel,0);assert.equal(updates,2);
});
test('viewer with loss asks the SFU publisher for a lighter screen',async()=>{
  let ticks=0;const notices=[];
  const voice={stageHidden:false,stageSid:'source',bySession:{source:{screenMode:'sfu'}},screenReceiveAdaptLevel:0,screenReceiveBadSamples:0,screenReceiveGoodSamples:0};
  const ctx=load(['assistirSid','protegerRecepcaoPorPerda'],{VOICE:voice,SID:'local',idValido:()=>true,PERDA_AUDIO_ALTA:12,PERDA_AUDIO_NORMAL:3,Number,voiceTick(){ticks++;},showToast:m=>notices.push(m)});
  const ruim=[{perdaAudioPct:35},{perdaAudioPct:42},{perdaAudioPct:1}];
  await ctx.protegerRecepcaoPorPerda(ruim);await ctx.protegerRecepcaoPorPerda(ruim);
  assert.equal(voice.screenReceiveAdaptLevel,1);assert.equal(ticks,1);assert.match(notices[0],/solicitamos/);
});
test('diagnostics distinguish the received SFU screen from direct video',async()=>{
  let bytes=1000,frames=10,audioBytes=500,audioReceived=100,audioLost=0;
  const pc={connectionState:'connected',iceConnectionState:'connected'};
  const subscriber={pc,closed:false,async stats(){
    return new Map([['video',{id:'video',type:'inbound-rtp',kind:'video',timestamp:bytes,
      bytesReceived:bytes,framesDecoded:frames,frameWidth:1280,frameHeight:720,freezeCount:0}],
      ['audio',{id:'audio',type:'inbound-rtp',kind:'audio',timestamp:bytes,
        bytesReceived:audioBytes,packetsReceived:audioReceived,packetsLost:audioLost,jitter:0.02}]]);
  }};
  const stream={};
  const peer={name:'Emissor',sfuSubscriber:subscriber,sfuScreen:stream,
    p2pScreen:{getVideoTracks:()=>[{readyState:'live',muted:false}]}};
  const voice={joined:true,peers:{remote:peer},bySession:{remote:{screenBitrateLevel:1}},screenReceiveAdaptLevel:1};
  const win={};
  const ctx=load(['colherDiagnostico'],{
    STATS_BUSY:false,VOICE:voice,PORTAO:{grafo:null},window:win,PERDA_AUDIO_ALTA:12,
    assistirSid:()=> 'remote',async protegerVozPorPerda(){},async protegerRecepcaoPorPerda(){},
    document:{getElementById:id=>id==='quality-indicator'?{}:id==='stage-video'?{srcObject:stream,readyState:4,paused:false,videoWidth:1280,videoHeight:720}:null}
  });
  await ctx.colherDiagnostico();bytes+=2500;frames+=8;audioBytes+=1000;audioReceived+=30;audioLost+=10;await ctx.colherDiagnostico();
  const received=win.__SALA_DIAGNOSTICO.pares.at(-1);
  assert.equal(received.rota,'SFU');assert.equal(received.videoDiretoAtivo,true);
  assert.equal(received.recebimento.kbps,8);assert.equal(received.recebimento.fpsMedido,3);
  assert.equal(received.audioTela.perdaPct,25);assert.equal(received.audioTela.jitterMs,20);
});
test('audio worklet opens for speech, closes in silence and calibrates without page timers',()=>{
  let Processor;const messages=[];
  class Base{constructor(){this.port={postMessage:m=>messages.push(m)};}}
  vm.runInNewContext(fs.readFileSync(path.join(root,'gate-worklet.js'),'utf8'),{AudioWorkletProcessor:Base,sampleRate:48000,registerProcessor:(id,p)=>{Processor=p;}});
  const node=new Processor({processorOptions:{threshold:0.018}});
  function process(amplitude,seconds){let output;for(let n=0;n<Math.ceil(48000*seconds/128);n++){output=new Float32Array(128);node.process([[new Float32Array(128).fill(amplitude)]],[[output]]);}return output;}
  process(0,0.2);assert.equal(node.open,false);
  const speech=process(0.1,0.2);assert.equal(node.open,true);assert.ok(speech[100]>0.09);
  const quiet=process(0,1);assert.equal(node.open,false);assert.ok(Math.abs(quiet[100])<0.0001);
  node.port.onmessage({data:{type:'calibrate'}});process(0.005,3.1);
  assert.ok(messages.some(m=>m.type==='calibrated'&&m.threshold>=0.003&&m.threshold<=0.06));
  node.port.onmessage({data:{type:'dispose'}});assert.equal(node.process([],[[new Float32Array(128)]]),false);
});
