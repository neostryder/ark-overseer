import fs from 'node:fs/promises';
import path from 'node:path';
import { extendLabel, shutdownLabel } from '../idle/settings.js';

// A Telegram bot that sends the empty-server prompt with buttons and carries the taps back. The token and chat
// come only from telegram.json in the data folder on the PC that runs Overseer, never from the web interface, and
// a tap counts only when it comes from that chat. The bot is Overseer's own: Telegram lets one process at a time
// receive a bot's updates, so a bot shared with another program would knock that one offline.
export const CONFIG_FILE = 'telegram.json';
const UNIT_CODES = { minute: 'm', hour: 'h', day: 'd' };
const UNIT_NAMES = { m: 'minute', h: 'hour', d: 'day' };
const ACTION_PATTERN = /^idle:(\d+):(s|e)(?::(\d+):([mhd]))?$/;

export function checkConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The file must hold one object.');
  const { botToken, chatId } = value;
  if (typeof botToken !== 'string' || !/^\d+:[\w-]{20,}$/.test(botToken)) {
    throw new Error('"botToken" must be the token BotFather gave the bot.');
  }
  if (!/^-?\d+$/.test(String(chatId ?? ''))) throw new Error('"chatId" must be the number of your chat with the bot.');
  return { botToken, chatId: String(chatId) };
}

export function actionData(serverId, action, extend) {
  return action === 'shutdown' ? `idle:${serverId}:s` : `idle:${serverId}:e:${extend.value}:${UNIT_CODES[extend.unit]}`;
}

export function parseAction(data) {
  const match = ACTION_PATTERN.exec(String(data ?? ''));
  if (!match) return null;
  const serverId = Number(match[1]);
  if (match[2] === 's') return match[3] === undefined ? { serverId, action: 'shutdown' } : null;
  if (match[3] === undefined) return null;
  return { serverId, action: 'extend', value: Number(match[3]), unit: UNIT_NAMES[match[4]] };
}

export function createTelegram({
  dataDir,
  fetchFn = globalThis.fetch,
  readFile = fs.readFile,
  log = () => {},
  // Called with (serverId, action, { value, unit }) for a tap; returns { message }.
  onAction = async () => ({ message: '' }),
  pollSeconds = 30,
  retryMs = 30 * 1000,
  idleMs = 60 * 1000,
  sleep = (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
    }),
}) {
  const file = path.join(dataDir, CONFIG_FILE);
  let abort = null;
  let task = null;

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

  // Never puts the token or the address that holds it in an error: only Telegram's own description or the status.
  async function call(config, method, body, signal) {
    let response;
    try {
      response = await fetchFn(`https://api.telegram.org/bot${config.botToken}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      throw new Error(
        `Telegram ${method} could not be reached (${cause.name === 'TimeoutError' ? 'timed out' : 'network error'}).`,
      );
    }
    const answer = await response.json().catch(() => ({}));
    if (!response.ok || answer.ok === false) {
      throw Object.assign(
        new Error(`Telegram ${method} was refused: ${answer.description ?? `HTTP ${response.status}`}`),
        {
          status: response.status,
        },
      );
    }
    return answer.result;
  }

  async function configured() {
    try {
      return Boolean(await load());
    } catch {
      return false;
    }
  }

  async function sendNotice(text) {
    const config = await load();
    if (!config) return false;
    await call(config, 'sendMessage', { chat_id: config.chatId, text }, AbortSignal.timeout(15000));
    return true;
  }

  async function sendPrompt(server, text, extend) {
    const config = await load();
    if (!config) return false;
    await call(
      config,
      'sendMessage',
      {
        chat_id: config.chatId,
        text,
        reply_markup: {
          inline_keyboard: [
            [{ text: shutdownLabel, callback_data: actionData(server.id, 'shutdown') }],
            [{ text: extendLabel(extend.value, extend.unit), callback_data: actionData(server.id, 'extend', extend) }],
          ],
        },
      },
      AbortSignal.timeout(15000),
    );
    return true;
  }

  async function handleTap(config, query, signal) {
    const fromChat =
      String(query.message?.chat?.id ?? '') === config.chatId && String(query.from?.id ?? '') === config.chatId;
    const parsed = fromChat ? parseAction(query.data) : null;
    let message = 'That button is not for this chat.';
    if (parsed) {
      try {
        message = (await onAction(parsed.serverId, parsed.action, { value: parsed.value, unit: parsed.unit })).message;
      } catch (cause) {
        message = cause.message;
      }
    }
    await call(
      config,
      'answerCallbackQuery',
      { callback_query_id: query.id, text: message.slice(0, 190) },
      signal,
    ).catch(() => {});
    if (parsed && query.message?.message_id) {
      await call(
        config,
        'editMessageText',
        {
          chat_id: config.chatId,
          message_id: query.message.message_id,
          text: `${query.message.text ?? ''}\n\n${message}`,
          reply_markup: { inline_keyboard: [] },
        },
        signal,
      ).catch(() => {});
    }
  }

  async function loop(signal) {
    let offset = 0;
    while (!signal.aborted) {
      let config;
      try {
        config = await load();
      } catch (cause) {
        log(`Telegram: telegram.json is not usable: ${cause.message}`);
        await sleep(idleMs, signal);
        continue;
      }
      if (!config) {
        await sleep(idleMs, signal);
        continue;
      }
      try {
        const updates = await call(
          config,
          'getUpdates',
          { offset, timeout: pollSeconds, allowed_updates: ['callback_query'] },
          AbortSignal.any([signal, AbortSignal.timeout((pollSeconds + 15) * 1000)]),
        );
        for (const update of updates ?? []) {
          offset = Math.max(offset, update.update_id + 1);
          if (update.callback_query) await handleTap(config, update.callback_query, signal);
        }
      } catch (cause) {
        if (signal.aborted) return;
        log(`Telegram: ${cause.message}`);
        await sleep(cause.status === 401 ? 5 * idleMs : retryMs, signal);
      }
    }
  }

  function start() {
    if (task) return;
    abort = new AbortController();
    task = loop(abort.signal).catch((cause) => log(`Telegram: ${cause.message}`));
  }
  async function stop() {
    abort?.abort();
    await task;
    task = null;
    abort = null;
  }

  return { configured, sendNotice, sendPrompt, start, stop };
}
