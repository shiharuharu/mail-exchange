import Imap from "imap";
import { simpleParser, ParsedMail } from "mailparser";
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
function log(level: "INFO" | "ERROR" | "WARN", message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${message}\n`;
  console[level === "ERROR" ? "error" : "log"](message);
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
      fetch.on("message", (msg, seqno) => {
        const uid = results[seqno - 1];
        msg.on("body", (stream) => {
          simpleParser(stream, async (err, mail) => {
            if (err) return;
            await processEmail(mail);
            // 处理成功后再标记已读
            imap.addFlags(uid, ["\\Seen"], (err) => {
              if (err) log("WARN", `Failed to mark as seen: ${mail.subject}`);
            });
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
  <title>Mail Exchange - Forward Tasks</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; padding: 20px; }
    h1 { color: #333; margin-bottom: 20px; }
    .stats { display: flex; gap: 20px; margin-bottom: 20px; }
    .stat { background: white; padding: 15px 25px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .stat-value { font-size: 24px; font-weight: bold; color: #2196F3; }
    .stat-label { color: #666; font-size: 14px; }
    table { width: 100%; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); border-collapse: collapse; }
    th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #fafafa; font-weight: 600; color: #333; }
    .success { color: #4CAF50; }
    .failed { color: #f44336; }
    .tag { background: #e3f2fd; color: #1976D2; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
    .refresh { float: right; padding: 8px 16px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer; }
    .refresh:hover { background: #1976D2; }
    .empty { text-align: center; padding: 40px; color: #999; }
  </style>
</head>
<body>
  <button class="refresh" onclick="location.reload()">Refresh</button>
  <h1>Mail Exchange - Forward Tasks</h1>
  <div class="stats">
    <div class="stat"><div class="stat-value" id="total">-</div><div class="stat-label">Total</div></div>
    <div class="stat"><div class="stat-value success" id="success">-</div><div class="stat-label">Success</div></div>
    <div class="stat"><div class="stat-value failed" id="failed">-</div><div class="stat-label">Failed</div></div>
  </div>
  <table>
    <thead><tr><th>Time</th><th>Subject</th><th>From</th><th>Tag</th><th>Recipients</th><th>Status</th></tr></thead>
    <tbody id="tasks"></tbody>
  </table>
  <script>
    fetch('/api/tasks').then(r => r.json()).then(data => {
      document.getElementById('total').textContent = data.length;
      document.getElementById('success').textContent = data.filter(t => t.status === 'success').length;
      document.getElementById('failed').textContent = data.filter(t => t.status === 'failed').length;
      const tbody = document.getElementById('tasks');
      if (!data.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">No forwarding tasks yet</td></tr>';
        return;
      }
      tbody.innerHTML = data.map(t => \`<tr>
        <td>\${new Date(t.timestamp).toLocaleString()}</td>
        <td>\${t.subject}</td>
        <td>\${t.from}</td>
        <td><span class="tag">\${t.matchedTag}</span></td>
        <td>\${t.recipients.join(', ')}</td>
        <td class="\${t.status}">\${t.status}\${t.error ? ' - ' + t.error : ''}</td>
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
