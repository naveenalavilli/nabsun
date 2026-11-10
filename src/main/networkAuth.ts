import {
  app,
  BrowserWindow,
  BaseWindow,
  WebContentsView,
  dialog,
  safeStorage,
  type Session,
  type WebContents,
  type AuthInfo,
} from 'electron';
import { randomUUID, createHash } from 'node:crypto';
import { JsonStore, secureStorageUsable } from './store';

interface Answer {
  username: string;
  password: string;
  save: boolean;
}
interface Challenge {
  url: string;
  host: string;
  port: number;
  realm: string;
  scheme: string;
  proxy: boolean;
  canSave: boolean;
  saved?: Answer;
}
export type AuthPrompt = (
  challenge: Challenge,
  owner: WebContents,
) => Promise<Answer | null>;
interface AuthVault {
  entries: Record<string, { username: string; encrypted: string }>;
}

const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><title>Website sign-in</title><style>:root{color-scheme:light dark;font:15px system-ui}body{margin:28px;background:Canvas;color:CanvasText}h1{font-size:23px}p{overflow-wrap:anywhere;line-height:1.5}label{display:block;margin-top:16px}input:not([type=checkbox]){display:block;box-sizing:border-box;width:100%;padding:11px;margin-top:7px;border:1px solid #8888;border-radius:8px;font:inherit}button{font:inherit;padding:10px 18px;border:1px solid #8888;border-radius:8px;cursor:pointer}.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:24px}#confirm{background:#ff763c;color:#181818}small{opacity:.75}</style><h1>Sign in to this website</h1><p id="destination"></p><small id="context"></small><form><label>Username<input id="username" autocomplete="username" maxlength="1000" required></label><label>Password<input id="password" type="password" autocomplete="current-password" maxlength="10000"></label><label><input id="save" type="checkbox"> Save securely on this computer</label><div class="actions"><button type="button" id="cancel">Cancel</button><button id="confirm" type="submit">Sign in</button></div></form>`;

/** A separate sandboxed native-owned window; it never joins the agent's tabs. */
export const nativeAuthPrompt: AuthPrompt = async (challenge, owner) => {
  const parent =
    BrowserWindow.fromWebContents(owner) ??
    BaseWindow.getAllWindows().find((candidate) =>
      candidate.contentView.children.some(
        (view) => view instanceof WebContentsView && view.webContents === owner,
      ),
    );
  const window = new BrowserWindow({
    parent,
    modal: !!parent,
    width: 490,
    height: 490,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'network-auth-' + randomUUID(),
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  const cancel = () => {
    if (!window.isDestroyed()) window.close();
  };
  owner.once('destroyed', cancel);
  owner.on('did-start-navigation', cancel);
  let timer: NodeJS.Timeout | undefined;
  const closed = new Promise<null>((resolve) => {
    window.once('closed', () => resolve(null));
    timer = setTimeout(() => {
      if (!window.isDestroyed()) window.close();
    }, 300000);
  });
  try {
    await window.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(html),
    );
    if (owner.isDestroyed()) return null;
    const answer = window.webContents.executeJavaScript(`(()=>{
    const info=${JSON.stringify(challenge)};
    document.querySelector('#destination').textContent=info.proxy?'Proxy: '+info.host+':'+info.port:info.url;
    document.querySelector('#context').textContent=info.scheme.toUpperCase()+(info.realm?' · '+info.realm:'')+'. Only you can enter credentials; the assistant cannot see this dialog.';
    document.querySelector('#save').disabled=!info.canSave;
    if(info.saved){document.querySelector('#username').value=info.saved.username;document.querySelector('#password').value=info.saved.password}
    document.querySelector('#username').focus();
    return new Promise(resolve=>{
      document.querySelector('#cancel').onclick=()=>resolve(null);
      document.querySelector('form').onsubmit=event=>{event.preventDefault();resolve({username:document.querySelector('#username').value,password:document.querySelector('#password').value,save:document.querySelector('#save').checked})};
    });
  })()`);
    window.show();
    return (await Promise.race([answer, closed])) as Answer | null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    owner.removeListener('destroyed', cancel);
    owner.removeListener('did-start-navigation', cancel);
    if (!window.isDestroyed()) window.destroy();
  }
};

export class NetworkAuth {
  private vault = new JsonStore<AuthVault>('network-auth.json', {
    entries: {},
  });
  private pending = new Set<number>();
  constructor(
    private session: Session,
    private prompt: AuthPrompt = nativeAuthPrompt,
  ) {}
  async answer(
    wc: WebContents,
    requestUrl: string,
    info: AuthInfo,
  ): Promise<Answer | null> {
    if (
      wc.isDestroyed() ||
      wc.session !== this.session ||
      this.pending.has(wc.id)
    )
      return null;
    let origin: string;
    try {
      const url = new URL(requestUrl);
      if (!['https:', 'http:'].includes(url.protocol)) return null;
      origin = url.origin;
    } catch {
      return null;
    }
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          info.isProxy,
          origin,
          info.host,
          info.port,
          info.realm,
          info.scheme,
        ]),
      )
      .digest('hex');
    let navigated = false;
    const onNavigate = (
      _event: Electron.Event,
      _url: string,
      _inPlace: boolean,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame) navigated = true;
    };
    wc.on('did-start-navigation', onNavigate);
    this.pending.add(wc.id);
    try {
      let saved: Answer | undefined;
      const entry = this.vault.get().entries[key];
      if (entry && secureStorageUsable()) {
        try {
          saved = {
            username: entry.username,
            password: safeStorage.decryptString(
              Buffer.from(entry.encrypted, 'base64'),
            ),
            save: false,
          };
        } catch {
          /* Corrupt saved entry is never sent. */
        }
      }
      const answer = await this.prompt(
        {
          url: origin,
          host: info.host,
          port: info.port,
          realm: info.realm,
          scheme: info.scheme,
          proxy: info.isProxy,
          canSave: secureStorageUsable(),
          saved,
        },
        wc,
      );
      if (
        !answer ||
        wc.isDestroyed() ||
        navigated ||
        typeof answer.username !== 'string' ||
        typeof answer.password !== 'string' ||
        answer.username.length > 1000 ||
        answer.password.length > 10000
      )
        return null;
      if (answer.save && secureStorageUsable())
        this.vault.commit({
          entries: {
            ...this.vault.get().entries,
            [key]: {
              username: answer.username,
              encrypted: safeStorage
                .encryptString(answer.password)
                .toString('base64'),
            },
          },
        });
      return answer;
    } finally {
      wc.removeListener('did-start-navigation', onNavigate);
      this.pending.delete(wc.id);
    }
  }
  install() {
    app.on('login', (event, wc, details, info, callback) => {
      if (!wc || wc.session !== this.session) return;
      event.preventDefault();
      const respond = (answer: Answer | null) => {
        try {
          if (answer) callback(answer.username, answer.password);
          else callback();
        } catch {
          /* The challenged request may have closed while the user was answering. */
        }
      };
      void this.answer(wc, details.url, info).then(respond, () =>
        respond(null),
      );
    });
    app.on(
      'select-client-certificate',
      (event, wc, url, certificates, callback) => {
        if (!wc || wc.session !== this.session) return;
        event.preventDefault();
        if (this.pending.has(wc.id)) {
          callback();
          return;
        }
        this.pending.add(wc.id);
        let navigated = false;
        const onNavigate = () => {
          navigated = true;
        };
        wc.on('did-start-navigation', onNavigate);
        const choices = certificates.slice(0, 20);
        let origin: string;
        try {
          origin = new URL(url).origin;
        } catch {
          origin = 'this website';
        }
        const respond = (certificate?: Electron.Certificate) => {
          try {
            callback(certificate);
          } catch {
            /* Closed request. */
          }
        };
        void dialog
          .showMessageBox({
            type: 'question',
            title: 'Choose a client certificate',
            message: `${origin} requests a certificate to identify you.`,
            detail: choices
              .map(
                (certificate, index) =>
                  `${index + 1}. ${certificate.subjectName}\nIssued by ${certificate.issuerName}\nExpires ${certificate.validExpiry}`,
              )
              .join('\n\n'),
            buttons: [
              'Cancel',
              ...choices.map(
                (certificate, index) =>
                  `${index + 1}. ${certificate.subjectName.slice(0, 80)}`,
              ),
            ],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          })
          .then(
            (result) => {
              const chosen =
                !navigated && !wc.isDestroyed()
                  ? choices[result.response - 1]
                  : undefined;
              respond(chosen);
            },
            () => respond(),
          )
          .finally(() => {
            wc.removeListener('did-start-navigation', onNavigate);
            this.pending.delete(wc.id);
          });
      },
    );
  }
}
