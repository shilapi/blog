# shilapi's blog

这是一个静态 Astro 博客，以 notion 作为内容管理平台。

See it running here: [lapiw.icu](lapiw.icu)

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

## Cloudflare Workers

本站使用 Astro 静态输出，由 `wrangler.jsonc` 将构建后的 `dist` 作为 Workers Static Assets 部署，不需要 `@astrojs/cloudflare` adapter。

在 Workers Builds 项目中设置：

- Build command：`npm run build`
- Deploy command：`npx wrangler deploy`
- Environment variables：`NOTION_TOKEN`、`NOTION_DATA_SOURCE_ID`
- Node.js：`22.12.0` 或更高

这是静态部署；Notion 内容更新后需要触发一次新的构建。Git 集成可以在每次推送后自动部署。本地可运行 `npm run deploy` 完成构建并部署，或用 `npx wrangler deploy --dry-run` 只验证部署包。

### Notion 更新后自动部署

`workers/notion-webhook/` 是独立的通知接收 Worker：Notion 内容变更 → 验证签名 → 调用博客的 Deploy Hook → Workers Builds 重新读取 Notion、构建并部署。博客继续使用静态资源部署。

使用一个**只授权博客数据库的 Notion connection**。这个接收器会为该订阅的所有受支持内容事件触发构建；它不会按数据库 ID 或文章状态筛选，因此也能处理文章改成 Private、删除和移出数据库的情况。不要复用有其他内容访问权限的 connection。

1. 在 Cloudflare 的博客 Worker（`blog`）中，确认已连接 Git 仓库，进入 **Settings → Builds → Deploy Hooks**，创建名为 `notion` 的 Hook，选择生产分支并复制 URL。构建环境继续保留 `NOTION_TOKEN`、`NOTION_DATA_SOURCE_ID`，不要启用 `NOTION_BLOCK_CACHE`。

2. 登录并部署通知 Worker，然后交互式保存 Hook URL（不要提交到 Git）：

   ```sh
   npx wrangler login
   npm run deploy:webhook
   npx wrangler secret put CLOUDFLARE_DEPLOY_HOOK_URL --config workers/notion-webhook/wrangler.jsonc
   ```

3. 在另一个终端监听通知 Worker 的实时日志：

   ```sh
   npx wrangler tail --config workers/notion-webhook/wrangler.jsonc --format pretty
   ```

4. 打开 [Notion connection 设置](https://www.notion.so/profile/integrations)，选择博客使用的 connection，在 **Webhooks → Create a subscription** 中填写上一步部署返回的 Worker URL，加上 `/notion` 路径。订阅以下事件：

   - `page.created`、`page.content_updated`、`page.properties_updated`
   - `page.deleted`、`page.undeleted`、`page.moved`
   - `data_source.content_updated`、`data_source.schema_updated`
   - `data_source.deleted`、`data_source.undeleted`、`data_source.moved`

5. 创建订阅后，在实时日志找到 `Notion subscription verification: secret_...`。保存这个验证 token 为 Worker secret，再将同一个值填进 Notion 的 **Verify subscription**：

   ```sh
   npx wrangler secret put NOTION_VERIFICATION_TOKEN --config workers/notion-webhook/wrangler.jsonc
   ```

   初始化阶段只输出验证 token，不触发构建；配置 secret 后停止输出 token，所有事件必须通过 HMAC 签名校验。接收器默认关闭持久化日志，验证 token 和 Hook URL 都应作为凭据保管。重新创建订阅时，需要删除旧 secret 后重复验证流程。

6. 修改一篇文章的正文，观察博客 Worker 的构建历史，应该出现由 `notion` Deploy Hook 触发的构建；构建完成后确认网站更新。再验证标题/状态修改、新增和删除文章。

Notion 会合并部分高频事件，通常在一分钟内发送，之后还需要等待构建完成。Cloudflare 仅在上一次构建仍处于 queued/initializing 阶段时合并重复 Hook 调用；持续编辑可能产生多次构建。接收器在 Hook 失败时返回 502，让 Notion 按其重试策略重发；Hook 接受请求之后的构建失败仍需在 Cloudflare 中查看并重试。未来日期文章到期本身不会发送变更事件，仍需手动构建或另加定时构建。

本地验证接收器：

```sh
npm run test:webhook
npm run check
npm run deploy:webhook -- --dry-run
```

参考：[Workers Deploy Hooks](https://developers.cloudflare.com/workers/ci-cd/builds/deploy-hooks/)、[Notion Webhooks](https://developers.notion.com/reference/webhooks)、[事件与重试策略](https://developers.notion.com/reference/webhooks-events-delivery)。

## Contributor

Thanks for GPT5.6 & CodeX.
