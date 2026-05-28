import fs from "node:fs";
import axios from "axios";

const TARGET = parseInt(process.argv[2]) || 50;
const PROXY_FILE = process.argv[3] || "/tmp/all-proxies.txt";

const all = fs.readFileSync(PROXY_FILE, "utf-8")
  .split("\n").map(s => s.trim()).filter(s => /^https?:\/\/\d+\.\d+\.\d+\.\d+:\d+/.test(s));

console.log(`🔍 ${all.length} 个代理待测，目标 ${TARGET} 个 (5s超时)\n`);

const working = [];
let tested = 0;
const BATCH = 100;

async function test(p) {
  const u = new URL(p);
  const start = Date.now();
  try {
    const ax = axios.create({
      timeout: 5000,
      proxy: { protocol: "http", host: u.hostname, port: parseInt(u.port) || 80 },
    });
    await ax.get("https://developer.walmart.com/", {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
      maxRedirects: 2,
    });
    return { p, ms: Date.now() - start };
  } catch { return null; }
}

for (let i = 0; i < all.length && working.length < TARGET; i += BATCH) {
  const batch = all.slice(i, i + BATCH);
  const results = await Promise.all(batch.map(test));
  for (const r of results) {
    tested++;
    if (r) working.push(r);
  }
  // 按速度排序，优先保留快的
  working.sort((a, b) => a.ms - b.ms);
  process.stdout.write(`\r  已测 ${tested}  ✅ ${working.length}  最快 ${working[0]?.ms}ms`);
}
console.log(`\n\n🎯 找到 ${working.length} 个可用代理\n`);
// 只输出最快的 TARGET 个
const best = working.slice(0, TARGET);
console.log(best.map(r => r.p).join(","));
