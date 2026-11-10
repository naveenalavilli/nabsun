import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { ToolSpec } from '../../shared/types';

export interface BridgeDeps {
  listTools: () => ToolSpec[];
  /** Runs a tool through the same approval gate the in-app agent uses. */
  callTool: (name: string, args: Record<string, unknown>, clientId: string) => Promise<string>;
}
export interface TaskBridgeAccess {signal:AbortSignal;listTools:()=>ToolSpec[];callTool:(name:string,args:Record<string,unknown>)=>Promise<string>}

/**
 * A loopback control plane for the browser's tools.
 *
 * It exists so an *external* agent — the Claude Code or Codex CLI we spawn, or
 * the same extensions running in VS Code — can drive this browser through MCP.
 * The MCP server itself is a tiny stdio process (`bin/nabsun-mcp.mjs`)
 * that proxies here, because MCP clients spawn their servers and cannot reach
 * into a running Electron process directly.
 *
 * Security: bound to 127.0.0.1 only, on an ephemeral port, behind a bearer
 * token minted per launch. Every call still goes through ApprovalManager, so an
 * external agent has exactly the same permissions as the built-in one — it
 * cannot use this to bypass the approval gate.
 */
export class BrowserBridgeServer {
  readonly token = randomBytes(24).toString('hex');
  private server: Server | null = null;
  private boundPort = 0;
  private capabilities=new Map<string,{access:TaskBridgeAccess;expiresAt:number;revoke:()=>void}>();

  constructor(private readonly deps: BridgeDeps) {}
  /** Host-only capability; callers cannot acquire scope by choosing a client id. */
  issue(access:TaskBridgeAccess,ttlMs=300000){
    if(!this.running||access.signal.aborted)throw Error('The browser task bridge is not available.');
    if(!Number.isFinite(ttlMs))throw Error('Invalid task authorization lifetime.');
    if(this.capabilities.size>=100)throw Error('Too many delegated browser tasks.');
    const token=randomBytes(32).toString('hex');
    const lifetime=Math.min(1800000,Math.max(1000,ttlMs));
    const revoke=()=>{clearTimeout(timer);this.capabilities.delete(token);access.signal.removeEventListener('abort',revoke)};
    const timer=setTimeout(revoke,lifetime);timer.unref();
    this.capabilities.set(token,{access,expiresAt:Date.now()+lifetime,revoke});
    access.signal.addEventListener('abort',revoke,{once:true});return {token,revoke};
  }

  get port(): number {
    return this.boundPort;
  }

  get url(): string {
    return `http://127.0.0.1:${this.boundPort}`;
  }

  get running(): boolean {
    return this.boundPort !== 0;
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = createServer((req, res) => {
      const send = (status: number, body: unknown) => {
        if (res.destroyed || res.writableEnded) return;
        const payload = JSON.stringify(body);
        res.writeHead(status, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        });
        res.end(payload);
      };

      const auth = req.headers.authorization ?? '';
      const global=auth===`Bearer ${this.token}`,token=auth.startsWith('Bearer ')?auth.slice(7):'';
      const capability=global?undefined:this.capabilities.get(token);
      const valid=()=>global||!!capability&&this.capabilities.get(token)===capability&&!capability.access.signal.aborted&&capability.expiresAt>Date.now();
      if (!valid()) {
        capability?.revoke();
        send(401, { error: 'unauthorized' });
        return;
      }

      if (req.method === 'GET' && req.url === '/tools') {
        try {
          send(200, {
            tools: (capability?capability.access.listTools():this.deps.listTools()).map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              risk: t.risk,
            })),
          });
        } catch {
          send(500, { error: 'could not list browser tools' });
        }
        return;
      }

      if (req.method === 'POST' && req.url === '/call') {
        const chunks: Buffer[] = [];
        let bytes = 0;
        let oversized = false;
        req.on('error', () => { chunks.length = 0; });
        req.on('data', (chunk: Buffer) => {
          if (oversized) return;
          bytes += chunk.length;
          if (bytes > 4_000_000) {
            oversized = true;
            chunks.length = 0;
            send(413, { error: 'request body too large' });
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => {
          if (oversized) return;
          if(!valid()){send(401,{error:'task authorization expired'});return}
          let parsed: { name: string; arguments?: Record<string, unknown> };
          try {
            // Decode once: a TCP chunk can end in the middle of a UTF-8 character.
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!parsed || typeof parsed.name !== 'string' || !parsed.name.trim() ||
                (parsed.arguments !== undefined && (parsed.arguments === null ||
                  typeof parsed.arguments !== 'object' || Array.isArray(parsed.arguments)))) {
              throw new Error('invalid tool call');
            }
          } catch {
            send(400, { error: 'expected a tool name and an arguments object' });
            return;
          } finally {
            chunks.length = 0;
          }
          void (async () => {
            try {
              if(capability&&!capability.access.listTools().some(tool=>tool.name===parsed.name))throw Error('This tool is not available to the delegated task.');
              // Identifies the connected agent, so its tab selection survives
              // between calls without leaking into another client's run.
              const clientId = String(req.headers['x-nabsun-client'] ?? '').slice(0, 64) || 'anonymous';
              const result = capability?await capability.access.callTool(parsed.name,parsed.arguments??{}):await this.deps.callTool(parsed.name, parsed.arguments ?? {}, clientId);
              send(200, { content: result });
            } catch (err) {
              send(200, {
                isError: true,
                content: err instanceof Error ? err.message : String(err),
              });
            }
          })();
        });
        return;
      }

      send(404, { error: 'not found' });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        const address = this.server!.address();
        this.boundPort = typeof address === 'object' && address ? address.port : 0;
        console.log(`[bridge] listening on ${this.url}`);
        resolve();
      });
    });
  }

  stop() {
    for(const capability of [...this.capabilities.values()])capability.revoke();
    this.server?.close();
    this.server = null;
    this.boundPort = 0;
  }
}
