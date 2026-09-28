import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseRegistryRules,
  readFirewallRules,
  neededRules,
  coveredBy,
  firewallPreview,
  removalScript,
  applyFirewallScript,
} from '../src/network/firewall.js';
import { createProcessRunner } from '../src/steamcmd/runner.js';

const fixture = fs
  .readFileSync(new URL('./fixtures/firewall-registry-ark.txt', import.meta.url), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean);
const env = { SystemRoot: 'C:\\Windows' };
const rules = parseRegistryRules(fixture, env);
const server = { id: 1, name: 'Neo Olympus', game_port: 7777, query_port: 27015, rcon_port: 27020 };
const install = { path: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\ARK Survival Ascended Dedicated Server' };
const without = (name) => rules.filter((r) => r.name !== name);
const SERVER_RULE = 'ARK: Survival Ascended Dedicated Server';
const PORT_RULES = 'ARK Game Port 7777 UDP, ARK Peer Port 7778 UDP';

function temp(t, prefix = 'ark-fw-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('parseRegistryRules reads the ten captured rules', () => {
  assert.deepEqual(
    rules.map((r) => r.name),
    [
      SERVER_RULE,
      SERVER_RULE,
      'ARK Query Port 27015 UDP',
      'ARK Peer Port 7778 UDP',
      'ARK Game Port 7777 UDP',
      'ARK: Survival Ascended',
      'ArkAscended',
      'Microsoft Store',
      '@FirewallAPI.dll,-33253',
      '@FirewallAPI.dll,-29257',
    ],
  );
  assert.deepEqual(
    rules.slice(0, 2).map((r) => r.protocol),
    ['UDP', 'TCP'],
  );
  assert.equal(rules[0].localPorts, 'any');
  assert.equal(rules[0].program, `${install.path}\\ShooterGame\\Binaries\\Win64\\ArkAscendedServer.exe`);
  assert.deepEqual(rules[0].profiles, ['Domain', 'Private', 'Public']);
  assert.equal(rules[0].enabled, true);
  assert.equal(rules[0].direction, 'in');
  assert.equal(rules[0].action, 'allow');
  assert.equal(rules[0].limited, false);
  assert.deepEqual(rules[2].localPorts, [27015]);
  assert.deepEqual(rules[4].localPorts, [7777]);
  assert.equal(rules[4].program, null);
  // No Profile field means every profile, and no Protocol field means any protocol.
  assert.deepEqual(rules[2].profiles, ['Any']);
  assert.equal(rules[7].protocol, 'Any');
});

test('parseRegistryRules marks package, service, owner and address limits, and reads keywords as no port', () => {
  const [store, schedule, smb] = rules.slice(7);
  assert.equal(store.limited, true);
  assert.equal(schedule.limited, true);
  assert.equal(schedule.enabled, false);
  assert.deepEqual(schedule.localPorts, []);
  assert.equal(schedule.program, 'C:\\Windows\\system32\\svchost.exe');
  assert.equal(smb.limited, true);
  assert.equal(smb.program, 'System');
  assert.equal(rules[6].limited, false, 'Defer and Desc do not narrow a rule');
});

test('parseRegistryRules reads single ports from LPort and ranges from LPort2_10, and skips non-rules', () => {
  const [parsed] = parseRegistryRules(
    ['v2.33|Action=Allow|Active=TRUE|Dir=In|Protocol=17|LPort=1|LPort2_10=7-9|Name=Test|', 'not a rule', 42],
    env,
  );
  assert.deepEqual(parsed.localPorts, [1, { from: 7, to: 9 }]);
  assert.equal(parsed.limited, false);
  assert.equal(parseRegistryRules(['junk', null], env).length, 0);
});

