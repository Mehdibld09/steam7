---
name: Security hardening decisions
description: All security patches applied and the reasoning behind each one.
---

## Email domain whitelist
Only @gmail.com, @outlook.com, @hotmail.com, @hotmail.fr, @hotmail.co.uk, @yahoo.com, @yahoo.fr, @yahoo.co.uk, @live.com, @msn.com allowed on registration. Hacker used cadebek.com (disposable). Whitelist is in `ALLOWED_EMAIL_DOMAINS` array in `artifacts/api-server/src/routes/auth.ts`.

**Why:** Disposable/throwaway email providers let attackers create and abandon accounts with no traceability.

## IP tracking
- `last_login_ip` and `last_login_at` added to `usersTable` schema (pushed via drizzle push).
- Login endpoint updates both fields on every successful login.
- Admin `/admin/users` endpoint returns both fields + `email` + `displayName` + `registrationIp`.
- Admin panel users table: click any row to expand — shows email, reg IP, last login IP, last login time, joined date, premium, avatar URL.

## SSRF via avatar URL
Hacker set avatar_url = `http://169.254.169.254/latest/meta-data/` (AWS IMDS). Now blocked: private IP ranges (10.x, 192.168.x, 172.16-31.x, 127.x, 169.254.x), localhost, *.local. Validated in avatar update route.

## XP farming
Self-likes blocked. Like/unlike loop now only grants XP on first like (not on unlike). Comment XP capped per post per user.

## Ban bypass
`requireAuth` now async — checks ban status every 2 min via `_banCheckedAt` cache on session.

## Session fixation
`req.session.regenerate()` called on both login and register.

## IP ban system
- New `ip_bans` table: `id`, `ip` (unique), `reason`, `banned_by_user_id`, `created_at`.
- Banning a user auto-bans their `registration_ip` and `last_login_ip` via `onConflictDoNothing`.
- Unbanning a user auto-removes the IP bans for their IPs.
- Login and register both check `ip_bans` before proceeding — returns 403 if IP is banned.
- Admin `IP Bans` tab: manually add/remove IPs, see full list.

## VPN/proxy blocking on registration
- `artifacts/api-server/src/lib/ipCheck.ts` — `isVpnOrProxy(ip)` uses ip-api.com free API.
- Checks `proxy` and `hosting` fields; results cached 1 hour in memory.
- Only applied on registration (not login — too strict for existing users).
- Fails open (allows through) if ip-api.com is down/rate-limited — never blocks legit users due to API failure.

## Known hacker on record (Vercel DB)
- Vercel user id: 264, username: `a user`
- Email: `soyito5427@cadebek.com` (disposable — cadebek.com)
- avatar_url: `http://169.254.169.254/latest/meta-data/` (AWS IMDS SSRF)
- registration_ip: `94.227.67.19` — Telenet BV residential, Mechelen, Belgium 🇧🇪
- Also attempted stored XSS: account title `<script>alert(1)</script>`
- Claimed Steam account #52 (Faizul07 + real password) 122 times
