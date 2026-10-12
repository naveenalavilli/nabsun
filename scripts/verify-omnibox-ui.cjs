const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-address-test-')));
async function main() {
  const bundle = await build({ entryPoints: [path.join(__dirname, '../src/renderer/overlay/overlay.ts')], bundle: true, write: false, format: 'iife' });
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    const html = fs.readFileSync(path.join(__dirname, '../src/renderer/overlay/index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/, '');
    await win.loadURL('data:text/html,' + encodeURIComponent(html));
    const results = await win.webContents.executeJavaScript(`(async () => {
      const results = [], pending = [], calls = [];
      const check = (name, ok) => { if (!ok) throw Error(name); results.push(name); };
      let open, closed = 0;
      window.overlay = { onOpen: cb => open = cb, suggest: query => new Promise(resolve => pending.push({query, resolve})), run: (...args) => calls.push(args), close: () => closed++ };
      ${bundle.outputFiles[0].text}
      const input = document.querySelector('#input');
      const tick = () => new Promise(r => setTimeout(r, 0));
      const type = text => { input.value = text; input.dispatchEvent(new Event('input')); };
      const key = (name, props = {}) => input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...props }));
      open({ kind: 'omnibox', payload: { query: 'https://example.com:8080/path#part', anchor: {x:110,y:42,width:650,height:28,viewportWidth:1000} }, theme: 'light' });
      check('full address is selected for replacement', input.selectionStart === 0 && input.selectionEnd === input.value.length);
      const rect = document.querySelector('#panel').getBoundingClientRect();
      check('editor is anchored to toolbar rather than centered', rect.x === 110 && rect.y === 42);
      check('page is not dimmed', getComputedStyle(document.querySelector('#backdrop')).backgroundColor === 'rgba(0, 0, 0, 0)');
      type('new query'); key('Enter');
      check('Enter before suggestions navigates current text', calls.at(-1)[1] === 'new query');
      type('newer query');
      pending.at(-1).resolve([{kind:'search',title:'newer query',value:'https://search.example/newer'}]); await tick();
      pending[0].resolve([{kind:'url',title:'old address',value:'https://old.example'}]); await tick();
      check('late response cannot overwrite current suggestions', document.querySelector('#list').textContent.includes('newer query') && !document.querySelector('#list').textContent.includes('old address'));
      const before = calls.length;
      key('Enter', {isComposing:true}); check('IME confirmation does not navigate', calls.length === before);
      type('choices'); pending.at(-1).resolve([{kind:'search',title:'first',value:'one'},{kind:'history',title:'second',value:'two'}]); await tick();
      key('ArrowDown'); key('Enter'); check('arrow selection opens selected destination', calls.at(-1)[1] === 'two');
      check('selection is exposed to assistive technology', input.getAttribute('aria-activedescendant') === 'suggestion-1');
      key('Escape'); check('Escape dismisses editor', closed === 1);
      open({ kind:'omnibox',payload:{query:'nabsun://home'},theme:'dark' });
      check('new tab starts empty without a fake URL', input.value === '' && !document.querySelector('#list').textContent);
      open({kind:'palette',payload:{},theme:'dark'});
      check('command palette retains separate styling and commands', document.querySelector('#backdrop').classList.contains('palette') && document.querySelector('#list').textContent.includes('New tab'));
      return results;
    })()`);
    results.forEach(name => console.log('PASS ' + name));
  } finally { win.destroy(); }
}
main().then(() => app.exit(0), err => { console.error(err); app.exit(1); });
