/**
 * HTML pages shown during the Quicken sign-in flows (/oauth/authorize and /connect).
 * Every page goes through layout() so they share one theme.
 */

export interface MfaInfo {
  mfaChannel: string;
  email?: string;
  phone?: string;
}

type HiddenFields = Record<string, string | undefined>;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLES = `
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#f0fdf4}
  .card{background:#fff;border:1px solid #bbf7d0;border-radius:16px;padding:32px;width:100%;max-width:400px;box-shadow:0 4px 24px rgba(0,0,0,.06)}
  .logo{display:flex;align-items:center;gap:10px;margin-bottom:24px}
  .logo-mark{width:36px;height:36px;background:#15803d;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:18px}
  .logo-name{font-weight:700;font-size:18px;color:#14532d}
  h1{margin:0 0 4px;font-size:20px;font-weight:700;color:#14532d}
  p.sub{margin:0 0 20px;color:#4b5563;font-size:14px}
  label{display:block;font-size:13px;font-weight:500;color:#374151;margin-bottom:6px}
  input[type=email],input[type=password],input[type=text]{width:100%;padding:10px 12px;border:1.5px solid #d1fae5;border-radius:8px;font-size:15px;outline:none;transition:.15s}
  input:focus{border-color:#16a34a;box-shadow:0 0 0 3px rgba(22,163,74,.12)}
  input.code{font-size:18px;letter-spacing:.15em}
  .field{margin-bottom:16px}
  button[type=submit]{width:100%;padding:11px;background:#16a34a;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;transition:.15s}
  button[type=submit]:hover{background:#15803d}
  .error{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:16px}
  .notice{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;border-radius:8px;padding:10px 14px;font-size:12px;margin-bottom:20px}
  .success{text-align:center;padding:8px 0}
  .check{font-size:48px;margin-bottom:12px}
`;

function layout(title: string, inner: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>${STYLES}</style>
  </head>
  <body>
    <main class="card">
      <div class="logo"><div class="logo-mark">S</div><span class="logo-name">Simplifi MCP</span></div>
      ${inner}
    </main>
  </body>
</html>`;
}

function hiddenInputs(hidden: HiddenFields): string {
  return Object.entries(hidden)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(String(value))}" />`)
    .join("\n");
}

function errorBox(message?: string): string {
  return message ? `<div class="error">${escapeHtml(message)}</div>` : "";
}

function describeMfaContact(info: MfaInfo): string {
  if (/^(sms|text|phone)/i.test(info.mfaChannel)) {
    return info.phone ? `phone (${escapeHtml(info.phone)})` : "phone";
  }
  return info.email ? `email (${escapeHtml(info.email)})` : escapeHtml(info.mfaChannel);
}

export function loginPage(opts: {
  action: string;
  hidden?: HiddenFields;
  subtitle: string;
  errorMessage?: string;
}): string {
  return layout(
    "Simplifi MCP — Sign In",
    `<h1>Sign in to Simplifi</h1>
      <p class="sub">${escapeHtml(opts.subtitle)}</p>
      <div class="notice">🔒 Your credentials are sent directly to Quicken and are never stored on disk.</div>
      ${errorBox(opts.errorMessage)}
      <form method="POST" action="${escapeHtml(opts.action)}">
        ${hiddenInputs(opts.hidden ?? {})}
        <div class="field">
          <label>Email</label>
          <input type="email" name="email" autocomplete="email" autofocus required placeholder="you@example.com" />
        </div>
        <div class="field">
          <label>Password</label>
          <input type="password" name="password" autocomplete="current-password" required />
        </div>
        <button type="submit">Sign in</button>
      </form>`,
  );
}

export function mfaPage(opts: {
  action: string;
  hidden?: HiddenFields;
  mfaInfo: MfaInfo;
  errorMessage?: string;
}): string {
  return layout(
    "Simplifi MCP — Verify",
    `<h1>Two-step verification</h1>
      <p class="sub">A verification code was sent to your ${describeMfaContact(opts.mfaInfo)}. Enter it below to continue.</p>
      ${errorBox(opts.errorMessage)}
      <form method="POST" action="${escapeHtml(opts.action)}">
        ${hiddenInputs(opts.hidden ?? {})}
        <div class="field">
          <label>Verification code</label>
          <input type="text" class="code" name="mfa_code" inputmode="numeric" autocomplete="one-time-code" autofocus required placeholder="123456" />
        </div>
        <button type="submit">Verify</button>
      </form>`,
  );
}

export function successPage(): string {
  return layout(
    "Simplifi MCP — Connected",
    `<div class="success">
        <div class="check">✅</div>
        <h1>Connected!</h1>
        <p class="sub" style="margin:8px 0 0">Your Simplifi account is linked. You can close this tab — the MCP server is ready.</p>
      </div>`,
  );
}
