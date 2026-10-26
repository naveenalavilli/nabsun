import { spawn, type ChildProcess } from 'node:child_process';

/** CLI subprocesses include MCP servers, which must stop with their parent. */
export function stopProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { child.kill(); });
    killer.on('exit', code => { if (code !== 0) child.kill(); });
  } else {
    // CLI processes are spawned in their own process group.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}
