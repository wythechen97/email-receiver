import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(rootDir, "data");
const accountsPath = path.join(dataDir, "accounts.json");
const mailDatabasePath = path.join(dataDir, "mail.sqlite");
const uiDir = path.join(rootDir, "ui");

const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "127.0.0.1",
  apiToken: requiredEnv("LOCAL_API_TOKEN"),
  encryptionKey: Buffer.from(requiredEnv("ACCOUNT_ENCRYPTION_KEY"), "base64"),
  proxyHost: requiredEnv("PROXY_HOST"),
  proxyPort: Number(process.env.PROXY_PORT || 10000),
  proxyUsernameTemplate: requiredEnv("PROXY_USERNAME_TEMPLATE"),
  proxyPassword: requiredEnv("PROXY_PASSWORD"),
  maxMessageBytes: Number(process.env.MAX_MESSAGE_BYTES || 5 * 1024 * 1024)
};

if (config.encryptionKey.length !== 32) {
  throw new Error("ACCOUNT_ENCRYPTION_KEY 必须是 32 字节密钥的 Base64 编码。");
}
if (!Number.isInteger(config.proxyPort) || config.proxyPort < 1 || config.proxyPort > 65535) {
  throw new Error("PROXY_PORT 无效。");
}
if (!config.proxyUsernameTemplate.includes("{sessionId}")) {
  throw new Error("PROXY_USERNAME_TEMPLATE 必须包含 {sessionId}。");
}

let accountStore = { version: 1, accounts: [] };
let mailDatabase;
const activeFetches = new Set();
let saveQueue = Promise.resolve();

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

async function initializeStore() {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  initializeMailDatabase();
  try {
    accountStore = JSON.parse(await fs.readFile(accountsPath, "utf8"));
    if (!Array.isArray(accountStore.accounts)) throw new Error("accounts 不是数组");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await saveStore();
  }

  // 兼容早期 JSON 缓存：首次启动后迁移到 SQLite，再从账号配置中移除正文。
  let migrated = false;
  for (const account of accountStore.accounts) {
    if (Array.isArray(account.savedMessages)) {
      saveMessages(account.id, account.savedMessages);
      delete account.savedMessages;
      migrated = true;
    }
  }
  if (migrated) await saveStore();
}

function initializeMailDatabase() {
  mailDatabase = new DatabaseSync(mailDatabasePath);
  mailDatabase.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS messages (
      account_id TEXT NOT NULL,
      uid TEXT NOT NULL,
      message_date TEXT,
      fetched_at TEXT NOT NULL,
      message_json TEXT NOT NULL,
      PRIMARY KEY (account_id, uid)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_account_date
      ON messages (account_id, message_date DESC, fetched_at DESC);
  `);
}

function saveMessages(accountId, messages) {
  const statement = mailDatabase.prepare(`
    INSERT INTO messages (account_id, uid, message_date, fetched_at, message_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, uid) DO UPDATE SET
      message_date = excluded.message_date,
      fetched_at = excluded.fetched_at,
      message_json = excluded.message_json
  `);
  const fetchedAt = new Date().toISOString();
  for (const message of messages) {
    statement.run(accountId, message.uid, message.headers?.date || null, fetchedAt, JSON.stringify(message));
  }
}

function getSavedMessages(accountId, limit = 200) {
  const rows = mailDatabase.prepare(`
    SELECT message_json FROM messages
    WHERE account_id = ?
    ORDER BY COALESCE(message_date, fetched_at) DESC, fetched_at DESC
    LIMIT ?
  `).all(accountId, limit);
  return rows.flatMap((row) => {
    try { return [JSON.parse(row.message_json)]; } catch { return []; }
  });
}

async function saveStore() {
  const snapshot = `${JSON.stringify(accountStore, null, 2)}\n`;
  const write = async () => {
    const temporaryPath = `${accountsPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, accountsPath);
  };

  // 多个账号同时手动收件时，串行写入配置，避免临时文件互相覆盖。
  saveQueue = saveQueue.catch(() => undefined).then(write);
  return saveQueue;
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", config.encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decrypt(value) {
  const packed = Buffer.from(value, "base64");
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const encrypted = packed.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", config.encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function createUniqueSessionId() {
  const existing = new Set(accountStore.accounts.map((account) => account.proxySessionId));
  let sessionId;
  do {
    sessionId = String(crypto.randomInt(10_000_000, 100_000_000));
  } while (existing.has(sessionId));
  return sessionId;
}

