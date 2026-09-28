export function parseSteamCmdLine(line) {
  const text = String(line).trim();
  let match = /^Update state \(([^)]+)\) ([^,]+), progress: ([\d.]+) \((\d+) \/ (\d+)\)$/.exec(text);
  if (match)
    return {
      kind: 'progress',
      phase: match[2],
      fraction: Number(match[3]) / 100,
      doneBytes: Number(match[4]),
      totalBytes: Number(match[5]),
    };
  match = /^\[(?:\s*(\d+)%|----)\] (.*)$/.exec(text);
  if (match) {
    const counts = /\(([\d,]+) of ([\d,]+) KB\)/.exec(match[2]);
    const fraction = counts
      ? Number(counts[1].replaceAll(',', '')) / Number(counts[2].replaceAll(',', ''))
      : match[1]
        ? Number(match[1]) / 100
        : null;
    return { kind: 'selfUpdate', fraction, message: match[2] };
  }
  if (text.startsWith("Success! App '2430930'")) return { kind: 'success', message: text };
  if (/^(ERROR|Error)!/.test(text)) return { kind: 'error', message: text };
  return null;
}
