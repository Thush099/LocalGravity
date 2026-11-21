import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export async function dockerTool(args = {}) {
  const { action = 'ps', container_id, lines = 50 } = args;
  try {
    switch (action) {
      case 'ps': {
        const { stdout } = await execAsync('docker ps -a --format "{{json .}}"');
        const containers = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        return { ok: true, containers };
      }
      case 'logs': {
        if (!container_id) throw new Error('container_id is required for logs');
        const { stdout } = await execAsync(`docker logs --tail ${Number(lines) || 50} ${JSON.stringify(container_id)}`);
        return { ok: true, logs: stdout };
      }
      case 'stats': {
        const { stdout } = await execAsync('docker stats --no-stream --format "{{json .}}"');
        const stats = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        return { ok: true, stats };
      }
      default:
        throw new Error(`Unknown docker action: ${action}`);
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
