import type { Settings } from '../../shared/types';

export class OnboardingView {
  constructor(
    private root: HTMLElement,
    private finish: (next: Settings, destination: 'chat' | 'extensions', prompt?: string) => void,
  ) {}

  render() {
    this.root.innerHTML = `
      <div class="welcome-heading"><div class="welcome-mark" aria-hidden="true">N</div><span>Your first few minutes</span></div>
      <p class="welcome-eyebrow">WELCOME TO NABSUN</p>
      <h1>A familiar browser.<br>A helpful new way to work.</h1>
      <p class="welcome-intro">Start with one page and one question. Here is how Nabsun brings your browser and assistant together.</p>
      <h2 class="welcome-path-heading">Choose your starting point</h2>
      <div class="welcome-paths"><button class="welcome-choice primary" data-action="local"><strong>Try the built-in assistant</strong><span>Start simple. Runs on your device, with no account or API key. Best for short tasks.</span></button>
      <button class="welcome-choice" data-action="connect"><strong>Connect Codex or Claude</strong><span>For more demanding tasks. Nabsun guides installation and sign-in; provider access is required.</span></button></div>
      <div class="welcome-illustration" role="img" aria-label="Illustration: an open webpage beside an assistant, with an approval step before an action">
        <div class="tour-browser"><div class="tour-chrome"><i></i><i></i><i></i><span> Your open page</span></div><div class="tour-page"><span class="tour-tag">YOUR CONTEXT</span><strong>An article worth exploring</strong><div class="tour-line"></div><div class="tour-line short"></div><div class="tour-picture"><svg viewBox="0 0 180 70" aria-hidden="true"><path d="M0 60 L40 25 L75 48 L120 10 L180 60" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="120" cy="10" r="5" fill="currentColor"/></svg></div><div class="tour-line"></div></div></div>
        <div class="tour-assistant"><span class="tour-tag">YOUR ASSISTANT</span><div class="tour-question">What are the key points?</div><div class="tour-answer">Read the page. Find the details.<br>Keep the useful context.</div><div class="tour-approval"><span class="tour-check" aria-hidden="true">✓</span><span><strong>You decide</strong><br>Review actions before approving</span></div></div>
      </div>
      <div class="welcome-steps">
        <div><span>1</span><p><strong>Open a page</strong><br>Browse as usual. Your assistant stays beside you.</p></div>
        <div><span>2</span><p><strong>Ask for what you need</strong><br>Summarize a page, compare options, or walk through a task.</p></div>
        <div><span>3</span><p><strong>Stay in control</strong><br>Review requested actions before approving them. You can stop at any time.</p></div>
      </div>
      <p class="hint">With a connected provider, your messages and any included page content go to that provider. Switch models in Settings → Model.</p>
      <button class="welcome-skip" data-action="skip">Just browse for now</button>
      <p class="hint">You can reopen this guide from Settings.</p>
      <p class="welcome-status" role="status"></p>`;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-action]')) {
      button.addEventListener('click', () => void this.complete(button.dataset.action!));
    }
  }

  private async complete(action: string) {
    const buttons = this.root.querySelectorAll<HTMLButtonElement>('button');
    buttons.forEach(b => b.disabled = true);
    try {
      const next = await window.nabsun.settings.set({
        onboardingCompleted: true,
        ...(action === 'local' ? { provider: 'local' as const } : {}),
      });
      this.finish(next, action === 'connect' ? 'extensions' : 'chat',
        action === 'local' ? 'What can you help me do in this browser?' : undefined);
    } catch {
      this.root.querySelector('.welcome-status')!.textContent = 'Could not save setup. Please try again.';
    } finally { buttons.forEach(b => b.disabled = false); }
  }
}
