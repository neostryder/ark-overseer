import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeCimDate } from './ownership.js';
import { buildWindowsCommandLine } from './launch.js';
const execFile = promisify(execFileCallback);

// Verbatim arguments turn off Node's quoting for the whole command line, including the program
// name at its start, so the program name is quoted here for an install path with spaces.
export function serverSpawnArgs({ exePath, cwd, args }) {
  return [
    exePath,
    [buildWindowsCommandLine(args)],
    {
      cwd,
      argv0: `"${exePath}"`,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    },
  ];
}

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

export function parseAllProcessJson(stdout) {
  if (!String(stdout).trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Could not parse process listing');
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map((row) => ({
    pid: Number(row.ProcessId),
    name: String(row.Name ?? ''),
    parentPid: Number(row.ParentProcessId),
  }));
}

// pwshPath exists because a Windows service does not see the user's PATH. On a machine where PowerShell
// 7 comes from the Store, only a full path to pwsh.exe reaches it.
export function createWindowsPlatform({ pwshPath = 'pwsh', exec = execFile } = {}) {
  async function query(filter) {
    const script = `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress`;
    const { stdout } = await exec(pwshPath, ['-NoProfile', '-Command', script], {
      windowsHide: true,
      timeout: 20000,
    });
    return stdout.trim() ? parseProcessJson(stdout) : [];
  }
  async function listAllProcesses() {
    const script =
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress';
    const { stdout } = await exec(pwshPath, ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 20000 });
    return parseAllProcessJson(stdout);
  }
  async function setProcessPolicy(pid, { priority, affinityMask }) {
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid process id');
    if (!['Idle', 'BelowNormal', 'Normal'].includes(priority)) throw new Error('Invalid priority');
    if (typeof affinityMask !== 'string' || !/^\d+$/.test(affinityMask)) throw new Error('Invalid affinity mask');
    // ProcessorAffinity takes a signed 64-bit value, so a mask with the top bit set wraps to negative.
    let value = BigInt(affinityMask);
    if (value >= 1n << 64n) throw new Error('Invalid affinity mask');
    if (value >= 1n << 63n) value -= 1n << 64n;
    const script = `$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.PriorityClass = '${priority}'; $p.ProcessorAffinity = [IntPtr]::new([long]${value})`;
    try {
      await exec(pwshPath, ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 20000 });
    } catch (error) {
      // The page shows this text, so it gets the process's own last error line, not the whole command.
      const lines = String(error.stderr ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      throw new Error(lines.at(-1) || error.message);
    }
  }
  return {
    listAllProcesses,
    setProcessPolicy,
    listServerProcesses: () => query("Name='ArkAscendedServer.exe'"),
    processInfo: async (pid) => (await query(`ProcessId=${Number(pid)}`))[0] ?? null,
    spawnServer: ({ exePath, cwd, args }) =>
      new Promise((resolve, reject) => {
        const child = spawn(...serverSpawnArgs({ exePath, cwd, args }));
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve({ pid: child.pid });
        });
      }),
    killPid: async (pid) => execFile('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true }),
  };
}
