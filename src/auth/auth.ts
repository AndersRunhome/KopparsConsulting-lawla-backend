/** Lösenord (argon2id), JWT (HS256) och användar-DTO. */
import argon2 from "argon2";
import { SignJWT, jwtVerify } from "jose";
import type { Db } from "../db/db.js";

export interface UserRow {
  id: number;
  email: string;
  name: string | null;
  role: string;
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface UserDto {
  id: number;
  email: string;
  name: string | null;
  role: string;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  isMember: boolean;
  isAdmin: boolean;
}

export function toUserDto(u: UserRow): UserDto {
  return {
    id: Number(u.id),
    email: u.email,
    name: u.name,
    role: u.role,
    isActive: u.is_active,
    createdAt: iso(u.created_at),
    lastLoginAt: u.last_login_at ? iso(u.last_login_at) : null,
    isMember: u.is_active,
    isAdmin: u.role === "admin",
  };
}

export function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

export const hashPassword = (pw: string) => argon2.hash(pw, { type: argon2.argon2id });
export const verifyPassword = (hash: string, pw: string) => argon2.verify(hash, pw).catch(() => false);

export class Tokens {
  private readonly key: Uint8Array;
  constructor(secret: string, private readonly ttlSeconds: number) {
    this.key = new TextEncoder().encode(secret);
  }
  async sign(user: Pick<UserRow, "id" | "role">): Promise<string> {
    return new SignJWT({ role: user.role })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(user.id))
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + this.ttlSeconds)
      .sign(this.key);
  }
  async verify(token: string): Promise<{ userId: number; role: string } | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ["HS256"] });
      return payload.sub ? { userId: Number(payload.sub), role: String(payload.role ?? "member") } : null;
    } catch {
      return null;
    }
  }
}

export async function findUserById(db: Db, id: number): Promise<UserRow | null> {
  return db.one<UserRow>(`SELECT id, email, name, role, is_active, created_at, last_login_at FROM users WHERE id = $1`, [id]);
}
