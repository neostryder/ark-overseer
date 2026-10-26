import test from 'node:test';
import assert from 'node:assert/strict';
import { actionData, checkConfig, createTelegram, parseAction } from '../src/telegram/telegram.js';

const TOKEN = '123456789:AAEhBP0av28KpQ4eXampleTokenValue_abc';
const CONFIG = JSON.stringify({ botToken: TOKEN, chatId: 4242 });

test('the config file needs a bot token and a chat number', () => {
  assert.deepEqual(checkConfig({ botToken: TOKEN, chatId: 4242 }), { botToken: TOKEN, chatId: '4242' });
  assert.equal(checkConfig({ botToken: TOKEN, chatId: '-100123' }).chatId, '-100123');
  for (const bad of [
    null,
    [],
    {},
    { botToken: 'nope', chatId: 1 },
    { botToken: TOKEN },
    { botToken: TOKEN, chatId: 'me' },
  ]) {
    assert.throws(() => checkConfig(bad), undefined, JSON.stringify(bad));
  }
});

test('button data round-trips and stays inside the 64 bytes Telegram allows', () => {
  assert.equal(actionData(7, 'shutdown'), 'idle:7:s');
  assert.equal(actionData(7, 'extend', { value: 1, unit: 'hour' }), 'idle:7:e:1:h');
  assert.deepEqual(parseAction('idle:7:s'), { serverId: 7, action: 'shutdown' });
  assert.deepEqual(parseAction('idle:12:e:30:m'), { serverId: 12, action: 'extend', value: 30, unit: 'minute' });
  assert.deepEqual(parseAction(actionData(3, 'extend', { value: 2, unit: 'day' })), {
    serverId: 3,
    action: 'extend',
    value: 2,
    unit: 'day',
  });
  for (const bad of [null, '', 'idle:x:s', 'idle:1:e', 'idle:1:e:1:w', 'other:1:s'])
    assert.equal(parseAction(bad), null);
  assert.ok(Buffer.byteLength(actionData(999999, 'extend', { value: 10080, unit: 'minute' })) <= 64);
});

