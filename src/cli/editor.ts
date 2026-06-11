/**
 * $EDITOR-based JSON document editing for the abode CLI.
 *
 * Writes the document (with `//` help comments) to a 0600 tmpfile, opens the
 * user's editor, then validates the result with zod — looping on parse or
 * validation errors so a typo never loses the edit.
 */

import { spawnSync } from 'child_process';
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { z } from 'zod';
import { confirm } from '@inquirer/prompts';

/** Strip lines whose first non-whitespace characters are `//`. */
export function stripCommentLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Parse and validate an edited document (comments stripped first). */
export function parseEditorDocument<T>(schema: z.ZodType<T>, text: string): ParseResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(stripCommentLines(text));
  } catch (error) {
    return { ok: false, error: `Invalid JSON: ${(error as Error).message}` };
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    return { ok: false, error: `Validation failed:\n${issues}` };
  }
  return { ok: true, value: result.data };
}

/**
 * Open a JSON document in $EDITOR and return the validated result, or null
 * if the user made no changes or gave up after a validation error.
 */
export async function editDocument<T>(options: {
  schema: z.ZodType<T>;
  initial: unknown;
  helpLines: string[];
}): Promise<T | null> {
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  const dir = await mkdtemp(join(tmpdir(), 'abode-settings-'));
  const filePath = join(dir, 'settings.json');

  const originalBody = JSON.stringify(options.initial, null, 2);
  const header = options.helpLines.map((line) => `// ${line}`).join('\n');
  await writeFile(filePath, `${header}\n${originalBody}\n`, { mode: 0o600 });

  try {
    while (true) {
      const result = spawnSync(editor, [filePath], { stdio: 'inherit' });
      if (result.status !== 0) {
        console.error(`Editor exited with status ${result.status}; discarding changes.`);
        return null;
      }

      const edited = stripCommentLines(await readFile(filePath, 'utf-8')).trim();
      if (edited === originalBody.trim()) {
        return null; // No changes
      }

      const parsed = parseEditorDocument(options.schema, edited);
      if (parsed.ok) {
        return parsed.value;
      }

      console.error(`\n${parsed.error}\n`);
      const retry = await confirm({ message: 'Re-open the editor to fix it?', default: true });
      if (!retry) return null;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
