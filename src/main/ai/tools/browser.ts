import { withTrustedInput, mouse } from '../../trustedInput';
import type { PageSnapshot } from '../../../shared/types';
import { resolveNavigationInput } from '../../history';
import { delay, type Tab } from '../../tabs';
import { assertLive, bool, defineTool, num, str, type Tool, type ToolContext } from './types';

/** Resolves the tab a tool should act on, preferring the agent's own tab. */
function target(ctx: ToolContext, input: Record<string, unknown>): Tab {
  const explicit = typeof input.tabId === 'string' ? input.tabId : undefined;
  const id = explicit ?? ctx.getAgentTabId() ?? undefined;
  const tab = ctx.tabs.resolveTarget(id);
  ctx.setAgentTabId(tab.id);
  return tab;
}

function renderSnapshot(snap: PageSnapshot): string {
  const pct = snap.scroll.height
    ? Math.round(((snap.scroll.y + snap.scroll.viewportHeight) / snap.scroll.height) * 100)
    : 100;
  return [
    `URL: ${snap.url}`,
    `Title: ${snap.title}`,
    `Scroll: ${Math.min(pct, 100)}% of page visible from top (y=${snap.scroll.y}/${snap.scroll.height})`,
    '',
    'Page outline (act on elements using their [ref=…] handle, copied verbatim):',
    snap.text || '(no visible content)',
  ].join('\n');
}

/**
 * After any action that can navigate or re-render, give the page a moment to
 * settle before the model looks at it again. Cheap insurance against acting on
 * a stale DOM.
 */
async function settle(ctx: ToolContext, tab: Tab, ms = 600) {
  await delay(ms);
  await ctx.tabs.waitForSettled(tab, 8_000);
}

interface InputTarget { x:number; y:number; role:string; name:string; type:string; multiline?:boolean; value?:string }
async function trustedClick(ctx:ToolContext, tab:Tab, ref:string, button='left', clickCount=1):Promise<string> {
  if(!['left','right','middle'].includes(button)||![1,2].includes(clickCount))throw Error('Unsupported mouse button or click count.');
  return withTrustedInput(tab.wc,ctx.signal,async send=>{
    let point=await ctx.tabs.callBridge<InputTarget>(tab,`window.__nabsunAgent.prepareInput(${JSON.stringify(ref)})`,ctx.signal);
    if(point.type==='file')throw Error('Only you can choose files. Attach a file to this chat, then use browser_upload with its file id.');
    await send('Input.dispatchMouseEvent',mouse('mouseMoved',point.x,point.y,'none'));
    for(let count=1;count<=clickCount;count++){
      assertLive(ctx,'this click');
      point=await ctx.tabs.callBridge<InputTarget>(tab,`window.__nabsunAgent.prepareInput(${JSON.stringify(ref)})`,ctx.signal);
      await send('Input.dispatchMouseEvent',mouse('mousePressed',point.x,point.y,button,count));
      await send('Input.dispatchMouseEvent',mouse('mouseReleased',point.x,point.y,button,count));
    }
    return `Clicked ${point.role} ${JSON.stringify(point.name)} with trusted ${button} input${clickCount===2?' (double-click)':''}`;
  });
}
async function trustedType(ctx:ToolContext,tab:Tab,ref:string,text:string,submit:boolean):Promise<string> {
  if(text.length>32768)throw Error('Text entry is limited to 32768 characters per call.');
  return withTrustedInput(tab.wc,ctx.signal,async send=>{
    const point=await ctx.tabs.callBridge<InputTarget>(tab,`window.__nabsunAgent.prepareInput(${JSON.stringify(ref)},'text')`,ctx.signal);
    if(!point.multiline && /[\n\r\t]/.test(text))throw Error('This single-line field cannot accept the requested value with line breaks or tabs. Nothing was typed or submitted.');
    const focused=()=>ctx.tabs.callBridge<{value:string}>(tab,`window.__nabsunAgent.focusedInput(${JSON.stringify(ref)})`,ctx.signal);
    await send('Input.dispatchMouseEvent',mouse('mousePressed',point.x,point.y));
    await send('Input.dispatchMouseEvent',mouse('mouseReleased',point.x,point.y));
    await focused();
    const key=async(key:string,extra:Record<string,unknown>={})=>{await focused();await send('Input.dispatchKeyEvent',{type:'keyDown',key,...extra});await send('Input.dispatchKeyEvent',{type:'keyUp',key})};
    await key('a',{code:'KeyA',modifiers:process.platform==='darwin'?4:2,commands:['selectAll']});
    await key('Backspace',{windowsVirtualKeyCode:8});
    for(const character of text) {
      if(/[\n\r\t]/.test(character)){await focused();await send('Input.insertText',{text:character})}
      else await key(character,{text:character,unmodifiedText:character});
    }
    const result=await focused();
    let fallback=false;
    if(result.value!==text) {
      if(!['date','time','month','week','datetime-local'].includes(point.type))throw Error('Trusted typing did not produce the requested value. The page may have changed or rejected input. No submission was sent; inspect the page before retrying.');
      // Chromium's segmented date/time controls reject ordinary text on some
      // locales. Preserve the legacy path only for these native widgets.
      await ctx.tabs.callBridge(tab,`window.__nabsunAgent.fill(${JSON.stringify(ref)},${JSON.stringify(text)},false)`,ctx.signal);
      const verified=await focused();
      if(verified.value!==text)throw Error('The native date/time control rejected the requested value. Nothing was submitted.');
      fallback=true;
    }
    if(submit)await key('Enter',{windowsVirtualKeyCode:13});
    return `Filled ${JSON.stringify(point.name)} (${text.length} characters) with ${fallback?'DOM compatibility fallback after native date/time input was rejected (input events are not trusted)':'trusted input'}${submit?' and pressed Enter':''}`;
  });
}

