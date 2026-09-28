import path from 'node:path';

export function parseNetstat(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(UDP|TCP)\s+(\S+):(\d+)\s+(\S+)(?:\s+(\S+))?\s+(\d+)$/i);
    if (!match) continue;
    const protocol = match[1].toLowerCase();
    // netstat prints the state in the display language, so a listening socket is recognised by its
    // foreign port of 0, which every language shares, and is always reported as LISTENING.
    const listening = protocol === 'tcp' && /:0$/.test(match[4]);
    const state = protocol === 'udp' ? null : listening ? 'LISTENING' : (match[5] ?? null);
    rows.push({ protocol, address: match[2], port: Number(match[3]), state, pid: Number(match[6]) });
  }
  return rows;
}

export async function listListeners({ runner }) {
  let output = '';
  const root = process.env.SystemRoot || 'C:\\Windows';
  const command = path.win32.join(root, 'System32', 'netstat.exe');
  const { code } = await runner(command, ['-ano'], {
    onLine: (line) => {
      output += `${line}\n`;
    },
  });
  if (code !== 0) throw new Error(`netstat exited with code ${code}`);
  return parseNetstat(output);
}
