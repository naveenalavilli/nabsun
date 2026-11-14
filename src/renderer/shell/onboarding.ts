import type { Settings } from '../../shared/types';
import { needsUsageAgreement, USAGE_AGREEMENT_VERSION } from '../../shared/assistantSettings';

const examples = [
  { label: 'Fill a form', prompt: 'Fill this form using the details I provide. Ask me for anything missing and let me review it before submitting.', steps: ['Find the right fields', 'Enter the details you provide', 'Leave the form ready for your review'], note: 'Open the form first. Add your details to the draft before sending.' },
  { label: 'Compare options', prompt: 'Find three options on this website that match my needs. Open them in separate tabs and compare the main differences. Ask me for my requirements first.', steps: ['Ask what matters to you', 'Search and open matching options', 'Compare them so you can decide'], note: 'Open a store or listings website. A more capable assistant works best for multi-step tasks.' },
  { label: 'Find a page', prompt: 'Find the returns policy on this website and open it for me.', steps: ['Look for the help or support area', 'Follow the relevant links', 'Bring the policy page into view'], note: 'Open a store website first. Navigation may ask for your approval.' },
  { label: 'Understand a page', prompt: 'Explain this page in three short points, then suggest a useful next step.', steps: ['Read the page you include', 'Pick out the important details', 'Suggest what to do next'], note: 'A good first task for the included local assistant. Keep Use this page checked.' },
] as const;
const panelIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="2"/><path d="M11.5 3v14M14.5 7v6"/></svg>';

export class OnboardingView {
  private selectedExample = 0;
  private step = 0;

  constructor(
    private root: HTMLElement,
    private finish: (next: Settings, destination: 'chat' | 'extensions' | 'browse', prompt?: string) => void,
  ) {}

