import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

// Runs a console program and hands its output over one line at a time. SteamCMD redraws progress
// with bare carriage returns, so \r ends a line as well as \n.
export function createProcessRunner() {
  return (command, args, { cwd, signal, onLine } = {}) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let settled = false;

      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(result);
      };

      // SteamCMD starts child processes of its own, so the whole tree is killed. If taskkill cannot
      // run, killing the direct child is the fallback.
      function abort() {
        if (child.pid) {
          const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.on('error', () => child.kill());
        }
        finish(abortError());
      }
      signal?.addEventListener('abort', abort, { once: true });

      // A decoder per stream keeps a multi-byte character that is split across two chunks intact.
      const streams = [child.stdout, child.stderr].map((stream) => ({
        stream,
        decoder: new StringDecoder('utf8'),
        tail: '',
      }));
      const emit = (text, entry) => {
        const parts = (entry.tail + text).split(/\r\n|\n|\r/);
        entry.tail = parts.pop();
        for (const line of parts) if (line) onLine?.(line);
      };
      for (const entry of streams) entry.stream.on('data', (chunk) => emit(entry.decoder.write(chunk), entry));

      child.once('error', (error) => finish(error));
      child.once('close', (code) => {
        for (const entry of streams) {
          emit(entry.decoder.end(), entry);
          if (entry.tail) onLine?.(entry.tail);
          entry.tail = '';
        }
        finish(null, { code });
      });
    });
}

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}
