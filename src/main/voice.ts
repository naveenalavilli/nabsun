import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { stopCliProcess } from './integrations/nativeCli';
import type {
  VoiceAvailability,
  VoiceEvent,
  VoiceLanguage,
} from '../shared/voice';

const initialization = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
`;
const recognition =
  initialization +
  String.raw`
$engine=$null
try {
  $culture=[Globalization.CultureInfo]::GetCultureInfo($env:NABSUN_DICTATION_LANGUAGE)
  $engine=New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture)
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $engine.InitialSilenceTimeout=[TimeSpan]::FromSeconds(6)
  $engine.BabbleTimeout=[TimeSpan]::FromSeconds(6)
  $engine.EndSilenceTimeout=[TimeSpan]::FromMilliseconds(650)
  $engine.SetInputToDefaultAudioDevice()
  [Console]::WriteLine('{"type":"listening"}')
  $deadline=[DateTime]::UtcNow.AddSeconds(60)
  while([DateTime]::UtcNow -lt $deadline) {
    $result=$engine.Recognize([TimeSpan]::FromSeconds(6))
    if($null -ne $result -and $result.Text.Length -gt 0) {
      [Console]::WriteLine((@{type='text';text=$result.Text}|ConvertTo-Json -Compress))
    }
  }
} catch { [Console]::WriteLine('{"type":"error"}') }
finally { if($null -ne $engine){$engine.Dispose()} }
`;

function powershell(script: string, language?: string): ChildProcess {
  const executable = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
  ])
    if (process.env[key]) env[key] = process.env[key];
  if (language) env.NABSUN_DICTATION_LANGUAGE = language;
  return spawn(
    executable,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env },
  );
}

export interface VoiceBackend {
  availability(): Promise<VoiceAvailability>;
  listen(
    language: string,
    emit: (event: Pick<VoiceEvent, 'type' | 'text'>) => void,
  ): () => void;
}
export class WindowsVoiceBackend implements VoiceBackend {
  private cached?: Promise<VoiceAvailability>;
  availability(): Promise<VoiceAvailability> {
    if (process.platform !== 'win32')
      return Promise.resolve({
        available: false,
        languages: [],
        help:
          process.platform === 'darwin'
            ? 'Click the message box, then press your Mac microphone key or Dictation shortcut. Enable Dictation and choose languages in System Settings > Keyboard.'
            : 'Use your system dictation tool with the message box focused. Built-in microphone dictation is currently available on Windows.',
      });
    return (this.cached ??= new Promise((resolve) => {
      const child = powershell(
        initialization +
          String.raw`[Console]::WriteLine((@([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object { @{code=$_.Culture.Name;name=$_.Culture.DisplayName} }) | ConvertTo-Json -Compress))`,
      );
      let output = '',
        done = false;
      const finish = (languages: VoiceLanguage[] = []) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        stopCliProcess(child);
        resolve({
          available: languages.length > 0,
          languages,
          help: languages.length
            ? 'Speech stays on this computer. Review the words before sending. Language choices depend on Windows speech packs.'
            : 'Windows speech recognition is unavailable. Click the message box and press Windows+H for system voice typing. Check microphone access and speech languages in Windows Settings.',
        });
      };
      const timer = setTimeout(() => finish(), 6000);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        output += chunk;
        if (output.length > 16000) finish();
      });
      child.stderr?.resume();
      child.once('error', () => finish());
      child.once('close', () => {
        try {
          const parsed: unknown = JSON.parse(output.replace(/^\uFEFF/, ''));
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          finish(
            rows
              .filter(
                (row): row is VoiceLanguage =>
                  !!row &&
                  typeof row === 'object' &&
                  typeof row.code === 'string' &&
                  /^[a-zA-Z-]{2,30}$/.test(row.code) &&
                  typeof row.name === 'string',
              )
              .slice(0, 50),
          );
        } catch {
          finish();
        }
      });
    }));
  }
  listen(
    language: string,
    emit: (event: Pick<VoiceEvent, 'type' | 'text'>) => void,
  ) {
    const child = powershell(recognition, language);
    let buffer = '',
      done = false,
      total = 0;
    const stop = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopCliProcess(child);
      emit({ type: 'ended' });
    };
    const timer = setTimeout(stop, 65000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (done) return;
      total += chunk.length;
      buffer += chunk;
      if (total > 64000 || buffer.length > 16000) {
        emit({
          type: 'error',
          text: 'Dictation reached its text limit. Please review your draft.',
        });
        stop();
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const event = JSON.parse(line.replace(/^\uFEFF/, ''));
          if (event.type === 'listening') emit({ type: 'listening' });
          else if (
            event.type === 'text' &&
            typeof event.text === 'string' &&
            event.text.length <= 8000
          )
            emit({ type: 'text', text: event.text });
          else if (event.type === 'error') {
            emit({
              type: 'error',
              text: 'Could not use the microphone. Check Windows microphone access, your default input device and the selected speech language. You can also click the message box and press Windows+H.',
            });
            stop();
            break;
          }
        } catch {
          /* Ignore non-protocol startup output. */
        }
      }
    });
    child.stderr?.resume();
    child.once('error', () => {
      if (!done)
        emit({
          type: 'error',
          text: 'Could not start Windows dictation. Click the message box and press Windows+H.',
        });
      stop();
    });
    child.once('close', stop);
    return stop;
  }
}

/** One microphone lease, owned by the exact UI and chat that requested it. */
export class VoiceManager {
  private active?: {
    owner: number;
    sessionId: string;
    requestId: string;
    stop?: () => void;
    emit: (event: VoiceEvent) => void;
  };
  constructor(private backend: VoiceBackend = new WindowsVoiceBackend()) {}
  availability() {
    return this.backend.availability();
  }
  async start(
    owner: number,
    sessionId: string,
    requestId: string,
    language: string,
    emit: (event: VoiceEvent) => void,
    consent: () => Promise<boolean>,
  ) {
    if (this.active)
      throw Error('Dictation is already starting or listening. Stop it first.');
    if (!/^[a-f0-9-]{36}$/i.test(requestId))
      throw Error('Invalid dictation request.');
    const active = {
      owner,
      sessionId,
      requestId,
      emit,
      stop: undefined as (() => void) | undefined,
    };
    this.active = active;
    try {
      const availability = await this.availability();
      if (!availability.available) throw Error(availability.help);
      if (!availability.languages.some((item) => item.code === language))
        throw Error('Choose one of the installed speech languages.');
      if (this.active !== active) return;
      const allowed = await consent();
      if (this.active !== active) return;
      if (!allowed) {
        this.stop(owner, requestId);
        return;
      }
      active.stop = this.backend.listen(language, (event) => {
        if (this.active !== active) return;
        if (event.type === 'ended') this.active = undefined;
        emit({ ...event, sessionId, requestId });
      });
    } catch (error) {
      if (this.active === active) this.stop(owner, requestId);
      throw error;
    }
  }
  stop(owner?: number, requestId?: string) {
    const active = this.active;
    if (
      !active ||
      (owner !== undefined && active.owner !== owner) ||
      (requestId !== undefined && active.requestId !== requestId)
    )
      return;
    this.active = undefined;
    active.stop?.();
    active.emit({
      type: 'ended',
      sessionId: active.sessionId,
      requestId: active.requestId,
    });
  }
  stopSession(sessionId: string) {
    if (this.active?.sessionId === sessionId) this.stop();
  }
}