  render(settings?: Settings) {
    if (settings && needsUsageAgreement(settings)) { this.renderAgreement(); return; }
    this.selectedExample = 0;
    this.step = 0;
    this.root.classList.remove('guide-progressed');
    this.root.innerHTML = `
      <div class="guide-heading"><span class="welcome-eyebrow">GETTING STARTED</span><span class="guide-duration">A quick tour. Come back any time.</span></div>
      <h1>Your browser. Ready to act.</h1>
      <p class="welcome-intro">Ask Nabsun to find a page, compare options, or fill a form. It works in your browser; you review the results and control the actions.</p>
      <div class="guide-start"><button class="primary" data-action="local">Start with the included assistant</button><button class="welcome-skip" data-action="skip">Just browse</button><p>No account needed for the local assistant. Best for simple tasks; its first reply can take a little time.</p></div>
      <details class="welcome-optional"><summary>Need help with a longer task? Connect another assistant</summary><p>Connect an eligible Codex or Claude account, or configure another provider in Settings. Online assistants receive your messages and the page context you share; provider charges and limits apply.</p><button class="welcome-choice" data-action="connect"><strong>Open assistant connections</strong><span>Keep your current choice until you select a different assistant.</span></button></details>
      <div class="guide-tabs" role="tablist" aria-label="Getting started sections">
        <button id="guide-tab-0" role="tab" aria-controls="guide-panel-0" aria-selected="true" tabindex="0" data-guide-step="0"><span>1</span> Find your way</button>
        <button id="guide-tab-1" role="tab" aria-controls="guide-panel-1" aria-selected="false" tabindex="-1" data-guide-step="1"><span>2</span> Try a task</button>
        <button id="guide-tab-2" role="tab" aria-controls="guide-panel-2" aria-selected="false" tabindex="-1" data-guide-step="2"><span>3</span> Stay in control</button>
      </div>
      <section class="guide-panel" id="guide-panel-0" role="tabpanel" aria-labelledby="guide-tab-0" tabindex="0">
        <div class="guide-panel-heading"><h2>One place to browse and get things done</h2><p>Start on the website where you want to work. Open the assistant using the panel button at the right of the address bar.</p></div>
        <div class="welcome-illustration guide-map" role="img" aria-label="Illustration of the browser toolbar: address bar for opening a website and panel button on the right for the assistant. The webpage is beside an assistant with a message box and Send button.">
          <div class="guide-browserbar"><span aria-hidden="true">&larr; &nbsp; &rarr;</span><span class="guide-address">Search or enter address</span><span class="guide-panel-button">${panelIcon}</span></div>
          <div class="guide-page"><span class="tour-tag">YOUR WEBSITE</span><strong>The place you want to work</strong><div class="guide-field"></div><div class="guide-field short"></div><span class="guide-map-caption">Browse, sign in, and open your page as usual.</span></div>
          <div class="guide-assistant"><strong>Assistant</strong><span class="guide-bubble">Tell me what you want done.</span><span class="guide-map-caption">Use this page &middot; Ask for approval</span><div class="guide-message">Your request <b>Send</b></div></div>
        </div>
        <div class="guide-tip-grid"><article><h3>Use this page</h3><p>Includes text from the open page with your message. Turn it off for a question that does not need that context.</p></article><article><h3>Make room for your work</h3><p>Drag the assistant divider to resize it. Its options menu has Detach assistant and Text size.</p></article></div>
      </section>
      <section class="guide-panel" id="guide-panel-1" role="tabpanel" aria-labelledby="guide-tab-1" tabindex="0" hidden>
        <div class="guide-panel-heading"><h2>Describe the outcome, not every click</h2><p>Pick an example to see how a task works. These are illustrations, not live actions.</p></div>
        <div class="guide-examples" role="group" aria-label="Example tasks">${examples.map((example, index) => `<button data-guide-example="${index}" aria-pressed="${index === 0}">${example.label}</button>`).join('')}</div>
        <div class="guide-task"><div><span class="tour-tag">YOUR REQUEST</span><blockquote id="guide-prompt"></blockquote><p class="hint" id="guide-example-note"></p></div><div><span class="tour-tag">WHAT NABSUN CAN DO</span><ol id="guide-task-steps"></ol><p class="guide-review">You review the result. Nothing in this tour is submitted.</p></div></div>
        <button class="primary" data-action="example">Open this example as a draft</button><p class="hint">Uses your current assistant. Edit the message and press Send when ready. Complex tasks need a more capable assistant; some websites may not work.</p>
      </section>
      <section class="guide-panel" id="guide-panel-2" role="tabpanel" aria-labelledby="guide-tab-2" tabindex="0" hidden>
        <div class="guide-panel-heading"><h2>You decide what happens next</h2><p>Give it a task, follow its progress, and check the result before making changes that matter.</p></div>
        <div class="guide-control-grid">
          <article><span class="guide-control-symbol" aria-hidden="true">&#10003;</span><h3>Review requested actions</h3><p>Reading is allowed by default. Clicks, typing, and navigation ask for approval unless you have allowed them. Check the request before approving.</p></article>
          <article><span class="guide-control-symbol" aria-hidden="true">&#9632;</span><h3>Stop or change direction</h3><p>Press Stop to cancel the running task and clear queued follow-ups. Cancellation cannot undo an action already completed on a website.</p></article>
          <article><span class="guide-control-symbol" aria-hidden="true">&#8644;</span><h3>Line up your next request</h3><p>While the assistant works, use Send next to queue a follow-up. Remove a pending prompt with its cancel button before it starts.</p></article>
        </div>
        <div class="guide-permission-note"><strong>Start with Ask for approval while you learn.</strong><p>Choose your approval mode in Settings. Approve routine actions reduces prompts on one site; Full access can run powerful tools without asking. Folder access still needs your permission.</p></div>
        <p class="hint">The local model runs on your computer. Websites still use the internet. An online assistant receives the messages and context you send to it.</p>
      </section>
      <div class="guide-navigation"><button data-guide-back hidden>Back</button><span class="guide-progress" aria-live="polite">Section 1 of 3</span><button data-guide-next>Next: Try a task &rarr;</button></div>
      <p class="guide-return hint">Reopen this guide from the assistant or Settings &rarr; Getting started. Change assistants in Settings &rarr; Assistant choice.</p>
      <p class="welcome-status" role="status"></p>`;
    this.updateExample();
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-action]')) {
      button.addEventListener('click', () => void this.complete(button.dataset.action!));
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-guide-example]')) {
      button.addEventListener('click', () => { this.selectedExample = Number(button.dataset.guideExample); this.updateExample(); });
    }
    for (const tab of this.root.querySelectorAll<HTMLButtonElement>('[data-guide-step]')) {
      tab.addEventListener('click', () => this.showStep(Number(tab.dataset.guideStep)));
      tab.addEventListener('keydown', event => {
        const index = Number(tab.dataset.guideStep);
        const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null;
        if (next === null) return;
        event.preventDefault(); this.showStep(next, true);
      });
    }
    this.root.querySelector('[data-guide-back]')!.addEventListener('click', () => this.showStep(this.step - 1, true));
    this.root.querySelector('[data-guide-next]')!.addEventListener('click', () => this.showStep(this.step === 2 ? 1 : this.step + 1, true));
  }

  private showStep(step: number, focus = false) {
    this.step = Math.max(0, Math.min(2, step));
    this.root.classList.toggle('guide-progressed', this.step > 0);
    this.root.scrollTop = 0;
    for (const tab of this.root.querySelectorAll<HTMLButtonElement>('[data-guide-step]')) {
      const selected = Number(tab.dataset.guideStep) === this.step;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    }
    for (let index = 0; index < 3; index++) this.root.querySelector<HTMLElement>(`#guide-panel-${index}`)!.hidden = index !== this.step;
    this.root.querySelector<HTMLElement>('[data-guide-back]')!.hidden = this.step === 0;
    const next = this.root.querySelector<HTMLButtonElement>('[data-guide-next]')!;
    next.textContent = this.step === 0 ? 'Next: Try a task \u2192' : this.step === 1 ? 'Next: Stay in control \u2192' : 'Choose a task \u2192';
    this.root.querySelector('.guide-progress')!.textContent = `Section ${this.step + 1} of 3`;
  }

  private renderAgreement() {
    this.root.classList.remove('guide-progressed');
    this.root.innerHTML = `
      <section class="usage-agreement" aria-labelledby="usage-agreement-heading">
        <span class="welcome-eyebrow">BEFORE YOU START</span>
        <h1 id="usage-agreement-heading">A little clarity. Your choice.</h1>
        <p class="welcome-intro">Nabsun can browse and take actions for you. Please understand what you are choosing before you begin.</p>
        <div class="agreement-points">
          <article><h2>You choose the access</h2><p>Start with Ask for approval. Other approval modes can allow actions without asking again. Full access includes page scripts and uploads. Nabsun file tools only use folders you explicitly connect; extra integrations can have their own access.</p></article>
          <article><h2>Review important work</h2><p>AI can make mistakes or follow misleading instructions on websites. Check messages, forms, and edited documents. Stop cancels pending work; it cannot undo completed actions.</p></article>
          <article><h2>Know what you share</h2><p>The included model runs locally. Online assistants receive the messages, page context, images, and file contents you share. Provider accounts may have their own terms, fees, and limits.</p></article>
          <article><h2>An early open-source product</h2><p>Nabsun is provided under the MIT license without warranty. Publisher signing and Apple notarization are not yet available. Only use integrations and downloads you trust.</p></article>
        </div>
        <label class="agreement-accept"><input id="usage-agreement-check" type="checkbox"> <span>I understand how Nabsun uses AI and the access I choose.</span></label>
        <div class="actions"><button class="primary" id="usage-agreement-continue" disabled>Agree and continue</button><button class="ghost" id="usage-agreement-exit">Exit Nabsun</button></div>
        <p id="usage-agreement-status" role="status" aria-live="polite"></p>
      </section>`;
    const check = this.root.querySelector<HTMLInputElement>('#usage-agreement-check')!;
    const proceed = this.root.querySelector<HTMLButtonElement>('#usage-agreement-continue')!;
    check.addEventListener('change', () => { proceed.disabled = !check.checked; });
    this.root.querySelector('#usage-agreement-exit')!.addEventListener('click', () => window.nabsun.window.close());
    proceed.addEventListener('click', async () => {
      if (!check.checked) return;
      proceed.disabled = true; check.disabled = true;
      try {
        const next = await window.nabsun.settings.set({ usageAgreementVersion: USAGE_AGREEMENT_VERSION });
        this.render(next);
      } catch {
        this.root.querySelector('#usage-agreement-status')!.textContent = 'Could not save your choice. Please try again.';
        proceed.disabled = false; check.disabled = false;
      }
    });
    check.focus();
  }

  private updateExample() {
    const example = examples[this.selectedExample];
    this.root.querySelector('#guide-prompt')!.textContent = example.prompt;
    this.root.querySelector('#guide-example-note')!.textContent = example.note;
    const list = this.root.querySelector('#guide-task-steps')!;
    list.replaceChildren(...example.steps.map(text => { const item = document.createElement('li'); item.textContent = text; return item; }));
    for (const button of this.root.querySelectorAll('[data-guide-example]')) button.setAttribute('aria-pressed', String(Number((button as HTMLElement).dataset.guideExample) === this.selectedExample));
  }

  private async complete(action: string) {
    const buttons = this.root.querySelectorAll<HTMLButtonElement>('button');
    buttons.forEach(button => button.disabled = true);
    this.root.querySelector('.welcome-status')!.textContent = '';
    try {
      const next = await window.nabsun.settings.set({
        onboardingCompleted: true,
        ...(action === 'local' ? { provider: 'local' as const } : {}),
      });
      this.finish(next, action === 'connect' ? 'extensions' : action === 'skip' ? 'browse' : 'chat',
        action === 'local' ? 'What can you help me do in this browser?' : action === 'example' ? examples[this.selectedExample].prompt : undefined);
    } catch {
      this.root.querySelector('.welcome-status')!.textContent = 'Could not save setup. Please try again.';
    } finally { buttons.forEach(button => button.disabled = false); }
  }
}
