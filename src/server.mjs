#!/usr/bin/env node
// jev-browser-clef: MCP stdio server exposing jev_navigate, with judgments
// served by Cloudflare Workers AI `clef` (@cf/cloudflare/clef) instead of
// the built-in Jev providers. Browser logic is NOT reimplemented here — the
// run itself is @jkudish/jev-browser's navigate(), called with an injected
// clef judgment transport.
//
//   node src/server.mjs          # MCP stdio server
//
// Env (required): CLOUDFLARE_API_TOKEN (or JEV_CLOUDFLARE_API_TOKEN, which
// takes precedence) + CLOUDFLARE_ACCOUNT_ID. Optional: JEV_BROWSER_MODEL
// (reported as the requested model; judgments still run on clef),
// JEV_BROWSER_HEADED=1, JEV_BROWSER_PASSWORD_ORIGIN, JEV_BROWSER_HANDOFF_DIR.

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { createRequire } from "node:module";
import { navigate } from "@jkudish/jev-browser";
import { createClefTransport, TRANSPORT_NAME, CLEF_MODEL_ID } from "./clef-transport.mjs";

// ── Credential ingress (mirrors @jkudish/jev-browser's MCP adapter rules) ──
// Secrets arrive by reference only: a one-shot handoff file consumed and
// deleted at run start, or a JEV_PASSWORD_*/JEV_COOKIE_* variable name (the
// prefix is the operator's opt-in; any other name is rejected before its
// value is ever looked up). Values never appear in tool arguments, the task,
// errors, traces, or screenshots — redaction itself lives inside navigate().
import { chmod, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

const PASSWORD_ENV_PREFIX = "JEV_PASSWORD_";
const COOKIE_ENV_PREFIX = "JEV_COOKIE_";
const MAX_SECRET_BYTES = 4096;
const MIN_SECRET_CHARS = 4;
const ENV_NAME_RE = /^[A-Z0-9_]+$/;

function parseTrustedOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.search || url.hash) return null;
  if (url.username || url.password) return null;
  if (/[*%]/.test(url.hostname)) return null;
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  return url.origin;
}

function handoffDir() {
  return process.env.JEV_BROWSER_HANDOFF_DIR || resolve(homedir(), ".jev-browser", "handoff");
}

async function ensureHandoffDir(dir = handoffDir()) {
  const resolved = resolve(dir);
  const st = await lstat(resolved).catch(() => null);
  if (st) {
    if (!st.isDirectory()) throw new Error(`handoff directory ${resolved} is not a directory`);
    if (st.uid !== process.getuid?.()) throw new Error(`handoff directory ${resolved} is not owned by this user`);
    if ((st.mode & 0o777) !== 0o700) {
      throw new Error(`handoff directory ${resolved} must be mode 0700; run chmod 700 on it or point JEV_BROWSER_HANDOFF_DIR elsewhere`);
    }
  } else {
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    await chmod(resolved, 0o700);
  }
}

function validateSecretBuffer(buf, label = "password") {
  if (buf.length === 0) throw new Error(`${label} is empty`);
  if (buf.length > MAX_SECRET_BYTES) throw new Error(`${label} exceeds ${MAX_SECRET_BYTES} bytes`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new Error(`${label} is not valid UTF-8 text`);
  }
  if (/[\r\n]/.test(text)) throw new Error(`${label} contains a line break; produce it without the trailing newline`);
  if (/[\x00-\x1f\x7f-\x9f]/.test(text)) throw new Error(`${label} contains a control character`);
  if ([...text].length < MIN_SECRET_CHARS) throw new Error(`${label} is shorter than ${MIN_SECRET_CHARS} characters`);
  return text;
}

