// @ts-nocheck
import express from "express";
import { getSetting } from "../lib/settings";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { db, usersTable, ipBansTable } from "@workspace/db";
import { eq, or } from "drizzle-orm";
import { RegisterBody, LoginBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { isVpnOrProxy } from "../lib/ipCheck";
import { sendEmail, twoFactorEmailHtml, verificationEmailHtml } from "../lib/email";

const router = express.Router();

function getClientIp(req: Parameters<typeof router.post>[1] extends (req: infer R, ...a: any[]) => any ? R : never): string {
  const forwarded = (req as any).headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return (req as any).socket?.remoteAddress ?? "unknown";
}

const ALLOWED_EMAIL_DOMAINS = ["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "yahoo.fr", "yahoo.co.uk", "hotmail.fr", "hotmail.co.uk", "live.com", "msn.com"];

router.post("/register", async (req, res) => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { username, email, password } = parsed.data;

  // Only allow trusted email providers to reduce throwaway/bot accounts
  const emailDomain = email.split("@")[1]?.toLowerCase() ?? "";
  if (!ALLOWED_EMAIL_DOMAINS.includes(emailDomain)) {
    res.status(400).json({ error: "Only Gmail, Outlook, Hotmail, and Yahoo email addresses are accepted." });
    return;
  }

  const ip = (req.headers["x-forwarded-for"] as string || req.socket?.remoteAddress || "unknown").split(",")[0].trim();

  // Check if IP is banned
  const [ipBan] = await db.select().from(ipBansTable).where(eq(ipBansTable.ip, ip)).limit(1);
  if (ipBan) {
    res.status(403).json({ error: "Registration is not available from your network." });
    return;
  }

  // Block VPN / proxy / hosting IPs
  const vpn = await isVpnOrProxy(ip);
  if (vpn) {
    res.status(403).json({ error: "VPN and proxy connections are not allowed. Please disable your VPN and try again." });
    return;
  }

  const existing = await db.select().from(usersTable).where(eq(usersTable.username, username)).limit(1);
  if (existing.length > 0) {
    res.status(409).json({ error: "Username already taken" });
    return;
  }

  const existingEmail = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (existingEmail.length > 0) {
    res.status(409).json({ error: "Email already in use" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const startingPoints = await getSetting("points_registration");

  // Generate email verification token
  const verificationToken = crypto.randomBytes(32).toString("hex");
  const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  const [user] = await db
    .insert(usersTable)
    .values({
      username,
      email,
      passwordHash,
      registrationIp: ip,
      points: startingPoints,
      emailVerified: false,
      emailVerificationToken: verificationToken,
      emailVerificationExpiresAt: verificationExpiresAt,
    })
    .returning();

  // Try to send verification email; if SMTP not configured, auto-verify and log in normally
  const host = req.headers.host || "localhost";
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const verifyUrl = `${protocol}://${host}/verify-email?token=${verificationToken}`;

  try {
    await sendEmail(email, "Verify your Steam Family account", verificationEmailHtml(verifyUrl, username));
    // Email sent — don't log in yet, ask them to verify
    res.status(201).json({ requiresEmailVerification: true });
  } catch (emailErr: any) {
    const msg: string = emailErr?.message ?? "";
    // SMTP not configured — auto-verify and log the user in so they aren't locked out
    if (msg.includes("SMTP is not configured")) {
      await db.update(usersTable)
        .set({ emailVerified: true, emailVerificationToken: null, emailVerificationExpiresAt: null })
        .where(eq(usersTable.id, user.id));

      const { passwordHash: _, ...safeUser } = user;
      req.session.regenerate((err) => {
        if (err) { res.status(500).json({ error: "Session error" }); return; }
        req.session.userId = user.id;
        req.session.isAdmin = user.isAdmin;
        req.session.isModerator = user.isModerator;
        req.session._banCheckedAt = Date.now();
        req.session.save((saveErr) => {
          if (saveErr) { res.status(500).json({ error: "Session error" }); return; }
          res.status(201).json(safeUser);
        });
      });
      return;
    }
    // Other SMTP error — still create account but surface the error
    res.status(201).json({ requiresEmailVerification: true, emailError: "Account created, but we couldn't send the verification email. Contact support." });
  }
});

// GET /auth/verify-email?token=xxx — verify email address
router.get("/verify-email", async (req, res) => {
  const { token } = req.query as { token?: string };
  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "Invalid or missing token." });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.emailVerificationToken, token)).limit(1);
  if (!user) {
    res.status(400).json({ error: "Verification link is invalid or has already been used." });
    return;
  }

  if (user.emailVerificationExpiresAt && new Date() > new Date(user.emailVerificationExpiresAt)) {
    res.status(400).json({ error: "Verification link has expired. Please request a new one." });
    return;
  }

  await db.update(usersTable)
    .set({ emailVerified: true, emailVerificationToken: null, emailVerificationExpiresAt: null })
    .where(eq(usersTable.id, user.id));

  res.json({ verified: true, username: user.username });
});

