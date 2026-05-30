/**
 * Walmart API 文档搜索脚本（SQLite + FTS5）
 *
 * 用法:
 *   node search.mjs <query>                    # FTS5 全文搜索（默认模式）
 *   node search.mjs <query> --mode endpoint    # 搜索 API 端点
 *   node search.mjs <query> --mode category    # 按模块分类浏览
 *   node search.mjs --mode list                # 列出所有模块及页面数
 *   node search.mjs --mode stats               # 输出爬取统计
 *   node search.mjs --mode sql    "SELECT ..."  # 直接跑 SQL（进阶）
 *
 * 搜索语法 (FTS5):
 *   inventory                        # 单个词
 *   "order management"               # 精确短语
 *   invent*                          # 前缀匹配
 *   inventory AND pricing            # 与逻辑（默认）
 *   inventory OR pricing             # 或逻辑
 *   inventory NOT returns            # 排除
 *   (inventory OR pricing) returns   # 分组
 *
 * 选项:
 *   --mode <keyword|endpoint|category|list|stats|sql>  搜索模式
 *   --limit <n>                     返回结果数 (默认 20)
 *   --output-dir <path>             数据目录 (默认 ../output)
 *   --no-db                         强制使用旧版 JSON 搜索（不使用 SQLite）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, "output");

// ── 参数解析 ──────────────────────────────────────────
function parseArgs(argv) {
  const args = { mode: "keyword", limit: 20, outputDir: DEFAULT_OUTPUT, query: "", noDb: false };
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
      case "--no-db":
        args.noDb = true;
        break;
      default:
        rest.push(argv[i]);
    }
  }
  args.query = rest.join(" ").trim();
  return args;
}

// ── JSON 加载（旧版） ────────────────────────────────
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
  return files.map((f) => loadJson(path.join(jsonDir, f))).filter(Boolean);
}

// ── SQLite 模式 ───────────────────────────────────────
function openDb(outputDir) {
  try {
    const dbPath = path.join(outputDir, "walmart-api.db");
    if (!fs.existsSync(dbPath)) return null;
    const Database = _require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    db.pragma("query_only = true");
    return db;
  } catch (e) {
    return null;
  }
}

/** 将用户查询转为 FTS5 兼容的查询字符串 */
function toFts5Query(query) {
  let q = query.trim();

  // 如果已经是 FTS5 语法（含引号、AND/OR/NOT、*），不作处理
  if (/["*()]/.test(q) || /\b(AND|OR|NOT)\b/i.test(q)) return q;

  // 含空格的短语 → 引号包裹
  if (/\s/.test(q) && !/^"/.test(q)) {
    return `"${q}"`;
  }
  return q;
}

/** 格式化搜索结果行 */
function printPageResult(page, score, index, total) {
  const prefix = total ? `[${index}/${total}]` : "";
  console.log(`${prefix} 📄 ${page.title}`);
  console.log(`     相关度: ${score?.toFixed(2) ?? "-"}`);
  console.log(`     URL: ${page.url}`);
  if (page.category) console.log(`     分类: ${page.category}`);
  if (page.endpoints_json) {
    try {
      const eps = JSON.parse(page.endpoints_json);
      if (eps.length) {
        console.log(`     端点:`);
        for (const ep of eps.slice(0, 5)) {
          console.log(`       ${ep.method.padEnd(7)} ${ep.url}`);
        }
        if (eps.length > 5) console.log(`       ... 还有 ${eps.length - 5} 个`);
      }
    } catch {}
  }
  console.log();
}

// ── 模式: keyword (FTS5) ─────────────────────────────
function searchKeywordDb(db, query, limit) {
  if (!query) {
    console.log("⚠️ 请输入搜索关键词");
    return;
  }

  const ftsQuery = toFts5Query(query);

  try {
    // FTS5 全文搜索 + BM25 排序
    const rows = db
      .prepare(
        `SELECT
           pages.*,
           bm25(pages_fts, 10.0, 5.0) AS rank
         FROM pages_fts
         JOIN pages ON pages.rowid = pages_fts.rowid
         WHERE pages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(ftsQuery, limit);

    if (rows.length === 0) {
      console.log(`🔍 未找到与 "${query}" 相关的结果`);
      console.log(`   提示: FTS5 语法 — "精确短语", 前*缀, term1 AND term2, term1 OR term2, term1 NOT term2`);
      return;
    }

    console.log(`🔍 FTS5 搜索 "${query}" — 找到 ${rows.length} 个结果\n`);
    for (let i = 0; i < rows.length; i++) {
      printPageResult(rows[i], -rows[i].rank, i + 1, rows.length);

      // 显示片段
      const snippet = (rows[i].content_text || "").substring(0, 250).trim();
      if (snippet) {
        console.log(`  摘要: ${snippet}...\n`);
      }
    }
  } catch (err) {
    if (err.message.includes("syntax error") || err.message.includes("malformed")) {
      console.log(`⚠️  FTS5 语法错误: "${ftsQuery}"`);
      console.log(`   提示: 避免特殊字符，或使用引号包裹短语`);
      console.log(`   示例: "order management", invent*, pricing AND inventory`);
    } else {
      throw err;
    }
  }
}

// ── 模式: keyword (JSON 旧版) ────────────────────────
function searchKeywordJson(pages, query, limit) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    console.log("⚠️ 请输入搜索关键词");
    return;
  }

  const scored = pages
    .map((page) => {
      const title = (page.title || "").toLowerCase();
      const text = (page.contentText || "").toLowerCase();
      let score = 0;

      for (const term of terms) {
        if (title.includes(term)) score += 10;
        const count = (text.match(new RegExp(term, "gi")) || []).length;
        score += Math.min(count, 50);
        if (page.endpoints) {
          for (const ep of page.endpoints) {
            if (ep.url.toLowerCase().includes(term)) score += 5;
            if (ep.method.toLowerCase() === term) score += 3;
          }
        }
      }

      return { page, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (scored.length === 0) {
    console.log(`🔍 未找到与 "${query}" 相关的结果`);
    return;
  }

  console.log(`🔍 搜索 "${query}" — 找到 ${scored.length} 个结果 (JSON 旧版)\n`);
  for (const { page, score } of scored) {
    printPageResult(page, score);
    const snippet = (page.contentText || "").substring(0, 200).trim();
    if (snippet) console.log(`  摘要: ${snippet}...\n`);
  }
}

// ── 模式: endpoint ────────────────────────────────────
function searchEndpoint(db, query, limit) {
  if (!query) {
    console.log("⚠️ 请输入端点关键词");
    return;
  }

  // 智能解析：如果查询包含 HTTP 方法 + URL，分开匹配
  // 比如 "GET /v3/orders" → method LIKE '%GET%' AND url LIKE '%/v3/orders%'
  const methodMatch = query.match(/^(GET|POST|PUT|DELETE|PATCH)\s+(.+)$/i);

  let rows;
  if (methodMatch) {
    const method = methodMatch[1].toUpperCase();
    const urlPart = methodMatch[2];
    rows = db
      .prepare(
        `SELECT e.id, e.page_slug, e.method, e.url, pages.title AS page_title, pages.url AS page_url
         FROM endpoints e
         JOIN pages ON pages.slug = e.page_slug
         WHERE e.method = ? AND e.url LIKE ?
         ORDER BY e.url
         LIMIT ?`
      )
      .all(method, `%${urlPart}%`, limit);
  } else {
    const q = `%${query}%`;
    rows = db
      .prepare(
        `SELECT e.id, e.page_slug, e.method, e.url, pages.title AS page_title, pages.url AS page_url
         FROM endpoints e
         JOIN pages ON pages.slug = e.page_slug
         WHERE e.method LIKE ? OR e.url LIKE ?
         ORDER BY e.method, e.url
         LIMIT ?`
      )
      .all(q, q, limit);
  }

  if (rows.length === 0) {
    console.log(`🔍 未找到与 "${query}" 相关的端点`);
    return;
  }

  console.log(`🔍 端点搜索 "${query}" — 找到 ${rows.length} 个端点:\n`);

  // 按 URL 去重显示
  const seen = new Set();
  for (const r of rows) {
    const key = `${r.method} ${r.url}`;
    if (seen.has(key)) continue;
    seen.add(key);

    console.log(`  ${r.method.padEnd(7)} ${r.url}`);
    console.log(`          📄 ${r.page_title}`);
    console.log(`          🔗 ${r.page_url}`);
    console.log();
  }

  if (rows.length > seen.size) {
    console.log(`  ... 还有 ${rows.length - seen.size} 个相同端点在其它页面`);
  }
}

// ── 模式: category ────────────────────────────────────
function searchCategory(db, query, limit) {
  if (!query) {
    // 列出所有分类
    const cats = db
      .prepare(
        `SELECT category, COUNT(*) AS cnt,
                 SUM(CASE WHEN endpoints_json IS NOT NULL AND endpoints_json != 'null' THEN 1 ELSE 0 END) AS has_endpoints
         FROM pages
         GROUP BY category
         ORDER BY cnt DESC`
      )
      .all();

    console.log(`📂 所有模块分类 (${cats.length} 个):\n`);
    for (const c of cats) {
      const epCount = db
        .prepare("SELECT COUNT(*) AS cnt FROM endpoints e JOIN pages p ON p.slug = e.page_slug WHERE p.category = ?")
        .get(c.category).cnt;
      console.log(`  ${c.category} (${c.cnt} 页, ${epCount} 端点)`);

      const pages = db
        .prepare("SELECT title FROM pages WHERE category = ? LIMIT 4")
        .all(c.category);
      for (const p of pages) {
        console.log(`    - ${p.title}`);
      }
      if (c.cnt > 4) console.log(`    ... 还有 ${c.cnt - 4} 个`);
      console.log();
    }
    return;
  }

  // 搜索匹配的分类
  const q = `%${query}%`;
  const cats = db
    .prepare("SELECT DISTINCT category FROM pages WHERE category LIKE ? ORDER BY category")
    .all(q);

  if (cats.length === 0) {
    console.log(`🔍 未找到与 "${query}" 相关的分类`);
    return;
  }

  for (const { category } of cats) {
    const pages = db
      .prepare("SELECT title, slug, endpoints_json FROM pages WHERE category = ? ORDER BY title")
      .all(category);

    const epCount = pages.reduce(
      (s, p) => {
        if (!p.endpoints_json) return s;
        try { return s + JSON.parse(p.endpoints_json).length; } catch { return s; }
      },
      0
    );

    console.log(`📂 ${category} (${pages.length} 页, ${epCount} 端点)\n`);
    for (const p of pages) {
      console.log(`  - ${p.title}`);
      if (p.endpoints_json) {
        try {
          const eps = JSON.parse(p.endpoints_json);
          for (const ep of eps.slice(0, 3)) {
            console.log(`    ${ep.method.padEnd(7)} ${ep.url}`);
          }
          if (eps.length > 3) console.log(`    ... 还有 ${eps.length - 3} 个`);
        } catch {}
      }
      console.log();
    }
  }
}

// ── 模式: list ────────────────────────────────────────
function listCategories(db) {
  const total = db.prepare("SELECT COUNT(*) AS cnt FROM pages").get().cnt;
  const totalEp = db.prepare("SELECT COUNT(*) AS cnt FROM endpoints").get().cnt;

  const cats = db
    .prepare(
      `SELECT category, COUNT(*) AS cnt
       FROM pages
       GROUP BY category
       ORDER BY cnt DESC`
    )
    .all();

  console.log(`📂 Walmart API 文档模块 (${total} 页, ${totalEp} 端点):\n`);
  for (const c of cats) {
    const epCount = db
      .prepare("SELECT COUNT(*) AS cnt FROM endpoints e JOIN pages p ON p.slug = e.page_slug WHERE p.category = ?")
      .get(c.category).cnt;
    console.log(`  ${c.category}`);
    console.log(`    ${c.cnt} 页面, ${epCount} 端点`);
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

  const methodCounts = new Map();
  for (const ep of summary.endpoints) {
    methodCounts.set(ep.method, (methodCounts.get(ep.method) || 0) + 1);
  }
  console.log(`\n  端点方法分布:`);
  for (const [method, count] of methodCounts) {
    console.log(`    ${method}: ${count}`);
  }

  // DB 信息
  const dbPath = path.join(outputDir, "walmart-api.db");
  if (fs.existsSync(dbPath)) {
    console.log(`\n  数据库: walmart-api.db (${(fs.statSync(dbPath).size / 1024).toFixed(0)} KB)`);
  }

  const failed = summary.pages.filter((p) => p.error);
  if (failed.length > 0) {
    console.log(`\n  ❌ 失败页面:`);
    for (const f of failed) {
      console.log(`    ${f.title}: ${f.error}`);
    }
  }
}

// ── 模式: sql (进阶) ─────────────────────────────────
function runSql(db, query) {
  if (!query) {
    console.log("⚠️ 请输入 SQL 查询语句");
    console.log("  例: node search.mjs --mode sql \"SELECT title, slug FROM pages LIMIT 5\"");
    console.log("  例: node search.mjs --mode sql \"SELECT method, url FROM endpoints WHERE method='POST' LIMIT 10\"");
    console.log("  例: node search.mjs --mode sql \"SELECT title, category FROM pages WHERE category='Inventory'\"");
    return;
  }

  try {
    const stmt = db.prepare(query);
    if (query.trim().toUpperCase().startsWith("SELECT") || query.trim().toUpperCase().startsWith("PRAGMA")) {
      const rows = stmt.all();
      if (rows.length === 0) {
        console.log("查询结果为空");
        return;
      }
      const cols = Object.keys(rows[0]);
      console.log(`  SQL: ${query}`);
      console.log(`  结果: ${rows.length} 行\n`);

      // 表格式输出
      const colWidths = cols.map((c) => Math.max(
        c.length,
        ...rows.map((r) => String(r[c] || "").length)
      ));

      // 表头
      console.log(
        "  " + cols.map((c, i) => c.padEnd(colWidths[i])).join(" │ ")
      );
      console.log(
        "  " + colWidths.map((w) => "─".repeat(w)).join("─┼─")
      );

      // 数据行
      for (const row of rows) {
        console.log(
          "  " + cols.map((c, i) => String(row[c] || "").padEnd(colWidths[i])).join(" │ ")
        );
      }
      console.log();
    } else {
      console.log("⚠️ 当前为只读模式，仅支持 SELECT 和 PRAGMA 查询");
    }
  } catch (err) {
    console.error(`❌ SQL 错误: ${err.message}`);
  }
}

// ── main ──────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv);

  // stats 模式不需要 DB
  if (args.mode === "stats") {
    showStats(args.outputDir);
    return;
  }

  // 尝试打开 SQLite DB
  let db = null;
  if (!args.noDb) {
    db = openDb(args.outputDir);
  }

  switch (args.mode) {
    case "keyword": {
      if (!args.query) {
        console.log("⚠️ 请输入搜索关键词");
        process.exit(1);
      }
      if (db) {
        searchKeywordDb(db, args.query, args.limit);
      } else {
        console.log("ℹ️  SQLite 数据库不可用，使用 JSON 旧版搜索");
        const pages = loadAllPages(args.outputDir);
        searchKeywordJson(pages, args.query, args.limit);
      }
      break;
    }

    case "endpoint": {
      if (!db) {
        console.error("❌ endpoint 模式需要 SQLite 数据库，请先运行 build-db.mjs");
        process.exit(1);
      }
      if (!args.query) {
        console.log("⚠️ 请输入端点关键词");
        process.exit(1);
      }
      searchEndpoint(db, args.query, args.limit);
      break;
    }

    case "category": {
      if (!db) {
        console.error("❌ category 模式需要 SQLite 数据库，请先运行 build-db.mjs");
        process.exit(1);
      }
      searchCategory(db, args.query, args.limit);
      break;
    }

    case "list": {
      if (!db) {
        console.error("❌ list 模式需要 SQLite 数据库，请先运行 build-db.mjs");
        process.exit(1);
      }
      listCategories(db);
      break;
    }

    case "sql": {
      if (!db) {
        console.error("❌ sql 模式需要 SQLite 数据库，请先运行 build-db.mjs");
        process.exit(1);
      }
      runSql(db, args.query);
      break;
    }

    default:
      console.error(`❌ 未知模式: ${args.mode}`);
      console.error("   可用模式: keyword, endpoint, category, list, stats, sql");
      process.exit(1);
  }

  if (db) db.close();
}

main();