test('a range rule written the way Windows stores 7777-7778 covers the game and peer ports', () => {
  // netsh stores localport=7777-7778 as LPort2_10, which is how ARK Overseer's own Game rule is kept.
  const range = parseRegistryRules(
    ['v2.33|Action=Allow|Active=TRUE|Dir=In|Protocol=17|LPort2_10=7777-7778|Name=Range|'],
    env,
  );
  assert.equal(coveredBy(neededRules(server, install)[0], range), 'Range');
});

test('a rule limited to some Windows versions is not cover', () => {
  const [rule] = parseRegistryRules(
    ['v2.33|Action=Allow|Active=TRUE|Dir=In|Protocol=17|Platform=2:6:2|Platform2=GTEQ|Name=Versioned|'],
    env,
  );
  assert.equal(rule.limited, true);
  assert.equal(coveredBy(neededRules(server, install)[0], [rule]), null);
});

test('readFirewallRules runs pwsh hidden and parses the JSON it prints', async () => {
  let call;
  const exec = async (file, args, options) => {
    call = { file, args, options };
    return {
      stdout: JSON.stringify({
        rules: fixture.slice(0, 2).map((text) => ({ store: 'local', text })),
        merge: [null, null, null],
      }),
      stderr: '',
    };
  };
  const read = await readFirewallRules({ pwshPath: 'C:\\pwsh\\pwsh.exe', exec, env });
  assert.equal(call.file, 'C:\\pwsh\\pwsh.exe');
  assert.equal(call.options.windowsHide, true);
  assert.match(call.args.at(-1), /SharedAccess\\Parameters\\FirewallPolicy\\FirewallRules/);
  assert.match(call.args.at(-1), /Policies\\Microsoft\\WindowsFirewall\\FirewallRules/);
  assert.equal(read.localRulesIgnored, false);
  assert.deepEqual(
    read.rules.map((r) => [r.protocol, r.store]),
    [
      ['UDP', 'local'],
      ['TCP', 'local'],
    ],
  );
  // ConvertTo-Json prints a single rule as a bare object rather than an array.
  const one = await readFirewallRules({
    exec: async () => ({ stdout: JSON.stringify({ rules: { store: 'policy', text: fixture[2] }, merge: null }) }),
    env,
  });
  assert.deepEqual(one.rules[0].localPorts, [27015]);
  assert.equal(one.rules[0].store, 'policy');
  assert.deepEqual(await readFirewallRules({ exec: async () => ({ stdout: '' }), env }), {
    rules: [],
    localRulesIgnored: false,
  });
});

test('when group policy turns off local rules for a profile, local rules are not cover', async () => {
  const stdout = JSON.stringify({
    rules: [
      { store: 'local', text: fixture[0] },
      { store: 'policy', text: fixture[2] },
    ],
    merge: [null, 0, null],
  });
  const read = await readFirewallRules({ exec: async () => ({ stdout }), env });
  assert.equal(read.localRulesIgnored, true);
  assert.deepEqual(
    read.rules.map((r) => r.name),
    ['ARK Query Port 27015 UDP'],
  );
  // Positive control: with merging allowed (1) the local rule stays.
  const allowed = await readFirewallRules({
    exec: async () => ({ stdout: stdout.replace('[null,0,null]', '[1,1,1]') }),
    env,
  });
  assert.equal(allowed.localRulesIgnored, false);
  assert.equal(allowed.rules.length, 2);
});

test(
  'the real reader script runs in pwsh and returns rules from this machine',
  { skip: process.platform !== 'win32' },
  async () => {
    const read = await readFirewallRules();
    assert.ok(Array.isArray(read.rules));
    assert.equal(typeof read.localRulesIgnored, 'boolean');
    // Every Windows install ships with enabled inbound rules.
    assert.ok(read.rules.some((r) => r.direction === 'in' && r.enabled));
  },
);

test('neededRules builds a game rule covering the peer port and a query rule when there is one', () => {
  const [game, query] = neededRules(server, install);
  assert.equal(game.name, 'ARK Overseer - Neo Olympus [1] - Game');
  assert.deepEqual(game.localPorts, [{ from: 7777, to: 7778 }]);
  assert.equal(game.program, rules[0].program);
  assert.equal(query.name, 'ARK Overseer - Neo Olympus [1] - Query');
  assert.deepEqual(query.localPorts, [27015]);
  assert.equal(neededRules({ ...server, query_port: null }, install).length, 1);
});

