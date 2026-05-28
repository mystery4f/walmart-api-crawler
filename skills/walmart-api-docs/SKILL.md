---
name: walmart-api-docs
description: 搜索和更新 Walmart Marketplace API 文档。当用户询问 Walmart API 相关问题、需要查找 API 端点用法、或者需要更新/重新爬取 Walmart 文档时触发。触发词：Walmart API、沃尔玛 API、Marketplace API、walmart-docs。
---

# Walmart Marketplace API 文档管理

管理 Walmart 开发者文档的爬取、搜索和查阅。

数据目录: `./output`（相对于当前工作目录）

## 前置条件

首次使用前安装依赖:

```bash
npm install
```

## 核心脚本

| 脚本 | 路径 |
|------|------|
| 爬取/更新 | `skills/walmart-api-docs/scripts/crawl.mjs` |
| 构建数据库 | `skills/walmart-api-docs/scripts/build-db.mjs` |
| 搜索文档 | `skills/walmart-api-docs/scripts/search.mjs` |

路径均相对于项目根目录。安装为 pi package 后，脚本在 package 根目录下执行。

## SQLite 数据库（搜索加速）

爬虫生成 JSON 文件后，运行 `build-db.mjs` 构建 SQLite 数据库（含 FTS5 全文索引）：

```bash
node skills/walmart-api-docs/scripts/build-db.mjs         # 构建
node skills/walmart-api-docs/scripts/build-db.mjs --verbose # 看进度
```

构建后 `search.mjs` 自动使用 SQLite，搜索速度从加载 388 个 JSON 文件（~秒级）降到 ~10ms。

爬取后或怀疑数据过时时重新构建：

```bash
node skills/walmart-api-docs/scripts/crawl.mjs     # 先爬最新文档
node skills/walmart-api-docs/scripts/build-db.mjs  # 再重构建数据库
```

数据库文件：`output/walmart-api.db`（~6 MB，单文件，零配置）

## 搜索文档

用户询问 Walmart API 相关问题时，先用搜索脚本查找相关文档，再阅读详情回答。

```bash
# 关键词搜索（FTS5 全文搜索，默认模式）
node skills/walmart-api-docs/scripts/search.mjs "order management"

# 搜索 API 端点（自动解析 HTTP 方法 + URL）
node skills/walmart-api-docs/scripts/search.mjs "GET /v3/orders" --mode endpoint

# 按模块分类浏览
node skills/walmart-api-docs/scripts/search.mjs "inventory" --mode category

# 列出所有模块
node skills/walmart-api-docs/scripts/search.mjs --mode list

# 查看爬取统计
node skills/walmart-api-docs/scripts/search.mjs --mode stats

# 直接跑 SQL 查询（进阶）
node skills/walmart-api-docs/scripts/search.mjs --mode sql "SELECT title, category FROM pages WHERE category = 'Inventory'"
```

**FTS5 全文搜索语法:**

| 语法 | 示例 | 说明 |
|------|------|------|
| 单个词 | `inventory` | 匹配包含 inventory 的页面 |
| 精确短语 | `"order management"` | 匹配完整短语 |
| 前缀匹配 | `invent*` | 匹配 invent 开头的词（inventory, inventories...） |
| 与逻辑 | `inventory AND pricing` | 同时包含（默认） |
| 或逻辑 | `inventory OR pricing` | 包含任一 |
| 排除 | `inventory NOT returns` | 包含 inventory 但不含 returns |
| 分组 | `(orders AND refunds) OR returns` | 组合条件 |
| Porter 词干 | 自动 | "inventorying" 也能匹配 "inventory" |

**搜索模式:**

| 模式 | 说明 |
|------|------|
| `keyword` (默认) | FTS5 全文搜索 + BM25 相关度排序（快且准） |
| `endpoint` | 搜索 API 端点，支持 `GET /v3/orders` 格式自动解析 |
| `category` | 按功能模块分类浏览 |
| `list` | 列出所有模块及页面数 |
| `stats` | 显示爬取统计信息 |
| `sql` | 直接执行 SQL 查询（进阶用途） |

**搜索结果后读取完整内容:**

搜索结果会给出 slug，完整 JSON 在 `output/json/<slug>.json`。

```bash
# 例: 搜索到 order-management-api-overview 后
cat output/json/order-management-api-overview.json
```

或者直接 SQL 查询：

```bash
node skills/walmart-api-docs/scripts/search.mjs --mode sql "SELECT slug, title FROM pages WHERE category = 'Orders'"
```

## 更新文档（重新爬取）

