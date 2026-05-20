const crypto = require("crypto");

const PASSWORD = process.env.PLAYGROUND_PASSWORD || "Iambellafrombreys";
const SECRET =
  process.env.APP_SECRET ||
  (() => {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[auth] APP_SECRET is not set in production. Tokens will be invalidated on every restart."
      );
    }
    return crypto.randomBytes(32).toString("hex");
  })();

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64");
}

function signToken() {
  const payload = { exp: Date.now() + TOKEN_TTL_MS };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(
    crypto.createHmac("sha256", SECRET).update(body).digest()
  );
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [body, sig] = parts;
  const expectedSig = b64url(
    crypto.createHmac("sha256", SECRET).update(body).digest()
  );
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;
  try {
    const payload = JSON.parse(b64urlDecode(body).toString("utf8"));
    if (typeof payload.exp !== "number") return false;
    if (Date.now() > payload.exp) return false;
    return true;
  } catch {
    return false;
  }
}

function loginHandler(req, res) {
  const { password } = req.body || {};
  if (typeof password !== "string" || password.length === 0) {
    return res.status(400).json({ error: "Password required" });
  }
  const expected = Buffer.from(PASSWORD);
  const provided = Buffer.from(password);
  const ok =
    expected.length === provided.length &&
    crypto.timingSafeEqual(expected, provided);
  if (!ok) {
    return res.status(401).json({ error: "Wrong password" });
  }
  return res.json({ token: signToken() });
}

function requireAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1] : null;
  if (!verifyToken(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

module.exports = { loginHandler, requireAuth };
