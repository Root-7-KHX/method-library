# @local/method-library

DSH 的**本地方法库**：把重复做过的事沉淀成可搜索、可执行的方法卡片。

AI 搜索 → 拿到填好参数的命令或步骤 → 自己执行 → 回报结果入库 → 方法过时可自动修正。

**插件零执行权**：它只检索、填参、发货、记账，绝不 spawn 进程。真正执行的是 AI 用你的终端工具，走你当前会话的权限。

## 安装

```bash
# 从本地目录安装（bundle）
# 在 DSH 里用插件管理器安装本目录，或：
#   plugin_manager action=install_bundle target=D:\AI\插件\method-library
```

装好后侧边栏出现「方法库」。

## 目录结构

```
method-library/
  index.js          插件入口：注册工具 / 面板接口 / 系统提示
  lib/engine.js     核心：纯文件存储、BM25 检索、体检、命令拼装、记账
  lib/tools.js      5 个 AI 工具
  lib/api.js        面板用的 HTTP 接口（仅本机）
  client.js         侧边栏入口 + 主区面板
  data/library/     默认方法库（methods.json + scripts/ + logs/ + archive/）
  test/selftest.mjs 离线自测：node test/selftest.mjs
```

## 数据

默认 `<插件目录>/data/library`，面板「设置」里可以改到任意文件夹。
所有数据都是纯文件：`methods.json`、`scripts/`、`logs/usage.jsonl`、`archive/`。

## 会话级（跟 AI记忆 一样的形态）

- 入口：**顶部标签栏**「方法库」（和 对话 / 轨迹 / 上下文 / AI记忆 并排），打开默认是当前对话的库。
- 面板顶部会话切换器：点开是按工作区（文件夹）分组的会话列表，**文件夹默认收起**，点开才看到里面的对话。
- 开关是**滑块**：「本对话」一个，列表里每个对话右边也有一个（不用切过去就能开关）。
- **新对话默认关闭**：要用哪个对话就把它打开（`defaultSessionEnabled: true` 可改回默认开启）。
- 关掉的会话：AI 看不到这 5 个工具，系统提示词也不注入（省 token）。
- 每个会话可单独指定库目录；留空跟随全局默认。指定新目录时可勾选「复制当前库一份过去」。
- 会话开关/目录存在 `<插件目录>/data/sessions.json`（不属于任何库，换库不丢）。

命令行 API（面板用的，仅本机）：`GET /method-library/api/sessions`、`GET /overview?session=<id>`、`POST /enable`、`POST /session-dir`。

## 配置（cordis.patch.yml）

```yaml
- id: method-library
  config:
    libraryDir: ''        # 留空 = 插件目录下 data/library
    searchLimit: 5        # method_search 默认条数
    draftDays: 90         # 草稿多久没动提示归档
    promptHint: true      # 是否在系统提示注入用法说明
```

## 自测

```bash
node test/selftest.mjs   # 引擎：存储/检索/发货/记账/体检/迁移/导入导出
node test/hub-test.mjs   # 会话层：开关、按会话库目录、引擎缓存、跟随全局
```

覆盖：建卡、中文检索、无关词不误召回、命令拼装、缺参报错、成功/失败记账、带 patch 修正、体检、归档恢复、导入导出、库目录迁移。

## 已知限制

- 不执行命令、不联网。
- 检索为关键词/别名/标签 + BM25，无向量检索。
- 无自动捕获；方法来自手动建、AI `method_save`、或 JSON 导入。

## 本机环境适配（实测）

- 本机只有 Windows PowerShell 5.1、没有 pwsh 7 → 运行时会自动解析，找不到 pwsh 就用 `powershell.exe`。
- PowerShell 执行策略禁止直接跑 `.ps1` → 默认参数模板带 `-ExecutionPolicy Bypass`。
- PS 5.1 读无 BOM 的 UTF-8 `.ps1` 中文会乱码 → `.ps1` 一律写 UTF-8 BOM。

## License

MIT
