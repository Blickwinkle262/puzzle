import bcrypt from "bcrypt";

export function createPasswordHasherService(options = {}) {
  const rawRounds = Number(options.rounds);
  const rounds = Number.isInteger(rawRounds) && rawRounds >= 4 && rawRounds <= 15
    ? rawRounds
    : 10;

  async function hashPassword(plainTextPassword) {
    return bcrypt.hash(String(plainTextPassword || ""), rounds);
  }

  async function verifyPassword(plainTextPassword, passwordHash) {
    if (typeof passwordHash !== "string" || !passwordHash) {
      return false;
    }
    return bcrypt.compare(String(plainTextPassword || ""), passwordHash);
  }

  return {
    hashPassword,
    verifyPassword,
  };
}