test('neededRules replaces unsafe characters in the server name', () => {
  assert.equal(neededRules({ ...server, name: 'A?B&"C%' }, install)[0].name, 'ARK Overseer - A-B--C- [1] - Game');
});

test('two servers whose names sanitize alike still get separate rules', () => {
  const a = neededRules({ ...server, id: 3, name: 'A&B' }, install)[0].name;
  const b = neededRules({ ...server, id: 4, name: 'A?B' }, install)[0].name;
  assert.deepEqual([a, b], ['ARK Overseer - A-B [3] - Game', 'ARK Overseer - A-B [4] - Game']);
});

test('neededRules refuses a server without an id and an install path holding a quote or line break', () => {
  assert.throws(() => neededRules({ ...server, id: undefined }, install), /needs its id/);
  for (const bad of ['C:\\A"B', 'C:\\A\nB', 'C:\\A\rB'])
    assert.throws(() => neededRules(server, { path: bad }), /quote or a line break/);
});

test('the Neo Olympus exe is covered by its any-port program rule', () => {
  const programOnly = rules.filter((r) => r.program);
  for (const rule of neededRules(server, install)) assert.equal(coveredBy(rule, programOnly), SERVER_RULE);
});

test('a program rule compares paths without regard to case', () => {
  const game = neededRules({ ...server }, { path: install.path.toUpperCase() })[0];
  assert.equal(
    coveredBy(
      game,
      rules.filter((r) => r.program),
    ),
    SERVER_RULE,
  );
});

test('a server whose exe lives elsewhere is not covered by that program rule', () => {
  const game = neededRules(server, { path: 'D:\\ARK\\Server' })[0];
  assert.equal(
    coveredBy(
      game,
      rules.filter((r) => r.program),
    ),
    null,
  );
});

test('separate port rules share the cover for the game and peer range', () => {
  const others = without(SERVER_RULE);
  const [game, query] = neededRules(server, install);
  assert.equal(coveredBy(game, others), PORT_RULES);
  assert.equal(coveredBy(query, others), 'ARK Query Port 27015 UDP');
  assert.equal(
    coveredBy(
      game,
      without(SERVER_RULE).filter((r) => r.name !== 'ARK Peer Port 7778 UDP'),
    ),
    null,
  );
});

test('the Microsoft Store rule, open on every port but limited to its app package, is not cover', () => {
  const game = neededRules(server, install)[0];
  const store = rules.filter((r) => r.name === 'Microsoft Store');
  assert.equal(store[0].localPorts, 'any');
  assert.equal(coveredBy(game, store), null);
  // Positive control: the same rule without its package limit would cover everything.
  assert.equal(coveredBy(game, [{ ...store[0], limited: false }]), 'Microsoft Store');
});

test('a disabled, blocking, outbound, other-protocol, partial-profile or remote-limited rule is not cover', () => {
  const game = neededRules(server, install)[0];
  const base = rules[0];
  for (const change of [
    { enabled: false },
    { action: 'block' },
    { direction: 'out' },
    { protocol: 'TCP' },
    { profiles: ['Private'] },
    { remoteIp: 'LocalSubnet' },
    { limited: true },
  ])
    assert.equal(coveredBy(game, [{ ...base, ...change }]), null, JSON.stringify(change));
  // Positive control: the unchanged rule does cover it, and so does one with the Any profile or protocol.
  assert.equal(coveredBy(game, [base]), SERVER_RULE);
  assert.equal(coveredBy(game, [{ ...base, profiles: ['Any'], protocol: 'Any' }]), SERVER_RULE);
});

