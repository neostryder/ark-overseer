import fs from 'node:fs';
import path from 'node:path';
import { serverPaths } from '../supervisor/launch.js';

export function parseFirewallRules(text) {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((block) => {
      const fields = {};
      for (const line of block.split(/\r?\n/)) {
        const m = line.match(/^\s*([^:]+):\s*(.*?)\s*$/);
        if (m) fields[m[1].trim().toLowerCase()] = m[2];
      }
      if (!fields['rule name']) return null;
      const local = fields.localport?.toLowerCase() ?? 'any';
      const localPorts =
        local === 'any'
          ? 'any'
          : local.split(/[\s,]+/).flatMap((part) => {
              const m = part.match(/^(\d+)-(\d+)$/);
              return m ? [{ from: Number(m[1]), to: Number(m[2]) }] : /^\d+$/.test(part) ? [Number(part)] : [];
            });
      return {
        name: fields['rule name'],
        enabled: /^yes$/i.test(fields.enabled ?? ''),
        direction: (fields.direction ?? '').toLowerCase(),
        profiles: (fields.profiles ?? '').split(',').map((v) => v.trim()),
        protocol: fields.protocol ?? 'Any',
        localPorts,
        program: !fields.program || /^any$/i.test(fields.program) ? null : fields.program,
        remoteIp: fields.remoteip ?? 'Any',
        action: (fields.action ?? '').toLowerCase(),
      };
    })
    .filter(Boolean);
}

// Sanitizing can map two server names onto one, and netsh matches names without regard to case, so
// the server id keeps each server's rules its own.
function ruleName(server, suffix) {
  if (!Number.isInteger(server.id)) throw new TypeError('A server needs its id before its firewall rules are named');
  const safe = String(server.name).replace(/[^A-Za-z0-9 _.-]/g, '-');
  return `ARK Overseer - ${safe} [${server.id}] - ${suffix}`;
}

