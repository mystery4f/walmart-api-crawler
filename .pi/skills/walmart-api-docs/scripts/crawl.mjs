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
 *   node crawl.mjs --concurrency 3                 # 设置并发数 (默认 4)
 *   node crawl.mjs --output-dir ./output           # 设置输出目录
 *   node crawl.mjs --slugs a,b,c                   # 只爬取指定 slug 列表
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

// ── 路径 ──────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname = .pi/skills/walmart-api-docs/scripts  → 项目根需要向上 4 级
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, "output");

// ── 配置 ──────────────────────────────────────────────
const BASE_URL = "https://developer.walmart.com";
const DOC_BASE = "/us-marketplace/docs/";
const ENTRY_SLUG = "introduction-to-marketplace-apis";
const MAX_RETRIES = 3;

// ── 参数解析 ──────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    dryRun: false,
    filter: null,
    concurrency: 4,
    outputDir: DEFAULT_OUTPUT,
    slugs: null,
    delay: 200,
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
        args.concurrency = parseInt(argv[++i], 10);
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
    }
  }
  return args;
}

// ── 工具 ──────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, retries = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    if (retries < MAX_RETRIES) {
      console.log(`  ↻ 重试 (${retries + 1}/${MAX_RETRIES}): ${url}`);
      await sleep(3000 * (retries + 1));
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
  const $ = cheerio.load(html);
  const slugs = [];
  // Walmart 文档站的侧边栏链接是相对路径（不含 / 前缀）
  $("#hub-sidebar a[href]").each((_, el) => {
    const href = $(el).attr("href")?.trim();
    // 只要纯 slug 形式的链接（排除绝对 URL、锚点、根路径）
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
  return [...new Set(slugs)]; // 去重保序
}

// ── 内容提取 ──────────────────────────────────────────
function extractContent(html) {
  const $ = cheerio.load(html);
  const mainEl = $("article").first();
  const target = mainEl.length ? mainEl : $("main").first();
  if (!target.length) return { title: $("title").text().trim(), contentHtml: "", contentText: "" };

  target.find("nav, script, style").remove();
  return {
    title: $("h1").first().text().trim() || $("title").text().trim(),
    contentHtml: target.html() || "",
    contentText: target.text().replace(/\s+/g, " ").trim(),
  };
}

function extractEndpoints(html) {
  const $ = cheerio.load(html);
  const text = $("body").text();
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
      if (!seen.has(key)) {
        seen.add(key);
        endpoints.push({ method, url });
      }
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
  const url = slugToUrl(slug);
  const html = await fetchWithRetry(url);
  const { title, contentHtml, contentText } = extractContent(html);
  const endpoints = extractEndpoints(html);
  const codeExamples = extractCodeExamples(html);
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

  // JSON
  fs.writeFileSync(
    path.join(outputDir, "json", `${filename}.json`),
    JSON.stringify(pageData, null, 2)
  );
  // HTML
  fs.writeFileSync(
    path.join(outputDir, "html", `${filename}.html`),
    contentHtml
  );
  // Markdown
  fs.writeFileSync(
    path.join(outputDir, "markdown", `${filename}.md`),
    toMarkdown(pageData)
  );

  return pageData;
}

// ── main ──────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);

  console.log("🚀 Walmart API 文档爬虫\n");
  console.log(`  并发: ${args.concurrency}  延迟: ${args.delay}ms  输出: ${args.outputDir}\n`);

  // 创建输出目录
  for (const d of ["json", "markdown", "html"]) {
    fs.mkdirSync(path.join(args.outputDir, d), { recursive: true });
  }

  // ── Step 1: 动态获取侧边栏链接 ──
  console.log("📡 Step 1: 从入口页动态获取侧边栏链接...");
  const entryHtml = await fetchWithRetry(slugToUrl(ENTRY_SLUG));
  let slugs = extractSidebarSlugs(entryHtml);

  if (!slugs.includes(ENTRY_SLUG)) slugs.unshift(ENTRY_SLUG);

  // 如果指定了 --slugs，覆盖
  if (args.slugs) {
    slugs = args.slugs;
    console.log(`  📋 使用指定的 ${slugs.length} 个 slug`);
  }

  // 如果指定了 --filter，过滤
  if (args.filter) {
    slugs = slugs.filter((s) => s.toLowerCase().includes(args.filter));
    console.log(`  🔍 过滤 "${args.filter}": 匹配 ${slugs.length} 个`);
  }

  // 保存链接索引
  const linkIndex = slugs.map((slug, i) => ({
    id: i + 1,
    slug,
    url: slugToUrl(slug),
  }));
  fs.writeFileSync(
    path.join(args.outputDir, "link-index.json"),
    JSON.stringify(linkIndex, null, 2)
  );
  console.log(`  ✅ 发现 ${slugs.length} 个页面\n`);

  // dry-run 模式：只输出链接列表，不爬取
  if (args.dryRun) {
    console.log("🏁 --dry-run 模式，仅输出链接列表:\n");
    for (const item of linkIndex) {
      console.log(`  ${String(item.id).padStart(3)}. ${item.slug}`);
    }
    return;
  }

  // ── Step 2: 爬取 ──
  console.log("📡 Step 2: 开始爬取...\n");
  const results = [];
  let done = 0;

  async function crawlOne(slug) {
    try {
      await sleep(args.delay + Math.random() * args.delay);
      const page = await crawlPage(slug, args.outputDir);
      done++;
      const ep = page.endpoints.length > 0 ? ` [${page.endpoints.length} endpoints]` : "";
      console.log(`  ✅ [${done}/${slugs.length}] ${page.title}${ep}`);
      return page;
    } catch (err) {
      done++;
      console.error(`  ❌ [${done}/${slugs.length}] ${slug}: ${err.message}`);
      return { title: slug, url: slugToUrl(slug), slug, error: err.message };
    }
  }

  for (let i = 0; i < slugs.length; i += args.concurrency) {
    const batch = slugs.slice(i, i + args.concurrency);
    const batchResults = await Promise.all(batch.map(crawlOne));
    results.push(...batchResults);
  }

  // ── Step 3: 汇总 ──
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

  fs.writeFileSync(
    path.join(args.outputDir, "summary.json"),
    JSON.stringify(summary, null, 2)
  );

  if (fail.length > 0) {
    fs.writeFileSync(
      path.join(args.outputDir, "failed.json"),
      JSON.stringify(fail, null, 2)
    );
  }

  console.log("━".repeat(50));
  console.log(`✅ 完成! 总页: ${slugs.length}  成功: ${ok.length}  失败: ${fail.length}  端点: ${allEndpoints.length}`);
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