// POST /auth/resend-verification — resend verification email
router.post("/resend-verification", async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email || typeof email !== "string") {
    res.status(400).json({ error: "Email is required." });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  // Always respond OK to avoid leaking whether an email exists
  if (!user || user.emailVerified) {
    res.json({ sent: true });
    return;
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.update(usersTable)
    .set({ emailVerificationToken: token, emailVerificationExpiresAt: expiresAt })
    .where(eq(usersTable.id, user.id));

  const host = req.headers.host || "localhost";
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const verifyUrl = `${protocol}://${host}/verify-email?token=${token}`;

  try {
    await sendEmail(email, "Verify your Steam Family account", verificationEmailHtml(verifyUrl, user.username));
  } catch {
    // silent — don't leak SMTP errors
  }

  res.json({ sent: true });
});

router.post("/login", async (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { username, password } = parsed.data;

  const loginIpRaw = (req.headers["x-forwarded-for"] as string || req.socket?.remoteAddress || "unknown").split(",")[0].trim();

  // Check if IP is banned before even looking up the user
  const [loginIpBan] = await db.select().from(ipBansTable).where(eq(ipBansTable.ip, loginIpRaw)).limit(1);
  if (loginIpBan) {
    res.status(403).json({ error: "Access from your network has been restricted." });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.username, username)).limit(1);
  if (!user) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  // Block login for unverified accounts
  if (user.emailVerified === false) {
    res.status(403).json({ error: "Please verify your email before logging in.", requiresEmailVerification: true, email: user.email });
    return;
  }

  if (user.isBanned && user.banExpiresAt && new Date() > new Date(user.banExpiresAt)) {
    await db.update(usersTable)
      .set({ isBanned: false, banReason: null, banExpiresAt: null })
      .where(eq(usersTable.id, user.id));
    user.isBanned = false;
    user.banReason = null;
    user.banExpiresAt = null;
  }

  // Record last login IP and timestamp for audit trail
  await db.update(usersTable).set({ lastLoginIp: loginIpRaw, lastLoginAt: new Date() }).where(eq(usersTable.id, user.id));

  // --- 2FA check ---
  if (user.twoFactorEnabled) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await db.update(usersTable)
      .set({ twoFactorCode: code, twoFactorCodeExpiresAt: expiresAt })
      .where(eq(usersTable.id, user.id));

    try {
      await sendEmail(user.email, "Your login code", twoFactorEmailHtml(code, user.username));
    } catch (emailErr: any) {
      const msg: string = emailErr?.message ?? "";
      // If SMTP is simply not configured yet, fall through to a normal login
      // so the admin can set it up without locking users out.
      if (msg.includes("SMTP is not configured")) {
        const { passwordHash: _pw, ...safeUserFallback } = user;
        req.session.regenerate((err) => {
          if (err) { res.status(500).json({ error: "Session error" }); return; }
          req.session.userId = user.id;
          req.session.isAdmin = user.isAdmin;
          req.session.isModerator = user.isModerator;
          req.session._banCheckedAt = Date.now();
          req.session.save((saveErr) => {
            if (saveErr) { res.status(500).json({ error: "Session error" }); return; }
            res.status(200).json(safeUserFallback);
          });
        });
        return;
      }
      res.status(500).json({ error: "Failed to send verification email. " + msg });
      return;
    }

    // Store pending user in session (not fully authenticated yet)
    req.session.regenerate((err) => {
      if (err) { res.status(500).json({ error: "Session error" }); return; }
      (req.session as any).pending2faUserId = user.id;
      req.session.save((saveErr) => {
        if (saveErr) { res.status(500).json({ error: "Session error" }); return; }
        res.status(200).json({ requiresTwoFactor: true });
      });
    });
    return;
  }

  const { passwordHash: _, ...safeUser } = user;

  // Regenerate session ID after login to prevent session fixation attacks
  req.session.regenerate((err) => {
    if (err) { res.status(500).json({ error: "Session error" }); return; }
    req.session.userId = user.id;
    req.session.isAdmin = user.isAdmin;
    req.session.isModerator = user.isModerator;
    req.session._banCheckedAt = Date.now();
    req.session.save((saveErr) => {
      if (saveErr) { res.status(500).json({ error: "Session error" }); return; }
      res.status(200).json(safeUser);
    });
  });
});

