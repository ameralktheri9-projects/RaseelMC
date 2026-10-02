import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// AUTH-04: minimum 8 characters, upper and lower case, a number.
export function isPasswordStrongEnough(plain: string): boolean {
  if (plain.length < 8) return false;
  if (!/[a-z]/.test(plain)) return false;
  if (!/[A-Z]/.test(plain)) return false;
  if (!/[0-9]/.test(plain)) return false;
  return true;
}

export function generateTemporaryPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const pick = (chars: string, n: number) =>
    Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  const raw = pick(upper, 2) + pick(lower, 4) + pick(digits, 2);
  return raw
    .split("")
    .sort(() => Math.random() - 0.5)
    .join("");
}
