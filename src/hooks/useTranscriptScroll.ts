import { useCallback, useEffect, useRef } from 'react';
import { useVoicePlaybackContext } from '@/hooks/useVoicePlayback';
import type { DisplayMessage } from '@/components/messages/types';

interface TranscriptScrollOptions {
  messages: DisplayMessage[];
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
}

/**
 * Scroll management for the transcript: load older pages from a top sentinel,
 * scroll to the bottom on first load, stick to the bottom as messages arrive or
 * the container shrinks, and follow voice playback. Attach the returned refs to
 * the scroll container, the top sentinel, and the bottom sentinel.
 */
export function useTranscriptScroll({
  messages,
  hasMore,
  isLoading,
  onLoadMore,
}: TranscriptScrollOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const hasInitialScrolled = useRef(false);

  // Voice playback state for playback-aware scrolling
  const { isPlaying: voiceIsPlaying, currentMessageId: voiceCurrentMessageId } =
    useVoicePlaybackContext();

  // Manual IntersectionObserver to detect when sentinel enters viewport
  // Uses the scroll container as root so rootMargin works relative to the container
  useEffect(() => {
    const container = containerRef.current;
    const sentinel = topSentinelRef.current;
    if (!container || !sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && hasMore && !isLoading && hasInitialScrolled.current) {
          onLoadMore();
        }
      },
      {
        root: container,
        rootMargin: '100% 0px 0px 0px',
        threshold: 0,
      }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isLoading, onLoadMore]);

  const scrollToBottom = useCallback(() => {
    // Always use instant scroll to avoid race conditions with smooth animation.
    // Smooth scroll can cause auto-scroll to break: if messages arrive faster than
    // the animation completes, the IntersectionObserver sees the sentinel as
    // not-intersecting mid-animation, isAtBottomRef becomes false, and subsequent
    // messages don't trigger auto-scroll.
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, []);

  // Initial scroll to bottom
  useEffect(() => {
    if (!hasInitialScrolled.current && messages.length > 0) {
      hasInitialScrolled.current = true;
      // Use requestAnimationFrame to ensure DOM has rendered
      requestAnimationFrame(() => {
        scrollToBottom();
      });
    }
  }, [messages, scrollToBottom]);

  // Auto-scroll to bottom when new messages arrive, if user was at bottom.
  // Suppressed when voice playback is actively reading a specific message —
  // in that case, playback-tracking scroll (below) handles positioning instead.
  useEffect(() => {
    const voiceIsTrackingMessage = voiceIsPlaying && voiceCurrentMessageId;
    if (hasInitialScrolled.current && isAtBottomRef.current && !voiceIsTrackingMessage) {
      scrollToBottom();
    }
  }, [messages, scrollToBottom, voiceIsPlaying, voiceCurrentMessageId]);

  // Track if user is at bottom using IntersectionObserver (for auto-scroll on new messages)
  // This is more reliable than scroll-position math because layout changes (textarea resize,
  // tool call expansion) change scrollHeight without firing scroll events.
  useEffect(() => {
    const container = containerRef.current;
    const bottom = bottomRef.current;
    if (!container || !bottom) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) {
          isAtBottomRef.current = entry.isIntersecting;
        }
      },
      {
        root: container,
        rootMargin: '0px 0px 150px 0px',
        threshold: 0,
      }
    );

    observer.observe(bottom);
    return () => observer.disconnect();
  }, []);

  // Re-scroll to bottom when the scroll container shrinks (e.g., VoiceControlPanel
  // appearing/disappearing changes the flex layout). Without this, the container
  // shrinks, the bottom sentinel exits the viewport, isAtBottomRef becomes false,
  // and auto-scroll stops working even though the user was at the bottom.
  //
  // We can't rely on isAtBottomRef here because the IntersectionObserver may have
  // already set it to false by the time the ResizeObserver fires. Instead, we track
  // the previous container height and compute whether the user was at the bottom
  // before the resize by comparing the distance-from-bottom to the height lost.
  const prevContainerHeightRef = useRef(0);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    prevContainerHeightRef.current = container.clientHeight;

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;

      const newHeight = entry.contentRect.height;
      const prevHeight = prevContainerHeightRef.current;
      prevContainerHeightRef.current = newHeight;

      // Only act when the container shrinks (e.g., taller input panel appeared)
      if (prevHeight > 0 && newHeight < prevHeight) {
        const heightLost = prevHeight - newHeight;
        const { scrollTop, scrollHeight, clientHeight } = container;
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

        // If distance from bottom ≈ the height lost, the user was at the bottom
        // before the resize. Re-scroll to bottom to maintain their position.
        if (distanceFromBottom <= heightLost + 50) {
          scrollToBottom();
        }
      }
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [scrollToBottom]);

  // Playback-tracking scroll: when voice playback advances to a new message,
  // scroll to keep that message visible (centered in view).
  // Only triggers when voiceCurrentMessageId changes (not on play/pause toggles).
  const prevVoiceMessageIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prevId = prevVoiceMessageIdRef.current;
    prevVoiceMessageIdRef.current = voiceCurrentMessageId;

    // Only scroll when the message ID changes to a new truthy value while playing.
    // Don't scroll on pause/resume (same ID) or when playback stops (null ID).
    if (!voiceIsPlaying || !voiceCurrentMessageId || voiceCurrentMessageId === prevId) return;

    const messageEl = containerRef.current?.querySelector(
      `[data-message-id="${voiceCurrentMessageId}"]`
    );
    // Instant scroll to avoid race conditions (same reason as scrollToBottom).
    messageEl?.scrollIntoView({ behavior: 'instant', block: 'center' });
  }, [voiceIsPlaying, voiceCurrentMessageId]);

  // When playback stops, transition back to normal auto-scroll behavior.
  // If the user is near the bottom, do a final scroll to bottom.
  const prevVoiceIsPlayingRef = useRef(false);
  useEffect(() => {
    const wasPlaying = prevVoiceIsPlayingRef.current;
    prevVoiceIsPlayingRef.current = voiceIsPlaying;

    // Playback just stopped: if the user is near the bottom, snap back to normal auto-scroll
    if (wasPlaying && !voiceIsPlaying && isAtBottomRef.current) {
      scrollToBottom();
    }
  }, [voiceIsPlaying, scrollToBottom]);

  return { containerRef, topSentinelRef, bottomRef };
}