**重要：侧边栏链接每次都动态获取，不写死。** 爬虫会先访问入口页面，实时从 DOM 中提取所有侧边栏链接，然后逐页爬取。

默认并发 50，约 1 分钟完成 388 页。

```bash
# 全量爬取（直连，推荐）
node skills/walmart-api-docs/scripts/crawl.mjs

# debug 模式：打印每页耗时、性能瓶颈分析
node skills/walmart-api-docs/scripts/crawl.mjs --debug

# 仅查看当前侧边栏有哪些页面（不爬取）
node skills/walmart-api-docs/scripts/crawl.mjs --dry-run

# 只更新特定模块的页面
node skills/walmart-api-docs/scripts/crawl.mjs --filter inventory
node skills/walmart-api-docs/scripts/crawl.mjs --filter order

# 爬取指定 slug 列表
node skills/walmart-api-docs/scripts/crawl.mjs --slugs "get-an-access-token,retrieve-access-token-details"

# 调整并发（默认 50）
node skills/walmart-api-docs/scripts/crawl.mjs --concurrency 20

# 使用代理（直连不通时）
node skills/walmart-api-docs/scripts/crawl.mjs --proxy "http://localhost:4444"
node skills/walmart-api-docs/scripts/crawl.mjs --proxy "socks5://localhost:1080"
```

**更新流程:**

1. 访问入口页面 `introduction-to-marketplace-apis`
2. 从页面 DOM 中动态提取 `#hub-sidebar a[href]` 所有链接
3. 去重得到完整的 slug 列表
4. 50 并发分批爬取每个页面
5. 提取标题、正文、API 端点、代码示例
6. 保存到 `output/json/`、`output/markdown/`、`output/html/`
7. 生成 `output/summary.json` 汇总

**何时需要更新:**
- 用户明确要求更新/重新爬取
- 搜索不到预期的 API 文档（可能 Walmart 新增了页面）
- 上次爬取时间过久（可先 `--mode stats` 查看爬取时间）

## 输出文件结构

```
output/
├── link-index.json    # 所有页面链接索引（slug + URL）
├── summary.json       # 汇总报告（统计 + 所有端点列表）
├── failed.json        # 失败列表（如有）
├── json/              # 每页结构化 JSON（含 title, contentText, endpoints, codeExamples）
├── markdown/          # 每页 Markdown 格式
└── html/              # 每页 HTML 片段
```

## 工作流程

### 搜索类请求

1. 分析用户问题，提取关键词
2. 运行 `node skills/walmart-api-docs/scripts/search.mjs "<关键词>"` 搜索（自动用 SQLite）
3. 如果搜到匹配的页面，读取对应 JSON 文件获取完整内容
4. 基于文档内容回答用户问题
5. 如有必要，用 `--mode endpoint` 补充搜索相关 API 端点

### 更新类请求

1. 运行爬取脚本: `node skills/walmart-api-docs/scripts/crawl.mjs`
2. 直连不通时加 `--proxy "http://localhost:4444"`
3. 爬取完成后，运行 `node skills/walmart-api-docs/scripts/build-db.mjs` 重建数据库
4. 报告统计结果（如有失败页面，告知用户并可重试）

### 分类浏览请求

1. 运行 `node skills/walmart-api-docs/scripts/search.mjs --mode list` 查看所有模块
2. 用户指定模块后，用 `--mode category "<模块名>"` 查看详情
3. 读取感兴趣的页面 JSON 文件

### SQL 查询（进阶）

```bash
# 查某个分类下的所有页面
node skills/walmart-api-docs/scripts/search.mjs --mode sql "SELECT title, slug FROM pages WHERE category = 'Orders' ORDER BY title"

# 查端点统计
node skills/walmart-api-docs/scripts/search.mjs --mode sql "SELECT method, COUNT(*) AS cnt FROM endpoints GROUP BY method ORDER BY cnt DESC"

# 查端点最多的页面 Top 5
node skills/walmart-api-docs/scripts/search.mjs --mode sql "SELECT title, json_array_length(endpoints_json) AS ep_count FROM pages WHERE endpoints_json IS NOT NULL ORDER BY ep_count DESC LIMIT 5"

# 组合查询：找到某个端点的所有页面
node skills/walmart-api-docs/scripts/search.mjs --mode sql "SELECT pages.title, pages.slug FROM endpoints JOIN pages ON pages.slug = endpoints.page_slug WHERE endpoints.url LIKE '%/v3/orders%'"

## 安装

```bash
# 从 GitHub 安装为 pi package
pi install git:github.com/mystery4f/walmart-api-crawler

# 或
pi install https://github.com/mystery4f/walmart-api-crawler
```
