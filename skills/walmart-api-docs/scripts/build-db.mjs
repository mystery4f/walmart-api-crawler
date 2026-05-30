/**
 * Walmart API 文档 → SQLite 数据库构建脚本
 *
 * 读取 output/json/ 下的所有 JSON 文件，构建带 FTS5 全文索引的 SQLite 数据库。
 * 数据库保存在 output/walmart-api.db.
 *
 * 用法:
 *   node scripts/build-db.mjs                         # 全量重建
 *   node scripts/build-db.mjs --output-dir <path>     # 指定数据目录
 *   node scripts/build-db.mjs --verbose               # 打印进度
 *
 * 依赖: better-sqlite3 (原生 SQLite + FTS5 支持)
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = path.join(os.homedir(), "crawl", "walmart");

// ── 参数解析 ──────────────────────────────────────────
function parseArgs(argv) {
  const args = { outputDir: DEFAULT_OUTPUT, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--output-dir":
        args.outputDir = argv[++i];
        break;
      case "--verbose":
        args.verbose = true;
        break;
    }
  }
  return args;
}

/** 清理 URL 中的 HTML 残留和换行符 */
function cleanUrl(url) {
  if (!url) return url;
  return url
    .replace(/<\/?code>/gi, "")       // 移除 <code> 和 </code>
    .replace(/\\n/g, " ")               // 转义换行 → 空格
    .replace(/\n/g, " ")                 // 字面换行 → 空格
    .replace(/&amp;/g, "&")              // HTML &amp;
    .replace(/&lt;/g, "<")               // HTML &lt;
    .replace(/&gt;/g, ">")               // HTML &gt;
    .replace(/&quot;/g, '"')             // HTML &quot;
    .replace(/\s+/g, " ")               // 合并空白
    .replace(/^https?:\/\/marketplace\.walmartapis\.com/, "") // 去掉完全限定域名
    .trim();
}

/** 清理正文中的 HTML 标签 */
function cleanText(text) {
  if (!text) return text;
  return text
    .replace(/<\/?code>/gi, "")
    .replace(/<\/?pre>/gi, "")
    .replace(/\u003c\/?code\u003e/gi, "")  // 已编码的 <code>
    .replace(/\u003c\/?pre\u003e/gi, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// ── 分类规则 ──────────────────────────────────────────
const CATEGORY_RULES = [
  { name: "Getting Started", patterns: ["introduction", "get-started", "getting-started", "authentication", "oauth", "token", "scope", "delegated", "glossary"] },
  { name: "Search Engine Marketing (SEM)", patterns: ["sem", "campaign", "search-engine-marketing", "catalog-management"] },
  { name: "Assortment Recommendations", patterns: ["assortment", "recommendations", "variants", "trends", "categorization"] },
  { name: "Shipment Protection", patterns: ["shipment-protection", "claim"] },
  { name: "Disputes", patterns: ["dispute"] },
  { name: "Feeds", patterns: ["feed", "fitment"] },
  { name: "Insights", patterns: ["insight", "listing-quality", "pro-seller", "unpublished-item"] },
  { name: "Seller Performance", patterns: ["seller-performance", "negative-feedback", "returns-performance", "item-not-received", "tracking-rate", "ship-from", "on-time-shipment", "carrier-method", "response-rate", "order-refund", "on-time-delivery", "order-cancellation"] },
  { name: "Inventory", patterns: ["inventory", "ship-node", "lag-time"] },
  { name: "Item Management", patterns: ["item-management", "item-setup", "create-item", "item-search", "catalog-search", "item-detail", "gtin", "retire", "bulk-item", "automotive", "repricing", "item-spec", "pagination", "rate-limit"] },
  { name: "Notifications & Webhooks", patterns: ["notification", "subscription", "webhook", "event-type", "event-catalog", "alert"] },
  { name: "Reports", patterns: ["report", "on-request", "report-schedul"] },
  { name: "Orders", patterns: ["order-management", "order", "acknowledge", "ship-order", "cancel-order", "refund-order", "carrier-names", "mlmq", "entity-match"] },
  { name: "Payments & Tax", patterns: ["payment", "tax-form", "recon", "performance-report"] },
  { name: "Pricing & Promotions", patterns: ["pricing", "repricer", "price-incentive", "promotional", "promotion"] },
  { name: "Returns", patterns: ["return", "refund-api", "return-overrides", "rap-post"] },
  { name: "Reviews", patterns: ["review", "eligible-item", "enrolled-item"] },
  { name: "Sandbox & Testing", patterns: ["sandbox", "dynamic-sandbox", "test", "simulate"] },
  { name: "Settings & Shipping", patterns: ["settings", "shipping-template", "fulfillment-center", "shipping-config", "carrier-method", "simplified-shipping", "partner-config", "provider"] },
  { name: "Utility APIs", patterns: ["utilitie", "platform-status", "app-store", "department", "taxonomy", "category"] },
  { name: "WFS (Walmart Fulfillment Services)", patterns: ["wfs-", "walmart-fulfillment", "inbound-shipment", "multichannel", "mcs-", "fulfillment-order", "walmart-preferred", "carrier-rate", "booking", "label", "bol", "shipment-tracking", "pickup", "wfs"] },
  { name: "Walmart+ SFF", patterns: ["walmart-", "seller-fulfilled", "sff"] },
  { name: "Troubleshooting & FAQ", patterns: ["troubleshoot", "error-code", "faq", "analytics-dashboard", "rate-limiting", "deprecation"] },
];

function inferCategory(slug, title) {
  const text = ((slug || "") + " " + (title || "")).toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((p) => text.includes(p))) return rule.name;
  }
  return "Other";
}