// POST /auth/verify-2fa — complete login after 2FA code is entered
router.post("/verify-2fa", async (req, res) => {
  const pendingUserId = (req.session as any).pending2faUserId;
  if (!pendingUserId) {
    res.status(400).json({ error: "No pending 2FA session. Please log in again." });
    return;
  }

  const { code } = req.body as { code: string };
  if (!code || typeof code !== "string" || !/^\d{6}$/.test(code.trim())) {
    res.status(400).json({ error: "Invalid code format." });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, pendingUserId)).limit(1);
  if (!user) {
    res.status(400).json({ error: "User not found." });
    return;
  }

  if (!user.twoFactorCode || user.twoFactorCode !== code.trim()) {
    res.status(401).json({ error: "Incorrect code. Please try again." });
    return;
  }

  if (!user.twoFactorCodeExpiresAt || new Date() > new Date(user.twoFactorCodeExpiresAt)) {
    res.status(401).json({ error: "Code has expired. Please log in again." });
    return;
  }

  // Clear the code
  await db.update(usersTable)
    .set({ twoFactorCode: null, twoFactorCodeExpiresAt: null })
    .where(eq(usersTable.id, user.id));

  const { passwordHash: _, ...safeUser } = user;

  req.session.regenerate((err) => {
    if (err) { res.status(500).json({ error: "Session error" }); return; }
    req.session.userId = user.id;
    req.session.isAdmin = user.isAdmin;
    req.session.isModerator = user.isModerator;
    req.session._banCheckedAt = Date.now();
    req.session.save((saveErr) => {
      if (saveErr) { res.status(500).json({ error: "Session error" }); return; }
      res.status(200).json(safeUser);
    });
  });
});

// GET /auth/2fa-status — returns whether 2FA is enabled for the logged-in user
router.get("/2fa-status", requireAuth, async (req, res) => {
  const [user] = await db
    .select({ twoFactorEnabled: usersTable.twoFactorEnabled })
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId!))
    .limit(1);
  res.json({ enabled: user?.twoFactorEnabled ?? false });
});

// POST /auth/2fa/enable — enable 2FA for the logged-in user
router.post("/2fa/enable", requireAuth, async (req, res) => {
  await db.update(usersTable)
    .set({ twoFactorEnabled: true })
    .where(eq(usersTable.id, req.session.userId!));
  res.json({ message: "Two-factor authentication enabled." });
});

// DELETE /auth/2fa — disable 2FA for the logged-in user
router.delete("/2fa", requireAuth, async (req, res) => {
  await db.update(usersTable)
    .set({ twoFactorEnabled: false, twoFactorCode: null, twoFactorCodeExpiresAt: null })
    .where(eq(usersTable.id, req.session.userId!));
  res.json({ message: "Two-factor authentication disabled." });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid", { path: "/" });
    res.json({ message: "Logged out" });
  });
});

