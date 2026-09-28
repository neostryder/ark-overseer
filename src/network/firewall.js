import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { serverPaths } from '../supervisor/launch.js';

const execFileAsync = promisify(execFile);

const PROTOCOLS = { 6: 'TCP', 17: 'UDP' };
// Fields that describe a rule without narrowing the traffic it allows. Any other field (an app
// package, a service, a rule owner, local or remote addresses, an interface, an authentication or
// trust requirement, a remote port, a Windows version condition) limits the rule to some traffic, so
// the rule is marked limited and never counts as cover. A field this list doesn't know is treated the
// same way. LPort2_10 and its siblings hold port ranges and are read as ports.
const PLAIN_FIELDS = new Set([
  'Action',
  'Active',
  'Dir',
  'Protocol',
  'Profile',
  'LPort',
  'App',
  'Name',
  'Desc',
  'EmbedCtxt',
  'Edge',
  'Defer',
]);
const PORT_FIELD = /^LPort(2_\d+)?$/;

// %SystemRoot% and the like, looked up without regard to case the way Windows does.
function expandEnv(value, env) {
  const lower = Object.fromEntries(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return value.replace(/%([^%]+)%/g, (whole, name) => lower[name.toLowerCase()] ?? whole);
}

// Reads the rule strings Windows keeps in the registry, such as
// "v2.33|Action=Allow|Active=TRUE|Dir=In|Protocol=17|LPort=7777|Name=ARK Game Port|". These carry the
// app package, service and owner that "netsh show rule" leaves out, and they read the same on every
// display language.
export function parseRegistryRules(entries, env = process.env) {
  return entries
    .map((item) => {
      // An entry is a rule string, or { store, text } when the reader knows which store it came from.
      const entry = typeof item === 'string' ? item : item?.text;
      if (typeof entry !== 'string' || !/^v\d+\.\d+\|/.test(entry)) return null;
      const fields = new Map();
      const ports = [];
      let limited = false;
      for (const part of entry.split('|').slice(1)) {
        const eq = part.indexOf('=');
        if (eq < 1) continue;
        const key = part.slice(0, eq);
        if (PORT_FIELD.test(key)) ports.push(part.slice(eq + 1));
        else if (!PLAIN_FIELDS.has(key)) limited = true;
        if (!fields.has(key)) fields.set(key, []);
        fields.get(key).push(part.slice(eq + 1));
      }
      const one = (key) => fields.get(key)?.[0];
      // Keywords such as RPC or Teredo stand for port sets decided at run time, so they cover no
      // numbered port.
      const localPorts = ports.length
        ? ports.flatMap((part) => {
            const m = part.match(/^(\d+)-(\d+)$/);
            return m ? [{ from: Number(m[1]), to: Number(m[2]) }] : /^\d+$/.test(part) ? [Number(part)] : [];
          })
        : 'any';
      const protocol = one('Protocol');
      const app = one('App');
      return {
        name: one('Name') ?? '',
        enabled: /^true$/i.test(one('Active') ?? ''),
        direction: (one('Dir') ?? '').toLowerCase(),
        profiles: fields.get('Profile') ?? ['Any'],
        protocol: protocol == null ? 'Any' : (PROTOCOLS[protocol] ?? protocol),
        localPorts,
        program: app == null ? null : /^system$/i.test(app) ? 'System' : expandEnv(app, env),
        remoteIp: 'Any',
        action: (one('Action') ?? '').toLowerCase(),
        limited,
        store: typeof item === 'string' ? 'local' : item.store,
      };
    })
    .filter(Boolean);
}

const LOCAL_KEY = String.raw`HKLM:\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallRules`;
const POLICY = String.raw`HKLM:\SOFTWARE\Policies\Microsoft\WindowsFirewall`;
// Local rules and rules set by group policy, plus each profile's policy on whether local rules apply
// at all. Every key here is readable by every user, the service's Network Service account included;
// the policy keys exist only on machines that have such a policy.
const READ_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$rules = [System.Collections.Generic.List[object]]::new()',
  `foreach ($pair in @(@('local', '${LOCAL_KEY}'), @('policy', '${POLICY}\\FirewallRules'))) {`,
  '  if (Test-Path -LiteralPath $pair[1]) {',
  '    $key = Get-Item -LiteralPath $pair[1]',
  '    foreach ($n in $key.GetValueNames()) { $v = $key.GetValue($n); if ($v -is [string]) { $rules.Add(@{ store = $pair[0]; text = $v }) } }',
  '  }',
  '}',
  '$merge = foreach ($p in @("DomainProfile", "PrivateProfile", "PublicProfile")) {',
  `  $k = '${POLICY}\\' + $p`,
  '  if (Test-Path -LiteralPath $k) { (Get-ItemProperty -LiteralPath $k).AllowLocalPolicyMerge } else { $null }',
  '}',
  'ConvertTo-Json -Compress -Depth 4 -InputObject @{ rules = $rules.ToArray(); merge = @($merge) }',
].join('\n');

// Returns the rules Windows enforces. When group policy turns off local rules for any profile, local
// rules are left out, since they don't apply everywhere, and localRulesIgnored says so: a rule added
// locally would not take effect either.
export async function readFirewallRules({ pwshPath = 'pwsh', exec = execFileAsync, env = process.env } = {}) {
  const { stdout } = await exec(pwshPath, ['-NoProfile', '-NonInteractive', '-Command', READ_SCRIPT], {
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout.trim() || '{}');
  const entries = parsed.rules == null ? [] : Array.isArray(parsed.rules) ? parsed.rules : [parsed.rules];
  const localRulesIgnored = [].concat(parsed.merge ?? []).some((value) => value === 0);
  const rules = parseRegistryRules(entries, env).filter((rule) => !localRulesIgnored || rule.store !== 'local');
  return { rules, localRulesIgnored };
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
  return allProfiles && !rule.limited && /^any$/i.test(String(rule.remoteIp ?? 'Any'));
}

function hasPort(ports, port) {
  return (
    ports === 'any' ||
    ports.some((entry) => (typeof entry === 'number' ? entry === port : port >= entry.from && port <= entry.to))
  );
}
// Several rules can share the cover, such as one rule for the game port and another for the peer
// port. The names of the rules that cover the needed ports come back joined, or null when any
// needed port is left uncovered.
export function coveredBy(rule, existingRules) {
  const needed =
    rule.localPorts === 'any'
      ? [null]
      : rule.localPorts.flatMap((p) =>
          typeof p === 'number' ? [p] : Array.from({ length: p.to - p.from + 1 }, (_, i) => p.from + i),
        );
  const usable = existingRules.filter(
    (old) =>
      old.enabled &&
      old.direction === 'in' &&
      old.action === 'allow' &&
      appliesEverywhere(old) &&
      (String(old.protocol).toLowerCase() === 'any' ||
        String(old.protocol).toLowerCase() === String(rule.protocol).toLowerCase()) &&
      (old.program == null ||
        path.win32.resolve(old.program).toLowerCase() === path.win32.resolve(rule.program).toLowerCase()),
  );
  const names = [];
  for (const port of needed) {
    const cover = usable.find((old) => (port === null ? old.localPorts === 'any' : hasPort(old.localPorts, port)));
    if (!cover) return null;
    if (!names.includes(cover.name)) names.push(cover.name);
  }
  return names.join(', ');
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