test('firewallPreview gives no script when every rule is covered', () => {
  const preview = firewallPreview([{ server, install }], rules);
  assert.deepEqual(
    preview.rules.map((r) => r.coveredBy),
    [SERVER_RULE, SERVER_RULE],
  );
  assert.deepEqual(preview.toAdd, []);
  assert.equal(preview.script, null);
});

test('firewallPreview writes the exact script for an uncovered server, doubling % in the path', () => {
  const preview = firewallPreview([{ server, install: { path: 'C:\\ARK 100%\\Server' } }], []);
  const exe = 'C:\\ARK 100%%\\Server\\ShooterGame\\Binaries\\Win64\\ArkAscendedServer.exe';
  const log = '>> "%~dp0result.log" 2>&1';
  assert.equal(
    preview.script,
    [
      '@echo off',
      'setlocal',
      'chcp 65001 >nul',
      `netsh advfirewall firewall delete rule name="ARK Overseer - Neo Olympus [1] - Game" ${log}`,
      `netsh advfirewall firewall add rule name="ARK Overseer - Neo Olympus [1] - Game" dir=in action=allow protocol=UDP localport=7777-7778 program="${exe}" profile=any enable=yes ${log}`,
      'if errorlevel 1 exit /b 1',
      `netsh advfirewall firewall delete rule name="ARK Overseer - Neo Olympus [1] - Query" ${log}`,
      `netsh advfirewall firewall add rule name="ARK Overseer - Neo Olympus [1] - Query" dir=in action=allow protocol=UDP localport=27015 program="${exe}" profile=any enable=yes ${log}`,
      'if errorlevel 1 exit /b 1',
      'exit /b 0',
      '',
    ].join('\r\n'),
  );
  assert.equal(preview.toAdd.length, 2);
});

test('a path holding & is quoted, not caret-escaped', () => {
  const { script } = firewallPreview([{ server: { ...server, query_port: null }, install: { path: 'C:\\A&B' } }], []);
  assert.match(script, /program="C:\\A&B\\ShooterGame/);
  assert.doesNotMatch(script, /\^/);
});

test('removalScript deletes both named rules and does not fail when one is missing', () => {
  const log = '>> "%~dp0result.log" 2>&1';
  assert.equal(
    removalScript({ id: 7, name: 'A&B' }),
    [
      '@echo off',
      'setlocal',
      'chcp 65001 >nul',
      `netsh advfirewall firewall delete rule name="ARK Overseer - A-B [7] - Game" ${log}`,
      `netsh advfirewall firewall delete rule name="ARK Overseer - A-B [7] - Query" ${log}`,
      'exit /b 0',
      '',
    ].join('\r\n'),
  );
});

test('applyFirewallScript runs cmd directly when already elevated and reads the log back', async (t) => {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, 'result.log'), 'from an earlier run\n');
  const calls = [];
  const result = await applyFirewallScript('@echo off\r\n', {
    dir,
    elevated: true,
    runner: async (command, args, options) => {
      calls.push({ command, args, options });
      assert.equal(fs.existsSync(path.join(dir, 'result.log')), false, 'the old log is cleared first');
      assert.equal(fs.readFileSync(path.join(dir, 'apply.cmd'), 'utf8'), '@echo off\r\n');
      fs.writeFileSync(path.join(dir, 'result.log'), 'Ok.\n');
      return { code: 0 };
    },
  });
  const root = process.env.SystemRoot || 'C:\\Windows';
  assert.deepEqual(calls, [
    {
      command: path.win32.join(root, 'System32', 'cmd.exe'),
      args: ['/d', '/c', '.\\apply.cmd'],
      options: { cwd: dir },
    },
  ]);
  assert.deepEqual(result, { ok: true, code: 0, log: 'Ok.\n' });
});