// ── 主流程 ────────────────────────────────────────────
function build(args) {
  // 检查数据目录
  const jsonDir = path.join(args.outputDir, "json");
  if (!fs.existsSync(jsonDir)) {
    console.error(`❌ JSON 数据目录不存在: ${jsonDir}`);
    console.error(`   请先运行爬虫: node skills/walmart-api-docs/scripts/crawl.mjs`);
    process.exit(1);
  }

  const dbPath = path.join(args.outputDir, "walmart-api.db");

  // 删除旧数据库
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    if (args.verbose) console.log("🗑️  删除旧数据库");
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  // ── 建表 ──
  db.exec(`
    -- 主表：页面
    CREATE TABLE pages (
      rowid INTEGER PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      content_text TEXT,
      category TEXT,
      endpoints_json TEXT,
      code_examples_json TEXT,
      crawled_at TEXT
    );

    -- FTS5 全文索引（标题 + 正文，porter 词干 + unicode 分词）
    CREATE VIRTUAL TABLE pages_fts USING fts5(
      title, content_text,
      tokenize='porter unicode61'
    );

    -- 端点表（结构化查询）
    CREATE TABLE endpoints (
      id INTEGER PRIMARY KEY,
      page_slug TEXT NOT NULL,
      method TEXT NOT NULL,
      url TEXT NOT NULL
    );

    -- FTS5 端点索引
    CREATE VIRTUAL TABLE endpoints_fts USING fts5(
      method, url,
      tokenize='unicode61'
    );

    -- 视图：端点 + 所属页面
    CREATE VIEW v_endpoints AS
    SELECT
      endpoints.id,
      endpoints.page_slug,
      endpoints.method,
      endpoints.url,
      pages.title AS page_title,
      pages.url AS page_url,
      pages.category
    FROM endpoints
    JOIN pages ON pages.slug = endpoints.page_slug;
  `);

  // ── 加载数据 ──
  const files = fs.readdirSync(jsonDir).filter((f) => f.endsWith(".json"));
  if (args.verbose) console.log(`📂 加载 ${files.length} 个 JSON 文件...`);

  // 准备语句
  const insertPage = db.prepare(
    "INSERT INTO pages (rowid, slug, title, url, content_text, category, endpoints_json, code_examples_json, crawled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertPageFts = db.prepare(
    "INSERT INTO pages_fts (rowid, title, content_text) VALUES (?, ?, ?)"
  );
  const insertEndpoint = db.prepare(
    "INSERT INTO endpoints (id, page_slug, method, url) VALUES (?, ?, ?, ?)"
  );
  const insertEndpointFts = db.prepare(
    "INSERT INTO endpoints_fts (rowid, method, url) VALUES (?, ?, ?)"
  );

  const insertAll = db.transaction((pages) => {
    let endpointCount = 0;

    for (const page of pages) {
      const rowid = page.rowid;
      insertPage.run(
        rowid,
        page.slug,
        page.title,
        page.url,
        page.contentText,
        page.category,
        page.endpointsJson,
        page.codeExamplesJson,
        page.crawledAt
      );
      insertPageFts.run(rowid, page.title, page.contentText);

      if (page.endpoints) {
        for (const ep of page.endpoints) {
          endpointCount++;
          const cleanEpUrl = cleanUrl(ep.url);
          insertEndpoint.run(endpointCount, page.slug, ep.method, cleanEpUrl);
          insertEndpointFts.run(endpointCount, ep.method, cleanEpUrl);
        }
      }
    }

    return endpointCount;
  });

  // 读取所有数据
  const pages = [];

  for (const file of files) {
    const filePath = path.join(jsonDir, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (err) {
      console.error(`  ⚠️ 跳过 ${file}: ${err.message}`);
      continue;
    }

    // 清理端点 URL
    const cleanEndpoints = data.endpoints?.map((ep) => ({
      ...ep,
      url: cleanUrl(ep.url),
    }));

    pages.push({
      rowid: pages.length + 1,
      slug: data.slug,
      title: data.title,
      url: data.url,
      contentText: cleanText(data.contentText) || "",
      category: inferCategory(data.slug, data.title),
      endpointsJson: cleanEndpoints ? JSON.stringify(cleanEndpoints) : null,
      codeExamplesJson: data.codeExamples ? JSON.stringify(data.codeExamples) : null,
      crawledAt: data.crawledAt || null,
      endpoints: cleanEndpoints,
    });
  }

  // 事务批量插入
  const endpointCount = insertAll(pages);

  // ── 创建索引 ──
  db.exec(`
    CREATE INDEX idx_endpoints_page_slug ON endpoints(page_slug);
    CREATE INDEX idx_endpoints_method ON endpoints(method);
    CREATE INDEX idx_pages_category ON pages(category);
    ANALYZE;
  `);

  // ── 验证 ──
  const pageCount = db.prepare("SELECT COUNT(*) AS cnt FROM pages").get().cnt;
  const epCount = db.prepare("SELECT COUNT(*) AS cnt FROM endpoints").get().cnt;

  db.close();

  console.log(`\n✅ SQLite 数据库已创建`);
  console.log(`   路径: ${dbPath}`);
  console.log(`   大小: ${((fs.statSync(dbPath).size) / 1024).toFixed(0)} KB`);
  console.log(`   页面: ${pageCount}`);
  console.log(`   端点: ${epCount}`);
}

// ── 入口 ──
const args = parseArgs(process.argv);
try {
  build(args);
} catch (err) {
  console.error("❌ 构建失败:", err.message);
  process.exit(1);
}
