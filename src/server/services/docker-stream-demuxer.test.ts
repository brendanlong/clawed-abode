import { describe, it, expect, beforeEach } from 'vitest';
import { DockerStreamDemuxer, demuxDockerStream } from './docker-stream-demuxer';

/**
 * Create a Docker multiplexed stream frame.
 * @param streamType 0=stdin, 1=stdout, 2=stderr
 * @param data The payload data
 */
function createFrame(streamType: number, data: string): Buffer {
  const payload = Buffer.from(data, 'utf-8');
  const header = Buffer.alloc(8);
  header[0] = streamType;
  // bytes 1-3 are reserved (0)
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe('DockerStreamDemuxer', () => {
  let demuxer: DockerStreamDemuxer;

  beforeEach(() => {
    demuxer = new DockerStreamDemuxer();
  });

  describe('single frame handling', () => {
    it('should extract stdout from a single frame', () => {
      const frame = createFrame(1, 'Hello, World!');
      const result = demuxer.push(frame);

      expect(result).toBe('Hello, World!');
      expect(demuxer.getStdout()).toBe('Hello, World!');
      expect(demuxer.getStderr()).toBe('');
    });

    it('should extract stderr from a single frame', () => {
      const frame = createFrame(2, 'Error message');
      const result = demuxer.push(frame);

      expect(result).toBe('Error message');
      expect(demuxer.getStdout()).toBe('');
      expect(demuxer.getStderr()).toBe('Error message');
    });

    it('should ignore stdin frames', () => {
      const frame = createFrame(0, 'stdin data');
      const result = demuxer.push(frame);

      expect(result).toBe('');
      expect(demuxer.getStdout()).toBe('');
      expect(demuxer.getStderr()).toBe('');
    });
  });

  describe('multiple frames in single chunk', () => {
    it('should handle multiple stdout frames in one chunk', () => {
      const frame1 = createFrame(1, 'First');
      const frame2 = createFrame(1, 'Second');
      const combined = Buffer.concat([frame1, frame2]);

      const result = demuxer.push(combined);

      expect(result).toBe('FirstSecond');
      expect(demuxer.getStdout()).toBe('FirstSecond');
    });

    it('should handle mixed stdout and stderr frames', () => {
      const frame1 = createFrame(1, 'out1');
      const frame2 = createFrame(2, 'err1');
      const frame3 = createFrame(1, 'out2');
      const combined = Buffer.concat([frame1, frame2, frame3]);

      const result = demuxer.push(combined);

      expect(result).toBe('out1err1out2');
      expect(demuxer.getStdout()).toBe('out1out2');
      expect(demuxer.getStderr()).toBe('err1');
    });
  });

  describe('frames split across chunks', () => {
    it('should handle a frame split in the middle of the header', () => {
      const frame = createFrame(1, 'Split test');

      // Split after 4 bytes (middle of header)
      const chunk1 = frame.slice(0, 4);
      const chunk2 = frame.slice(4);

      const result1 = demuxer.push(chunk1);
      expect(result1).toBe('');
      expect(demuxer.hasRemainingData()).toBe(true);

      const result2 = demuxer.push(chunk2);
      expect(result2).toBe('Split test');
    });

    it('should handle a frame split between header and payload', () => {
      const frame = createFrame(1, 'Split test');

      // Split exactly at header boundary (8 bytes)
      const chunk1 = frame.slice(0, 8);
      const chunk2 = frame.slice(8);

      const result1 = demuxer.push(chunk1);
      expect(result1).toBe('');

      const result2 = demuxer.push(chunk2);
      expect(result2).toBe('Split test');
    });

    it('should handle a frame split in the middle of the payload', () => {
      const frame = createFrame(1, 'Split test');

      // Split in middle of payload
      const chunk1 = frame.slice(0, 12);
      const chunk2 = frame.slice(12);

      const result1 = demuxer.push(chunk1);
      expect(result1).toBe('');

      const result2 = demuxer.push(chunk2);
      expect(result2).toBe('Split test');
    });

    it('should handle multiple frames with one split across chunks', () => {
      const frame1 = createFrame(1, 'First');
      const frame2 = createFrame(1, 'Second');
      const combined = Buffer.concat([frame1, frame2]);

      // Split in the middle of the second frame
      const splitPoint = frame1.length + 5;
      const chunk1 = combined.slice(0, splitPoint);
      const chunk2 = combined.slice(splitPoint);

      const result1 = demuxer.push(chunk1);
      expect(result1).toBe('First');

      const result2 = demuxer.push(chunk2);
      expect(result2).toBe('Second');
    });
  });

  describe('realistic long message scenario', () => {
    it('should handle a long JSON message split across multiple frames', () => {
      // Simulate a long Claude Code response that gets split into multiple Docker frames
      const longMessage = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'test-id',
              content: 'A'.repeat(5000), // Long content
            },
          ],
        },
        session_id: 'test-session',
        uuid: 'test-uuid',
      });

      // Split into multiple ~1KB frames (like Docker might do)
      const frames: Buffer[] = [];
      const chunkSize = 1024;
      for (let i = 0; i < longMessage.length; i += chunkSize) {
        const chunk = longMessage.slice(i, i + chunkSize);
        frames.push(createFrame(1, chunk));
      }

      // Push all frames
      let accumulated = '';
      for (const frame of frames) {
        accumulated += demuxer.push(frame);
      }

      expect(accumulated).toBe(longMessage);
      expect(demuxer.getStdout()).toBe(longMessage);
    });

    it('should handle frames with embedded Docker headers in data', () => {
      // The problematic case: data that looks like Docker headers
      // This tests that we correctly parse based on the header's size field
      const dataWithHeaderLikeBytes = Buffer.concat([
        Buffer.from('Before '),
        Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10]), // Looks like a header
        Buffer.from(' After'),
      ]).toString('utf-8');

      const frame = createFrame(1, dataWithHeaderLikeBytes);
      const result = demuxer.push(frame);

      expect(result).toBe(dataWithHeaderLikeBytes);
    });
  });

  describe('flush', () => {
    it('should return remaining data on flush', () => {
      // Push an incomplete frame (just partial header)
      demuxer.push(Buffer.from([0x01, 0x00, 0x00, 0x00]));

      const remaining = demuxer.flush();
      expect(remaining.length).toBe(4);
      expect(demuxer.hasRemainingData()).toBe(false);
    });

    it('should handle flush with no remaining data', () => {
      const frame = createFrame(1, 'Complete');
      demuxer.push(frame);

      const remaining = demuxer.flush();
      expect(remaining).toBe('');
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      const frame = createFrame(1, 'Data');
      demuxer.push(frame);

      demuxer.reset();

      expect(demuxer.getStdout()).toBe('');
      expect(demuxer.getStderr()).toBe('');
      expect(demuxer.getCombined()).toBe('');
      expect(demuxer.hasRemainingData()).toBe(false);
    });
  });

  describe('non-multiplexed fallback', () => {
    it('should treat invalid stream type as raw text', () => {
      // Stream type > 2 is invalid
      const invalidHeader = Buffer.concat([
        Buffer.from([0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04]),
        Buffer.from('test'),
      ]);

      const result = demuxer.push(invalidHeader);

      // Should treat the entire buffer as raw text
      expect(result.length).toBe(12);
      expect(demuxer.getStdout().length).toBe(12);
    });
  });
});

describe('demuxDockerStream helper', () => {
  it('should demux a complete buffer with multiple frames', () => {
    const frame1 = createFrame(1, 'Hello');
    const frame2 = createFrame(1, ' World');
    const combined = Buffer.concat([frame1, frame2]);

    const result = demuxDockerStream(combined);
    expect(result).toBe('Hello World');
  });
});
