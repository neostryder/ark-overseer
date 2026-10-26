// The empty-server watch: its settings, and the words used for times so a unit always agrees with its number.

export const UNITS = { minute: 60 * 1000, hour: 60 * 60 * 1000, day: 24 * 60 * 60 * 1000 };
export const MAX_EXTEND_MS = 7 * UNITS.day;
export const IDLE_MESSAGES = {
  badSettings: 'The empty-server settings are not valid.',
  badMinutes: 'Minutes must be a whole number from 1 to 240.',
  badExtend: 'Choose a whole number of minutes, hours, or days, up to 7 days in all.',
  badServers: 'Choose servers from the list this computer runs.',
  badAction: 'Choose Save and shut down now, or Leave it running for a while longer.',
};

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  // How long nobody is connected before the prompt goes out.
  idleMinutes: 5,
  // What "Leave it running" offers unless a longer or shorter time is picked.
  extendValue: 1,
  extendUnit: 'hour',
  // With no answer to the prompt, save and shut the server down after this long.
  autoShutdown: true,
  autoShutdownMinutes: 15,
  // null watches every server; a list watches only those.
  serverIds: null,
});

const whole = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;

export function checkDuration(value, unit) {
  if (!Object.hasOwn(UNITS, unit) || !whole(value, 1, 10080) || value * UNITS[unit] > MAX_EXTEND_MS) {
    throw new Error(IDLE_MESSAGES.badExtend);
  }
  return { value, unit };
}

export const durationMs = ({ value, unit }) => value * UNITS[unit];

// "1 hour", "2 hours", "30 minutes": the unit word is plural exactly when the number is not 1.
export function describeDuration(value, unit) {
  return `${value} ${value === 1 ? unit : `${unit}s`}`;
}

// A partial update merged over the current settings, or the defaults. Anything out of range is refused whole.
export function checkSettings(input, current = DEFAULT_SETTINGS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(IDLE_MESSAGES.badSettings);
  const next = { ...current, ...input };
  if (typeof next.enabled !== 'boolean' || typeof next.autoShutdown !== 'boolean') {
    throw new Error(IDLE_MESSAGES.badSettings);
  }
  if (!whole(next.idleMinutes, 1, 240) || !whole(next.autoShutdownMinutes, 1, 240)) {
    throw new Error(IDLE_MESSAGES.badMinutes);
  }
  checkDuration(next.extendValue, next.extendUnit);
  if (next.serverIds !== null) {
    if (!Array.isArray(next.serverIds) || next.serverIds.some((id) => !Number.isInteger(id))) {
      throw new Error(IDLE_MESSAGES.badServers);
    }
    next.serverIds = [...new Set(next.serverIds)].sort((a, b) => a - b);
  }
  return {
    enabled: next.enabled,
    idleMinutes: next.idleMinutes,
    extendValue: next.extendValue,
    extendUnit: next.extendUnit,
    autoShutdown: next.autoShutdown,
    autoShutdownMinutes: next.autoShutdownMinutes,
    serverIds: next.serverIds,
  };
}

// The text of the prompt, shared by every place it is shown.
export function promptText(server, settings) {
  const lines = [
    `${server.name} is still running and nobody has been connected for ${describeDuration(settings.idleMinutes, 'minute')}.`,
  ];
  if (settings.autoShutdown) {
    lines.push(
      `If nobody answers, it saves and shuts down in ${describeDuration(settings.autoShutdownMinutes, 'minute')}.`,
    );
  }
  return lines.join(' ');
}

export const shutdownLabel = 'Save and shut down now';
export const extendLabel = (value, unit) =>
  `Leave it running for ${describeDuration(value, unit)} more, then shut down if nobody is on`;
// The short form for a button that cannot hold the whole sentence.
export const extendShortLabel = (value, unit) => `Leave it ${describeDuration(value, unit)}`;
// The two answers in a sentence, for a place where the buttons have no room for their full labels.
export const choiceText = (value, unit) =>
  `You can save and shut down now, or leave it running for ${describeDuration(value, unit)} more and it shuts down then if nobody is on.`;
