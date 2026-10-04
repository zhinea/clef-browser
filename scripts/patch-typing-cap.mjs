#!/usr/bin/env node
/**
 * scripts/patch-typing-cap.mjs — make jev-browser's typing token cap configurable.
 *
 * Why: @jkudish/jev-browser hardcodes maxOutputTokens: 48 for custom
 * OpenAI-compatible typing providers (the `compatible-endpoint` branch in
 * dist/navigate.js). Reasoning models such as @cf/google/gemma-4-26b-a4b-it
 * spend those 48 tokens on chain-of-thought (surfaced as `reasoning_content`)
 * and return an empty `content`, so every typing action fails with
 * "typing_generator_empty".
 *
 * The patch replaces the hardcoded 48 with:
 *   Math.max(48, Number(process.env.JEV_BROWSER_TYPE_MAX_TOKENS) || 0)
 * i.e. 48 stays the floor; set JEV_BROWSER_TYPE_MAX_TOKENS=300 (or similar)
 * when the typing model needs room to reason.
 *
 * Idempotent: safe to run on every `npm install` (see package.json postinstall).
 * Verified against @jkudish/jev-browser 0.x dist/navigate.js.
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const target = require.resolve("@jkudish/jev-browser/dist/navigate.js");
const src = readFileSync(target, "utf8");

const OLD = ": { maxOutputTokens: 48 };";
const NEW =
  ": { maxOutputTokens: Math.max(48, Number(process.env.JEV_BROWSER_TYPE_MAX_TOKENS) || 0) };";

if (src.includes(NEW)) {
  console.log("[patch-typing-cap] already applied, nothing to do.");
  process.exit(0);
}
if (src.split(OLD).length - 1 !== 1) {
  console.error(
    "[patch-typing-cap] expected exactly 1 occurrence of the 48-token cap; " +
      "upstream dist may have changed — refusing to patch."
  );
  process.exit(1);
}
copyFileSync(target, target + ".pre-typing-cap.bak");
writeFileSync(target, src.replace(OLD, NEW));
console.log("[patch-typing-cap] applied. Set JEV_BROWSER_TYPE_MAX_TOKENS to raise the cap.");
