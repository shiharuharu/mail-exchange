// Reply email template - Edit this file to customize the notification

export interface RecipientResult {
  email: string;
  success: boolean;
  error?: string;
}

export interface ReplyData {
  subject: string;
  results: RecipientResult[];
  duration: number;
  timestamp: string;
}

export function getReplySubject(data: ReplyData): string {
  const allSuccess = data.results.every((r) => r.success);
  return allSuccess ? `[Mail Exchange] 转发成功 - ${data.subject}` : `[Mail Exchange] 部分失败 - ${data.subject}`;
}

export function getReplyHtml(data: ReplyData): string {
  const successCount = data.results.filter((r) => r.success).length;
  const failCount = data.results.length - successCount;
  const allSuccess = failCount === 0;
  const themeColor = allSuccess ? "#10B981" : "#F59E0B";

  const rows = data.results
    .map((r) => {
      const badge = r.success
        ? '<span style="display:inline-block;padding:4px 10px;background-color:#D1FAE5;color:#065F46;font-size:12px;font-weight:bold;">✓ 成功</span>'
        : '<span style="display:inline-block;padding:4px 10px;background-color:#FEE2E2;color:#991B1B;font-size:12px;font-weight:bold;">✗ 失败</span>';
      const errorLine = r.error ? `<div style="margin-top:4px;font-size:12px;color:#DC2626;">${r.error}</div>` : "";
      return `<tr>
        <td style="padding:12px;border-bottom:1px solid #f0f0f0;color:#374151;">${r.email}${errorLine}</td>
        <td style="padding:12px;border-bottom:1px solid #f0f0f0;text-align:right;vertical-align:top;">${badge}</td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;">
  <tr>
    <td align="center" style="padding:20px;">
      <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border:1px solid #e5e7eb;">
        <tr><td style="height:6px;background-color:${themeColor};"></td></tr>
        <tr>
          <td style="padding:24px 32px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e5e7eb;padding-bottom:16px;margin-bottom:20px;">
              <tr><td>
                <h1 style="margin:0 0 8px 0;font-size:20px;color:#111827;">${allSuccess ? "✅ 邮件转发成功" : "⚠️ 邮件转发部分失败"}</h1>
                <p style="margin:0;color:#6b7280;font-size:14px;">原始标题: <span style="color:#111827;font-weight:bold;">${data.subject}</span></p>
              </td></tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;margin-bottom:24px;">
              <tr>
                <td width="33%" align="center" style="padding:12px;border-right:1px solid #e5e7eb;">
                  <div style="font-size:12px;color:#6b7280;text-transform:uppercase;">总数</div>
                  <div style="font-size:24px;font-weight:bold;color:#374151;">${data.results.length}</div>
                </td>
                <td width="33%" align="center" style="padding:12px;border-right:1px solid #e5e7eb;">
                  <div style="font-size:12px;color:#6b7280;text-transform:uppercase;">成功</div>
                  <div style="font-size:24px;font-weight:bold;color:#10B981;">${successCount}</div>
                </td>
                <td width="34%" align="center" style="padding:12px;">
                  <div style="font-size:12px;color:#6b7280;text-transform:uppercase;">失败</div>
                  <div style="font-size:24px;font-weight:bold;color:${failCount > 0 ? "#EF4444" : "#d1d5db"};">${failCount}</div>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 12px 0;font-size:14px;color:#4b5563;font-weight:bold;">发送详情</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
              <tr style="background-color:#f9fafb;">
                <td style="padding:10px 12px;color:#6b7280;font-weight:bold;">收件人</td>
                <td style="padding:10px 12px;color:#6b7280;font-weight:bold;text-align:right;">状态</td>
              </tr>
              ${rows}
            </table>
          </td>
        </tr>
        <tr>
          <td style="background-color:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;text-align:center;">
            <p style="margin:0 0 4px 0;font-weight:bold;">Mail Exchange</p>
            <p style="margin:0;">耗时: ${data.duration}ms · ${data.timestamp}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

export function getReplyText(data: ReplyData): string {
  const successCount = data.results.filter((r) => r.success).length;
  const failCount = data.results.length - successCount;
  const lines = data.results.map((r) => `  ${r.email}: ${r.success ? "成功" : "失败 - " + (r.error || "未知")}`);

  return `[Mail Exchange] 邮件转发报告

原始标题: ${data.subject}
统计: 成功 ${successCount} / 失败 ${failCount} / 共 ${data.results.length}

发送详情:
${lines.join("\n")}

耗时: ${data.duration}ms
完成时间: ${data.timestamp}`;
}
