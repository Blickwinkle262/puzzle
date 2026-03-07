import { createPasswordHasherService } from "../src/services/passwordHasherService.js";

function toMs(start, end) {
  return Number(end - start) / 1e6;
}

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

async function runBenchmark({ rounds, iterations, concurrency }) {
  const { hashPassword, verifyPassword } = createPasswordHasherService({ rounds });
  const basePassword = `Bench#${Date.now()}!Aa1`;

  const hashDurations = [];
  const verifyDurations = [];

  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, iterations));

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= iterations) {
        return;
      }

      const plainText = `${basePassword}-${index}`;

      const hashStart = process.hrtime.bigint();
      const hash = await hashPassword(plainText);
      const hashEnd = process.hrtime.bigint();
      hashDurations.push(toMs(hashStart, hashEnd));

      const verifyStart = process.hrtime.bigint();
      const verified = await verifyPassword(plainText, hash);
      const verifyEnd = process.hrtime.bigint();
      verifyDurations.push(toMs(verifyStart, verifyEnd));

      if (!verified) {
        throw new Error("password verify failed during benchmark");
      }
    }
  }

  const wallStart = process.hrtime.bigint();
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const wallEnd = process.hrtime.bigint();

  return {
    rounds,
    iterations,
    concurrency: workerCount,
    wall_ms: toMs(wallStart, wallEnd),
    hash_ms: {
      avg: average(hashDurations),
      p50: percentile(hashDurations, 50),
      p95: percentile(hashDurations, 95),
      p99: percentile(hashDurations, 99),
      max: percentile(hashDurations, 100),
    },
    verify_ms: {
      avg: average(verifyDurations),
      p50: percentile(verifyDurations, 50),
      p95: percentile(verifyDurations, 95),
      p99: percentile(verifyDurations, 99),
      max: percentile(verifyDurations, 100),
    },
  };
}

function normalizePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.floor(n);
}

const rounds = normalizePositiveInt(process.env.BENCH_ROUNDS || process.env.AUTH_PASSWORD_HASH_ROUNDS, 10);
const iterations = normalizePositiveInt(process.env.BENCH_ITERATIONS, 24);
const concurrency = normalizePositiveInt(process.env.BENCH_CONCURRENCY, 4);

const result = await runBenchmark({ rounds, iterations, concurrency });
console.log(JSON.stringify(result, null, 2));
