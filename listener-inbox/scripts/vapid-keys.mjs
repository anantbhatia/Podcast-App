#!/usr/bin/env node
// Makes the VAPID key pair for browser push and prints the PRIVATE key (a P-256 JWK) on
// stdout, so it can go straight into the worker's secret without ever being shown:
//   node scripts/vapid-keys.mjs | npx --yes wrangler@4 secret put VAPID_PRIVATE_KEY
// The worker derives the public key from it (src/push.mjs), so nothing else is needed.
// It refuses to write anywhere but a pipe, so the key is never on screen or in a file.
// Setting a new key signs out every browser that subscribed with the old one.
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
import { fstatSync } from "node:fs";
// Only a pipe will do: not a terminal (it would show), not a file (it would be kept).
if (!fstatSync(1).isFIFO()) {
  console.error("Refusing: the private key only goes down a pipe, straight into wrangler:\n  node scripts/vapid-keys.mjs | npx --yes wrangler@4 secret put VAPID_PRIVATE_KEY");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d }));
console.error("VAPID key pair made; the private key went to stdout only.");
