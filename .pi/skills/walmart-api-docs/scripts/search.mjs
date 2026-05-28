/**
 * Walmart API 文档搜索脚本
 *
 * 用法:
 *   node search.mjs <query>                    # 默认 keyword 模式，搜索标题+内容
 *   node search.mjs <query> --mode endpoint    # 搜索 API 端点
 *   node search.mjs <query> --mode category    # 按模块分类浏览
 *   node search.mjs --mode list                # 列出所有模块及页面数
 *   node search.mjs --mode stats               # 输出爬取统计
 *
 * 选项:
 *   --mode <keyword|endpoint|category|list|stats>  搜索模式 (默认 keyword)
 *   --limit <n>                                     返回结果数 (默认 20)
 *   --output-dir <path>                             数据目录 (默认 ../../output)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── 路径 ──────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname = .pi/skills/walmart-api-docs/scripts  → 项目根需要向上 4 级
const DEFAULT_OUTPUT = path.resolve(__dirname, "..", "..", "..", "..", "output");

// ── 参数解析 ──────────────────────────────────────────
function parseArgs(argv) {
  const args = { mode: "keyword", limit: 20, outputDir: DEFAULT_OUTPUT, query: "" };
  const rest = [];

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--mode":
        args.mode = argv[++i];
        break;
      case "--limit":
        args.limit = parseInt(argv[++i], 10);
        break;
      case "--output-dir":
        args.outputDir = argv[++i];
        break;
      default:
        rest.push(argv[i]);
    }
  }
  args.query = rest.join(" ").trim();
  return args;
}

// ── 加载数据 ──────────────────────────────────────────
function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function loadAllPages(outputDir) {
  const jsonDir = path.join(outputDir, "json");
  if (!fs.existsSync(jsonDir)) {
    console.error(`❌ 数据目录不存在: ${jsonDir}`);
    console.error(`   请先运行爬虫: node scripts/crawl.mjs`);
    process.exit(1);
  }

  const files = fs.readdirSync(jsonDir).filter((f) => f.endsWith(".json"));
  const pages = [];
  for (const f of files) {
    const data = loadJson(path.join(jsonDir, f));
    if (data) pages.push(data);
  }
  return pages;
}

// ── 模式: keyword ─────────────────────────────────────
function searchKeyword(pages, query, limit) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) { console.log("⚠️ 请输入搜索关键词"); return; }

  const scored = pages.map((page) => {
    const title = (page.title || "").toLowerCase();
    const text = (page.contentText || "").toLowerCase();
    let score = 0;

    for (const term of terms) {
      // 标题匹配权重高
      if (title.includes(term)) score += 10;
      // 内容匹配
      const count = (text.match(new RegExp(term, "gi")) || []).length;
      score += Math.min(count, 50);
      // 端点 URL 匹配
      if (page.endpoints) {
        for (const ep of page.endpoints) {
          if (ep.url.toLowerCase().includes(term)) score += 5;
          if (ep.method.toLowerCase() === term) score += 3;
        }
      }
    }

    return { page, score };
  }).filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (scored.length === 0) {
    console.log(`🔍 未找到与 "${query}" 相关的结果`);
    return;
  }

  console.log(`🔍 搜索 "${query}" — 找到 ${scored.length} 个结果:\n`);
  for (const { page, score } of scored) {
    console.log(`─── [相关度: ${score}] ───`);
    console.log(`  标题: ${page.title}`);
    console.log(`  URL:  ${page.url}`);
    if (page.endpoints?.length) {
      console.log(`  端点:`);
      for (const ep of page.endpoints.slice(0, 5)) {
        console.log(`    ${ep.method} ${ep.url}`);
      }
      if (page.endpoints.length > 5) {
        console.log(`    ... 还有 ${page.endpoints.length - 5} 个`);
      }
    }
    // 显示内容摘要
    const snippet = (page.contentText || "").substring(0, 200).trim();
    if (snippet) {
      console.log(`  摘要: ${snippet}...`);
    }
    console.log();
  }
}

// ── 模式: endpoint ────────────────────────────────────
function searchEndpoint(pages, query, limit) {
  const q = query.toLowerCase();
  const results = [];

  for (const page of pages) {
    if (!page.endpoints?.length) continue;
    for (const ep of page.endpoints) {
      const match = !q
        || ep.method.toLowerCase().includes(q)
        || ep.url.toLowerCase().includes(q);
      if (match) {
        results.push({ ...ep, pageTitle: page.title, pageUrl: page.url, slug: page.slug });
      }
    }
  }

  if (results.length === 0) {
    console.log(`🔍 未找到与 "${query}" 相关的端点`);
    return;
  }

  const shown = results.slice(0, limit);
  console.log(`🔍 端点搜索 "${query}" — 找到 ${results.length} 个端点 (显示 ${shown.length} 个):\n`);

  // 按 URL 分组
  const grouped = new Map();
  for (const r of shown) {
    const key = `${r.method} ${r.url}`;
    if (!grouped.has(key)) grouped.set(key, r);
  }

  for (const [key, r] of grouped) {
    console.log(`  ${r.method.padEnd(7)} ${r.url}`);
    console.log(`          📄 ${r.pageTitle}`);
    console.log(`          🔗 ${r.pageUrl}`);
    console.log();
  }
}

// ── 模式: category ────────────────────────────────────
function searchCategory(pages, query, limit) {
  const q = query.toLowerCase();

  // 从 summary.json 中获取分类信息
  // 或者从页面 slug 中推断分类（sidebar 结构）
  // 根据 slug 前缀和内容推断
  const categories = inferCategories(pages);

  if (!q) {
    // 列出所有分类
    console.log(`📂 所有模块分类:\n`);
    for (const [name, catPages] of categories) {
      const epCount = catPages.reduce((s, p) => s + (p.endpoints?.length || 0), 0);
      console.log(`  ${name} (${catPages.length} 页, ${epCount} 端点)`);
      for (const p of catPages.slice(0, 3)) {
        console.log(`    - ${p.title}`);
      }
      if (catPages.length > 3) {
        console.log(`    ... 还有 ${catPages.length - 3} 个`);
      }
      console.log();
    }
    return;
  }

  // 搜索匹配的分类
  const matched = [...categories.entries()]
    .filter(([name]) => name.toLowerCase().includes(q));

  if (matched.length === 0) {
    console.log(`🔍 未找到与 "${query}" 相关的分类`);
    return;
  }

  for (const [name, catPages] of matched) {
    const epCount = catPages.reduce((s, p) => s + (p.endpoints?.length || 0), 0);
    console.log(`📂 ${name} (${catPages.length} 页, ${epCount} 端点)\n`);
    for (const p of catPages) {
      console.log(`  - ${p.title}`);
      if (p.endpoints?.length) {
        for (const ep of p.endpoints.slice(0, 3)) {
          console.log(`    ${ep.method} ${ep.url}`);
        }
      }
      console.log();
    }
  }
}

/** 从 slug 推断分类 — 使用 link-index.json 的顺序和 summary 中的信息 */
function inferCategories(pages) {
  // 预定义分类关键词映射
  const categoryRules = [
    { name: "Getting Started", patterns: ["introduction", "get-started", "getting-started", "authentication", "oauth", "token", "scope", "delegated"] },
    { name: "Search Engine Marketing (SEM)", patterns: ["sem", "campaign", "search-engine-marketing", "catalog-management", "reporting", "billing-history"] },
    { name: "Assortment Recommendations", patterns: ["assortment", "recommendations", "variants", "trends", "categorization"] },
    { name: "Shipment Protection", patterns: ["shipment-protection", "claim"] },
    { name: "Disputes", patterns: ["dispute", "duplicate"] },
    { name: "Feeds", patterns: ["feed", "fitment"] },
    { name: "Insights", patterns: ["insight", "listing-quality", "pro-seller", "unpublished-item"] },
    { name: "Seller Performance", patterns: ["seller-performance", "negative-feedback", "returns-performance", "item-not-received", "tracking-rate", "ship-from", "on-time-shipment", "carrier-method", "response-rate", "order-refund", "on-time-delivery", "order-cancellation"] },
    { name: "Inventory", patterns: ["inventory", "ship-node", "lag-time"] },
    { name: "Item Management", patterns: ["item-management", "item-setup", "create-item", "item-search", "catalog-search", "item-detail", "gtin", "retire", "bulk-item", "automotive", "repricing-during"] },
    { name: "Notifications", patterns: ["notification", "subscription", "webhook", "event-type", "buy-box-event", "inventory-oos", "offer-published", "po-created", "driver-status", "return-notification"] },
    { name: "Reports", patterns: ["report", "on-request", "report-schedul"] },
    { name: "Orders", patterns: ["order-management", "retrieve-order", "released-order", "acknowledge", "ship-order", "cancel-order", "refund-order", "carrier-names", "mlmq"] },
    { name: "Payments", patterns: ["payment", "tax-form", "recon", "performance-report"] },
    { name: "Pricing & Promotions", patterns: ["pricing", "repricer", "price-incentive", "promotional", "promotion-price"] },
    { name: "Returns", patterns: ["return", "refund-api", "return-overrides"] },
    { name: "Reviews", patterns: ["review", "rap-post", "eligible-item", "enrolled-item"] },
    { name: "Sandbox", patterns: ["sandbox", "dynamic-sandbox", "feeds-validation"] },
    { name: "Settings & Shipping", patterns: ["settings", "shipping-template", "fulfillment-center", "shipping-config", "carrier-method", "simplified-shipping", "partner-config"] },
    { name: "Utility APIs", patterns: ["utilitie", "taxonomy", "department", "categor", "platform-status"] },
    { name: "WFS (Walmart Fulfillment Services)", patterns: ["wfs-", "walmart-fulfillment", "inbound-shipment", "multichannel", "mcs-", "fulfillment-order", "walmart-preferred", "carrier-rate", "booking", "label", "bol", "shipment-tracking", "pickup"] },
    { name: "Troubleshooting & FAQ", patterns: ["troubleshoot", "error-code", "faq", "glossary", "analytics-dashboard"] },
  ];

  const categorized = new Map();
  const assigned = new Set();

  // 按规则分配
  for (const rule of categoryRules) {
    const catPages = [];
    for (const page of pages) {
      const slug = (page.slug || "").toLowerCase();
      const title = (page.title || "").toLowerCase();
      const matched = rule.patterns.some(
        (p) => slug.includes(p) || title.includes(p)
      );
      if (matched && !assigned.has(page.slug)) {
        catPages.push(page);
        assigned.add(page.slug);
      }
    }
    if (catPages.length > 0) {
      categorized.set(rule.name, catPages);
    }
  }

  // 未归类的
  const unassigned = pages.filter((p) => !assigned.has(p.slug));
  if (unassigned.length > 0) {
    categorized.set("Other", unassigned);
  }

  return categorized;
}

