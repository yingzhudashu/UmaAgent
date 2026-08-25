import type { SkillSummary } from "@uma-agent/protocol";

export interface BuiltinSkill extends SkillSummary {
  content: string;
  path: string;
}

/**
 * MiniAgent 自带的通用 Skill 说明经过人工改写后作为 UmaAgent 的只读基线。
 * 这里只移植可跨运行时复用的工作流，不加载 MiniAgent 的 Python 工具代码。
 */
export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    name: "builtin-web",
    description: "联网搜索、读取网页、浏览器提取和来源核验。",
    keywords: ["搜索", "网页", "联网", "浏览器", "下载", "来源"],
    enabled: true,
    diagnostics: [],
    scope: "global",
    userInvocable: true,
    modelInvocable: true,
    path: "builtin://builtin-web",
    content: `# Web 工作流

当任务需要外部信息时，先定义需要验证的事实，再选择最小工具：

1. 需要搜索关键词时使用 web_search，并保留返回的来源 URL。
2. 已知公开 URL 且只需要文本时使用 http_get。
3. 页面依赖 JavaScript、需要点击或填写时使用 Browser MCP 工具。
4. Browser Worker 只能访问公网 HTTP(S)，不能访问本机或内网地址。
5. 搜索结果只是发现入口；关键结论应读取原始来源并在回答中标注来源。
6. 不要把凭据、Cookie 或完整网页响应写入记忆、日志或 Trace。
`,
  },
  {
    name: "builtin-stackexchange",
    description: "从 Stack Exchange 检索技术问题、答案和引用来源。",
    keywords: ["Stack Overflow", "Stack Exchange", "编程问题", "技术问答"],
    enabled: true,
    diagnostics: [],
    scope: "global",
    userInvocable: true,
    modelInvocable: true,
    path: "builtin://builtin-stackexchange",
    content: `# Stack Exchange 工作流

遇到编程或工程问题时，可以使用 web_search，并将 provider 设置为 stackexchange。
优先阅读答案正文和投票较高的相关回答，核对版本和适用条件；不要把单个回答当作官方规范。
回答中保留问题或答案 URL，明确哪些内容是社区经验而不是项目事实。
`,
  },
  {
    name: "skill-vetter",
    description: "审查 Skill 包的来源、权限、依赖、危险操作和凭据泄漏风险。",
    keywords: ["技能审查", "Skill 安全", "插件审计", "凭据", "供应链"],
    enabled: true,
    diagnostics: [],
    scope: "global",
    userInvocable: true,
    modelInvocable: true,
    path: "builtin://skill-vetter",
    content: `# Skill 审查清单

启用 Skill 前逐项检查：

- 是否有明确的 SKILL.md、用途、输入输出和依赖说明。
- 是否包含硬编码 Token、Cookie、密码或私有 URL。
- 是否尝试删除文件、执行任意命令、动态加载代码或联网下载脚本。
- 是否越出当前 workspace、访问 Core state 或读取其他用户数据。
- 是否真的需要可执行代码；能用静态说明和现有工具完成时不要引入 Worker。
- 是否有可重复的验证命令和失败处理。

发现高风险内容时停止启用，说明具体文件和证据，不用模糊的“看起来安全”替代审查。
`,
  },
  {
    name: "skill-creator",
    description: "创建结构清晰、可测试、渐进加载的 SKILL.md 技能包。",
    keywords: ["创建技能", "编写 Skill", "SKILL.md", "技能包"],
    enabled: true,
    diagnostics: [],
    scope: "global",
    userInvocable: true,
    modelInvocable: true,
    path: "builtin://skill-creator",
    content: `# Skill 创建工作流

创建 Skill 时先明确触发条件、成功标准和输出格式，再写最小可用的 SKILL.md。

- 使用小写 kebab-case 名称。
- frontmatter 至少包含 name 和 description；description 要写清楚何时触发。
- 正文只保留模型真正需要的步骤，较大的资料放在 references/。
- 优先组合现有 Core/MCP 工具，不重复实现已有能力。
- 如必须执行代码，拆成经过审核、哈希固定的 Worker 包，不在 SKILL.md 中执行任意脚本。
- 用一个成功样例和一个失败/边界样例验证，然后再启用。
`,
  },
];
