import { Request, Response, NextFunction } from "express";

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Playwright's self-contained HTML report includes inline scripts.
  const report = req.path.startsWith("/report") || /^\/runs\/[^/]+\/report(?:\/|$)/.test(req.path);
  res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self'${report ? " 'unsafe-inline'" : ""}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`);
  next();
}

/** JSON-only mutations plus browser origin checks protect cookie-authenticated routes. */
export function sameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  let foreign = req.get("sec-fetch-site") === "cross-site";
  if (origin) {
    try { foreign ||= new URL(origin).host !== req.get("host"); } catch { foreign = true; }
  }
  if (foreign) { res.status(403).json({ error: "Cross-origin requests are not allowed." }); return; }
  if (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0" && !req.is("application/json")) {
    res.status(415).json({ error: "Use application/json for request bodies." }); return;
  }
  next();
}

export function authRateLimit(limit = 20, windowMs = 15 * 60 * 1000) {
  const attempts = new Map<string, { count: number; expires: number }>();
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "POST") return next();
    const now = Date.now();
    for (const [key, value] of attempts) if (value.expires <= now) attempts.delete(key);
    const key = req.ip || "local";
    const entry = attempts.get(key) || { count: 0, expires: now + windowMs };
    if (entry.count >= limit) {
      res.setHeader("Retry-After", Math.ceil((entry.expires - now) / 1000));
      res.status(429).json({ error: "Too many authentication attempts. Try again later." }); return;
    }
    entry.count++;
    attempts.set(key, entry);
    res.once("finish", () => { if (res.statusCode < 400) entry.count = Math.max(0, entry.count - 1); });
    next();
  };
}
