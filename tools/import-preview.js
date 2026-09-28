import { openDatabase } from '../src/db/index.js';
import { detectPhase0, previewImport } from '../src/import/phase0.js';

const folder = process.argv[2];
if (!folder) {
  process.stderr.write('Usage: node tools/import-preview.js <dashboard folder>\n');
  process.exitCode = 1;
} else {
  try {
    const detection = await detectPhase0(folder);
    const db = openDatabase(':memory:');
    try {
      const result = previewImport(db, detection);
      for (const item of result.servers) {
        const server = detection.servers.find((entry) => entry.profileId === item.profileId);
        process.stdout.write(
          `${item.name} | map ${item.server.map} | install ${item.install.path} (${item.install.source}) | build ${item.install.buildId ?? 'unknown'}\n`,
        );
        process.stdout.write(
          `Ports: ${item.server.game_port}, ${item.server.query_port}, ${item.server.rcon_port} | players ${item.server.max_players} | mods ${item.server.settings.mods.join(', ') || 'none'} | BattlEye ${item.server.settings.disableBattlEye ? 'disabled' : 'enabled'}\n`,
        );
        process.stdout.write(
          `Server password: ${server.hasServerPassword ? 'yes' : 'no'} | Admin password: ${server.hasAdminPassword ? 'yes' : 'no'}\n`,
        );
        for (const file of item.files)
          process.stdout.write(`File: ${file.relPath} (${file.size} bytes, ${file.sha256.slice(0, 12)})\n`);
        for (const issue of [...item.problems, ...item.conflicts, ...item.warnings])
          process.stdout.write(`${issue.code}: ${issue.message}\n`);
      }
      if (result.servers.some((item) => !item.ok)) process.exitCode = 1;
    } finally {
      db.close();
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