export function neededRules(server, install) {
  const exe = serverPaths(install.path).exePath;
  // A quote or a line break would end the quoted netsh argument, or the batch line, early.
  if (/["\r\n]/.test(exe)) throw new Error('The install path contains a quote or a line break');
  const rules = [
    {
      name: ruleName(server, 'Game'),
      enabled: true,
      direction: 'in',
      profiles: ['any'],
      protocol: 'UDP',
      localPorts: [{ from: server.game_port, to: server.game_port + 1 }],
      program: exe,
      action: 'allow',
    },
  ];
  if (server.query_port != null)
    rules.push({
      name: ruleName(server, 'Query'),
      enabled: true,
      direction: 'in',
      profiles: ['any'],
      protocol: 'UDP',
      localPorts: [server.query_port],
      program: exe,
      action: 'allow',
    });
  return rules;
}

// A rule limited to some profiles or to some remote addresses lets the traffic through only some of
// the time, so only a rule that applies everywhere counts as cover.
function appliesEverywhere(rule) {
  const profiles = rule.profiles.map((p) => p.toLowerCase());
  const allProfiles = profiles.includes('any') || ['domain', 'private', 'public'].every((p) => profiles.includes(p));
  return allProfiles && /^any$/i.test(String(rule.remoteIp ?? 'Any'));
}

function hasPort(ports, port) {
  return (
    ports === 'any' ||
    ports.some((entry) => (typeof entry === 'number' ? entry === port : port >= entry.from && port <= entry.to))
  );
}
export function coveredBy(rule, existingRules) {
  const needed =
    rule.localPorts === 'any'
      ? []
      : rule.localPorts.flatMap((p) =>
          typeof p === 'number' ? [p] : Array.from({ length: p.to - p.from + 1 }, (_, i) => p.from + i),
        );
  return (
    existingRules.find(
      (old) =>
        old.enabled &&
        old.direction === 'in' &&
        old.action === 'allow' &&
        appliesEverywhere(old) &&
        (String(old.protocol).toLowerCase() === 'any' ||
          String(old.protocol).toLowerCase() === String(rule.protocol).toLowerCase()) &&
        (old.program == null ||
          path.win32.resolve(old.program).toLowerCase() === path.win32.resolve(rule.program).toLowerCase()) &&
        needed.every((port) => hasPort(old.localPorts, port)),
    )?.name ?? null
  );
}

// Every value sits inside double quotes, where cmd treats & | < > ^ literally; only % is still expanded
// there. Names are limited to safe characters and neededRules refuses a path holding a quote.
const batch = (value) => String(value).replace(/%/g, '%%');

// chcp 65001 makes cmd read the rest of the file as UTF-8, so a path with non-ASCII characters
// reaches netsh intact.
const HEADER = ['@echo off', 'setlocal', 'chcp 65001 >nul'];
const LOG = '>> "%~dp0result.log" 2>&1';

// Deleting a rule that does not exist fails, and that is the normal case on a first apply, so the
// delete's result is not checked. Only an add decides whether the script failed.
const deleteLine = (name) => `netsh advfirewall firewall delete rule name="${batch(name)}" ${LOG}`;

function commandFor(rule) {
  const ports = rule.localPorts.map((p) => (typeof p === 'number' ? p : `${p.from}-${p.to}`)).join(',');
  return `netsh advfirewall firewall add rule name="${batch(rule.name)}" dir=in action=allow protocol=${rule.protocol} localport=${ports} program="${batch(rule.program)}" profile=any enable=yes`;
}
function scriptFor(rules) {
  const lines = [...HEADER];
  for (const rule of rules) {
    lines.push(deleteLine(rule.name));
    lines.push(`${commandFor(rule)} ${LOG}`);
    lines.push('if errorlevel 1 exit /b 1');
  }
  lines.push('exit /b 0');
  return `${lines.join('\r\n')}\r\n`;
}
export function firewallPreview(servers, existingRules) {
  const rules = servers.flatMap(({ server, install }) =>
    neededRules(server, install).map((rule) => ({ ...rule, coveredBy: coveredBy(rule, existingRules) })),
  );
  const toAdd = rules.filter((rule) => rule.coveredBy === null).map(({ coveredBy: _coveredBy, ...rule }) => rule);
  return { rules, toAdd, script: toAdd.length ? scriptFor(toAdd) : null };
}

export function removalScript(server) {
  // A server without a query port never had a Query rule, so a missing rule is not a failure here
  // either; the log still records what netsh said.
  const lines = [...HEADER];
  for (const suffix of ['Game', 'Query']) lines.push(deleteLine(ruleName(server, suffix)));
  lines.push('exit /b 0');
  return `${lines.join('\r\n')}\r\n`;
}

export async function applyFirewallScript(script, { runner, elevated = false, dir, pwshPath = 'pwsh' }) {
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, 'apply.cmd');
  const logPath = path.join(dir, 'result.log');
  fs.writeFileSync(scriptPath, script, 'utf8');
  // The script appends to the log, so an earlier run's output is cleared first.
  fs.rmSync(logPath, { force: true });
  const root = process.env.SystemRoot || 'C:\\Windows';
  const cmd = path.win32.join(root, 'System32', 'cmd.exe');
  let code;
  if (elevated) {
    // Node would escape quotes around the path in a way cmd does not understand, so the script is
    // named relative to the working directory instead and needs no quotes at all.
    ({ code } = await runner(cmd, ['/d', '/c', '.\\apply.cmd'], { cwd: dir }));
  } else {
    // With /s, cmd drops only the outer pair of quotes and runs the quoted path as one command, even
    // when the path holds a character such as & that would otherwise split it.
    const psPath = path.join(dir, 'elevate.ps1');
    const quoted = scriptPath.replace(/'/g, "''");
    fs.writeFileSync(
      psPath,
      `$p = Start-Process -FilePath '${cmd}' -ArgumentList '/d /s /c ""${quoted}""' -Verb RunAs -Wait -PassThru -WindowStyle Hidden\nexit $p.ExitCode\n`,
    );
    ({ code } = await runner(pwshPath, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath], { cwd: dir }));
  }
  return { ok: code === 0, code, log: fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '' };
}
