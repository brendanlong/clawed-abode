import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReadDisplay } from './ReadDisplay';
import type { ToolCall } from './types';

describe('ReadDisplay input validation', () => {
  it('keeps rendering the good fields when one input field has the wrong type', () => {
    const tool: ToolCall = {
      name: 'Read',
      id: 'read-1',
      input: { file_path: 'src/app.ts', offset: '10' },
      output: '1\tconst a = 1;',
    };

    render(<ReadDisplay tool={tool} />);

    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    expect(screen.queryByText('Unknown file')).not.toBeInTheDocument();
  });

  it('falls back to placeholders for a still-streaming (empty) input', () => {
    render(<ReadDisplay tool={{ name: 'Read', id: 'read-2', input: {} }} />);

    expect(screen.getAllByText('Unknown file').length).toBeGreaterThan(0);
  });
});
