# Security Policy

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report privately using GitHub's **"Report a vulnerability"** button under this
repository's **Security → Advisories** tab (GitHub Private Vulnerability Reporting).

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (optional)

This is a solo-maintained open-source project: responses are best-effort, with no fixed SLA.
Please allow time to patch before public disclosure.

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
