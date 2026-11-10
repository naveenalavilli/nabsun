export interface VoiceLanguage {
  code: string;
  name: string;
}
export interface VoiceAvailability {
  available: boolean;
  languages: VoiceLanguage[];
  help: string;
}
export interface VoiceEvent {
  requestId: string;
  sessionId: string;
  type: 'listening' | 'text' | 'error' | 'ended';
  text?: string;
}
