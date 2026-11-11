import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, ApprovalRequest, SessionToolGrant } from '../../shared/types';
import type { SettingsStore } from '../store';
import type { Tool } from './tools/types';
import {defaultPolicy,integrationPolicy,PolicyDeniedError,type PolicyProvider} from './policy';

type Emit = (req: ApprovalRequest) => void;
export type ApprovalMode='read-only'|'autopilot'|'task'|'site'|'session'|'user'|'denied';
interface ApprovalMetadata {folderLabel?:string;sessionId?:string;origin?:string;fileName?:string;target?:{role:string;name:string;value?:string;credential?:boolean};crossOriginSubmit?:boolean;onDecision?:(mode:ApprovalMode)=>void}

interface Pending {
  resolve: (decision: ApprovalDecision) => void;
}

/**
 * The permission gate between the model and anything that changes state.
 * Permissions are checked before every action. Explicit session grants live
 * only in memory and cannot bypass host policy or another chat/source boundary.
 */
export class ApprovalManager {
  private pending = new Map<string, Pending>();
  private emit: Emit = () => {};
  private sessionGrants = new Map<string, Map<string, SessionToolGrant>>();

  private sessionKey(toolName: string, source?: string) {
    return JSON.stringify([toolName, source ?? null]);
  }
  grantsForSession(sessionId: string): SessionToolGrant[] {
    return [...(this.sessionGrants.get(sessionId)?.values() ?? [])].map(grant => ({ ...grant }));
  }
  revokeSessionTool(sessionId: string, toolName: string, source?: string) {
    const grants = this.sessionGrants.get(sessionId);
    grants?.delete(this.sessionKey(toolName, source));
    if (!grants?.size) this.sessionGrants.delete(sessionId);
  }
  clearSession(sessionId: string) {
    this.sessionGrants.delete(sessionId);
  }
  private taskGrants = new WeakMap<AbortSignal, Set<string>>();
  private autopilotOrigin = new WeakMap<AbortSignal, string>();

  constructor(private readonly settings: SettingsStore,private readonly policy:PolicyProvider=defaultPolicy) {}

  checkPolicy(tool:Tool,input:Record<string,unknown>,origin?:string){
    const action={tool:tool.name,risk:tool.risk,origin,input,source:tool.source};
    const local=integrationPolicy(this.settings).evaluate(action);if(!local.allowed)throw new PolicyDeniedError('Blocked by policy: '+local.reason);
    const decision=this.policy.evaluate(action);
    if(!decision.allowed)throw new PolicyDeniedError('Blocked by policy: '+decision.reason);
    return decision;
  }

  setEmitter(emit: Emit) {
    this.emit = emit;
  }

  /** Resolves to true when the call may proceed. */
  async request(tool: Tool, input: Record<string, unknown>, signal: AbortSignal, metadata:ApprovalMetadata={}): Promise<boolean> {
    if (signal.aborted) return false;
    const allow=(mode:ApprovalMode)=>{metadata.onDecision?.(mode);return true};
    const settings = this.settings.get();
    let origin:string|undefined;
    try {const url=new URL(metadata.origin??'');if(['http:','https:'].includes(url.protocol))origin=url.origin}catch{/* Originless actions require individual approval. */}
    const policy=this.checkPolicy(tool,input,origin);
    const sessionId = metadata.sessionId;
    const sessionKey = this.sessionKey(tool.name, tool.source);
    const allowSession = !!sessionId && !policy.requirePrompt;
    if (allowSession && sessionId && this.sessionGrants.get(sessionId)?.has(sessionKey))
      return allow('session');
    const mustPrompt=policy.requirePrompt||metadata.crossOriginSubmit||['browser_upload','browser_evaluate'].includes(tool.name)||tool.name==='browser_press_key'&&(/^(?:enter|return)$/i.test(String(input.key))||/[\r\n]/.test(String(input.key)));
    const key=origin?tool.name+'|'+origin:undefined;
    if(!mustPrompt&&key&&this.taskGrants.get(signal)?.has(key))return allow('task');
    if(!mustPrompt&&origin&&settings.siteToolGrants?.some(grant=>grant.tool===tool.name&&grant.origin===origin&&grant.expiresAt>Date.now()))return allow('site');
    if(!mustPrompt&&tool.risk==='safe'&&settings.autoApprove.safe)return allow('read-only');
    if(!mustPrompt&&tool.risk==='write'&&settings.autoApprove.write&&origin){
      const bound=this.autopilotOrigin.get(signal);
      if(!bound){this.autopilotOrigin.set(signal,origin);return allow('autopilot')}
      if(bound===origin)return allow('autopilot');
    }

    const req: ApprovalRequest = {
      id: randomUUID(),
      toolName: tool.name,
      risk: tool.risk,
      title: tool.source==='local-files' ? describe(tool,input)+(metadata.folderLabel?' in '+metadata.folderLabel.replace(/[\x00-\x1f\x7f]/g,' '):'') : tool.name==='browser_upload'?`Upload ${JSON.stringify(metadata.fileName??'attached file')} to ${metadata.origin??'the page'}`:metadata.target?`${describe(tool,input)}: ${metadata.target.role} ${JSON.stringify(metadata.target.name)} on ${origin??'this page'}`:describe(tool, input),
      detail: metadata.target?`${metadata.target.credential?'Credential field: the assistant cannot type here.':metadata.target.value!==undefined?'Current value: '+metadata.target.value.slice(0,500):''}\n${metadata.crossOriginSubmit?'This form sends data to another origin.\n':''}${summarizeInput(input)}`:summarizeInput(input),
      input,
      origin,
      forceOnce:mustPrompt||!origin,
      sessionId,
      allowSession,
      source:tool.source,
    };

    const decision = await new Promise<ApprovalDecision>((resolve) => {
      const finish = (decision: ApprovalDecision) => {
        this.pending.delete(req.id);
        signal.removeEventListener('abort', onAbort);
        resolve(signal.aborted ? 'deny' : decision);
      };
      const onAbort = () => finish('deny');
      this.pending.set(req.id, { resolve: finish });
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        this.emit(req);
      } catch {
        finish('deny');
      }
    });

