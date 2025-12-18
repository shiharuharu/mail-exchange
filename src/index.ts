import Imap from "imap";
import { simpleParser, ParsedMail, Source } from "mailparser";
import nodemailer from "nodemailer";
import express from "express";
import { readFileSync, existsSync, appendFileSync } from "fs";
import { getReplySubject, getReplyHtml, getReplyText, ReplyData, RecipientResult } from "./reply-template";

// Types
interface ForwardRule {
  tag: string;
  recipients: string[];
}

interface Config {
  imap: {
    user: string;
    password: string;
    host: string;
    port: number;
    tls: boolean;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    auth: { user: string; pass: string };
  };
  rules: ForwardRule[];
  webPort: number;
  forwardPrefix?: string;
  allowedSenders?: string[];
  retryCount?: number;
  logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR";
}

interface ForwardTask {
  id: number;
  timestamp: string;
  subject: string;
  from: string;
  matchedTag: string;
  recipients: string[];
  status: "success" | "failed";
  error?: string;
}

// Global state
const tasks: ForwardTask[] = [];
let taskId = 0;
let config: Config;
let transporter: nodemailer.Transporter;
const DATA_DIR = process.env.DATA_DIR || ".";
const LOG_FILE = `${DATA_DIR}/mail-exchange.log`;
const FORWARDED_FILE = `${DATA_DIR}/.forwarded-ids`;
const forwardedIds = new Set<string>();

// Load/save forwarded Message-IDs
function loadForwardedIds(): void {
  if (existsSync(FORWARDED_FILE)) {
    const data = readFileSync(FORWARDED_FILE, "utf-8").trim();
    if (data) data.split("\n").forEach((id) => forwardedIds.add(id));
  }
}

function saveForwardedId(messageId: string, subject: string): void {
  forwardedIds.add(messageId);
  appendFileSync(FORWARDED_FILE, `${messageId}\n`);
  log("INFO", `Marked as processed: ${subject}`);
}

function isAlreadyForwarded(mail: ParsedMail): boolean {
  const messageId = mail.messageId || mail.headers?.get("message-id")?.toString();
  return messageId ? forwardedIds.has(messageId) : false;
}

function getMessageId(mail: ParsedMail): string {
  return mail.messageId || mail.headers?.get("message-id")?.toString() || `${Date.now()}-${Math.random()}`;
}

