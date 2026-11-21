import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execAsync = promisify(exec);

export async function sqliteTool(args = {}) {
  const { db_path, query } = args;
  if (!db_path || !query) {
    return { ok: false, error: 'db_path and query are required' };
  }
  try {
    const resolvedPath = path.resolve(db_path);
    // Use sqlite3 command line if available or node sqlite
    const command = `sqlite3 -json ${JSON.stringify(resolvedPath)} ${JSON.stringify(query)}`;
    const { stdout, stderr } = await execAsync(command);
    let data = [];
    try {
      data = JSON.parse(stdout || '[]');
    } catch {
      data = stdout.trim();
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
