import type { WebContents } from 'electron';
import type { PageSnapshot } from '../shared/types';
import { isBlockedHost } from './blockedHosts';
import { withTrustedInput, type ProtocolSend } from './trustedInput';
interface FrameTree {
  frame: { id: string; url: string; parentId?: string };
  childFrames?: FrameTree[];
}
interface FrameRef {
  frameId: string;
  url: string;
}
interface Point {
  x: number;
  y: number;
}

/** Child documents get their own isolated worlds and never reuse another frame's refs. */
export class FrameBridge {
  private refs = new WeakMap<WebContents, Map<string, FrameRef>>();
  private sessions = new WeakMap<ProtocolSend, Map<string, string>>();
  origin(wc: WebContents, ref: string): string | undefined {
    return this.refs.get(wc)?.get(ref)?.url;
  }
  constructor(private readonly source: () => string) {}
  private async session(
    send: ProtocolSend,
    frameId: string,
  ): Promise<{ executionContextId: number; sessionId?: string }> {
    const params = {
      frameId,
      worldName: 'nabsun-agent-frame-v1',
      grantUniveralAccess: false,
    };
    const sessions = this.sessions.get(send) ?? new Map<string, string>();
    this.sessions.set(send, sessions);
    const existing = sessions.get(frameId);
    if (existing)
      return {
        ...(await send('Page.createIsolatedWorld', params, existing)),
        sessionId: existing,
      };
    try {
      return await send('Page.createIsolatedWorld', params);
    } catch {
      // Cross-process frames have their own CDP session. Only a frame id from
      // this tab's tree or a previously issued ref can reach this path.
      const attached = await send('Target.attachToTarget', {
        targetId: frameId,
        flatten: true,
      });
      sessions.set(frameId, attached.sessionId);
      const world = await send(
        'Page.createIsolatedWorld',
        params,
        attached.sessionId,
      );
      return { ...world, sessionId: attached.sessionId };
    }
  }
  private async evaluate(
    send: ProtocolSend,
    frameId: string,
    expression: string,
  ): Promise<unknown> {
    const world = await this.session(send, frameId);
    const run = async (code: string) => {
      const result = await send(
        'Runtime.evaluate',
        {
          expression: code,
          contextId: world.executionContextId,
          returnByValue: true,
          timeout: 4000,
        },
        world.sessionId,
      );
      if (result.exceptionDetails)
        throw Error(
          result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text ||
            'Frame script failed',
        );
      return result.result?.value;
    };
    if (
      !(await run(
        'typeof window.__nabsunAgent !== "undefined" && window.__nabsunAgent.version === 1',
      ))
    )
      await run(this.source());
    return run(
      `(()=>{try{return {ok:true,value:${expression}}}catch(error){return {ok:false,error:String(error.message||error)}}})()`,
    );
  }
  private async owner(send: ProtocolSend, frameId: string, scroll = false) {
    const owner = await send('DOM.getFrameOwner', { frameId });
    if (scroll)
      await send('DOM.scrollIntoViewIfNeeded', {
        backendNodeId: owner.backendNodeId,
      });
    const model = (
      await send('DOM.getBoxModel', { backendNodeId: owner.backendNodeId })
    ).model as { content: number[]; width: number; height: number };
    const object = await send('DOM.resolveNode', {
      backendNodeId: owner.backendNodeId,
    });
    const visibility = await send('Runtime.callFunctionOn', {
      objectId: object.object.objectId,
      functionDeclaration:
        'function(){for(let node=this;node;node=node.parentElement){const style=getComputedStyle(node);if(style.display==="none"||style.visibility==="hidden"||style.visibility==="collapse"||Number(style.opacity)===0)return false}return true}',
      returnByValue: true,
    });
    return {
      ...model,
      backendNodeId: owner.backendNodeId,
      visible: visibility.result?.value === true,
    };
  }
  async route(
    wc: WebContents,
    expression: string,
    signal?: AbortSignal,
  ): Promise<{ handled: boolean; value?: unknown }> {
    const ref =
      /window\.__nabsunAgent\.\w+\(\s*\[?\s*["']([a-z0-9]+-\d+)["']/.exec(
        expression,
      )?.[1];
    const target = ref ? this.refs.get(wc)?.get(ref) : undefined;
    if (!target) return { handled: false };
    return withTrustedInput(wc, signal, async (send) => {
      const raw = (await this.evaluate(send, target.frameId, expression)) as {
        ok: boolean;
        value: any;
        error?: string;
      };
      if (!raw?.ok) throw Error(raw?.error || 'Frame returned no result');
      if (/\.(?:prepareInput|uploadTarget)\(/.test(expression)) {
        const box = await this.owner(send, target.frameId, true);
        const viewport = (await this.evaluate(
          send,
          target.frameId,
          '({width:innerWidth,height:innerHeight})',
        )) as { ok: boolean; value: { width: number; height: number } };
        if (!viewport.ok || !viewport.value.width || !viewport.value.height)
          throw Error('Frame viewport is unavailable.');
        const { x, y } = raw.value as Point,
          q = box.content;
        // Affine mapping supports bordered/scaled frame elements as well as offsets.
        raw.value.x =
          q[0] +
          (x / viewport.value.width) * (q[2] - q[0]) +
          (y / viewport.value.height) * (q[6] - q[0]);
        raw.value.y =
          q[1] +
          (x / viewport.value.width) * (q[3] - q[1]) +
          (y / viewport.value.height) * (q[7] - q[1]);
        // Verify the embedding iframe is actually hit, not a covering parent surface.
        const hit = await send('DOM.getNodeForLocation', {
          x: Math.round(raw.value.x),
          y: Math.round(raw.value.y),
          includeUserAgentShadowDOM: false,
        });
        if (
          !box.visible ||
          (hit.frameId &&
            hit.frameId !== target.frameId &&
            hit.backendNodeId !== box.backendNodeId)
        )
          throw Error(
            'The iframe target is covered or moved. No input was sent.',
          );
      }
      return { handled: true, value: raw.value };
    });
  }
  async append(
    wc: WebContents,
    main: PageSnapshot,
    maxChars: number,
    signal?: AbortSignal,
  ): Promise<PageSnapshot> {
    if (wc.mainFrame.framesInSubtree.length <= 1) return main;
    return withTrustedInput(wc, signal, async (send) => {
      const tree = (await send('Page.getFrameTree')).frameTree as FrameTree;
      const frames: FrameTree[] = [];
      const walk = (node: FrameTree) => {
        for (const child of node.childFrames ?? []) {
          frames.push(child);
          walk(child);
        }
      };
      walk(tree);
      // OOP iframe documents are omitted from the root Page tree. Their owner
      // nodes still belong to this tab; use those ids to avoid attaching targets
      // from unrelated tabs merely because their URL happens to match.
      const document = await send('DOM.getDocument', { depth: 0 });
      const owners = await send('DOM.querySelectorAll', {
        nodeId: document.root.nodeId,
        selector: 'iframe,frame',
      });
      const targets = (await send('Target.getTargets')).targetInfos as {
        targetId: string;
        url: string;
        type: string;
      }[];
      for (const nodeId of owners.nodeIds as number[]) {
        const node = (await send('DOM.describeNode', { nodeId, depth: 0 }))
          .node;
        if (
          !node.frameId ||
          frames.some((frame) => frame.frame.id === node.frameId)
        )
          continue;
        const target = targets.find(
          (target) =>
            target.targetId === node.frameId && target.type === 'iframe',
        );
        if (target)
          frames.push({
            frame: {
              id: node.frameId,
              url: target.url,
              parentId: tree.frame.id,
            },
          });
      }
      const candidates = frames
        .slice(0, 24)
        .filter(
          (frame) =>
            /^https?:/.test(frame.frame.url) && !isBlockedHost(frame.frame.url),
        );
      if (!candidates.length) return main;
      const available = Math.max(1000, Math.floor(maxChars / 2));
      const result = {
        ...main,
        text: main.text.slice(0, available),
        elements: [...main.elements],
        truncated: main.truncated || main.text.length > available,
      };
      const refs = this.refs.get(wc) ?? new Map<string, FrameRef>();
      this.refs.set(wc, refs);
      if (refs.size > 5000) refs.clear();
      const perFrame = Math.max(
        100,
        Math.floor((maxChars - result.text.length) / candidates.length) - 150,
      );
      for (const frame of candidates) {
        if (signal?.aborted) throw Error('Stopped while reading frames.');
        try {
          const box = await this.owner(send, frame.frame.id);
          if (!box.visible || box.width < 12 || box.height < 12) continue;
          const raw = (await this.evaluate(
            send,
            frame.frame.id,
            `window.__nabsunAgent.snapshot({maxChars:${perFrame}})`,
          )) as { ok: boolean; value: PageSnapshot; error?: string };
          if (!raw?.ok) throw Error(raw?.error || 'No frame snapshot');
          const snapshot = raw.value;
          for (const element of snapshot.elements) {
            refs.set(element.ref, {
              frameId: frame.frame.id,
              url: frame.frame.url,
            });
            result.elements.push({
              ...element,
              origin: new URL(frame.frame.url).origin,
            });
          }
          result.text +=
            `\n  Frame ${JSON.stringify(frame.frame.url)} (untrusted page data):\n` +
            snapshot.text
              .split('\n')
              .map((line) => '    ' + line)
              .join('\n');
          result.truncated ||= snapshot.truncated;
        } catch (error) {
          result.text += `\n  Frame ${JSON.stringify(frame.frame.url)} unavailable: ${String(error instanceof Error ? error.message : error).slice(0, 180)}`;
        }
      }
      result.text = result.text.slice(0, maxChars);
      return result;
    });
  }
}