// Logger
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
function log(level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string): void {
  const minLevel = LOG_LEVELS[config?.logLevel || "INFO"];
  if (LOG_LEVELS[level] < minLevel) return;

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${message}\n`;
  console[level === "ERROR" ? "error" : "log"](`[${level}] ${message}`);
  appendFileSync(LOG_FILE, line);
}

// Parse JSONC (JSON with comments)
function parseJsonc(content: string): unknown {
  const stripped = content
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return JSON.parse(stripped);
}

// Load config
function loadConfig(): Config {
  const configPath = process.env.CONFIG_PATH || "./config.jsonc";
  if (!existsSync(configPath)) {
    log("ERROR", `Config file not found: ${configPath}`);
    process.exit(1);
  }
  return parseJsonc(readFileSync(configPath, "utf-8")) as Config;
}

// Match forwarding rule by subject
function matchRule(subject: string): ForwardRule | null {
  const lowerSubject = subject.toLowerCase();
  for (const rule of config.rules) {
    if (lowerSubject.includes(rule.tag.toLowerCase())) {
      return rule;
    }
  }
  return null;
}

// Send email to single recipient with retry
async function sendToRecipient(mail: ParsedMail, recipient: string, from: string): Promise<RecipientResult> {
  const maxAttempts = config.retryCount ?? 3;
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await transporter.sendMail({
        from: config.smtp.auth.user,
        to: recipient,
        subject: config.forwardPrefix ? `${config.forwardPrefix} ${mail.subject}` : mail.subject,
        text: mail.text || "",
        html: mail.html || undefined,
        attachments: mail.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        })),
      });
      log("INFO", `  -> ${recipient}: OK${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
      return { email: recipient, success: true, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log("WARN", `  -> ${recipient}: RETRY ${attempt}/${maxAttempts} - ${lastError}`);
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  log("ERROR", `  -> ${recipient}: FAILED after ${maxAttempts} attempts - ${lastError}`);
  return { email: recipient, success: false, error: lastError, attempts: maxAttempts };
}

// Forward email to all recipients
async function forwardEmail(mail: ParsedMail, rule: ForwardRule, from: string): Promise<RecipientResult[]> {
  log("INFO", `Forwarding from=${from} tag=${rule.tag} to=${rule.recipients.length} recipients`);
  return Promise.all(rule.recipients.map((r) => sendToRecipient(mail, r, from)));
}

// Send reply notification to original sender
async function sendReplyNotification(mail: ParsedMail, results: RecipientResult[], duration: number): Promise<void> {
  const replyTo = mail.from?.value?.[0]?.address;
  if (!replyTo) return;

  const data: ReplyData = {
    subject: mail.subject || "(no subject)",
    results,
    duration,
    timestamp: new Date().toISOString(),
  };

  await transporter.sendMail({
    from: config.smtp.auth.user,
    to: replyTo,
    subject: getReplySubject(data),
    text: getReplyText(data),
    html: getReplyHtml(data),
  });
}

// Check if sender is allowed
function isSenderAllowed(email: string): boolean {
  if (!config.allowedSenders?.length) return true;
  const addr = email.toLowerCase();
  return config.allowedSenders.some((s) => addr.includes(s.toLowerCase()));
}

// Process incoming email
async function processEmail(mail: ParsedMail): Promise<void> {
  const startTime = Date.now();
  const subject = mail.subject || "(no subject)";
  const from = mail.from?.text || "unknown";
  const fromAddr = mail.from?.value?.[0]?.address || "";
  const messageId = getMessageId(mail);
  const mailSize = Math.round((mail.text?.length || 0) / 1024) + "KB";
  const attachCount = mail.attachments?.length || 0;

  log("INFO", `New mail: "${subject}" from=${fromAddr} size=${mailSize} attachments=${attachCount}`);

  if (isAlreadyForwarded(mail)) {
    log("INFO", `Already forwarded (skip): ${subject}`);
    return;
  }

  if (!isSenderAllowed(fromAddr)) {
    log("WARN", `Sender not allowed: ${fromAddr} - ${subject}`);
    saveForwardedId(messageId, subject);
    return;
  }

  const rule = matchRule(subject);

  if (!rule) {
    log("INFO", `No matching rule for: ${subject}`);
    saveForwardedId(messageId, subject);
    return;
  }

  const task: ForwardTask = {
    id: ++taskId,
    timestamp: new Date().toISOString(),
    subject,
    from,
    matchedTag: rule.tag,
    recipients: rule.recipients,
    status: "success",
  };

  const results = await forwardEmail(mail, rule, fromAddr);
  const duration = Date.now() - startTime;
  const successCount = results.filter((r) => r.success).length;
  const failCount = results.length - successCount;

  if (failCount > 0) {
    task.status = "failed";
    task.error = `${failCount}/${results.length} failed`;
    log("ERROR", `Forward completed: ${subject} - ${successCount}/${results.length} success, ${failCount} failed (${duration}ms)`);
  } else {
    log("INFO", `Forward completed: ${subject} - ${successCount}/${results.length} success (${duration}ms)`);
  }
  saveForwardedId(messageId, subject);
  await sendReplyNotification(mail, results, duration);

  tasks.unshift(task);
  if (tasks.length > 100) tasks.pop();
}

// IMAP listener
function startImapListener(): void {
  const imap = new Imap(config.imap);

  imap.once("ready", () => {
    log("INFO", "IMAP connected");
    imap.openBox("INBOX", false, (err) => {
      if (err) {
        log("ERROR", `Failed to open INBOX: ${err.message}`);
        return;
      }
      log("INFO", "Listening for new emails...");
    });
  });

  imap.on("mail", () => {
    imap.search(["UNSEEN"], (err, results) => {
      if (err || !results.length) return;
      const fetch = imap.fetch(results, { bodies: "" });
      fetch.on("message", (msg) => {
        let uid: number | undefined;
        msg.on("attributes", (attrs) => {
          uid = attrs.uid;
        });
        msg.on("body", (stream) => {
          simpleParser(stream as unknown as Source, async (err, mail) => {
            if (uid) {
              imap.addFlags(uid, ["\\Seen"], (e) => {
                if (e) log("WARN", `Failed to mark as seen (uid=${uid})`);
              });
            }
            if (err) return;
            await processEmail(mail);
          });
        });
      });
    });
  });

  imap.on("error", (err: Error) => {
    log("ERROR", `IMAP error: ${err.message}`);
    setTimeout(startImapListener, 5000);
  });

  imap.on("end", () => {
    log("WARN", "IMAP disconnected, reconnecting...");
    setTimeout(startImapListener, 5000);
  });

  imap.connect();
}

// Web server
function startWebServer(): void {
  const app = express();

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mail Exchange</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; min-height: 100vh; padding: 20px; }
    .container { max-width: 1000px; margin: 0 auto; background: #fff; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); overflow: hidden; }
    .brand-bar { height: 6px; background: #10B981; }
    .header { padding: 24px 32px; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 22px; color: #111827; }
    .header p { color: #6b7280; font-size: 14px; margin-top: 4px; }
    .refresh { padding: 8px 16px; background: #f3f4f6; color: #374151; border: 1px solid #d1d5db; border-radius: 6px; cursor: pointer; font-size: 14px; }
    .refresh:hover { background: #e5e7eb; }
    .stats { display: grid; grid-template-columns: repeat(3, 1fr); background: #f9fafb; border-bottom: 1px solid #e5e7eb; }
    .stat { padding: 20px; text-align: center; border-right: 1px solid #e5e7eb; }
    .stat:last-child { border-right: none; }
    .stat-label { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; }
    .stat-value { font-size: 28px; font-weight: 700; color: #374151; margin-top: 4px; }
    .stat-value.success { color: #10B981; }
    .stat-value.failed { color: #EF4444; }
    .stat-value.zero { color: #d1d5db; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { padding: 12px 16px; text-align: left; background: #f9fafb; color: #374151; font-weight: 600; border-bottom: 1px solid #e5e7eb; }
    td { padding: 14px 16px; border-bottom: 1px solid #f0f0f0; color: #374151; }
    tr:hover td { background: #f9fafb; }
    .tag { display: inline-block; padding: 4px 10px; background: #DBEAFE; color: #1E40AF; border-radius: 12px; font-size: 12px; font-weight: 600; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
    .badge-success { background: #D1FAE5; color: #065F46; }
    .badge-failed { background: #FEE2E2; color: #991B1B; }
    .empty { text-align: center; padding: 48px; color: #9ca3af; }
    @media (max-width: 640px) {
      .stats { grid-template-columns: 1fr; }
      .stat { border-right: none; border-bottom: 1px solid #e5e7eb; }
      .header { flex-direction: column; gap: 16px; text-align: center; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand-bar" id="brandBar"></div>
    <div class="header">
      <div><h1>Mail Exchange</h1><p>Forward Tasks Dashboard</p></div>
      <button class="refresh" onclick="location.reload()">↻ Refresh</button>
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-label">Total</div><div class="stat-value" id="total">-</div></div>
      <div class="stat"><div class="stat-label">Success</div><div class="stat-value success" id="success">-</div></div>
      <div class="stat"><div class="stat-label">Failed</div><div class="stat-value failed" id="failed">-</div></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Time</th><th>Subject</th><th>From</th><th>Tag</th><th>Recipients</th><th>Status</th></tr></thead>
        <tbody id="tasks"></tbody>
      </table>
    </div>
  </div>
  <div class="container" style="margin-top:20px;">
    <div class="header" style="border-bottom:none;padding-bottom:16px;">
      <div><h1>Forwarding Rules</h1><p id="ruleCount">-</p></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Tag</th><th>Recipients</th></tr></thead>
        <tbody id="rules"></tbody>
      </table>
    </div>
  </div>
  <script>
    fetch('/api/tasks').then(r => r.json()).then(data => {
      const total = data.length;
      const success = data.filter(t => t.status === 'success').length;
      const failed = total - success;
      document.getElementById('total').textContent = total;
      document.getElementById('success').textContent = success;
      const failedEl = document.getElementById('failed');
      failedEl.textContent = failed;
      failedEl.className = 'stat-value ' + (failed > 0 ? 'failed' : 'zero');
      document.getElementById('brandBar').style.background = failed > 0 ? '#F59E0B' : '#10B981';
      const tbody = document.getElementById('tasks');
      if (!total) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">No forwarding tasks yet</td></tr>';
        return;
      }
      tbody.innerHTML = data.map(t => \`<tr>
        <td>\${new Date(t.timestamp).toLocaleString()}</td>
        <td>\${t.subject}</td>
        <td>\${t.from}</td>
        <td><span class="tag">\${t.matchedTag}</span></td>
        <td>\${t.recipients.join(', ')}</td>
        <td><span class="badge badge-\${t.status}">\${t.status === 'success' ? '✓ Success' : '✗ Failed'}</span>\${t.error ? '<br><small style="color:#DC2626">' + t.error + '</small>' : ''}</td>
      </tr>\`).join('');
    });
    fetch('/api/rules').then(r => r.json()).then(rules => {
      document.getElementById('ruleCount').textContent = rules.length + ' rules configured';
      document.getElementById('rules').innerHTML = rules.map(r => \`<tr>
        <td><span class="tag">\${r.tag}</span></td>
        <td>\${r.recipients.join(', ')}</td>
      </tr>\`).join('');
    });
  </script>
</body>
</html>`;

  app.get("/", (_, res) => res.send(html));
  app.get("/api/tasks", (_, res) => res.json(tasks));
  app.get("/api/rules", (_, res) => res.json(config.rules));

  app.listen(config.webPort, () => {
    console.log(`Web interface: http://localhost:${config.webPort}`);
  });
}

// Graceful shutdown
function shutdown(): void {
  log("INFO", "Shutting down...");
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Main
config = loadConfig();
transporter = nodemailer.createTransport(config.smtp);
loadForwardedIds();
log("INFO", `Loaded ${config.rules.length} rules, ${forwardedIds.size} forwarded IDs`);
startWebServer();
startImapListener();
