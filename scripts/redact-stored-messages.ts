#!/usr/bin/env tsx
import { redactStoredMessages } from '@/server/services/message-store';

async function main() {
  const rewritten = await redactStoredMessages();
  console.log(`Redacted secrets in ${rewritten} stored messages.`);
}

main();
