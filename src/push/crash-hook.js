import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

// An optional command that runs when a server crashes. Whatever it prints on its first line is added to the
// crash alert. The command comes only from crash-hook.json in the data folder on the PC that runs Overseer,
// never from the web interface, because the service runs under its own account and a web setting would let
// anyone who can sign in run a program there.
export const CONFIG_FILE = 'crash-hook.json';
export const DEFAULT_TIMEOUT_SECONDS = 45;
export const MAX_TIMEOUT_SECONDS = 120;
export const MAX_DETAIL_LENGTH = 140;
const MAX_BUFFER = 64 * 1024;
const TOKENS = ['serverId', 'serverName', 'reason', 'logPath', 'installPath'];

export function checkConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The file must hold one object.');
  const { command, args = [], timeoutSeconds = DEFAULT_TIMEOUT_SECONDS } = value;
  if (typeof command !== 'string' || (!path.win32.isAbsolute(command) && !path.posix.isAbsolute(command))) {
    throw new Error('"command" must be the full path of a program.');
  }
  if (/\.(bat|cmd)$/i.test(command))
    throw new Error('"command" cannot be a .bat or .cmd file; name a program and pass the script in "args".');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
    throw new Error('"args" must be a list of strings.');
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`"timeoutSeconds" must be from 1 to ${MAX_TIMEOUT_SECONDS}.`);
  }
  return { command, args, timeoutSeconds };
}

// {serverName} and the other tokens become separate arguments, so a name with spaces or quotes stays one value.
export function fillArgs(args, values) {
  return args.map((arg) =>
    arg.replace(/\{(\w+)\}/g, (whole, key) => (TOKENS.includes(key) ? String(values[key] ?? '') : whole)),
  );
}

// One line of plain text: the first non-empty line, control characters gone, spaces collapsed, cut to length.
export function firstLine(output) {
  const line = String(output ?? '')
    .split(/\r?\n/)
    .map((text) =>
      text
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .find(Boolean);
  if (!line) return null;
  return line.length > MAX_DETAIL_LENGTH ? `${line.slice(0, MAX_DETAIL_LENGTH - 3)}...` : line;
}

const execute = (command, args, timeout) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

export function createCrashHook({ dataDir, exec = execute, readFile = fs.readFile, log = () => {} }) {
  const file = path.join(dataDir, CONFIG_FILE);

  async function load() {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    return checkConfig(JSON.parse(text.replace(/^﻿/, '')));
  }

  // The line to add to the alert, or null. A missing file means the feature is off; a broken file, a failing
  // command, or a timeout is logged and the alert goes out without a detail.
  async function run(server, reason) {
    try {
      const config = await load();
      if (!config) return null;
      const values = {
        serverId: server.id,
        serverName: server.name,
        reason,
        logPath: server.log_path,
        installPath: server.install_path,
      };
      const stdout = await exec(config.command, fillArgs(config.args, values), config.timeoutSeconds * 1000);
      return firstLine(stdout);
    } catch (error) {
      log(`crash hook for ${server?.name ?? 'a server'}: ${error.message}`);
      return null;
    }
  }

  return { run };
}
