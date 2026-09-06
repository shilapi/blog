# shilapi's blog

这是一个静态 Astro 博客，以 notion 作为内容管理平台。

## 本地运行

```sh
npm install
cp .env.example .env
# 编辑 .env，填入 NOTION_TOKEN 和 NOTION_DATA_SOURCE_ID
npm run dev -- --background
```

后台开发服务器的管理命令：

```sh
npm run astro -- dev status
npm run astro -- dev logs
npm run astro -- dev stop
```

生产构建：

```sh
npm run check
npm run format:check
npm run build
npm run preview
```

## Notion 数据源字段

当前代码按名称（不区分大小写）读取这些属性：

| 属性      | Notion 类型     | 用途                                                      |
| --------- | --------------- | --------------------------------------------------------- |
| `title`   | Title           | 文章标题                                                  |
| `slug`    | Rich text       | URL，例如 `my-first-post`                                 |
| `type`    | Select          | `Post` 生成到 `/posts/[slug]/`；`Paper` 生成到 `/[slug]/` |
| `status`  | Select / Status | `Private` 完全忽略；其他值正常生成                        |
| `date`    | Date            | 排序和发布日期                                            |
| `summary` | Rich text       | 首页摘要                                                  |
| `tags`    | Multi-select    | 详情页标签                                                |

Token 只放在本地 `.env` 或 Cloudflare 的环境变量中，不要提交到 Git。

## 渲染和自定义

- `src/lib/notion.ts`：供页面和组件使用的稳定入口。
- `src/lib/notion/`：按职责拆分的 Notion 客户端、文章映射、Block 树和媒体持久化。
- `src/lib/post-routes.ts`：Post/Paper 路由、标签归档和文章链接规则。
- `src/components/NotionBlocks.astro`：把连续列表项分组。
- `src/components/NotionBlock.astro`：按 `block.type` 渲染段落、标题、图片、表格、代码、引用、Callout、Toggle 等。新增 Notion Block 类型时，在这里加一个 `case`。
- `src/components/NotionCodeBlock.astro`：代码块复制和滚动条交互。
- `src/components/NotionRichText.astro`：粗体、斜体、下划线、删除线、行内代码和链接。
- `src/components/PostList.astro` / `PostCard.astro`：归档列表与文章磁贴。
- `src/components/SiteSidebar.astro` / `SiteFooter.astro`：全站导航。
- `src/styles/`：全局主题和 Notion 内容样式。
- `src/config.ts`：站点标题、描述和语言。

默认支持的图片/文件策略是“构建时下载”。Notion 托管的文件 URL 只有短期有效期，所以不能直接把它当长期静态资源；构建钩子会把下载结果复制到 `dist/notion`。可选地设置 `NOTION_BLOCK_CACHE=true` 使用 `tmp/` 中的 Block 缓存（默认关闭，保证每次构建读取最新内容）。

## Cloudflare Pages

在 Pages 项目中设置：

- Build command：`npm run build`
- Output directory：`dist`
- Environment variables：`NOTION_TOKEN`、`NOTION_DATA_SOURCE_ID`
- Node.js：`22.12.0` 或更高

这是静态部署；Notion 内容更新后需要触发一次新的构建。Git 集成可以在每次推送后自动部署。

## Contributor

Thanks for GPT5.6 & CodeX.