router.get("/me", requireAuth, async (req, res) => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!)).limit(1);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  if (user.isBanned && user.banExpiresAt && new Date() > new Date(user.banExpiresAt)) {
    await db.update(usersTable)
      .set({ isBanned: false, banReason: null, banExpiresAt: null })
      .where(eq(usersTable.id, user.id));
    user.isBanned = false;
    user.banReason = null;
    user.banExpiresAt = null;
  }

  const { passwordHash: _, ...safeUser } = user;
  res.json(safeUser);
});

// Update avatar URL and/or display name
router.put("/profile", requireAuth, async (req, res) => {
  const { avatarUrl, displayName } = req.body;
  if (typeof avatarUrl !== "string" && avatarUrl !== null && avatarUrl !== undefined) {
    res.status(400).json({ error: "Invalid avatarUrl" });
    return;
  }
  // Only allow http/https URLs to prevent javascript: or data: URI injection
  if (avatarUrl && !/^https?:\/\//i.test(avatarUrl)) {
    res.status(400).json({ error: "avatarUrl must be a valid http or https URL" });
    return;
  }
  // Block private/local IP ranges (SSRF prevention).
  // Attackers set avatar URLs to local IPs so every visitor's browser
  // silently probes their local network when loading the leaderboard.
  if (avatarUrl) {
    try {
      const { hostname } = new URL(avatarUrl);
      const isPrivate =
        hostname === "localhost" ||
        hostname === "::1" ||
        hostname.endsWith(".local") ||
        hostname.endsWith(".internal") ||
        /^127\./.test(hostname) ||                         // 127.0.0.0/8
        /^10\./.test(hostname) ||                          // 10.0.0.0/8
        /^192\.168\./.test(hostname) ||                    // 192.168.0.0/16
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||   // 172.16.0.0/12
        /^169\.254\./.test(hostname) ||                    // 169.254.0.0/16
        /^0\./.test(hostname);                             // 0.0.0.0/8
      if (isPrivate) {
        res.status(400).json({ error: "avatarUrl cannot point to a private or local network address" });
        return;
      }
    } catch {
      res.status(400).json({ error: "avatarUrl is not a valid URL" });
      return;
    }
  }
  if (displayName !== undefined && typeof displayName !== "string") {
    res.status(400).json({ error: "Invalid displayName" });
    return;
  }
  const updates: Record<string, any> = {};
  if (avatarUrl !== undefined) updates.avatarUrl = avatarUrl || null;
  if (displayName !== undefined) {
    const trimmed = displayName.trim();
    if (trimmed && (trimmed.length < 2 || trimmed.length > 30)) {
      res.status(400).json({ error: "Display name must be 2–30 characters" });
      return;
    }
    updates.displayName = trimmed || null;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }
  const [updated] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, req.session.userId!))
    .returning();
  const { passwordHash: _, ...safeUser } = updated;
  res.json(safeUser);
});

// Change password (requires current password)
router.put("/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword || typeof newPassword !== "string" || newPassword.length < 6) {
    res.status(400).json({ error: "New password must be at least 6 characters" });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!)).limit(1);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }
  const newHash = await bcrypt.hash(newPassword, 10);
  await db.update(usersTable).set({ passwordHash: newHash }).where(eq(usersTable.id, user.id));
  res.json({ message: "Password updated successfully" });
});

// Delete own account
router.delete("/account", requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password) {
    res.status(400).json({ error: "Password required to delete account" });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!)).limit(1);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  // Banned users cannot delete their account to evade bans
  if (user.isBanned) {
    const isActiveBan = !user.banExpiresAt || new Date() < new Date(user.banExpiresAt);
    if (isActiveBan) {
      res.status(403).json({ error: "Banned accounts cannot be deleted" });
      return;
    }
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Incorrect password" });
    return;
  }
  await db.delete(usersTable).where(eq(usersTable.id, user.id));
  req.session.destroy(() => {
    res.clearCookie("connect.sid", { path: "/" });
    res.json({ message: "Account deleted" });
  });
});

export default router;
