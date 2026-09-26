'use client';

import { useMemo, useState } from 'react';
import { SearchableCombobox, type ComboboxOption } from '@/components/SearchableCombobox';
import { matchesAllTerms } from '@/lib/search';
import { searchVoices, type NamedVoice } from '@/lib/tts';

interface VoicePickerProps {
  voices: readonly NamedVoice[];
  /** The chosen voice URI, or null for auto-detect. */
  value: string | null;
  onChange: (voiceURI: string | null) => void;
  /** Locale whose voices are listed first (normally `navigator.language`). */
  locale: string;
}

const AUTO_DETECT_LABEL = 'Auto-detect (match browser language)';
const AUTO_DETECT_VALUE = '__auto__';

function describeVoice(voice: NamedVoice): string {
  return `${voice.name} (${voice.lang})${voice.localService ? '' : ' [network]'}`;
}

/** A searchable voice chooser; the list is capped and mounted only while open (see {@link searchVoices}). */
export function VoicePicker({ voices, value, onChange, locale }: VoicePickerProps) {
  const [query, setQuery] = useState('');

  const selected = value === null ? null : voices.find((v) => v.voiceURI === value);
  const triggerLabel =
    value === null
      ? AUTO_DETECT_LABEL
      : selected
        ? describeVoice(selected)
        : 'Saved voice is unavailable; using auto-detect';

  const { matches, total } = useMemo(
    () => searchVoices(voices, query, locale, value),
    [voices, query, locale, value]
  );
  const showAutoDetect = matchesAllTerms(AUTO_DETECT_LABEL, query);

  const options: ComboboxOption[] = [
    ...(showAutoDetect
      ? [{ value: AUTO_DETECT_VALUE, label: AUTO_DETECT_LABEL, selected: value === null }]
      : []),
    ...matches.map((voice) => ({
      value: voice.voiceURI,
      label: describeVoice(voice),
      selected: value === voice.voiceURI,
    })),
  ];

  return (
    <SearchableCombobox
      triggerLabel={triggerLabel}
      ariaLabel="TTS voice"
      searchPlaceholder="Search voices by name or language…"
      emptyText="No matching voices"
      query={query}
      onQueryChange={setQuery}
      options={options}
      onSelect={(v) => onChange(v === AUTO_DETECT_VALUE ? null : v)}
      cap={{ matches, total, noun: 'voices' }}
    />
  );
}
