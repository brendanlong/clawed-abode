import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MessageStore } from './message-store.js';

describe('MessageStore', () => {
  let store: MessageStore;

  beforeEach(() => {
    // Use in-memory SQLite for tests
    store = new MessageStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('append', () => {
    it('should append a message and return the sequence number', () => {
      const seq = store.append('session-1', 'assistant', '{"type":"assistant"}');
      expect(seq).toBe(1);
    });

    it('should auto-increment sequence numbers', () => {
      const seq1 = store.append('session-1', 'assistant', '{"type":"assistant","data":"first"}');
      const seq2 = store.append('session-1', 'user', '{"type":"user","data":"second"}');
      const seq3 = store.append('session-1', 'result', '{"type":"result","data":"third"}');

      expect(seq1).toBe(1);
      expect(seq2).toBe(2);
      expect(seq3).toBe(3);
    });

    it('should support multiple sessions', () => {
      store.append('session-1', 'assistant', '{"data":"s1-m1"}');
      store.append('session-2', 'assistant', '{"data":"s2-m1"}');
      store.append('session-1', 'user', '{"data":"s1-m2"}');

      expect(store.getCount('session-1')).toBe(2);
      expect(store.getCount('session-2')).toBe(1);
    });
  });

  describe('getAfter', () => {
    it('should return all messages after a given sequence', () => {
      store.append('session-1', 'system', '{"type":"system"}');
      store.append('session-1', 'assistant', '{"type":"assistant"}');
      store.append('session-1', 'user', '{"type":"user"}');

      const messages = store.getAfter(1);
      expect(messages).toHaveLength(2);
      expect(messages[0].sequence).toBe(2);
      expect(messages[1].sequence).toBe(3);
    });

    it('should return all messages when after=0', () => {
      store.append('session-1', 'system', '{"type":"system"}');
      store.append('session-1', 'assistant', '{"type":"assistant"}');

      const messages = store.getAfter(0);
      expect(messages).toHaveLength(2);
    });

    it('should return empty array when no messages exist after sequence', () => {
      store.append('session-1', 'system', '{"type":"system"}');

      const messages = store.getAfter(1);
      expect(messages).toHaveLength(0);
    });

    it('should return messages in ascending order', () => {
      store.append('session-1', 'system', '{"seq":1}');
      store.append('session-1', 'assistant', '{"seq":2}');
      store.append('session-1', 'user', '{"seq":3}');

      const messages = store.getAfter(0);
      expect(messages[0].sequence).toBeLessThan(messages[1].sequence);
      expect(messages[1].sequence).toBeLessThan(messages[2].sequence);
    });

    it('should include content as JSON string', () => {
      const content = '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}';
      store.append('session-1', 'assistant', content);

      const messages = store.getAfter(0);
      expect(messages[0].content).toBe(content);
    });
  });

  describe('getLastSequence', () => {
    it('should return 0 when no messages exist', () => {
      expect(store.getLastSequence()).toBe(0);
    });

    it('should return the highest sequence number', () => {
      store.append('session-1', 'system', '{}');
      store.append('session-1', 'assistant', '{}');
      store.append('session-1', 'user', '{}');

      expect(store.getLastSequence()).toBe(3);
    });
  });

  describe('getCount', () => {
    it('should return 0 for unknown session', () => {
      expect(store.getCount('nonexistent')).toBe(0);
    });

    it('should return correct count per session', () => {
      store.append('session-1', 'system', '{}');
      store.append('session-1', 'assistant', '{}');
      store.append('session-2', 'system', '{}');

      expect(store.getCount('session-1')).toBe(2);
      expect(store.getCount('session-2')).toBe(1);
    });
  });
});
