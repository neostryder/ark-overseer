import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { extendLabel, shutdownLabel } from '../idle/settings.js';

// Sends the empty-server prompt to Telegram with buttons and carries the taps back. Overseer only sends: the bot is
// shared with other programs, and Telegram lets one process at a time receive a bot's updates, so another program
// (Hermes) holds that and forwards each tap here, to /api/telegram/relay, with a shared secret. The token, the chat
// and the secret come only from telegram.json in the data folder on the PC that runs Overseer, never from the web
// interface, and a tap counts only when it comes from that chat.
export const CONFIG_FILE = 'telegram.json';
const UNIT_CODES = { minute: 'm', hour: 'h', day: 'd' };
const UNIT_NAMES = { m: 'minute', h: 'hour', d: 'day' };
const ACTION_PATTERN = /^idle:(\d+):(s|e)(?::(\d+):([mhd]))?$/;

export function checkConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The file must hold one object.');
  const { botToken, chatId, relaySecret } = value;
  if (typeof botToken !== 'string' || !/^\d+:[\w-]{20,}$/.test(botToken)) {
    throw new Error('"botToken" must be the token BotFather gave the bot.');
  }
  if (!/^-?\d+$/.test(String(chatId ?? ''))) throw new Error('"chatId" must be the number of your chat with the bot.');
  if (typeof relaySecret !== 'string' || relaySecret.length < 32) {
    throw new Error('"relaySecret" must be a made-up string of at least 32 characters.');
  }
  return { botToken, chatId: String(chatId), relaySecret };
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
}) {
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

  // A tap forwarded by the program that receives the bot's updates. Returns { status, message }: 403 for a wrong
  // secret, 400 for a tap that is not an idle button, 200 once the action has been tried (its outcome is the message).
  async function relayTap(secret, tap) {
    const config = await load().catch(() => null);
    if (!config) return { status: 404, message: 'Telegram is not set up.' };
    const given = Buffer.from(String(secret ?? ''));
    const wanted = Buffer.from(config.relaySecret);
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return { status: 403, message: 'Refused.' };
    const parsed = parseAction(tap?.data);
    if (!parsed) return { status: 400, message: 'That is not an idle button.' };
    const fromChat = String(tap.chatId ?? '') === config.chatId && String(tap.fromId ?? '') === config.chatId;
    let message = 'That button is not for this chat.';
    if (fromChat) {
      try {
        message = (await onAction(parsed.serverId, parsed.action, { value: parsed.value, unit: parsed.unit })).message;
      } catch (cause) {
        message = cause.message;
      }
    }
    const signal = AbortSignal.timeout(15000);
    if (typeof tap.callbackQueryId === 'string' && tap.callbackQueryId) {
      await call(
        config,
        'answerCallbackQuery',
        { callback_query_id: tap.callbackQueryId, text: message.slice(0, 190) },
        signal,
      ).catch(() => {});
    }
    if (fromChat && Number.isInteger(tap.messageId)) {
      await call(
        config,
        'editMessageText',
        {
          chat_id: config.chatId,
          message_id: tap.messageId,
          text: `${String(tap.text ?? '').slice(0, 3500)}\n\n${message}`,
          reply_markup: { inline_keyboard: [] },
        },
        signal,
      ).catch(() => {});
    }
    return { status: 200, message };
  }

  return { configured, sendNotice, sendPrompt, relayTap };
}
