/**
 * Check if the accumulated transcript ends with a trigger word as a standalone phrase.
 *
 * "Standalone" means the trigger appears as its own sentence/utterance at the end.
 * For example, with trigger "Over":
 *   - "fix the bug. Over." → match (standalone sentence)
 *   - "Over." → match
 *   - "over" → match (case-insensitive)
 *   - "it's over" → NO match (part of a larger sentence)
 *   - "game over" → NO match (compound phrase)
 *   - "hand it over. Over." → match (last "Over" is standalone)
 *
 * The trigger is considered standalone if it appears at the end and is either:
 *   1. The entire text, or
 *   2. Preceded by sentence-ending punctuation + whitespace (e.g., ". ", "! ", "? ")
 *
 * @returns The transcript with the trigger word stripped, or null if no trigger detected.
 */
export function detectTriggerWord(transcript: string, triggerWord: string): string | null {
  if (!transcript || !triggerWord) {
    return null;
  }

  const trimmedTranscript = transcript.trim();
  const trimmedTrigger = triggerWord.trim();

  if (!trimmedTranscript || !trimmedTrigger) {
    return null;
  }

  // Normalize: strip trailing punctuation from the trigger for matching purposes
  const triggerNorm = trimmedTrigger.replace(/[.!?,;:]+$/, '').toLowerCase();

  if (!triggerNorm) {
    return null;
  }

  // Strip trailing punctuation from transcript for matching
  const transcriptNorm = trimmedTranscript.replace(/[.!?,;:]+$/, '').toLowerCase();

  // Check if the entire transcript is just the trigger word
  if (transcriptNorm === triggerNorm) {
    return '';
  }

  // Check if transcript ends with the trigger word preceded by sentence boundary
  // A sentence boundary is: punctuation + optional whitespace before the trigger
  const sentenceBoundaryPattern = new RegExp(
    `[.!?]\\s+${escapeRegExp(triggerNorm)}[.!?,;:]*\\s*$`,
    'i'
  );

  if (sentenceBoundaryPattern.test(trimmedTranscript)) {
    // Strip the trigger word and the sentence boundary from the end
    const strippedPattern = new RegExp(`\\s+${escapeRegExp(triggerNorm)}[.!?,;:]*\\s*$`, 'i');
    return trimmedTranscript.replace(strippedPattern, '').trim();
  }

  return null;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