// A fake Telegram: records each call and answers from a queue of canned results.
function fake(results = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const method = url.split('/').pop();
    const body = JSON.parse(init.body);
    calls.push({ url, method, body });
    if (method === 'getUpdates' && calls.filter((call) => call.method === method).length > 1) {
      // Later polls wait, as a real long poll does, until the loop is stopped.
      return new Promise((resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
    }
    const answer = results[method];
    const next = typeof answer === 'function' ? answer(body) : answer;
    if (next instanceof Error) throw next;
    return {
      ok: next?.status ? next.status < 400 : true,
      status: next?.status ?? 200,
      json: async () => next?.body ?? { ok: true, result: next?.result ?? {} },
    };
  };
  return { calls, fetchFn };
}

const readConfig =
  (text = CONFIG) =>
  async () =>
    text;
const missing = async () => {
  throw Object.assign(new Error('gone'), { code: 'ENOENT' });
};

test('a prompt goes to the chat with the two buttons, labeled with agreeing words', async () => {
  const { calls, fetchFn } = fake();
  const telegram = createTelegram({ dataDir: 'x', fetchFn, readFile: readConfig() });
  const sent = await telegram.sendPrompt({ id: 7, name: 'Alpha' }, 'Alpha is idle.', { value: 1, unit: 'hour' });
  assert.equal(sent, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/sendMessage$/);
  assert.equal(calls[0].body.chat_id, '4242');
  assert.deepEqual(calls[0].body.reply_markup.inline_keyboard, [
    [{ text: 'Save and shut down now', callback_data: 'idle:7:s' }],
    [{ text: 'Leave it running for 1 hour more, then shut down if nobody is on', callback_data: 'idle:7:e:1:h' }],
  ]);
  await telegram.sendPrompt({ id: 7, name: 'Alpha' }, 'x', { value: 2, unit: 'hour' });
  assert.match(calls[1].body.reply_markup.inline_keyboard[1][0].text, /for 2 hours more/);
});

test('with no telegram.json nothing is sent and the feature reads as not configured', async () => {
  const { calls, fetchFn } = fake();
  const telegram = createTelegram({ dataDir: 'x', fetchFn, readFile: missing });
  assert.equal(await telegram.configured(), false);
  assert.equal(await telegram.sendNotice('hi'), false);
  assert.equal(await telegram.sendPrompt({ id: 1 }, 'hi', { value: 1, unit: 'hour' }), false);
  assert.deepEqual(calls, []);
  const broken = createTelegram({ dataDir: 'x', fetchFn, readFile: readConfig('{"botToken":1}') });
  assert.equal(await broken.configured(), false);
});

test('a failed send never carries the token or the address that holds it', async () => {
  for (const results of [
    { sendMessage: new Error(`connect failed for https://api.telegram.org/bot${TOKEN}/sendMessage`) },
    { sendMessage: { status: 401, body: { ok: false, description: 'Unauthorized' } } },
  ]) {
    const { fetchFn } = fake(results);
    const telegram = createTelegram({ dataDir: 'x', fetchFn, readFile: readConfig() });
    await assert.rejects(telegram.sendNotice('hi'), (error) => {
      assert.ok(!error.message.includes(TOKEN));
      assert.ok(!error.message.includes('api.telegram.org'));
      return true;
    });
  }
});

// Drives the poll loop through one batch of updates and stops it.
async function runOnce(updates, { onAction, extra = {} } = {}) {
  const { calls, fetchFn } = fake({ getUpdates: { result: updates }, ...extra });
  const telegram = createTelegram({
    dataDir: 'x',
    fetchFn,
    readFile: readConfig(),
    onAction,
    sleep: () => new Promise(() => {}),
  });
  telegram.start();
  // The tap handler runs after getUpdates answers; give it a few turns, then stop the waiting poll.
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await telegram.stop();
  return calls;
}

const tap = (overrides = {}) => ({
  update_id: 10,
  callback_query: {
    id: 'cb1',
    from: { id: 4242 },
    message: { message_id: 55, text: 'Alpha is idle.', chat: { id: 4242 } },
    data: 'idle:7:e:1:h',
    ...overrides,
  },
});

test('a tap from the chat runs the action, answers it, and closes the buttons on the message', async () => {
  const seen = [];
  const calls = await runOnce([tap()], {
    onAction: async (...args) => (
      seen.push(args),
      { message: 'Alpha stays running for 1 hour more, then shuts down if nobody is on.' }
    ),
  });
  assert.deepEqual(seen, [[7, 'extend', { value: 1, unit: 'hour' }]]);
  const answer = calls.find((call) => call.method === 'answerCallbackQuery');
  assert.equal(answer.body.callback_query_id, 'cb1');
  assert.match(answer.body.text, /1 hour more/);
  const edit = calls.find((call) => call.method === 'editMessageText');
  assert.equal(edit.body.message_id, 55);
  assert.deepEqual(edit.body.reply_markup, { inline_keyboard: [] });
  assert.match(edit.body.text, /^Alpha is idle\.\n\nAlpha stays running/);
  assert.deepEqual(calls[0].body.allowed_updates, ['callback_query']);
});

test('a tap from any other chat or person is refused and runs nothing', async () => {
  for (const overrides of [
    { from: { id: 999 } },
    { message: { message_id: 55, text: 't', chat: { id: 999 } } },
    { data: 'idle:7:s:extra' },
  ]) {
    let ran = false;
    const calls = await runOnce([tap(overrides)], { onAction: async () => ((ran = true), { message: 'done' }) });
    assert.equal(ran, false, JSON.stringify(overrides));
    assert.equal(
      calls.find((call) => call.method === 'answerCallbackQuery').body.text,
      'That button is not for this chat.',
    );
    assert.equal(
      calls.find((call) => call.method === 'editMessageText'),
      undefined,
    );
  }
});

test('an action that throws is told to the person who tapped', async () => {
  const calls = await runOnce([tap({ data: 'idle:7:s' })], {
    onAction: async () => {
      throw new Error('Alpha is busy with another task right now.');
    },
  });
  assert.equal(
    calls.find((call) => call.method === 'answerCallbackQuery').body.text,
    'Alpha is busy with another task right now.',
  );
});
