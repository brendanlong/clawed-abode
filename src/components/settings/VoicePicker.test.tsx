import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VoicePicker, type PickableVoice } from './VoicePicker';
import { VOICE_PICKER_LIMIT } from '@/lib/tts';

function makeVoices(count: number): PickableVoice[] {
  return Array.from({ length: count }, (_, i) => ({
    voiceURI: `urn:voice:${i}`,
    name: `Voice ${i}`,
    lang: i % 3 === 0 ? 'en-US' : 'de-DE',
    localService: true,
  }));
}

describe('VoicePicker', () => {
  it('renders no options while closed and at most the cap once open', async () => {
    const user = userEvent.setup();
    render(<VoicePicker voices={makeVoices(5000)} value={null} onChange={vi.fn()} locale="en" />);

    expect(screen.queryAllByRole('option')).toHaveLength(0);

    await user.click(screen.getByRole('combobox', { name: 'TTS voice' }));

    const options = await screen.findAllByRole('option');
    // The auto-detect entry rides along with the capped voice list.
    expect(options.length).toBeLessThanOrEqual(VOICE_PICKER_LIMIT + 1);
    expect(screen.getByText(/Showing 50 of 5,000 voices/)).toBeInTheDocument();
  });

  it('filters by the typed query and reports the chosen voice', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<VoicePicker voices={makeVoices(100)} value={null} onChange={onChange} locale="en" />);

    await user.click(screen.getByRole('combobox', { name: 'TTS voice' }));
    await user.type(screen.getByPlaceholderText(/Search voices/), 'voice 42');

    await user.click(await screen.findByText('Voice 42 (en-US)'));
    expect(onChange).toHaveBeenCalledWith('urn:voice:42');
  });

  it('shows the selected voice on the trigger and lets auto-detect clear it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <VoicePicker voices={makeVoices(10)} value="urn:voice:3" onChange={onChange} locale="en" />
    );

    expect(screen.getByRole('combobox', { name: 'TTS voice' })).toHaveTextContent(
      'Voice 3 (en-US)'
    );

    await user.click(screen.getByRole('combobox', { name: 'TTS voice' }));
    await user.click(await screen.findByText('Auto-detect (match browser language)'));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
