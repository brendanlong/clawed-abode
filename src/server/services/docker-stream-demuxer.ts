/**
 * Docker Stream Demultiplexer
 *
 * Docker exec streams use a multiplexed format where stdout and stderr are
 * interleaved with 8-byte frame headers. This module properly parses that
 * format to extract the actual content.
 *
 * Frame format:
 * - Byte 0: Stream type (0=stdin, 1=stdout, 2=stderr)
 * - Bytes 1-3: Reserved (always 0)
 * - Bytes 4-7: Payload size (big-endian uint32)
 * - Bytes 8+: Payload data
 *
 * Multiple frames can appear in a single chunk, and frames can span
 * chunk boundaries.
 */

const HEADER_SIZE = 8;

export type StreamType = 'stdin' | 'stdout' | 'stderr' | 'unknown';

export interface DemuxedFrame {
  streamType: StreamType;
  data: string;
}

/**
 * Stateful demultiplexer for Docker exec streams.
 * Call push() with each chunk, then read accumulated text from stdout/stderr.
 */
export class DockerStreamDemuxer {
  private buffer: Buffer = Buffer.alloc(0);
  private stdoutText: string = '';
  private stderrText: string = '';

  /**
   * Push a chunk of data and extract any complete frames.
   * Returns the text extracted from this chunk (stdout + stderr combined).
   */
  push(chunk: Buffer): string {
    // Append new data to buffer
    this.buffer = Buffer.concat([this.buffer, chunk]);

    let extractedText = '';

    // Process all complete frames in the buffer
    while (this.buffer.length >= HEADER_SIZE) {
      // Read frame header
      const streamType = this.buffer[0];
      const payloadSize = this.buffer.readUInt32BE(4);

      // Check if we have the complete frame
      const frameSize = HEADER_SIZE + payloadSize;
      if (this.buffer.length < frameSize) {
        // Incomplete frame, wait for more data
        break;
      }

      // Validate stream type (should be 0, 1, or 2)
      if (streamType > 2) {
        // Invalid header - this might not be a multiplexed stream
        // Fall back to treating the entire buffer as raw text
        const text = this.buffer.toString('utf-8');
        this.stdoutText += text;
        extractedText += text;
        this.buffer = Buffer.alloc(0);
        break;
      }

      // Extract payload
      const payload = this.buffer.slice(HEADER_SIZE, frameSize);
      const text = payload.toString('utf-8');

      // Accumulate based on stream type
      if (streamType === 1) {
        // stdout
        this.stdoutText += text;
        extractedText += text;
      } else if (streamType === 2) {
        // stderr
        this.stderrText += text;
        extractedText += text;
      }
      // streamType 0 (stdin) is ignored

      // Remove processed frame from buffer
      this.buffer = this.buffer.slice(frameSize);
    }

    return extractedText;
  }

  /**
   * Get all accumulated stdout text.
   */
  getStdout(): string {
    return this.stdoutText;
  }

  /**
   * Get all accumulated stderr text.
   */
  getStderr(): string {
    return this.stderrText;
  }

  /**
   * Get combined stdout + stderr text.
   */
  getCombined(): string {
    return this.stdoutText + this.stderrText;
  }

  /**
   * Check if there's any remaining data in the buffer (incomplete frame).
   */
  hasRemainingData(): boolean {
    return this.buffer.length > 0;
  }

  /**
   * Get any remaining data as raw text (for handling non-multiplexed streams
   * or flushing at end of stream).
   */
  flush(): string {
    if (this.buffer.length === 0) {
      return '';
    }
    const remaining = this.buffer.toString('utf-8');
    this.buffer = Buffer.alloc(0);
    return remaining;
  }

  /**
   * Reset the demuxer state.
   */
  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.stdoutText = '';
    this.stderrText = '';
  }
}

/**
 * Simple helper to demux a single complete buffer.
 * Use DockerStreamDemuxer class for streaming data.
 */
export function demuxDockerStream(data: Buffer): string {
  const demuxer = new DockerStreamDemuxer();
  demuxer.push(data);
  const remaining = demuxer.flush();
  return demuxer.getCombined() + remaining;
}
