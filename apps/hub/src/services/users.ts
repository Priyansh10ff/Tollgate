import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { type DB, newId } from "../db.ts";
import { AppError } from "../errors.ts";

export interface User {
  id: string;
  email: string;
  createdAt: string;
}

const SESSION_DAYS = 30;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** scrypt with a random salt, stored as "scrypt$<salt>$<hash>". */
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

function checkPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = scryptSync(password, Buffer.from(salt, "base64url"), expected.length);
  return timingSafeEqual(expected, actual);
}

// Used when the email doesn't exist, so a wrong email takes as long as a wrong password.
const DUMMY_HASH = hashPassword(randomBytes(12).toString("hex"));

/** Website accounts and their dashboard sessions. */
export class Users {
  constructor(private db: DB) {}

  signup(email: string, password: string): { user: User; token: string } {
    const normalized = email.trim().toLowerCase();
    const exists = this.db.prepare("SELECT 1 FROM users WHERE email = ?").get(normalized);
    if (exists) throw new AppError(409, "email_taken", "An account with this email already exists. Log in instead.");
    const id = newId("usr");
    this.db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)").run(id, normalized, hashPassword(password));
    return { user: this.get(id), token: this.createSession(id) };
  }

  login(email: string, password: string): { user: User; token: string } {
    const row = this.db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(email.trim().toLowerCase()) as
      | { id: string; password_hash: string }
      | undefined;
    const ok = checkPassword(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok) throw new AppError(401, "bad_login", "Wrong email or password.");
    return { user: this.get(row.id), token: this.createSession(row.id) };
  }

  /** Returns the user for a valid, unexpired session token. */
  fromSession(token: string): User | undefined {
    const row = this.db
      .prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?")
      .get(hashToken(token)) as { user_id: string; expires_at: string } | undefined;
    if (!row) return undefined;
    if (Date.parse(row.expires_at) < Date.now()) {
      this.logout(token);
      return undefined;
    }
    return this.get(row.user_id);
  }

  logout(token: string) {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }

  get(id: string): User {
    const row = this.db.prepare("SELECT id, email, created_at FROM users WHERE id = ?").get(id) as
      | { id: string; email: string; created_at: string }
      | undefined;
    if (!row) throw new AppError(404, "not_found", "User not found");
    return { id: row.id, email: row.email, createdAt: row.created_at };
  }

  private createSession(userId: string): string {
    const token = `tg_sess_${randomBytes(32).toString("base64url")}`;
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
    this.db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(hashToken(token), userId, expires);
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
    return token;
  }
}