export function browserTools(): Tool[] {
  return [
    defineTool(
      {
        name: 'browser_snapshot',
        description:
          'Read the current page as a structured outline in which every interactive element carries an opaque [ref=…] handle. Call this before clicking or typing, and again after any action that changes the page. This is the primary way to see a page.',
        risk: 'safe',
        properties: {
          tabId: { type: 'string', description: 'Tab to read. Defaults to the agent\'s current tab.' },
          viewportOnly: {
            type: 'boolean',
            description: 'Only include elements currently on screen. Useful on very long pages.',
          },
          maxChars: { type: 'number', description: 'Outline character limit, 1000–24000; default 8000. Increase if needed.' },
        },
      },
      async (input, ctx) => {
        const tab = target(ctx, input);
        await ctx.tabs.waitForSettled(tab, 8_000);
        const snap = await ctx.tabs.callBridge<PageSnapshot>(
          tab,
          `window.__nabsunAgent.snapshot({ viewportOnly: ${bool(input.viewportOnly)}, maxChars: ${Math.max(1000, Math.min(24000, num(input.maxChars, 8000)))} })`,
      ctx.signal,
        );
        ctx.status(`Read ${snap.title || snap.url}`);
        return renderSnapshot(snap);
      },
    ),

    defineTool(
      {
        name: 'browser_navigate',
        description:
          'Navigate a tab to a URL or a search query. Waits for the page to load and returns a fresh snapshot.',
        risk: 'write',
        properties: {
          url: { type: 'string', description: 'A URL, a bare domain, or a search query.' },
          tabId: { type: 'string' },
        },
        required: ['url'],
      },
      async (input, ctx) => {
        const tab = target(ctx, input);
        const url = resolveNavigationInput(str(input.url), ctx.settings.get().searchEngine);
        ctx.status(`Navigating to ${url}`);
        assertLive(ctx, 'this navigation');
        ctx.tabs.navigate(tab.id, url);
        await settle(ctx, tab, 300);
        if (tab.error) return `Navigation failed: ${tab.error}`;
        const snap = await ctx.tabs.callBridge<PageSnapshot>(tab, 'window.__nabsunAgent.snapshot({})', ctx.signal);
        return renderSnapshot(snap);
      },
    ),

    defineTool(
      {
        name: 'browser_click',
        description:
          'Click an element by its [ref=…] handle from the most recent snapshot. Returns the page state after the click.',
        risk: 'write',
        properties: {
          ref: { type: 'string', description: 'The opaque ref handle from the latest snapshot, copied verbatim.' },
          tabId: { type: 'string' },
          button: { type:'string', enum:['left','right','middle'], description:'Mouse button; default left.' },
          clickCount: { type:'number', enum:[1,2], description:'One click or double-click; default 1.' },
          expectNavigation: {
            type: 'boolean',
            description: 'Set when the click is expected to load a new page, to wait longer.',
          },
        },
        required: ['ref'],
      },
      async (input, ctx) => {
        const tab = target(ctx, input);
        const ref = JSON.stringify(str(input.ref));
        await ctx.tabs.callBridge(tab, `window.__nabsunAgent.highlight([${ref}])`, ctx.signal);
        assertLive(ctx, 'this click');
        const message = await trustedClick(ctx, tab, str(input.ref), str(input.button,'left'), num(input.clickCount,1));
        ctx.status(message);
        await settle(ctx, tab, bool(input.expectNavigation) ? 1200 : 500);
        const snap = await ctx.tabs.callBridge<PageSnapshot>(tab, 'window.__nabsunAgent.snapshot({})', ctx.signal);
        return `${message}\n\n${renderSnapshot(snap)}`;
      },
    ),

    defineTool(
      {
        name: 'browser_type',
        description:
          'Type text into a text field or contenteditable identified by its [ref=…] handle. Set submit to press Enter afterwards.',
        risk: 'write',
        properties: {
          ref: { type: 'string' },
          text: { type: 'string' },
          submit: { type: 'boolean', description: 'Press Enter after typing.' },
          tabId: { type: 'string' },
        },
        required: ['ref', 'text'],
      },
      async (input, ctx) => {
        const tab = target(ctx, input);
        const ref = JSON.stringify(str(input.ref));
        const text = str(input.text);
        const submit = bool(input.submit);
        await ctx.tabs.callBridge(tab, `window.__nabsunAgent.highlight([${ref}])`, ctx.signal);
        assertLive(ctx, submit ? 'typing and submitting' : 'this text entry');
        const message = await trustedType(ctx, tab, str(input.ref), text, submit);
        ctx.status(message);
        await settle(ctx, tab, submit ? 1200 : 400);
        const snap = await ctx.tabs.callBridge<PageSnapshot>(tab, 'window.__nabsunAgent.snapshot({})', ctx.signal);
        return `${message}\n\n${renderSnapshot(snap)}`;
      },
    ),

    defineTool(
      {
        name: 'browser_select',
        description: 'Choose one or more options in a <select> element by value or visible label.',
        risk: 'write',
        properties: {
          ref: { type: 'string' },
          values: { type: 'array', items: { type: 'string' } },
          tabId: { type: 'string' },
        },
        required: ['ref', 'values'],
      },
      async (input, ctx) => {
        const tab = target(ctx, input);
        const values = Array.isArray(input.values) ? input.values.map((v) => str(v)) : [str(input.values)];
        assertLive(ctx, 'this selection');
        const ref=JSON.stringify(str(input.ref));
        const message = await withTrustedInput(tab.wc,ctx.signal,async send=>{
          const meta=await ctx.tabs.callBridge<{multiple:boolean;options:{value:string;label:string;disabled:boolean}[];value:string}>(tab,`window.__nabsunAgent.selectionTarget(${ref})`,ctx.signal);
          // Retain multi-select support; disclose the compatibility path explicitly.
          if(meta.multiple||values.length!==1){
            const result=await ctx.tabs.callBridge<string>(tab,`window.__nabsunAgent.select(${ref}, ${JSON.stringify(values)})`,ctx.signal);
            return `${result} (DOM compatibility fallback for multi-select; events are not trusted)`;
          }
          const options=meta.options.filter(option=>!option.disabled);
          const index=options.findIndex(option=>option.value.toLowerCase()===values[0].toLowerCase()||option.label.toLowerCase()===values[0].toLowerCase());
          if(index<0)throw Error('No enabled option matches the requested value.');
          if(index>500)throw Error('Select has too many options for a bounded keyboard action.');
          const point=await ctx.tabs.callBridge<InputTarget>(tab,`window.__nabsunAgent.prepareInput(${ref})`,ctx.signal);
          await send('Input.dispatchMouseEvent',mouse('mousePressed',point.x,point.y));
          await send('Input.dispatchMouseEvent',mouse('mouseReleased',point.x,point.y));
          for(const key of ['Escape','Home',...Array<string>(index).fill('ArrowDown')]){
            await send('Input.dispatchKeyEvent',{type:'keyDown',key,windowsVirtualKeyCode:key==='Escape'?27:key==='Home'?36:40});
            await send('Input.dispatchKeyEvent',{type:'keyUp',key});
          }
          const result=await ctx.tabs.callBridge<{value:string}>(tab,`window.__nabsunAgent.selectionTarget(${ref})`,ctx.signal);
          if(result.value!==options[index].value)throw Error('Trusted selection did not match. Inspect the page before retrying.');
          return 'Selected the requested option with trusted keyboard input';
        });
        ctx.status(message);
        await settle(ctx, tab, 400);
        return message;
      },
    ),

    defineTool(
      {
        name: 'browser_set_checked',
        description: 'Check or uncheck a checkbox, radio button or ARIA switch.',
        risk: 'write',
        properties: {
          ref: { type: 'string' },
          checked: { type: 'boolean' },
          tabId: { type: 'string' },
        },
        required: ['ref', 'checked'],
      },
      async (input, ctx) => {
        const tab = target(ctx, input);
        assertLive(ctx, 'this change');
        const ref=JSON.stringify(str(input.ref)),wanted=bool(input.checked);
        const message=await withTrustedInput(tab.wc,ctx.signal,async send=>{
          const before=await ctx.tabs.callBridge<boolean>(tab,`window.__nabsunAgent.checkedTarget(${ref})`,ctx.signal);
          if(before===wanted)return 'Already in the requested checked state';
          const point=await ctx.tabs.callBridge<InputTarget>(tab,`window.__nabsunAgent.prepareInput(${ref})`,ctx.signal);
          await send('Input.dispatchMouseEvent',mouse('mousePressed',point.x,point.y));
          await send('Input.dispatchMouseEvent',mouse('mouseReleased',point.x,point.y));
          const after=await ctx.tabs.callBridge<boolean>(tab,`window.__nabsunAgent.checkedTarget(${ref})`,ctx.signal);
          if(after!==wanted)throw Error('The control did not enter the requested state. Inspect the page before retrying.');
          return 'Updated checked state with trusted input';
        });
        ctx.status(message);
        await settle(ctx, tab, 400);
        return message;
      },
    ),

    defineTool(
      {
        name: 'browser_hover',
        description: 'Hover an element, to reveal menus or tooltips that appear on mouseover.',
        risk: 'write',
        properties: { ref: { type: 'string' }, tabId: { type: 'string' } },
        required: ['ref'],
      },
      async (input, ctx) => {
        const tab = target(ctx, input);
        const message = await withTrustedInput(tab.wc,ctx.signal,async send=>{
          const point=await ctx.tabs.callBridge<InputTarget>(tab,`window.__nabsunAgent.prepareInput(${JSON.stringify(str(input.ref))})`,ctx.signal);
          await send('Input.dispatchMouseEvent',mouse('mouseMoved',point.x,point.y,'none'));
          return `Hovered ${JSON.stringify(point.name)} with trusted input`;
        });
        await delay(400);
        const snap = await ctx.tabs.callBridge<PageSnapshot>(tab, 'window.__nabsunAgent.snapshot({})', ctx.signal);
        return `${message}\n\n${renderSnapshot(snap)}`;
      },
    ),

    defineTool({
      name:'browser_drag', description:'Drag from one current element ref to another with trusted pointer input. Take a new snapshot afterwards.',risk:'write',
      properties:{ref:{type:'string'},toRef:{type:'string'},tabId:{type:'string'}},required:['ref','toRef'],
    },async(input,ctx)=>{
      const tab=target(ctx,input);
      return withTrustedInput(tab.wc,ctx.signal,async send=>{
        const from=await ctx.tabs.callBridge<InputTarget>(tab,`window.__nabsunAgent.prepareInput(${JSON.stringify(str(input.ref))})`,ctx.signal);
        const to=await ctx.tabs.callBridge<InputTarget>(tab,`window.__nabsunAgent.prepareInput(${JSON.stringify(str(input.toRef))})`,ctx.signal);
        // Scrolling the destination can move the source. Recheck both before pressing.
        const again=await ctx.tabs.callBridge<InputTarget>(tab,`window.__nabsunAgent.prepareInput(${JSON.stringify(str(input.ref))})`,ctx.signal);
        if(Math.abs(from.x-again.x)>1||Math.abs(from.y-again.y)>1)throw Error('Drag targets moved while scrolling. Keep both visible and retry.');
        await send('Input.dispatchMouseEvent',mouse('mouseMoved',from.x,from.y,'none'));
        await send('Input.dispatchMouseEvent',mouse('mousePressed',from.x,from.y));
        for(let step=1;step<=12;step++)await send('Input.dispatchMouseEvent',{...mouse('mouseMoved',from.x+(to.x-from.x)*step/12,from.y+(to.y-from.y)*step/12),buttons:1});
        await send('Input.dispatchMouseEvent',mouse('mouseReleased',to.x,to.y));
        return 'Dragged with trusted pointer input. Check the page to verify the result.';
      });
    }),

    defineTool(
      {
        name: 'browser_scroll',
        description:
          'Scroll the page (or a scrollable element) and return the newly visible content.',
        risk: 'safe',
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
          amount: { type: 'number', description: 'Pixels. Defaults to about one viewport.' },
          ref: { type: 'string', description: 'Scroll this element instead of the window.' },
          tabId: { type: 'string' },
        },
        required: ['direction'],
      },
      async (input, ctx) => {
        const tab = target(ctx, input);
        const dir = str(input.direction, 'down');
        const amount = input.amount === undefined ? 'undefined' : String(num(input.amount));
        const ref = input.ref === undefined ? 'undefined' : JSON.stringify(str(input.ref));
        const message = await ctx.tabs.callBridge<string>(
          tab,
          `window.__nabsunAgent.scroll(${JSON.stringify(dir)}, ${amount}, ${ref})`,
      ctx.signal,
        );
        await delay(350);
        const snap = await ctx.tabs.callBridge<PageSnapshot>(
          tab,
          'window.__nabsunAgent.snapshot({ viewportOnly: true })',
          ctx.signal,
        );
        return `${message}\n\n${renderSnapshot(snap)}`;
      },
    ),

    defineTool(
      {
        name: 'browser_read_text',
        description:
          'Read page prose without element handles. Prefer a selector for the relevant section. Use offset to continue a truncated read on an unchanged page.',
        risk: 'safe',
        properties: {
          selector: { type: 'string', description: 'Optional CSS selector to read a subtree only.' },
          maxChars: { type: 'number', description: 'Characters to read, 1000–60000; default 12000.' },
          offset: { type: 'number', description: 'Character offset for continuation on an unchanged page, default 0.' },
          tabId: { type: 'string' },
        },
      },
      async (input, ctx) => {
        const tab = target(ctx, input);
        await ctx.tabs.waitForSettled(tab, 8_000);
        const selector = input.selector === undefined ? 'undefined' : JSON.stringify(str(input.selector));
        const offset = Math.max(0, Math.floor(num(input.offset, 0)));
        const res = await ctx.tabs.callBridge<{ text: string; truncated: boolean }>(
          tab,
          `window.__nabsunAgent.readText(${selector}, ${Math.max(1000, Math.min(60000, num(input.maxChars, 12000)))}, ${Math.max(0, Math.floor(num(input.offset, 0)))})`,
      ctx.signal,
        );
        ctx.status(`Read text from ${tab.wc.getTitle()}`);
        return res.truncated ? `${res.text}\n\n[More text available: continue with offset=${offset + res.text.length} and the same selector on this unchanged page.]` : res.text;
      },
    ),

    defineTool(
      {
        name: 'browser_find_text',
        description:
          'Locate occurrences of a string on the page and return surrounding context plus the nearest actionable [ref=…].',
        risk: 'safe',
        properties: { query: { type: 'string' }, tabId: { type: 'string' } },
        required: ['query'],
      },
      async (input, ctx) => {
        const tab = target(ctx, input);
        const hits = await ctx.tabs.callBridge<{ ref: number | null; context: string }[]>(
          tab,
          `window.__nabsunAgent.findText(${JSON.stringify(str(input.query))})`,
      ctx.signal,
        );
        if (!hits.length) return `No occurrences of ${JSON.stringify(str(input.query))} on this page.`;
        return hits
          .map((h, i) => `${i + 1}. ${h.context}${h.ref !== null ? ` [ref=${h.ref}]` : ''}`)
          .join('\n');
      },
    ),

    defineTool(
      {
        name: 'browser_extract',
        description:
          'Pull structured records off a page. Give a CSS selector matching each row, and a field map of name -> CSS selector (use "." for the row itself, or "sel@attr" to read an attribute). Returns JSON.',
        risk: 'safe',
        properties: {
          selector: { type: 'string', description: 'Selector matching each repeated row.' },
          fields: {
            type: 'object',
            description: 'Field name -> CSS selector, e.g. {"title":"h3","url":"a@href"}',
            additionalProperties: { type: 'string' },
          },
          tabId: { type: 'string' },
        },
        required: ['selector', 'fields'],
      },
      async (input, ctx) => {
        const tab = target(ctx, input);
        const fields = (input.fields ?? {}) as Record<string, string>;
        const rows = await ctx.tabs.callBridge<Record<string, string>[]>(
          tab,
          `window.__nabsunAgent.extract(${JSON.stringify(str(input.selector))}, ${JSON.stringify(fields)})`,
          ctx.signal,
        );
        ctx.status(`Extracted ${rows.length} rows`);
        return rows.length
          ? JSON.stringify(rows, null, 2)
          : `No elements matched ${JSON.stringify(str(input.selector))}.`;
      },
    ),

    defineTool(
      {
        name: 'browser_screenshot',
        description:
          'Capture what the page looks like right now. Use when layout or visual detail matters and the text outline is not enough.',
        risk: 'safe',
        properties: { tabId: { type: 'string' } },
      },
      async (input, ctx) => {
        const tab = target(ctx, input);
        const shot = await ctx.tabs.screenshot(tab);
        ctx.status('Captured screenshot');
        return {
          content: `Screenshot of ${tab.wc.getURL()}`,
          images: [shot],
        };
      },
    ),

    defineTool(
      {
        name: 'browser_press_key',
        description:
          'Send a real key press to the page (Enter, Escape, Tab, ArrowDown, PageDown, a single character, …). Use for keyboard-driven UI that ignores synthetic events.',
        risk: 'write',
        properties: {
          key: { type: 'string' },
          modifiers: {
            type: 'array',
            items: { type: 'string', enum: ['control', 'shift', 'alt', 'meta'] },
          },
          tabId: { type: 'string' },
        },
        required: ['key'],
      },
      async (input, ctx) => {
        const tab = target(ctx, input);
        const key = str(input.key);
        const modifiers = Array.isArray(input.modifiers) ? input.modifiers.map((m) => str(m)) : [];
        const focus=await ctx.tabs.callBridge<{credential:boolean;file:boolean;frame:boolean}>(tab,'window.__nabsunAgent.keyboardTarget()',ctx.signal);
        if(!['Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End'].includes(key)){
          if(focus.credential)throw Error('The assistant does not send text or edit keys to password or one-time-code fields.');
          if(focus.file)throw Error('Only you can choose files. Attach a file to this chat and use browser_upload.');
          if(focus.frame)throw Error('Use browser_type with a fresh frame ref instead of an unscoped key press.');
        }
        // Real input events go through the browser rather than the DOM, so the
        // page cannot tell them apart from the user's own typing.
        assertLive(ctx, 'this key press');
        tab.wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers } as never);
        if (key.length === 1 && !modifiers.length) {
          tab.wc.sendInputEvent({ type: 'char', keyCode: key } as never);
        }
        tab.wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers } as never);
        await settle(ctx, tab, 500);
        return `Pressed ${[...modifiers, key].join('+')}`;
      },
    ),

    defineTool(
      {
        name: 'browser_back',
        description: 'Go back in the tab history.',
        risk: 'write',
        properties: { tabId: { type: 'string' } },
      },
      async (input, ctx) => {
        const tab = target(ctx, input);
        if (!tab.wc.navigationHistory.canGoBack()) return 'No earlier page in this tab.';
        tab.wc.navigationHistory.goBack();
        await settle(ctx, tab, 600);
        return `Went back to ${tab.wc.getURL()}`;
      },
    ),

    defineTool(
      {
        name: 'browser_wait',
        description:
          'Wait for the page to settle, optionally until a piece of text appears. Use after triggering an action that loads content asynchronously.',
        risk: 'safe',
        properties: {
          seconds: { type: 'number', description: 'Maximum seconds to wait (default 5, max 30).' },
          text: { type: 'string', description: 'Stop waiting once this text is present.' },
          tabId: { type: 'string' },
        },
      },
      async (input, ctx) => {
        const tab = target(ctx, input);
        const maxMs = Math.min(num(input.seconds, 5), 30) * 1000;
        const wanted = input.text === undefined ? null : str(input.text);
        const deadline = Date.now() + maxMs;

        while (Date.now() < deadline) {
          if (ctx.signal.aborted) return 'Wait aborted.';
          if (!wanted) {
            await ctx.tabs.waitForSettled(tab, maxMs);
            return 'Page settled.';
          }
          const hits = await ctx.tabs
            .callBridge<{ context: string }[]>(
              tab,
              `window.__nabsunAgent.findText(${JSON.stringify(wanted)}, 1)`,
              ctx.signal,
            )
            .catch(() => []);
          if (hits.length) return `Found ${JSON.stringify(wanted)} after waiting.`;
          await delay(400);
        }
        return wanted
          ? `Timed out after ${maxMs / 1000}s without seeing ${JSON.stringify(wanted)}.`
          : 'Timed out waiting for the page to settle.';
      },
    ),

    defineTool(
      {
        name: 'browser_evaluate',
        description:
          'Run a JavaScript expression in the page and return its result. Powerful escape hatch for things the other tools cannot express. Prefer the dedicated tools when they fit.',
        risk: 'dangerous',
        properties: {
          expression: {
            type: 'string',
            description: 'A JavaScript expression. The value of the last expression is returned.',
          },
          tabId: { type: 'string' },
        },
        required: ['expression'],
      },
      async (input, ctx) => {
        const tab = target(ctx, input);
        const expr = str(input.expression);
        assertLive(ctx, 'running this script');
        const value = await ctx.tabs.callBridge<unknown>(tab, `(() => { return (${expr}); })()`, ctx.signal);
        ctx.status('Ran page script');
        const rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        return rendered === undefined ? 'undefined' : String(rendered).slice(0, 20_000);
      },
    ),
  ];
}