    if (signal.aborted) return false;
    if (decision === 'allow_session' && allowSession && sessionId) {
      const current = this.checkPolicy(tool, input, origin);
      if (current.requirePrompt) {
        metadata.onDecision?.('denied');
        return false;
      }
      const grants = this.sessionGrants.get(sessionId) ?? new Map<string, SessionToolGrant>();
      grants.set(sessionKey, { toolName: tool.name, source: tool.source });
      this.sessionGrants.set(sessionId, grants);
      return allow('user');
    }
    if (decision === 'allow_always' && !mustPrompt && key) {
      const grants=this.taskGrants.get(signal)??new Set<string>();grants.add(key);this.taskGrants.set(signal,grants);
      return allow('user');
    }
    if(decision==='allow_site'&&!mustPrompt&&origin){
      const current=this.settings.get().siteToolGrants??[];
      this.settings.save({siteToolGrants:[...current.filter(grant=>grant.expiresAt>Date.now()&&(grant.tool!==tool.name||grant.origin!==origin)),{tool:tool.name,origin,expiresAt:Date.now()+24*60*60*1000}].slice(-500)});
      return allow('user');
    }
    if(decision==='allow')return allow('user');
    metadata.onDecision?.('denied');return false;
  }

  resolve(id: string, decision: ApprovalDecision) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.resolve(decision);
  }

  /** Deny everything outstanding, e.g. when the window is closing. */
  denyAll() {
    for (const [, entry] of this.pending) entry.resolve('deny');
    this.pending.clear();
    this.sessionGrants.clear();
  }
}

function describe(tool: Tool, input: Record<string, unknown>): string {
  switch (tool.name) {
    case 'local_request_folder': return 'Choose a folder on your computer';
    case 'local_word_create': return 'Create Word document '+JSON.stringify(String(input.path??''));
    case 'local_word_edit': return 'Edit Word document '+JSON.stringify(String(input.path??''));
    case 'local_excel_create': return 'Create Excel workbook '+JSON.stringify(String(input.path??''));
    case 'local_excel_edit': return 'Update Excel cells in '+JSON.stringify(String(input.path??''));
    case 'local_write': return 'Save local file '+JSON.stringify(String(input.path??''));
    case 'local_edit': return 'Edit local file '+JSON.stringify(String(input.path??''));
    case 'local_append': return 'Add text to local file '+JSON.stringify(String(input.path??''));
    case 'local_trash': return 'Move local file '+JSON.stringify(String(input.path??''))+' to Recycle Bin/Trash';
    case 'local_mkdir': return 'Create local folder '+JSON.stringify(String(input.path??''));
    case 'local_copy': return 'Copy local file '+JSON.stringify(String(input.from??''))+' to '+JSON.stringify(String(input.to??''));
    case 'local_move': return 'Move local file '+JSON.stringify(String(input.from??''))+' to '+JSON.stringify(String(input.to??''));
    case 'browser_navigate':
      return `Navigate to ${String(input.url ?? '')}`;
    case 'browser_click':
      return 'Click an element on the page';
    case 'browser_type':
      return `Type into the page${input.submit ? ' and submit' : ''}`;
    case 'browser_evaluate':
      return 'Run JavaScript in the page';
    case 'tab_open':
      return `Open a tab${input.url ? ` at ${String(input.url)}` : ''}`;
    case 'tab_close':
      return 'Close a tab';
    default:
      return `Run ${tool.name}`;
  }
}

function summarizeInput(input: Record<string, unknown>): string {
  const json = JSON.stringify(input, null, 2);
  return json.length > 1200 ? `${json.slice(0, 1200)}\n…` : json;
}
