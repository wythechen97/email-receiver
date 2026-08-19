import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import tls from "node:tls";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { SocksClient } from "socks";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(rootDir, "data");
const accountsPath = path.join(dataDir, "accounts.json");
const mailDatabasePath = path.join(dataDir, "mail.sqlite");
const uiDir = path.join(rootDir, "ui");
const GMX_EMAIL_PATTERN = /^.+@gmx\.(com|us|net|de|at|ch)$/i;

const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "127.0.0.1",
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

let accountStore = { version: 2, users: [], accounts: [] };
let mailDatabase;
const activeFetches = new Set();
let saveQueue = Promise.resolve();
const sessions = new Map();
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;

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

  // 兼容旧版单用户数据：注册第一个用户时会认领这些无归属账号。
  if (!Array.isArray(accountStore.users)) accountStore.users = [];
  if (accountStore.version !== 2) {
    accountStore.version = 2;
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

function readResponse(socket, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("出口 IP 查询超时。"));
    }, timeoutMs);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("end", () => { clearTimeout(timeout); resolve(Buffer.concat(chunks).toString("utf8")); });
    socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
}

async function resolveProxyEgress(account) {
  let proxySocket;
  let secureSocket;
  try {
    const connection = await SocksClient.createConnection({
      command: "connect",
      proxy: {
        host: config.proxyHost,
        port: config.proxyPort,
        type: 5,
        userId: getProxyUsername(account.proxySessionId),
        password: config.proxyPassword
      },
      destination: { host: "api.ipify.org", port: 443 }
    });
    proxySocket = connection.socket;
    secureSocket = tls.connect({ socket: proxySocket, servername: "api.ipify.org", rejectUnauthorized: true });
    await new Promise((resolve, reject) => {
      secureSocket.once("secureConnect", resolve);
      secureSocket.once("error", reject);
    });
    const responsePromise = readResponse(secureSocket);
    // 不能在请求发送后立即 half-close：部分 SOCKS5 服务会随之关闭隧道，
    // 导致 HTTP 响应尚未转发回来就触发 `end`，从而误报出口查询失败。
    // HTTP 的 Connection: close 会由服务端在响应完成后关闭连接。
    secureSocket.write("GET /?format=json HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\nAccept: application/json\r\n\r\n");
    const response = await responsePromise;
    const [, body = ""] = response.split("\r\n\r\n", 2);
    const ip = JSON.parse(body).ip;
    if (typeof ip !== "string" || !ip) throw new Error("出口 IP 服务返回了无效响应。");
    return { ip, checkedAt: new Date().toISOString(), sessionId: account.proxySessionId };
  } finally {
    secureSocket?.destroy();
    proxySocket?.destroy();
  }
}

function publicAccount(account) {
  return {
    id: account.id,
    email: account.email,
    note: account.note || "",
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

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || "").split(";").flatMap((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [] : [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]];
  }));
}

function getCurrentUser(request) {
  const token = parseCookies(request).mail_session;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return accountStore.users.find((user) => user.id === session.userId) || null;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, { userId, expiresAt: Date.now() + sessionLifetimeMs });
  return token;
}

function setSessionCookie(response, token) {
  response.setHeader("Set-Cookie", `mail_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(sessionLifetimeMs / 1000)}`);
}

