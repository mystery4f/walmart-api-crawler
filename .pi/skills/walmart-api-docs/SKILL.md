---
name: walmart-api-docs
description: 搜索和更新 Walmart Marketplace API 文档。当用户询问 Walmart API 相关问题、需要查找 API 端点用法、或者需要更新/重新爬取 Walmart 文档时触发。触发词：Walmart API、沃尔玛 API、Marketplace API、walmart-docs。
---

# Walmart Marketplace API 文档管理

管理 Walmart 开发者文档的爬取、搜索和查阅。

项目目录: `D:/Documents/work/code/walmart-api-crawler`
数据目录: `D:/Documents/work/code/walmart-api-crawler/output`

## 前置条件

首次使用前安装依赖:

```bash
cd D:/Documents/work/code/walmart-api-crawler && npm install
```

## 核心脚本

| 脚本 | 路径 |
|------|------|
| 爬取/更新 | `scripts/crawl.mjs` |
| 搜索文档 | `scripts/search.mjs` |

脚本路径均相对于 skill 目录: `D:/Documents/work/code/walmart-api-crawler/.pi/skills/walmart-api-docs/`

## 搜索文档

用户询问 Walmart API 相关问题时，先用搜索脚本查找相关文档，再阅读详情回答。

```bash
# 关键词搜索（在标题+内容中搜索）
node scripts/search.mjs "order management"

# 搜索 API 端点
node scripts/search.mjs "GET /v3/orders" --mode endpoint

# 按模块分类浏览
node scripts/search.mjs "inventory" --mode category

# 列出所有模块
node scripts/search.mjs --mode list

# 查看爬取统计
node scripts/search.mjs --mode stats
```

**搜索模式:**

| 模式 | 说明 |
|------|------|
| `keyword` (默认) | 在标题和正文中搜索关键词，按相关度排序 |
| `endpoint` | 搜索 API 端点 (HTTP 方法 + URL) |
| `category` | 按功能模块分类浏览 |
| `list` | 列出所有模块及页面数 |
| `stats` | 显示爬取统计信息 |

**搜索结果后读取完整内容:**

搜索结果会给出 slug，完整 JSON 在 `output/json/<slug>.json`，完整 Markdown 在 `output/markdown/<slug>.json`。

```bash
# 例: 搜索到 order-management-api-overview 后
cat D:/Documents/work/code/walmart-api-crawler/output/json/order-management-api-overview.json
```

## 更新文档（重新爬取）

**重要：侧边栏链接每次都动态获取，不写死。** 爬虫会先访问入口页面，实时从 DOM 中提取所有侧边栏链接，然后逐页爬取。

```bash
# 全量更新（推荐）
node scripts/crawl.mjs

# 仅查看当前侧边栏有哪些页面（不爬取）
node scripts/crawl.mjs --dry-run

# 只更新特定模块的页面（按 slug 过滤）
node scripts/crawl.mjs --filter inventory
node scripts/crawl.mjs --filter order
node scripts/crawl.mjs --filter pricing

# 爬取指定 slug 列表
node scripts/crawl.mjs --slugs "get-an-access-token,retrieve-access-token-details"

# 调整并发和延迟
node scripts/crawl.mjs --concurrency 2 --delay 500

# 指定输出目录
node scripts/crawl.mjs --output-dir ./output
```

**更新流程:**

1. 访问入口页面 `introduction-to-marketplace-apis`
2. 从页面 DOM 中动态提取 `#hub-sidebar a[href]` 所有链接
3. 去重得到完整的 slug 列表
4. 按并发配置分批爬取每个页面
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
2. 运行 `node scripts/search.mjs "<关键词>"` 搜索
3. 如果搜到匹配的页面，读取对应 JSON 文件获取完整内容
4. 基于文档内容回答用户问题
5. 如有必要，用 `--mode endpoint` 补充搜索相关 API 端点

### 更新类请求

1. 先用 `--dry-run` 查看当前侧边栏页面数量
2. 运行全量或增量爬取
3. 爬取完成后报告统计结果
4. 如有失败页面，告知用户并可重试

### 分类浏览请求

1. 运行 `node scripts/search.mjs --mode list` 查看所有模块
2. 用户指定模块后，用 `--mode category "<模块名>"` 查看详情
3. 读取感兴趣的页面 JSON 文件
