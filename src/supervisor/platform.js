import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeCimDate } from './ownership.js';
const execFile = promisify(execFileCallback);

export function parseProcessJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Could not parse process listing');
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.filter(Boolean).map((row) => ({
    pid: Number(row.ProcessId),
    exePath: row.ExecutablePath ?? null,
    commandLine: row.CommandLine ?? '',
    startedAt: normalizeCimDate(row.CreationDate),
  }));
}

// pwshPath exists because a Windows service does not see the user's PATH. On a machine where PowerShell
// 7 comes from the Store, only a full path to pwsh.exe reaches it.
export function createWindowsPlatform({ pwshPath = 'pwsh' } = {}) {
  async function query(filter) {
    const script = `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress`;
    const { stdout } = await execFile(pwshPath, ['-NoProfile', '-Command', script], {
      windowsHide: true,
      timeout: 20000,
    });
    return stdout.trim() ? parseProcessJson(stdout) : [];
  }
  return {
    listServerProcesses: () => query("Name='ArkAscendedServer.exe'"),
    processInfo: async (pid) => (await query(`ProcessId=${Number(pid)}`))[0] ?? null,
    spawnServer: ({ exePath, cwd, args }) =>
      new Promise((resolve, reject) => {
        const child = spawn(exePath, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve({ pid: child.pid });
        });
      }),
    killPid: async (pid) => execFile('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true }),
  };
}
