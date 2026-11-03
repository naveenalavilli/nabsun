import type { Settings } from '../../shared/types';

export class OnboardingView {
  constructor(
    private root: HTMLElement,
    private finish: (next: Settings, destination: 'chat' | 'extensions' | 'browse', prompt?: string) => void,
  ) {}

  render() {
    this.root.innerHTML = `
      <div class="welcome-heading"><div class="welcome-mark" aria-hidden="true">N</div><span>Your first few minutes</span></div>
      <p class="welcome-eyebrow">WELCOME TO NABSUN</p>
      <h1>A familiar browser.<br>A helpful new way to work.</h1>
      <p class="welcome-intro">Browse the web as usual. When you want a little help, ask Nabsun to explain or summarize the page you are reading.</p>
      <div class="welcome-start"><p class="welcome-recommended">Recommended for your first visit</p><button class="welcome-choice primary" data-action="local"><strong>Start with the built-in assistant</strong><span>No account or setup needed. Best for short questions. Your first reply may take a little time.</span></button><p class="hint">We will prepare a question for you. You can change it before pressing Send.</p><button class="welcome-skip" data-action="skip">Just browse for now</button></div>
      <details class="welcome-optional"><summary>Already use Codex or Claude?</summary><p>You can connect an existing account for more demanding tasks. You can also do this later in Settings.</p><button class="welcome-choice" data-action="connect"><strong>Connect an existing account</strong><span>Nabsun guides you through setup and sign-in. Your account may require a paid plan.</span></button></details>
      <div class="welcome-illustration" role="img" aria-label="Illustration: an open webpage beside an assistant, with an approval step before an action">
        <div class="tour-browser"><div class="tour-chrome"><i></i><i></i><i></i><span> Your open page</span></div><div class="tour-page"><span class="tour-tag">THE PAGE YOU ARE READING</span><strong>An article worth exploring</strong><div class="tour-line"></div><div class="tour-line short"></div><div class="tour-picture"><svg viewBox="0 0 180 70" aria-hidden="true"><path d="M0 60 L40 25 L75 48 L120 10 L180 60" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="120" cy="10" r="5" fill="currentColor"/></svg></div><div class="tour-line"></div></div></div>
        <div class="tour-assistant"><span class="tour-tag">YOUR ASSISTANT</span><div class="tour-question">What are the key points?</div><div class="tour-answer">Read the page. Find the details.<br>Keep the useful context.</div><div class="tour-approval"><span class="tour-check" aria-hidden="true">✓</span><span><strong>You decide</strong><br>Review actions before approving</span></div></div>
      </div>
      <div class="welcome-steps">
        <div><span>1</span><p><strong>Open a website</strong><br>Use the address bar to search or enter a website address.</p></div>
        <div><span>2</span><p><strong>Ask about the page</strong><br>Click Ask about page, type a question, then press Send.</p></div>
        <div><span>3</span><p><strong>You are in control</strong><br>Review requested actions before approving them. Press Stop to cancel the current task.</p></div>
      </div>
      <p class="hint">The built-in assistant answers on your computer. If you connect an online service, your messages and any included page text are shared with that service. Websites still use the internet as usual.</p>
      <p class="hint">You can reopen this guide from Settings → Getting started, or choose a different assistant in Settings → Assistant choice.</p>
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
      this.finish(next, action === 'connect' ? 'extensions' : action === 'skip' ? 'browse' : 'chat',
        action === 'local' ? 'What can you help me do in this browser?' : undefined);
    } catch {
      this.root.querySelector('.welcome-status')!.textContent = 'Could not save setup. Please try again.';
    } finally { buttons.forEach(b => b.disabled = false); }
  }
}