async function readHandoffSecret(path, dir = handoffDir(), what = "password_file") {
  if (!isAbsolute(path)) throw new Error(`${what} must be an absolute path inside the handoff directory`);
  const resolvedPath = resolve(path);
  const resolvedDir = resolve(dir);
  const rel = relative(resolvedDir, resolvedPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.includes("/") || rel.includes("\\")) {
    throw new Error(`${what} must be a file directly inside the handoff directory ${resolvedDir}, not a nested path`);
  }
  await ensureHandoffDir(resolvedDir);
  const fh = await open(resolvedPath, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  let unlinked = false;
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error(`${what} is not a regular file`);
    if (st.uid !== process.getuid?.()) throw new Error(`${what} is not owned by this user`);
    if ((st.mode & 0o777) !== 0o600) throw new Error(`${what} must be mode 0600; run chmod 600 on it and retry`);
    if (st.nlink !== 1) throw new Error(`${what} has multiple hard links`);
    if (st.size === 0) throw new Error(`${what} is empty`);
    if (st.size > MAX_SECRET_BYTES) throw new Error(`${what} exceeds ${MAX_SECRET_BYTES} bytes`);
    const named = await lstat(resolvedPath).catch(() => null);
    if (!named || named.ino !== st.ino || named.dev !== st.dev) {
      throw new Error(`${what} was replaced while opening; retry with a fresh file`);
    }
    await unlink(resolvedPath);
    unlinked = true;
    const post = await fh.stat();
    if (post.nlink !== 0) throw new Error(`${what} still has links after being consumed; refusing to trust it`);
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const { bytesRead } = await fh.read(buf, read, st.size - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buf.subarray(0, read);
  } catch (error) {
    const cur = await lstat(resolvedPath).catch(() => null);
    const pinned = await fh.stat().catch(() => null);
    if (cur && pinned && cur.ino === pinned.ino && cur.dev === pinned.dev && !unlinked) {
      await unlink(resolvedPath).catch(() => {});
    }
    throw error;
  } finally {
    await fh.close().catch(() => {});
  }
}

function readSecretFromEnv(name, { prefix = PASSWORD_ENV_PREFIX, what = "password_env" } = {}) {
  if (!name.startsWith(prefix) || !ENV_NAME_RE.test(name)) {
    throw new Error(`${what} must name a ${prefix}* variable; giving a variable that name is the opt-in`);
  }
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set in this server's environment`);
  if (value.length === 0) throw new Error(`${name} is empty`);
  return Buffer.from(value, "utf8");
}

function assertNoPlaywrightDebug() {
  for (const key of ["PWDEBUG", "DEBUG", "DEBUG_FILE"]) {
    if (process.env[key]) throw new Error(`refusing credential run with ${key} set (Playwright debug output can record raw values)`);
  }
}

// ── Server ───────────────────────────────────────────────────────────────────

const { version: packageVersion } = createRequire(import.meta.url)("../package.json");

// Fail fast with a clear message when Cloudflare credentials are missing,
// before any MCP handshake or browser launch.
const clefTransport = createClefTransport();

const server = new McpServer(
  { name: "jev-browser-clef", version: packageVersion },
  { capabilities: { tools: { listChanged: false } } },
);

server.registerTool(
  "jev_navigate",
  {
    title: "Navigate a browser with Jev (clef judgments)",
    description:
      "Give a task and a start URL; a Jev-driven agent navigates a real headless browser until the goal is met, " +
      "the stuck gate fires, or a budget (steps/seconds) is exhausted. Judgments are served by Cloudflare Workers AI " +
      "`clef` (@cf/cloudflare/clef), a 27B decision model — faster/cheaper than the default Jev providers. Returns the final page in a chosen format " +
      "(text, markdown, html, or an aria snapshot), the full step trace with confidences, console/page/network " +
      "errors captured along the way, token usage with estimated cost, and a final screenshot. " +
      "The result also reports typing degradation explicitly (degraded, warnings with codes, typing_provider, typing_model), so a failed typing generator is visible instead of silently typing keyword soup. " +
      "For logins: with JEV_BROWSER_PASSWORD_ORIGIN set in this server's environment, password_file or password_env " +
      "fills native password fields on that origin only, without the value ever entering model context, traces, or " +
      "screenshots; never put the password value itself in any argument or in the task. To start already logged in, " +
      "seed a session cookie instead via cookie_file or cookie_env (same reference-based delivery and redaction).",
    inputSchema: {
      task: z.string().min(1).describe("What the agent should accomplish, in natural language."),
      start_url: z
        .string()
        .url()
        .refine((v) => /^https?:\/\//.test(v), "start_url must be an http(s) URL")
        .describe("Where to start."),
      max_steps: z.number().int().min(1).max(100).optional().describe("Hard step cap. Default 24."),
      max_seconds: z.number().min(10).max(600).optional().describe("Wall-clock cap in seconds. Default 180."),
      allow_typing: z
        .boolean()
        .optional()
        .describe("Whether the agent may type into fields. Uses the configured small model; when it fails, ordinary fields are left empty with a warning and search boxes fall back to a keyword heuristic. Default true."),
      format: z
        .enum(["text", "markdown", "html", "aria"])
        .optional()
        .describe(
          "Final page payload format: text (default, 8k chars), markdown (16k, via turndown), " +
            "html (1MB, for app-side parsing), aria (16k, Playwright aria snapshot YAML).",
        ),
      max_chars: z.number().int().min(100).max(1_000_000).optional().describe("Override the format's default character cap (at most 1,000,000, the html format's default)."),
      screenshot: z.enum(["final", "none"]).optional().describe("Final viewport JPEG. Default 'final'. Suppressed automatically after a password fill."),
      password_file: z
        .string()
        .min(1)
        .max(4096)
        .optional()
        .describe(
          "Password fill: absolute path inside the handoff directory (default ~/.jev-browser/handoff; override with " +
            "JEV_BROWSER_HANDOFF_DIR) holding the password, written by your secret manager (e.g. " +
            "op read --no-newline --out-file ...). The file is consumed and deleted at run start. " +
            "Requires JEV_BROWSER_PASSWORD_ORIGIN in this server's environment. Never put the password value itself here.",
        ),
      password_env: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe(
          "Password fill: name of a JEV_PASSWORD_* environment variable visible to this server. Naming a variable " +
            "with that prefix is the operator's opt-in; any other name is rejected. Requires " +
            "JEV_BROWSER_PASSWORD_ORIGIN in this server's environment.",
        ),
      cookie_file: z
        .array(
          z.object({
            name: z.string().min(1).max(256).describe("Cookie name, e.g. session."),
            file: z
              .string()
              .min(1)
              .max(4096)
              .describe(
                "Path inside the handoff directory (default ~/.jev-browser/handoff; override with JEV_BROWSER_HANDOFF_DIR) " +
                  "holding this cookie's value, written by your secret manager. The file is consumed and deleted at run start.",
              ),
            domain: z.string().max(256).optional().describe("Omit (recommended): host-only on the start URL's exact host. '.example.com' (leading dot) also matches subdomains."),
            path: z.string().max(1024).optional().describe("Defaults to '/'."),
            secure: z.boolean().optional().describe("Defaults to true on https start URLs. Forced true for __Host-/__Secure- names and sameSite \"None\"; secure: false cannot strip a forced flag."),
            httpOnly: z.boolean().optional().describe("Defaults to true; set false only if the site's own scripts must read this cookie."),
            sameSite: z.enum(["Strict", "Lax", "None"]).optional().describe("Defaults to 'Lax'."),
          }),
        )
        .min(1)
        .optional()
        .describe(
          "Seed cookies so the run starts behind a login, e.g. a session cookie captured elsewhere. " +
            "Values arrive by reference and are redacted like passwords. Never put a cookie value itself in any argument.",
        ),
      cookie_env: z
        .array(
          z.object({
            name: z.string().min(1).max(256).describe("Cookie name, e.g. session."),
            env: z.string().min(1).max(256).describe("Name of a JEV_COOKIE_* environment variable visible to this server."),
            domain: z.string().max(256).optional().describe("Omit (recommended): host-only on the start URL's exact host. '.example.com' (leading dot) also matches subdomains."),
            path: z.string().max(1024).optional().describe("Defaults to '/'."),
            secure: z.boolean().optional().describe("Defaults to true on https start URLs. Forced true for __Host-/__Secure- names and sameSite \"None\"; secure: false cannot strip a forced flag."),
            httpOnly: z.boolean().optional().describe("Defaults to true; set false only if the site's own scripts must read this cookie."),
            sameSite: z.enum(["Strict", "Lax", "None"]).optional().describe("Defaults to 'Lax'."),
          }),
        )
        .min(1)
        .optional()
        .describe(
          "Seed cookies with values from JEV_COOKIE_* environment variables; naming a variable with that prefix is " +
            "the operator's opt-in, any other name is rejected. Redacted like passwords.",
        ),
    },
  },
  async ({ task, start_url, ...rest }, ctx) => {
    let password;
    if (rest.password_file || rest.password_env) {
      try {
        if (rest.password_file && rest.password_env) {
          throw new Error("pass at most one of password_file and password_env");
        }
        const rawOrigin = process.env.JEV_BROWSER_PASSWORD_ORIGIN;
        if (!rawOrigin) {
          throw new Error(
            "password fill requested but JEV_BROWSER_PASSWORD_ORIGIN is not set; add it to this server's " +
              "environment as an exact origin (e.g. https://acme.com)",
          );
        }
        const origin = parseTrustedOrigin(rawOrigin);
        if (!origin) {
          throw new Error("JEV_BROWSER_PASSWORD_ORIGIN must be an exact origin like https://acme.com (http is allowed only on localhost)");
        }
        assertNoPlaywrightDebug();
        const secret = rest.password_file
          ? validateSecretBuffer(await readHandoffSecret(rest.password_file, handoffDir()), "password file")
          : validateSecretBuffer(readSecretFromEnv(rest.password_env), "password env");
        password = { value: secret, origin };
      } catch (error) {
        return { content: [{ type: "text", text: error.message }], isError: true };
      }
    }
    let cookies;
    const cookieFileSpecs = rest.cookie_file ?? [];
    const cookieEnvSpecs = rest.cookie_env ?? [];
    if (cookieFileSpecs.length > 0 || cookieEnvSpecs.length > 0) {
      try {
        if (cookieFileSpecs.length > 0 && cookieEnvSpecs.length > 0) {
          throw new Error("pass at most one of cookie_file and cookie_env");
        }
        const specs = [...cookieFileSpecs, ...cookieEnvSpecs];
        const names = new Set(specs.map((s) => s.name));
        if (names.size !== specs.length) {
          throw new Error("cookie names must be unique within one run");
        }
        assertNoPlaywrightDebug();
        cookies = await Promise.all(
          specs.map(async (s) => {
            const buf =
              s.file !== undefined
                ? await readHandoffSecret(s.file, handoffDir(), "cookie_file")
                : readSecretFromEnv(s.env, { prefix: COOKIE_ENV_PREFIX, what: "cookie_env" });
            return {
              name: s.name,
              value: validateSecretBuffer(buf, `cookie "${s.name}"`),
              domain: s.domain,
              path: s.path,
              secure: s.secure,
              httpOnly: s.httpOnly,
              sameSite: s.sameSite,
            };
          }),
        );
      } catch (error) {
        return { content: [{ type: "text", text: error.message }], isError: true };
      }
    }
    const result = await navigate(
      {
        task,
        startUrl: start_url,
        maxSteps: rest.max_steps,
        maxSeconds: rest.max_seconds,
        allowTyping: rest.allow_typing,
        format: rest.format,
        maxChars: rest.max_chars,
        screenshot: rest.screenshot,
        password,
        cookies,
        transport: clefTransport,
      },
      ctx.mcpReq.signal,
    );

    const { screenshot_base64_jpeg, ...json } = result;
    const content = [{ type: "text", text: JSON.stringify(json, null, 2) }];
    if (typeof screenshot_base64_jpeg === "string") {
      content.push({ type: "image", data: screenshot_base64_jpeg, mimeType: "image/jpeg" });
    }
    return { content, isError: json.status === "error" };
  },
);

serveStdio(server);
console.error(`[jev-browser-clef] ready — judgments via ${TRANSPORT_NAME} (${CLEF_MODEL_ID})`);
