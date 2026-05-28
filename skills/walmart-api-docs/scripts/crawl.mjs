/**
 * Walmart API 文档爬取脚本
 *
 * 功能：
 *   1. 动态获取入口页面，实时提取侧边栏所有链接（不写死）
 *   2. 并发抓取所有页面内容
 *   3. 提取 API 端点信息
 *   4. 保存为 JSON / Markdown / HTML
 *   5. 生成汇总报告
 *
 * 用法:
 *   node crawl.mjs                                 # 全量爬取
 *   node crawl.mjs --dry-run                       # 仅获取侧边栏链接，不爬取内容
 *   node crawl.mjs --filter <keyword>              # 只爬取 slug 包含关键词的页面
 *   node crawl.mjs --concurrency 3                 # 设置并发数 (默认 50)
 *   node crawl.mjs --output-dir ./output           # 设置输出目录
 *   node crawl.mjs --slugs a,b,c                   # 只爬取指定 slug 列表
 *   node crawl.mjs --proxy http://localhost:4444   # 使用代理
 *   node crawl.mjs --debug                         # 打印性能调试信息
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import dnsCallback from "node:dns";
import { fileURLToPath } from "node:url";
import axios from "axios";
import * as cheerio from "cheerio";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

// ── 路径 ──────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = path.resolve(process.cwd(), "output");

// ── 配置 ──────────────────────────────────────────────
const BASE_URL = "https://developer.walmart.com";
const DOC_BASE = "/us-marketplace/docs/";
const ENTRY_SLUG = "introduction-to-marketplace-apis";
const DEFAULT_CONCURRENCY = 50;

// ── 代理 ──────────────────────────────────────────────
let axiosInstance = null;

function initProxy(proxyUrl) {
  if (!proxyUrl) {
    axiosInstance = axios.create({ timeout: 10_000 });
    return;
  }
  const u = new URL(proxyUrl);
  const protocol = u.protocol.replace(":", "");
  if (protocol === "socks5" || protocol === "socks4") {
    const agent = new SocksProxyAgent(proxyUrl);
    axiosInstance = axios.create({ timeout: 10_000, httpsAgent: agent, httpAgent: agent });
  } else {
    const agent = new HttpsProxyAgent(proxyUrl);
    axiosInstance = axios.create({ timeout: 10_000, httpsAgent: agent, httpAgent: agent });
  }
  console.log(`  🔀 代理: ${proxyUrl}`);
}

// ── Debug 工具 ────────────────────────────────────────
let debugMode = false;
const perfMarks = {};

function dbg(label, ms) {
  if (!debugMode) return;
  console.log(`    🐛 ${label}: ${ms.toFixed(0)}ms`);
}

function perfStart(name) {
  if (!debugMode) return;
  perfMarks[name] = performance.now();
}

function perfEnd(name, label) {
  if (!debugMode) return;
  const elapsed = performance.now() - (perfMarks[name] || 0);
  dbg(label || name, elapsed);
  return elapsed;
}

// ── 参数解析 ──────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    dryRun: false,
    filter: null,
    concurrency: DEFAULT_CONCURRENCY,
    outputDir: DEFAULT_OUTPUT,
    slugs: null,
    delay: 0,
    proxy: null,
    debug: false,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--filter":
        args.filter = argv[++i]?.toLowerCase();
        break;
      case "--concurrency":
        args.concurrency = parseInt(argv[++i], 10) || DEFAULT_CONCURRENCY;
        break;
      case "--output-dir":
        args.outputDir = argv[++i];
        break;
      case "--slugs":
        args.slugs = argv[++i]?.split(",").map((s) => s.trim());
        break;
      case "--delay":
        args.delay = parseInt(argv[++i], 10);
        break;
      case "--proxy":
        args.proxy = argv[++i];
        break;
      case "--debug":
        args.debug = true;
        break;
    }
  }
  return args;
}

// ── DNS fallback ──────────────────────────────────────
const FALLBACK_DNS = ["223.5.5.5", "8.8.8.8"];

function patchDnsLookup() {
  const originalLookup = dnsCallback.lookup;
  dnsCallback.lookup = function (hostname, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }

    originalLookup.call(dnsCallback, hostname, options, (err, address, family) => {
      if (!err) { callback(null, address, family); return; }

      (async () => {
        for (const server of FALLBACK_DNS) {
          try {
            const resolver = new dns.Resolver();
            resolver.setServers([server]);
            const ips = await resolver.resolve4(hostname);
            if (ips.length) {
              console.log(`  🔀 DNS fallback (${server}): ${hostname} → ${ips[0]}`);
              callback(null, ips[0], 4);
              return;
            }
          } catch {}
        }
        callback(new Error(`DNS 解析失败: ${hostname}`));
      })();
    });
  };
}

// ── 工具 ──────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let RETRY_COUNT = 0;

function isRetryableError(err) {
  const msg = err.message || "";
  const code = err.code || "";
  const status = err.response?.status || 0;
  return status >= 500 ||
    msg.includes("fetch failed") ||
    msg.includes("abort") ||
    msg.includes("timeout") ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    msg.includes("socket");
}

async function fetchWithRetry(url, retries = 0) {
  perfStart(`fetch:${url}`);
  try {
    const res = await axiosInstance.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      responseType: "text",
    });
    perfEnd(`fetch:${url}`, `  网络请求 ${url.split("/").pop()}`);
    return res.data;
  } catch (err) {
    perfEnd(`fetch:${url}`, `  网络请求(失败) ${url.split("/").pop()}`);
    if (isRetryableError(err)) {
      RETRY_COUNT++;
      if (retries > 0 && retries % 3 === 0) {
        console.log(`  ⚠️  ${url.split("/").pop()} 已重试 ${retries} 次，继续...`);
      }
      return fetchWithRetry(url, retries + 1);
    }
    throw err;
  }
}

function slugToUrl(slug) {
  return `${BASE_URL}${DOC_BASE}${slug}`;
}

function slugToFilename(slug) {
  return slug.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// ── 侧边栏提取（核心：每次动态获取）─────────────────
function extractSidebarSlugs(html) {
  perfStart("sidebar");
  const $ = cheerio.load(html);
  const slugs = [];
  $("#hub-sidebar a[href]").each((_, el) => {
    const href = $(el).attr("href")?.trim();
    if (
      href &&
      !href.startsWith("http") &&
      !href.startsWith("#") &&
      !href.startsWith("/") &&
      href.length > 1
    ) {
      slugs.push(href);
    }
  });
  perfEnd("sidebar", "  侧边栏解析");
  return [...new Set(slugs)];
}

// ── 内容提取 ──────────────────────────────────────────
function extractContent(html) {
  perfStart("extract");
  const $ = cheerio.load(html);
  const mainEl = $("article").first();
  const target = mainEl.length ? mainEl : $("main").first();
  if (!target.length) {
    perfEnd("extract", "  内容提取(无article/main)");
    return { title: $("title").text().trim(), contentHtml: "", contentText: "" };
  }

  target.find("nav, script, style").remove();
  perfEnd("extract", "  内容提取");
  return {
    title: $("h1").first().text().trim() || $("title").text().trim(),
    contentHtml: target.html() || "",
    contentText: target.text().replace(/\s+/g, " ").trim(),
  };
}

function extractEndpoints(html) {
  const text = cheerio.load(html)("body").text();
  const endpoints = [];
  const seen = new Set();

  const patterns = [
    /\b(GET|POST|PUT|DELETE|PATCH)\s+(\/v[\d.]+\/[^\s,：<>"')\]]+)/gi,
    /\b(GET|POST|PUT|DELETE|PATCH)\s+(https?:\/\/[^\s,：<>"')\]]+walmart[^\s,：<>"')\]]+)/gi,
  ];

  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      const method = m[1].toUpperCase();
      const url = m[2].replace(/[`'"]+/g, "").trim();
      const key = `${method}:${url}`;
      if (!seen.has(key)) { seen.add(key); endpoints.push({ method, url }); }
    }
  }
  return endpoints;
}

function extractCodeExamples(html) {
  const $ = cheerio.load(html);
  const examples = [];
  $("pre").each((_, el) => {
    const code = $(el).text().trim();
    if (code.length > 15) {
      const cls = $(el).find("code").attr("class") || "";
      const lang = cls.replace("language-", "").replace("hljs ", "").trim() || "text";
      examples.push({ language: lang, code });
    }
  });
  return examples;
}

function toMarkdown(page) {
  let md = `# ${page.title}\n\n> URL: ${page.url}\n\n---\n\n${page.contentText}\n\n`;
  if (page.endpoints?.length) {
    md += `## API Endpoints\n\n`;
    for (const ep of page.endpoints) md += `- **${ep.method}** \`${ep.url}\`\n`;
    md += "\n";
  }
  if (page.codeExamples?.length) {
    md += `## Code Examples\n\n`;
    for (const ex of page.codeExamples) md += `\`\`\`${ex.language}\n${ex.code}\n\`\`\`\n\n`;
  }
  return md;
}

// ── 爬取单页 ──────────────────────────────────────────
async function crawlPage(slug, outputDir) {
  perfStart(`page:${slug}`);
  const url = slugToUrl(slug);
  const html = await fetchWithRetry(url);

  perfStart(`parse:${slug}`);
  const { title, contentHtml, contentText } = extractContent(html);
  const endpoints = extractEndpoints(html);
  const codeExamples = extractCodeExamples(html);
  perfEnd(`parse:${slug}`, `  解析 ${slug}`);

  perfStart(`write:${slug}`);
  const filename = slugToFilename(slug);
  const pageData = {
    title: title || slug,
    url,
    slug,
    contentText,
    endpoints,
    codeExamples,
    crawledAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(outputDir, "json", `${filename}.json`), JSON.stringify(pageData, null, 2));
  fs.writeFileSync(path.join(outputDir, "html", `${filename}.html`), contentHtml);
  fs.writeFileSync(path.join(outputDir, "markdown", `${filename}.md`), toMarkdown(pageData));
  perfEnd(`write:${slug}`, `  写盘 ${slug}`);

  perfEnd(`page:${slug}`, `  整页 ${slug}`);
  return pageData;
}

// ── main ──────────────────────────────────────────────
async function main() {
  const t0 = performance.now();
  const args = parseArgs(process.argv);
  debugMode = args.debug;

  patchDnsLookup();
  initProxy(args.proxy || process.env.PROXY_POOL || null);

  console.log("🚀 Walmart API 文档爬虫\n");
  console.log(`  并发: ${args.concurrency}  延迟: ${args.delay}ms  输出: ${args.outputDir}${args.debug ? "  🐛 debug" : ""}`);
  console.log();

  // 创建输出目录
  for (const d of ["json", "markdown", "html"]) {
    fs.mkdirSync(path.join(args.outputDir, d), { recursive: true });
  }

  // ── Step 1: 动态获取侧边栏链接 ──
  perfStart("step1");
  console.log("📡 Step 1: 从入口页动态获取侧边栏链接...");
  const entryHtml = await fetchWithRetry(slugToUrl(ENTRY_SLUG));
  let slugs = extractSidebarSlugs(entryHtml);

  if (!slugs.includes(ENTRY_SLUG)) slugs.unshift(ENTRY_SLUG);

  if (args.slugs) {
    slugs = args.slugs;
    console.log(`  📋 使用指定的 ${slugs.length} 个 slug`);
  }

  if (args.filter) {
    slugs = slugs.filter((s) => s.toLowerCase().includes(args.filter));
    console.log(`  🔍 过滤 "${args.filter}": 匹配 ${slugs.length} 个`);
  }

  const linkIndex = slugs.map((slug, i) => ({ id: i + 1, slug, url: slugToUrl(slug) }));
  fs.writeFileSync(path.join(args.outputDir, "link-index.json"), JSON.stringify(linkIndex, null, 2));
  const step1ms = perfEnd("step1", "  Step 1 总耗时");
  console.log(`  ✅ 发现 ${slugs.length} 个页面\n`);

  if (args.dryRun) {
    console.log("🏁 --dry-run 模式，仅输出链接列表:\n");
    for (const item of linkIndex) console.log(`  ${String(item.id).padStart(3)}. ${item.slug}`);
    return;
  }

  // ── Step 2: 爬取（滑动窗口并发池）──
  perfStart("step2");
  console.log("📡 Step 2: 开始爬取...\n");
  const results = [];
  let done = 0;
  let nextIdx = 0;

  async function runWorker() {
    while (nextIdx < slugs.length) {
      const slug = slugs[nextIdx++]; // 原子取下一个任务
      const t0 = debugMode ? performance.now() : 0;
      try {
        if (args.delay > 0) await sleep(args.delay + Math.random() * args.delay);
        const page = await crawlPage(slug, args.outputDir);
        done++;
        const ep = page.endpoints.length > 0 ? ` [${page.endpoints.length} endpoints]` : "";
        console.log(`  ✅ [${done}/${slugs.length}] ${page.title}${ep}`);
        results.push(page);
      } catch (err) {
        done++;
        console.error(`  ❌ [${done}/${slugs.length}] ${slug}: ${err.message}`);
        results.push({ title: slug, url: slugToUrl(slug), slug, error: err.message });
      }
      if (debugMode) {
        dbg(`  页耗时 ${slug}`, performance.now() - t0);
      }
    }
  }

  // 启动 N 个 worker，各自不断取任务直到队列空
  const workers = Array.from({ length: Math.min(args.concurrency, slugs.length) }, () => runWorker());
  await Promise.all(workers);

  const step2ms = perfEnd("step2", "  Step 2 总耗时");

  // ── Step 3: 汇总 ──
  perfStart("step3");
  console.log("\n📊 Step 3: 生成汇总...\n");
  const ok = results.filter((r) => !r.error);
  const fail = results.filter((r) => r.error);
  const allEndpoints = ok.flatMap((r) => r.endpoints || []);

  const summary = {
    crawledAt: new Date().toISOString(),
    total: slugs.length,
    success: ok.length,
    failed: fail.length,
    totalEndpoints: allEndpoints.length,
    pages: results.map((r) => ({
      title: r.title,
      url: r.url,
      slug: r.slug,
      endpointCount: r.endpoints?.length || 0,
      error: r.error || null,
    })),
    endpoints: allEndpoints,
  };

  fs.writeFileSync(path.join(args.outputDir, "summary.json"), JSON.stringify(summary, null, 2));

  if (fail.length > 0) {
    fs.writeFileSync(path.join(args.outputDir, "failed.json"), JSON.stringify(fail, null, 2));
  }

  perfEnd("step3", "  Step 3 总耗时");

  // ── 最终报告 ──
  const totalMs = performance.now() - t0;
  const pagesPerSec = slugs.length / (totalMs / 1000);
  console.log("━".repeat(50));
  console.log(`✅ 完成! 总页: ${slugs.length}  成功: ${ok.length}  失败: ${fail.length}  端点: ${allEndpoints.length}`);
  console.log(`⏱️  总耗时: ${(totalMs / 1000).toFixed(1)}s  速率: ${pagesPerSec.toFixed(1)} 页/s  重试: ${RETRY_COUNT} 次`);

  if (debugMode) {
    console.log(`\n🐛 性能分析:`);
    console.log(`  Step 1 (发现页面): ${step1ms.toFixed(0)}ms`);
    console.log(`  Step 2 (爬取页面): ${step2ms.toFixed(0)}ms`);
    console.log(`  并发池: ${Math.min(args.concurrency, slugs.length)} workers  每页约 ${(step2ms / slugs.length).toFixed(0)}ms`);
    console.log(`  瓶颈: 网络 I/O (代理延迟)`);
  }
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