function clearSessionCookie(response) {
  response.setHeader("Set-Cookie", "mail_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("base64")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("base64");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expectedHash] = String(stored).split(":");
  if (!salt || !expectedHash) return false;
  const actual = Buffer.from(crypto.scryptSync(password, salt, 64).toString("base64"));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function ownedAccounts(userId) {
  return accountStore.accounts.filter((account) => account.ownerId === userId);
}

function getOwnedAccount(userId, accountId) {
  return accountStore.accounts.find((account) => account.id === accountId && account.ownerId === userId);
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

  if (request.method === "POST" && request.url === "/api/auth/register") {
    const payload = await readJson(request);
    const username = typeof payload.username === "string" ? payload.username.trim().toLowerCase() : "";
    const password = typeof payload.password === "string" ? payload.password : "";
    if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/i.test(username)) {
      throw new HttpError(400, "INVALID_USERNAME", "用户名应为 3–32 个字母、数字或 . _ -。");
    }
    if (password.length < 8 || password.length > 200) {
      throw new HttpError(400, "INVALID_PASSWORD", "密码长度应为 8–200 个字符。");
    }
    if (accountStore.users.some((user) => user.username === username)) {
      throw new HttpError(409, "USERNAME_TAKEN", "该用户名已被使用。");
    }
    const user = { id: crypto.randomUUID(), username, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
    accountStore.users.push(user);
    // 旧版 token 模式为单人使用；保留既有邮箱和邮件，并将其归属给首位注册用户。
    if (accountStore.users.length === 1) {
      for (const account of accountStore.accounts) if (!account.ownerId) account.ownerId = user.id;
    }
    await saveStore();
    setSessionCookie(response, createSession(user.id));
    return sendJson(response, 201, { ok: true, user: { username: user.username } });
  }

  if (request.method === "POST" && request.url === "/api/auth/login") {
    const payload = await readJson(request);
    const username = typeof payload.username === "string" ? payload.username.trim().toLowerCase() : "";
    const password = typeof payload.password === "string" ? payload.password : "";
    const user = accountStore.users.find((item) => item.username === username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new HttpError(401, "INVALID_CREDENTIALS", "用户名或密码不正确。");
    }
    setSessionCookie(response, createSession(user.id));
    return sendJson(response, 200, { ok: true, user: { username: user.username } });
  }

  if (request.method === "POST" && request.url === "/api/auth/logout") {
    const token = parseCookies(request).mail_session;
    if (token) sessions.delete(token);
    clearSessionCookie(response);
    return sendJson(response, 200, { ok: true });
  }

  const user = getCurrentUser(request);
  if (!user) {
    return sendJson(response, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "请先登录。" } });
  }

  if (request.method === "GET" && request.url === "/api/auth/me") {
    return sendJson(response, 200, { ok: true, user: { username: user.username } });
  }

  if (request.method === "GET" && request.url === "/api/accounts") {
    return sendJson(response, 200, { ok: true, accounts: ownedAccounts(user.id).map(publicAccount) });
  }

  const accountMessages = request.url?.match(/^\/api\/accounts\/([^/]+)\/messages$/);
  if (request.method === "GET" && accountMessages) {
    const accountId = decodeURIComponent(accountMessages[1]);
    if (!getOwnedAccount(user.id, accountId)) {
      throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在。");
    }
    return sendJson(response, 200, { ok: true, accountId, messages: getSavedMessages(accountId) });
  }

  const accountEgress = request.url?.match(/^\/api\/accounts\/([^/]+)\/egress$/);
  if (request.method === "GET" && accountEgress) {
    const accountId = decodeURIComponent(accountEgress[1]);
    const account = getOwnedAccount(user.id, accountId);
    if (!account) throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在。");
    try {
      return sendJson(response, 200, { ok: true, egress: await resolveProxyEgress(account) });
    } catch (error) {
      console.error(`Proxy egress lookup failed for ${account.email}: ${redactConnectionSecrets(String(error?.message || error))}`);
      throw new HttpError(502, "EGRESS_LOOKUP_FAILED", "无法确认当前代理出口。请稍后重试。", redactConnectionSecrets(String(error?.message || error)));
    }
  }

  if (request.method === "POST" && request.url === "/api/accounts/import") {
    const payload = await readJson(request);
    if (!Array.isArray(payload.accounts) || payload.accounts.length === 0) {
      throw new HttpError(400, "INVALID_ACCOUNTS", "accounts 必须是非空数组。");
    }

    const imported = [];
    const skipped = [];
    const knownEmails = new Set(ownedAccounts(user.id).map((account) => account.email));

    for (const item of payload.accounts) {
      const email = typeof item?.email === "string" ? item.email.trim().toLowerCase() : "";
      const password = typeof item?.password === "string" ? item.password : "";
      if (!GMX_EMAIL_PATTERN.test(email) || !password) {
        skipped.push({ email: email || null, reason: "INVALID_EMAIL_OR_PASSWORD" });
        continue;
      }
      if (knownEmails.has(email)) {
        skipped.push({ email, reason: "ALREADY_IMPORTED" });
        continue;
      }

      const account = {
        id: crypto.randomUUID(),
        ownerId: user.id,
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

  const accountNote = request.url?.match(/^\/api\/accounts\/([^/]+)\/note$/);
  if (request.method === "PUT" && accountNote) {
    const accountId = decodeURIComponent(accountNote[1]);
    const account = getOwnedAccount(user.id, accountId);
    if (!account) throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在。");

    const payload = await readJson(request);
    if (typeof payload.note !== "string") {
      throw new HttpError(400, "INVALID_NOTE", "备注必须是文本。");
    }
    const note = payload.note.trim();
    if (note.length > 200) {
      throw new HttpError(400, "NOTE_TOO_LONG", "备注不能超过 200 个字符。");
    }
    account.note = note;
    await saveStore();
    return sendJson(response, 200, { ok: true, account: publicAccount(account) });
  }

  const accountAction = request.url?.match(/^\/api\/accounts\/([^/]+)\/(fetch|enable|disable|renew-session)$/);
  if (request.method === "POST" && accountAction) {
    const accountId = decodeURIComponent(accountAction[1]);
    const action = accountAction[2];
    const account = getOwnedAccount(user.id, accountId);
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
