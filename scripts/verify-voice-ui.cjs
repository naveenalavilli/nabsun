const {app, BrowserWindow} = require('electron');
const {build} = require('esbuild');
(async () => {
  const bundle = await build({entryPoints:['src/renderer/shell/voice.ts'],bundle:true,write:false,format:'iife',globalName:'Voice',platform:'browser'});
  await app.whenReady();
  const win = new BrowserWindow({show:false,webPreferences:{sandbox:true}});
  try {
    await win.loadURL('data:text/html,<main></main>');
    const result = await win.webContents.executeJavaScript(`(async () => {
      ${bundle.outputFiles[0].text}
      document.body.innerHTML='<section id="view-chat" class="active"><textarea></textarea><button id="voice-toggle"></button><div id="voice-controls" hidden><button id="voice-close"></button><label><select id="voice-language"></select></label><p id="voice-status"></p></div></section>';
      const check=(ok,message)=>{if(!ok)throw Error(message)};
      let sequence=0;Object.defineProperty(crypto,'randomUUID',{value:()=> 'voice-fixture-'+(++sequence)});
      const tick=()=>new Promise(r=>setTimeout(r,0));
      let availabilityResolve,startResolve,receive,starts=[],stops=[];
      window.nabsun={voice:{availability:()=>new Promise(r=>availabilityResolve=r),start:(...args)=>{starts.push(args);return new Promise(r=>startResolve=r)},stop:id=>stops.push(id),onEvent:fn=>receive=fn}};
      const prompt=document.querySelector('textarea'), mic=document.querySelector('#voice-toggle'), panel=document.querySelector('#voice-controls'), close=document.querySelector('#voice-close');
      new Voice.VoiceInput(prompt,()=> 'chat-a');
      mic.click();check(!panel.hidden&&!mic.disabled,'startup must remain cancellable');
      close.click();check(panel.hidden,'close during discovery hides panel');
      const availability={available:true,languages:[{code:'en-US',name:'English'}],help:'Fixture'};availabilityResolve(availability);await tick();
      check(starts.length===0,'late discovery must not start microphone');
      mic.click();await tick();check(starts.length===1,'reopen starts dictation');
      const id=starts[0][1];close.click();check(panel.hidden&&stops.includes(id),'close cancels pending consent');
      startResolve();await tick();
      receive({sessionId:'chat-a',requestId:id,type:'text',text:'late'});check(!prompt.value,'closed dictation ignores late words');
      mic.click();await tick();startResolve();await tick();receive({sessionId:'chat-a',requestId:starts.at(-1)[1],type:'listening'});mic.click();check(panel.hidden,'second microphone click closes listening panel');
      mic.click();await tick();startResolve();await tick();close.focus();close.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));check(panel.hidden,'Escape works outside prompt');
      receive({sessionId:'chat-a',requestId:starts.at(-1)[1],type:'ended'});check(panel.hidden,'late ended does not reopen panel');
      window.nabsun.voice.start=async()=>{throw Error('Microphone unavailable')};mic.click();await tick();check(!panel.hidden&&document.querySelector('#voice-status').textContent.includes('Microphone unavailable'),'startup error remains readable');close.click();check(panel.hidden,'error panel can close');
      availability.available=false;mic.click();await tick();check(!panel.hidden,'system dictation guidance opens');mic.click();check(panel.hidden,'unavailable dictation guidance can close');
      return 'PASS dictation close, startup cancellation, late events, microphone toggle and Escape';
    })()`);
    console.log(result);
  } finally {win.destroy();app.quit()}
})().catch(error=>{console.error(error);app.exit(1)});
