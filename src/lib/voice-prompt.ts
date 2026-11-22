const LISTENING_NOTE = '[The user is listening to replies read aloud]';

export const VOICE_SYSTEM_NOTE = `The user can have your replies read aloud. Messages they send while listening start with \`${LISTENING_NOTE}\`; otherwise they are reading. While they're listening, write conversationally, the way you'd say it out loud, and wrap anything that's only useful to read (long URLs, file paths, tables, code, raw output) in \`<unspoken>…</unspoken>\`: it still shows in the transcript but isn't read aloud. It works inline or around whole blocks, and you can mix it into your reply wherever is easiest. Read-aloud already skips markdown syntax and link targets (\`[PR #123](url)\` is read as "PR #123"), so only tag what you'd rather not hear. Do read out a table or link when hearing it is actually useful.`;

export function withListeningNote(prompt: string, listening: boolean): string {
  return listening ? `${LISTENING_NOTE}\n\n${prompt}` : prompt;
}
