import { useEffect, useRef } from 'react';
import { useNotification } from '@/hooks/useNotification';
import type { AskUserQuestionInfo } from '@/components/messages/messageHelpers';

/**
 * Show a browser notification for each newly pending AskUserQuestion while the
 * tab is hidden. Each question notifies at most once.
 */
export function useAskUserQuestionNotifications(pendingQuestions: AskUserQuestionInfo[]) {
  // Track which AskUserQuestion IDs we've already notified about (using ref to avoid re-renders)
  const notifiedQuestionIdsRef = useRef<Set<string>>(new Set());

  const { showNotification } = useNotification();

  useEffect(() => {
    for (const question of pendingQuestions) {
      if (!notifiedQuestionIdsRef.current.has(question.id)) {
        // Mark as notified (mutating ref doesn't cause re-render)
        notifiedQuestionIdsRef.current.add(question.id);

        // Only show notification if the page is not visible (user is on different tab/window minimized)
        if (document.hidden) {
          showNotification(`Claude: ${question.header}`, {
            body: question.question,
            tag: `ask-user-question-${question.id}`, // Prevents duplicate notifications
            requireInteraction: true, // Keep notification visible until user interacts
          });
        }
      }
    }
  }, [pendingQuestions, showNotification]);
}
