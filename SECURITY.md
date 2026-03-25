# Security Policy

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: [your-security-email@example.com]

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (optional)

You will receive a response within 72 hours. Please allow time to patch before public disclosure.

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | Yes       |

## Security Design

- OAuth tokens encrypted at rest (AES-256-GCM)
- Meta webhook signatures verified on every request (HMAC-SHA256)
- All database queries scoped by `workspace_id`
- No secrets accepted from user input
- Per-channel webhook secrets (not shared)
- Auth tokens are JWTs, never stored server-side
