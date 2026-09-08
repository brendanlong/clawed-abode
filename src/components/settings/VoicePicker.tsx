'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { matchesAllTerms, searchVoices, type NamedVoice } from '@/lib/tts';

interface VoicePickerProps {
  voices: readonly NamedVoice[];
  /** The chosen voice URI, or null for auto-detect. */
  value: string | null;
  onChange: (voiceURI: string | null) => void;
  /** Locale whose voices are listed first (normally `navigator.language`). */
  locale: string;
}

const AUTO_DETECT_LABEL = 'Auto-detect (match browser language)';

function describeVoice(voice: NamedVoice): string {
  return `${voice.name} (${voice.lang})${voice.localService ? '' : ' [network]'}`;
}

/** A searchable voice chooser; the list is capped and mounted only while open (see {@link searchVoices}). */
export function VoicePicker({ voices, value, onChange, locale }: VoicePickerProps) {
  const [open, setOpen] = useState(false);
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

  const choose = (voiceURI: string | null) => {
    onChange(voiceURI);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="TTS voice"
          className="w-full justify-between font-normal"
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-[var(--radix-popover-trigger-width)]" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search voices by name or language…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>No matching voices</CommandEmpty>
            <CommandGroup>
              {showAutoDetect && (
                <CommandItem value="__auto__" onSelect={() => choose(null)}>
                  <Check className={cn('h-4 w-4', value === null ? 'opacity-100' : 'opacity-0')} />
                  {AUTO_DETECT_LABEL}
                </CommandItem>
              )}
              {matches.map((voice) => (
                <CommandItem
                  key={voice.voiceURI}
                  value={voice.voiceURI}
                  onSelect={() => choose(voice.voiceURI)}
                >
                  <Check
                    className={cn(
                      'h-4 w-4',
                      value === voice.voiceURI ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className="truncate">{describeVoice(voice)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {total > matches.length && (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              Showing {matches.length} of {total.toLocaleString()} voices. Keep typing to narrow the
              list.
            </p>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