function getProxyUsername(sessionId) {
  return config.proxyUsernameTemplate.replaceAll("{sessionId}", sessionId);
}

function getProxyUrl(sessionId) {
  const proxyUrl = new URL("socks5://");
  proxyUrl.hostname = config.proxyHost;
  proxyUrl.port = String(config.proxyPort);
  proxyUrl.username = getProxyUsername(sessionId);
  proxyUrl.password = config.proxyPassword;
  return proxyUrl.toString();
}

function publicAccount(account) {
  return {
    id: account.id,
    email: account.email,
    enabled: account.enabled,
    proxy: {
      host: config.proxyHost,
      port: config.proxyPort,
      username: getProxyUsername(account.proxySessionId),
      sessionId: account.proxySessionId
    },
    createdAt: account.createdAt,
    lastFetchAt: account.lastFetchAt || null,
    lastFetchStatus: account.lastFetchStatus || null
  };
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(data));
}

async function serveUiFile(response, filename, contentType) {
  const content = await fs.readFile(path.join(uiDir, filename));
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
  response.end(content);
}

function isAuthorized(request) {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  const expected = Buffer.from(config.apiToken);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function readJson(request, maxBytes = 1024 * 1024) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) throw new HttpError(413, "REQUEST_TOO_LARGE", "请求体过大。");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new HttpError(400, "INVALID_JSON", "请求不是有效 JSON。");
  }
}

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function classifyImapError(error) {
  const message = String(error?.message || error);
  const code = String(error?.code || "");
  const detail = redactConnectionSecrets(message);
  if (/AUTHENTICATIONFAILED|AUTHENTICATE|LOGIN|credentials/i.test(`${code} ${message}`)) {
    return { code: "AUTH_FAILED", message: "GMX 认证失败：请检查账号和 IMAP/应用专用密码。", detail };
  }
  if (/ETIMEDOUT|timeout/i.test(`${code} ${message}`)) {
    return { code: "TIMEOUT", message: "连接代理或 GMX IMAP 超时。", detail };
  }
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|proxy/i.test(`${code} ${message}`)) {
    return { code: "NETWORK_ERROR", message: "代理或 GMX 网络连接失败。", detail };
  }
  return { code: "IMAP_ERROR", message: "读取 GMX 邮件失败。", detail };
}

function redactConnectionSecrets(value) {
  return value
    .replace(/(socks(?:4|5)?:\/\/[^:/\s]+:)[^@\s]+@/gi, "$1***@")
    .replace(/(pass(?:word)?[=:]\s*)[^,\s]+/gi, "$1***")
    .slice(0, 500);
}

function shouldRenewProxySession(error) {
  const description = `${error?.code || ""} ${error?.message || ""}`;
  return /ECONNRESET|disconnected before secure TLS connection was established/i.test(description);
}

