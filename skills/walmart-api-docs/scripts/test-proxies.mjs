import axios from "axios";

const proxies = `http://20.27.11.248:8561
http://20.78.118.91:8561
http://20.78.26.206:8561
http://20.27.14.220:8561
http://199.68.217.2:3128
http://8.222.175.80:6128
http://177.247.249.5:3128
http://20.164.75.153:8080
http://157.230.38.173:3128
http://139.162.46.62:3128
http://174.138.174.142:8181
http://187.19.128.76:3131
http://174.137.134.182:2999
http://192.99.8.15:8850
http://91.228.155.23:3128
http://5.250.181.197:3128
http://137.59.47.73:3128
http://217.52.247.73:1981
http://190.212.131.238:3128
http://185.191.239.248:3128
http://190.94.244.30:8080
http://116.80.48.148:3172
http://187.216.141.46:3128
http://74.242.169.16:3128
http://72.56.85.224:3128
http://144.31.203.168:3128
http://45.131.6.46:80
http://63.141.128.27:80
http://23.190.168.41:80
http://13.230.34.30:80
http://4.213.167.178:80
http://174.136.204.40:80
http://35.202.49.74:80
http://34.44.49.215:80
http://47.74.157.194:80
http://62.99.138.162:80
http://213.33.126.130:80
http://213.143.113.82:80
http://23.227.38.192:80
http://45.12.30.44:80
http://45.12.31.222:80
http://45.12.31.113:80
http://45.12.30.221:80
http://45.131.7.160:80
http://45.59.186.60:80
http://65.108.103.19:80
http://66.235.200.64:80
http://161.35.70.249:8080
http://161.35.4.201:80`
  .trim().split("\n").map(s => s.trim()).filter(Boolean);

const results = [];

async function test(proxyUrl) {
  const u = new URL(proxyUrl);
  const inst = axios.create({
    timeout: 8000,
    proxy: {
      protocol: "http",
      host: u.hostname,
      port: parseInt(u.port) || 80,
    },
  });
  const start = Date.now();
  try {
    const res = await inst.get("https://developer.walmart.com/", {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
      maxRedirects: 3,
      responseType: "text",
    });
    const ms = Date.now() - start;
    console.log(`✅ ${proxyUrl}  ${ms}ms`);
    return { proxy: proxyUrl, ok: true, ms };
  } catch (e) {
    const ms = Date.now() - start;
    console.log(`❌ ${proxyUrl}  ${ms}ms  ${e.code || e.message?.slice(0, 40)}`);
    return { proxy: proxyUrl, ok: false, ms, err: e.code || e.message?.slice(0, 40) };
  }
}

console.log(`测试 ${proxies.length} 个代理...\n`);
const batch = [];
for (const p of proxies) {
  batch.push(test(p));
  if (batch.length >= 5) {
    await Promise.all(batch);
    batch.length = 0;
  }
}
if (batch.length) await Promise.all(batch);

const working = results.filter(r => r.ok);
console.log(`\n\n可用代理 (${working.length}/${proxies.length}):`);
console.log(working.map(r => r.proxy).join(","));
