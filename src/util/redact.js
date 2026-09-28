// Masks secrets in text that is about to leave the process: log lines shown in the Live Log panel
// and error messages sent to a browser. ShooterGame.log records the server's own launch line, so
// anything passed as ?SomethingPassword=value there would otherwise show up in the UI verbatim.

export const MASK = '********';

const PATTERNS = [
  // ServerPassword=..., ServerAdminPassword=..., SpectatorPassword=... in a launch URL or ini line.
  [/(\b\w*password\w*\s*=\s*)[^?&\s"']+/gi, `$1${MASK}`],
  // The same keys inside JSON, such as a settings body quoted in an error: "ServerPassword":"x".
  [/("[^"]*password[^"]*"\s*:\s*")[^"]*(")/gi, `$1${MASK}$2`],
  // Header-style secrets, in case a request or response ever gets logged.
  [
    /(\b(?:x-api-key|authorization|cf-access-jwt-assertion)\s*[:=]\s*)(?:(?:basic|bearer)\s+)?[^\s"',;]+/gi,
    `$1${MASK}`,
  ],
];

export function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}