async function manuallyFetchMessages(account, limit, attempt = 0, isRetry = false) {
  if (!isRetry && activeFetches.has(account.id)) {
    throw new HttpError(409, "FETCH_ALREADY_RUNNING", "此账号已有手动收件任务正在运行。");
  }
  if (!isRetry) activeFetches.add(account.id);

  const client = new ImapFlow({
    host: "imap.gmx.net",
    port: 993,
    secure: true,
    auth: { user: account.email, pass: decrypt(account.passwordEncrypted) },
    proxy: getProxyUrl(account.proxySessionId),
    tls: { rejectUnauthorized: true },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    logger: false
  });
  let connected = false;

  try {
    await client.connect();
    connected = true;
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ all: true }, { uid: true });
      const latestUids = uids.slice(-limit).reverse();
      const messages = [];

      for await (const message of client.fetch(
        latestUids,
        { uid: true, envelope: true, flags: true, size: true, source: true },
        { uid: true }
      )) {
        if (message.source.length > config.maxMessageBytes) {
          messages.push({
            uid: String(message.uid),
            skipped: true,
            reason: "MESSAGE_TOO_LARGE",
            size: message.source.length
          });
          continue;
        }

        const parsed = await simpleParser(message.source);
        messages.push({
          uid: String(message.uid),
          messageId: parsed.messageId || message.envelope?.messageId || null,
          headers: {
            subject: parsed.subject || "",
            from: parsed.from?.text || "",
            to: parsed.to?.text || "",
            date: parsed.date?.toISOString() || null
          },
          body: { text: parsed.text || "", html: parsed.html || "" },
          flags: {
            seen: message.flags?.has("\\Seen") ?? false,
            answered: message.flags?.has("\\Answered") ?? false,
            flagged: message.flags?.has("\\Flagged") ?? false,
            deleted: message.flags?.has("\\Deleted") ?? false,
            draft: message.flags?.has("\\Draft") ?? false,
            raw: [...(message.flags || [])]
          },
          size: message.size || message.source.length,
          attachments: parsed.attachments.map((attachment) => ({
            filename: attachment.filename || null,
            contentType: attachment.contentType,
            size: attachment.size,
            contentId: attachment.cid || null
          }))
        });
      }

      // 每封邮件都绑定本次 IMAP 请求实际使用的代理 Session，供后续审计与界面展示。
      const egress = {
        proxyHost: config.proxyHost,
        proxyPort: config.proxyPort,
        sessionId: account.proxySessionId
      };
      for (const message of messages) message.egress = egress;

      // 邮件正文与元数据独立写入 SQLite；账号 JSON 仅保留账户配置。
      saveMessages(account.id, messages);
      account.lastFetchAt = new Date().toISOString();
      account.lastFetchStatus = "ok";
      await saveStore();
      return messages;
    } finally {
      lock.release();
    }
  } catch (error) {
    // 某些粘性出口无法完成 GMX TLS；仅在用户手动收件时自动换一次出口重试。
    if (attempt < 2 && shouldRenewProxySession(error)) {
      account.proxySessionId = createUniqueSessionId();
      account.lastFetchStatus = "retrying_with_new_proxy_session";
      await saveStore();
      return manuallyFetchMessages(account, limit, attempt + 1, true);
    }
    account.lastFetchAt = new Date().toISOString();
    account.lastFetchStatus = classifyImapError(error).code;
    await saveStore();
    throw error;
  } finally {
    if (!isRetry) activeFetches.delete(account.id);
    if (connected) {
      // 不让不稳定的代理把一次手动收件卡在 logout 阶段。
      await Promise.race([
        client.logout().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 2_000))
      ]);
    }
    client.close();
  }
}

