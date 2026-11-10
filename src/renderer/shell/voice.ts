import type { VoiceAvailability, VoiceEvent } from '../../shared/voice';

/** Dictation changes only the current draft; it never submits a prompt. */
export class VoiceInput {
  private requestId: string | null = null;
  private generation = 0;
  private availability?: VoiceAvailability;
  private button = document.querySelector<HTMLButtonElement>('#voice-toggle')!;
  private panel = document.querySelector<HTMLElement>('#voice-controls')!;
  private status = document.querySelector<HTMLElement>('#voice-status')!;
  private languages =
    document.querySelector<HTMLSelectElement>('#voice-language')!;
  constructor(
    private prompt: HTMLTextAreaElement,
    private session: () => string | null,
  ) {
    this.button.addEventListener('click', () => {
      void this.toggle();
    });
    document.querySelector('#voice-close')!.addEventListener('click', () => {
      this.stop();
      this.button.focus();
    });
    window.nabsun.voice.onEvent((event) => this.receive(event));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stop();
    });
    window.addEventListener('pagehide', () => this.stop());
    const chat = document.querySelector('#view-chat');
    if (chat)
      new MutationObserver(() => {
        if (!chat.classList.contains('active') || chat.hasAttribute('hidden'))
          this.stop();
      }).observe(chat, {
        attributes: true,
        attributeFilter: ['class', 'hidden'],
      });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.panel.hidden) {
        this.stop();
        this.button.focus();
        event.preventDefault();
      }
    });
  }
  stop() {
    this.generation++;
    const id = this.requestId;
    this.requestId = null;
    if (id) window.nabsun.voice.stop(id);
    this.panel.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    this.render(false);
    if (id)
      this.status.textContent =
        'Dictation stopped. Review your draft before sending.';
  }
  private render(active: boolean) {
    this.button.setAttribute('aria-pressed', String(active));
    this.button.setAttribute(
      'aria-label',
      active ? 'Stop dictation' : 'Dictate a message',
    );
    this.button.title = active
      ? 'Stop dictation (Escape)'
      : 'Dictate a message';
    this.languages.disabled = active;
  }
  private async toggle() {
    if (!this.panel.hidden) {
      this.stop();
      return;
    }
    const sessionId = this.session();
    if (!sessionId) return;
    this.panel.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    const generation = ++this.generation;
    this.status.textContent = 'Checking dictation availability...';
    try {
      const availability = (this.availability ??=
        await window.nabsun.voice.availability());
      if (generation !== this.generation) return;
      if (this.session() !== sessionId) {
        this.stop();
        return;
      }
      if (!this.languages.options.length) {
        for (const language of availability.languages) {
          const option = document.createElement('option');
          option.value = language.code;
          option.textContent = language.name;
          this.languages.append(option);
        }
        const preferred =
          availability.languages.find(
            (language) => language.code === navigator.language,
          ) ??
          availability.languages.find(
            (language) =>
              language.code.split('-')[0] === navigator.language.split('-')[0],
          );
        if (preferred) this.languages.value = preferred.code;
      }
      this.languages.parentElement!.hidden = !availability.available;
      this.status.textContent = availability.help;
      if (!availability.available) {
        this.prompt.focus();
        return;
      }
      const requestId = crypto.randomUUID();
      this.requestId = requestId;
      this.render(true);
      this.status.textContent = 'Waiting for microphone approval...';
      await window.nabsun.voice.start(
        sessionId,
        requestId,
        this.languages.value,
      );
    } catch (error) {
      if (generation !== this.generation) return;
      const id = this.requestId;
      this.requestId = null;
      if (id) window.nabsun.voice.stop(id);
      this.render(false);
      this.status.textContent =
        error instanceof Error
          ? error.message
          : 'Dictation is unavailable. You can continue typing.';
    }
  }
  private receive(event: VoiceEvent) {
    if (
      event.requestId !== this.requestId ||
      event.sessionId !== this.session()
    )
      return;
    if (event.type === 'listening') {
      this.status.textContent =
        'Listening — speak naturally. Click the microphone again to stop. Nothing sends automatically.';
      this.prompt.focus();
    } else if (event.type === 'text' && event.text) {
      const separator =
        this.prompt.value && !/\s$/.test(this.prompt.value) ? ' ' : '';
      this.prompt.value += separator + event.text;
      this.prompt.dispatchEvent(new Event('input', { bubbles: true }));
      this.status.textContent =
        'Listening — words added to your draft. Review them before sending.';
    } else if (event.type === 'error') {
      this.status.textContent =
        event.text ?? 'Dictation failed. Your draft is safe.';
    } else if (event.type === 'ended') {
      this.requestId = null;
      this.render(false);
      if (!this.status.textContent?.includes('Could not'))
        this.status.textContent =
          'Dictation stopped. Review your draft before sending.';
    }
  }
}