// ── 模式: list ────────────────────────────────────────
function listCategories(pages) {
  const categories = inferCategories(pages);
  console.log(`📂 Walmart API 文档模块 (${pages.length} 页):\n`);
  for (const [name, catPages] of categories) {
    const epCount = catPages.reduce((s, p) => s + (p.endpoints?.length || 0), 0);
    console.log(`  ${name}`);
    console.log(`    ${catPages.length} 页面, ${epCount} 端点`);
  }
}

// ── 模式: stats ───────────────────────────────────────
function showStats(outputDir) {
  const summary = loadJson(path.join(outputDir, "summary.json"));
  if (!summary) {
    console.error("❌ summary.json 不存在，请先运行爬虫");
    process.exit(1);
  }

  console.log("📊 Walmart API 文档爬取统计\n");
  console.log(`  爬取时间: ${summary.crawledAt}`);
  console.log(`  总页面:   ${summary.total}`);
  console.log(`  成功:     ${summary.success}`);
  console.log(`  失败:     ${summary.failed}`);
  console.log(`  API 端点: ${summary.totalEndpoints}`);

  // 端点方法统计
  const methodCounts = new Map();
  for (const ep of summary.endpoints) {
    methodCounts.set(ep.method, (methodCounts.get(ep.method) || 0) + 1);
  }
  console.log(`\n  端点方法分布:`);
  for (const [method, count] of methodCounts) {
    console.log(`    ${method}: ${count}`);
  }

  // 失败列表
  const failed = summary.pages.filter((p) => p.error);
  if (failed.length > 0) {
    console.log(`\n  ❌ 失败页面:`);
    for (const f of failed) {
      console.log(`    ${f.title}: ${f.error}`);
    }
  }
}

// ── main ──────────────────────────────────────────────
const args = parseArgs(process.argv);

switch (args.mode) {
  case "keyword": {
    if (!args.query) { console.log("⚠️ 请输入搜索关键词"); process.exit(1); }
    const pages = loadAllPages(args.outputDir);
    searchKeyword(pages, args.query, args.limit);
    break;
  }
  case "endpoint": {
    const pages = loadAllPages(args.outputDir);
    searchEndpoint(pages, args.query, args.limit);
    break;
  }
  case "category": {
    const pages = loadAllPages(args.outputDir);
    searchCategory(pages, args.query, args.limit);
    break;
  }
  case "list": {
    const pages = loadAllPages(args.outputDir);
    listCategories(pages);
    break;
  }
  case "stats": {
    showStats(args.outputDir);
    break;
  }
  default:
    console.error(`❌ 未知模式: ${args.mode}`);
    console.error("   可用模式: keyword, endpoint, category, list, stats");
    process.exit(1);
}