test('applyFirewallScript asks for one elevation through pwsh and quotes a path holding an apostrophe', async (t) => {
  const dir = temp(t, "ark-o'brien-");
  let call;
  const result = await applyFirewallScript('x', {
    dir,
    pwshPath: 'C:\\Tools\\pwsh.exe',
    runner: async (...args) => {
      call = args;
      return { code: 0 };
    },
  });
  const psPath = path.join(dir, 'elevate.ps1');
  assert.deepEqual(call, [
    'C:\\Tools\\pwsh.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath],
    { cwd: dir },
  ]);
  const cmd = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  const quoted = path.join(dir, 'apply.cmd').replace(/'/g, "''");
  assert.equal(
    fs.readFileSync(psPath, 'utf8'),
    `$p = Start-Process -FilePath '${cmd}' -ArgumentList '/d /s /c ""${quoted}""' -Verb RunAs -Wait -PassThru -WindowStyle Hidden\nexit $p.ExitCode\n`,
  );
  assert.match(quoted, /o''brien/);
  assert.equal(result.ok, true);
});

test('a declined elevation resolves ok: false with the code instead of throwing', async (t) => {
  const result = await applyFirewallScript('x', { dir: temp(t), runner: async () => ({ code: 1223 }) });
  assert.deepEqual(result, { ok: false, code: 1223, log: '' });
});

// The next two run real cmd.exe on a generated script in which netsh is replaced by a Node stand-in
// that records the arguments it received, so the batch quoting, the % escaping, the log path and the
// exit codes are exercised for real without changing any firewall rule.
function standIn(script, dir, { failAdd = false } = {}) {
  // A delete fails, as it does for a rule that does not exist yet; an add fails only when asked to.
  fs.writeFileSync(
    path.join(dir, 'fake-netsh.mjs'),
    `const a = process.argv.slice(2);\nconsole.log(JSON.stringify(a));\nprocess.exit(a[2] === 'delete' || (${failAdd} && a[2] === 'add') ? 1 : 0);\n`,
  );
  return script.replaceAll('netsh advfirewall', `"${process.execPath}" "%~dp0fake-netsh.mjs" advfirewall`);
}
const received = (log) =>
  log
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));

test('a generated script survives a first apply where every delete fails, with & and % in the path', async (t) => {
  if (process.platform !== 'win32') return t.skip('cmd.exe is Windows only');
  const dir = temp(t, 'ark fw & 100%-');
  const { script } = firewallPreview([{ server, install: { path: 'C:\\Games & Co\\ARK 100%' } }], []);
  const result = await applyFirewallScript(standIn(script, dir), {
    dir,
    elevated: true,
    runner: createProcessRunner(),
  });
  assert.equal(result.code, 0);
  const exe = 'C:\\Games & Co\\ARK 100%\\ShooterGame\\Binaries\\Win64\\ArkAscendedServer.exe';
  const calls = received(result.log);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], [
    'advfirewall',
    'firewall',
    'delete',
    'rule',
    'name=ARK Overseer - Neo Olympus [1] - Game',
  ]);
  assert.deepEqual(calls[1], [
    'advfirewall',
    'firewall',
    'add',
    'rule',
    'name=ARK Overseer - Neo Olympus [1] - Game',
    'dir=in',
    'action=allow',
    'protocol=UDP',
    'localport=7777-7778',
    `program=${exe}`,
    'profile=any',
    'enable=yes',
  ]);
  assert.equal(calls[3][8], 'localport=27015');
});

test('a generated script stops at the first add that fails and exits 1', async (t) => {
  if (process.platform !== 'win32') return t.skip('cmd.exe is Windows only');
  const dir = temp(t);
  const { script } = firewallPreview([{ server, install: { path: 'C:\\ARK' } }], []);
  const result = await applyFirewallScript(standIn(script, dir, { failAdd: true }), {
    dir,
    elevated: true,
    runner: createProcessRunner(),
  });
  assert.equal(result.code, 1);
  assert.equal(result.ok, false);
  // Only the Game rule's delete and add ran; the Query rule was never reached.
  assert.deepEqual(
    received(result.log).map((call) => call[2]),
    ['delete', 'add'],
  );
});
