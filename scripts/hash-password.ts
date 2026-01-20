#!/usr/bin/env tsx
import * as argon2 from 'argon2';

async function main() {
  const password = process.argv[2];

  if (!password) {
    console.error('Usage: pnpm hash-password <password>');
    console.error('');
    console.error(
      'Generates a base64-encoded Argon2 hash for the PASSWORD_HASH environment variable.'
    );
    console.error('The hash is base64-encoded to avoid issues with $ characters in dotenv.');
    process.exit(1);
  }

  const hash = await argon2.hash(password);
  const base64Hash = Buffer.from(hash).toString('base64');
  console.log(base64Hash);
}

main();
