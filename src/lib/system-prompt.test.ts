import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from './system-prompt';

describe('buildSystemPrompt', () => {
  it('should return default prompt when no options provided', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('commit your changes');
    expect(prompt).toContain('push your commits');
  });

  it('should warn against unscoped process kills and give the exact scoped command', () => {
    const prompt = buildSystemPrompt({});
    // The full command form is pinned so a regression in the sed/cgroup
    // extraction or the template-literal escaping fails the test.
    expect(prompt).toContain(`pkill --cgroup "$(sed 's#^0::##' /proc/self/cgroup)" -f <pattern>`);
    // The guard against the unwrapped-fallback case (shared cgroup) must survive.
    expect(prompt).toContain('clawed-session-<id>.scope');
  });

  it('should warn against mutating global/user-level config on the shared host', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('git config --global');
    expect(prompt).toContain('git config --local');
  });

  it('should use global override when enabled', () => {
    const prompt = buildSystemPrompt({
      globalSettings: {
        systemPromptOverride: 'Custom override',
        systemPromptOverrideEnabled: true,
        systemPromptAppend: null,
      },
    });
    expect(prompt).toBe('Custom override');
    expect(prompt).not.toContain('commit your changes');
  });

  it('should not use global override when disabled', () => {
    const prompt = buildSystemPrompt({
      globalSettings: {
        systemPromptOverride: 'Custom override',
        systemPromptOverrideEnabled: false,
        systemPromptAppend: null,
      },
    });
    expect(prompt).toContain('commit your changes');
    expect(prompt).not.toContain('Custom override');
  });

  it('should append global content', () => {
    const prompt = buildSystemPrompt({
      globalSettings: {
        systemPromptOverride: null,
        systemPromptOverrideEnabled: false,
        systemPromptAppend: 'Global append',
      },
    });
    expect(prompt).toContain('commit your changes');
    expect(prompt).toContain('Global append');
  });

  it('should append per-repo custom prompt', () => {
    const prompt = buildSystemPrompt({
      customSystemPrompt: 'Repo-specific prompt',
    });
    expect(prompt).toContain('commit your changes');
    expect(prompt).toContain('Repo-specific prompt');
  });

  it('should apply all three layers in order', () => {
    const prompt = buildSystemPrompt({
      customSystemPrompt: 'Repo prompt',
      globalSettings: {
        systemPromptOverride: 'Override',
        systemPromptOverrideEnabled: true,
        systemPromptAppend: 'Global append',
      },
    });
    expect(prompt).toBe('Override\n\nGlobal append\n\nRepo prompt');
  });
});
