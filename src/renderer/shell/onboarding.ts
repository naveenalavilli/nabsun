import type { Settings } from '../../shared/types';

export class OnboardingView {
  constructor(
    private root: HTMLElement,
    private finish: (next: Settings, destination: 'chat' | 'extensions', prompt?: string) => void,
  ) {}

  render() {
    this.root.innerHTML = `
      <div class="welcome-mark" aria-hidden="true">N</div>
      <p class="welcome-eyebrow">WELCOME TO NABSUN</p>
      <h1>Your browser.<br>A little more capable.</h1>
      <p class="welcome-intro">Read less. Find answers. Get things done with an assistant beside your tabs.</p>
      <div class="welcome-steps">
        <div><span>1</span><p><strong>Open a page</strong><br>Browse as usual. Your assistant stays beside you.</p></div>
        <div><span>2</span><p><strong>Ask for what you need</strong><br>Summarize a page, compare options, or walk through a task.</p></div>
        <div><span>3</span><p><strong>Stay in control</strong><br>Review requested actions before approving them. You can stop at any time.</p></div>
      </div>
      <button class="welcome-choice primary" data-action="local"><strong>Try the built-in assistant</strong><span>Runs on your device. No account needed.</span></button>
      <button class="welcome-choice" data-action="connect"><strong>Connect Codex or Claude</strong><span>Sign in through your browser. Nabsun handles setup.</span></button>
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