async function handleRequest(request, response) {
  if (request.method === "GET" && request.url === "/") {
    return serveUiFile(response, "index.html", "text/html; charset=utf-8");
  }
  if (request.method === "GET" && request.url === "/app.js") {
    return serveUiFile(response, "app.js", "text/javascript; charset=utf-8");
  }
  if (request.method === "GET" && request.url === "/styles.css") {
    return serveUiFile(response, "styles.css", "text/css; charset=utf-8");
  }

  if (!isAuthorized(request)) {
    return sendJson(response, 401, { ok: false, error: { code: "UNAUTHORIZED" } });
  }

  if (request.method === "GET" && request.url === "/api/accounts") {
    return sendJson(response, 200, { ok: true, accounts: accountStore.accounts.map(publicAccount) });
  }

  const accountMessages = request.url?.match(/^\/api\/accounts\/([^/]+)\/messages$/);
  if (request.method === "GET" && accountMessages) {
    const accountId = decodeURIComponent(accountMessages[1]);
    if (!accountStore.accounts.some((account) => account.id === accountId)) {
      throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在。");
    }
    return sendJson(response, 200, { ok: true, accountId, messages: getSavedMessages(accountId) });
  }

  if (request.method === "POST" && request.url === "/api/accounts/import") {
    const payload = await readJson(request);
    if (!Array.isArray(payload.accounts) || payload.accounts.length === 0) {
      throw new HttpError(400, "INVALID_ACCOUNTS", "accounts 必须是非空数组。");
    }

    const imported = [];
    const skipped = [];
    const knownEmails = new Set(accountStore.accounts.map((account) => account.email));

    for (const item of payload.accounts) {
      const email = typeof item?.email === "string" ? item.email.trim().toLowerCase() : "";
      const password = typeof item?.password === "string" ? item.password : "";
      if (!/^.+@gmx\.(com|net|de|at|ch)$/i.test(email) || !password) {
        skipped.push({ email: email || null, reason: "INVALID_EMAIL_OR_PASSWORD" });
        continue;
      }
      if (knownEmails.has(email)) {
        skipped.push({ email, reason: "ALREADY_IMPORTED" });
        continue;
      }

      const account = {
        id: crypto.randomUUID(),
        email,
        passwordEncrypted: encrypt(password),
        proxySessionId: createUniqueSessionId(),
        enabled: true,
        createdAt: new Date().toISOString()
      };
      accountStore.accounts.push(account);
      knownEmails.add(email);
      imported.push(publicAccount(account));
    }

    await saveStore();
    return sendJson(response, 201, { ok: true, imported, skipped });
  }

  const accountAction = request.url?.match(/^\/api\/accounts\/([^/]+)\/(fetch|enable|disable|renew-session)$/);
  if (request.method === "POST" && accountAction) {
    const accountId = decodeURIComponent(accountAction[1]);
    const action = accountAction[2];
    const account = accountStore.accounts.find((item) => item.id === accountId);
    if (!account) throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在。");

    if (action === "enable" || action === "disable") {
      account.enabled = action === "enable";
      await saveStore();
      return sendJson(response, 200, { ok: true, account: publicAccount(account) });
    }

    if (action === "renew-session") {
      account.proxySessionId = createUniqueSessionId();
      account.lastFetchStatus = null;
      await saveStore();
      return sendJson(response, 200, { ok: true, account: publicAccount(account) });
    }

    if (!account.enabled) {
      throw new HttpError(403, "ACCOUNT_DISABLED", "账号已停用；启用后才能手动收件。");
    }
    const payload = await readJson(request);
    const limit = Math.min(Math.max(Number(payload.limit) || 10, 1), 50);
    try {
      const messages = await manuallyFetchMessages(account, limit);
      return sendJson(response, 200, { ok: true, accountId: account.id, messages });
    } catch (error) {
      const details = classifyImapError(error);
      console.error(`Manual IMAP fetch failed for ${account.email}: [${details.code}] ${details.detail}`);
      return sendJson(response, 502, { ok: false, error: details });
    }
  }

  return sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND" } });
}

await initializeStore();
const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    if (error instanceof HttpError) {
      return sendJson(response, error.statusCode, { ok: false, error: { code: error.code, message: error.message } });
    }
    console.error("Unhandled server error:", error);
    return sendJson(response, 500, { ok: false, error: { code: "INTERNAL_ERROR", message: "本地服务发生未预期错误。" } });
  });
});

server.listen(config.port, config.host, () => {
  console.log(`GMX on-demand mail service listening at http://${config.host}:${config.port}`);
});
