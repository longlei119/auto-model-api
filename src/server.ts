import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import { callProvider, streamProvider, testProviderChat, testProviderModels } from "./adapters.js";
import { loadConfig, saveConfig } from "./config.js";
import { toInternalRequest } from "./context.js";
import { MetricsStore } from "./metrics.js";
import { ProviderRouter } from "./router.js";
import type { ClaudeMessagesRequest, ProviderConfig } from "./types.js";

const claudeRequestSchema = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().positive(),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.any()
  })),
  system: z.any().optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  stop_sequences: z.array(z.string()).optional()
}).passthrough();

const importProvidersSchema = z.object({
  text: z.string().min(1),
  model: z.string().optional().default(""),
  path: z.string().min(1).default("/v1/chat/completions")
});

const addProviderSchema = z.object({
  name: z.string().optional(),
  baseUrl: z.string().url(),
  apiKey: z.string().min(8),
  model: z.string().optional().default(""),
  path: z.string().min(1).default("/v1/chat/completions")
});

const config = loadConfig();
const metrics = new MetricsStore();
const router = new ProviderRouter(config, metrics);
const app = Fastify({ logger: true });
const providerHealth = new Map<string, ProviderHealth>();
let healthCheckRunning = false;

type ProviderHealth = {
  id: string;
  ok?: boolean;
  latencyMs?: number;
  checkedAt?: number;
  error?: string;
};

await app.register(cors, { origin: true });

app.get("/", async (_request, reply) => {
  reply.type("text/html; charset=utf-8");
  const providerCards = sortedProvidersForView().map((provider) => {
    const model = provider.models[0] ?? "unknown";
    const providerKind = provider.type === "openai" ? "openai" : "anthropic";
    const health = providerHealth.get(provider.id);
    const status = health?.ok === true ? "ok" : health?.ok === false ? "err" : "pending";
    const latencyText = health?.latencyMs ? `${health.latencyMs}ms` : "待检测";
    return `<article class="provider-card" data-provider-id="${escapeHtml(provider.id)}" data-health-state="${status}" data-latency="${health?.latencyMs ?? 999999999}">
      <div class="card-head">
        <div>
          <h2>${escapeHtml(provider.id)}</h2>
          <p>${escapeHtml(provider.name)}</p>
        </div>
        <div class="badges">
          <span class="health ${status}" id="health-${escapeHtml(provider.id)}">${statusLabel(status)}</span>
          <span class="tag ${providerKind}">${providerKind}</span>
        </div>
      </div>
      <dl>
        <div><dt>URL</dt><dd title="${escapeHtml(provider.baseUrl)}">${escapeHtml(provider.baseUrl)}</dd></div>
        <div><dt>Path</dt><dd>${escapeHtml(provider.path)}</dd></div>
        <div><dt>Key</dt><dd>${escapeHtml(maskKey(provider.apiKey))}</dd></div>
        <div><dt>Models</dt><dd class="model">${escapeHtml(model)}</dd></div>
        <div><dt>Latency</dt><dd id="latency-${escapeHtml(provider.id)}">${escapeHtml(latencyText)}</dd></div>
        <div><dt>Checked</dt><dd id="checked-${escapeHtml(provider.id)}">${health?.checkedAt ? escapeHtml(formatTime(health.checkedAt)) : "待检测"}</dd></div>
      </dl>
      <div class="card-actions">
        <button data-test="${escapeHtml(provider.id)}">测试</button>
        <button data-default="${escapeHtml(provider.id)}"${provider.id === config.defaultProvider ? " class=\"active\"" : ""}>${provider.id === config.defaultProvider ? "取消默认" : "设为默认"}</button>
        <button data-edit="${escapeHtml(provider.id)}">编辑</button>
        <button class="danger">删除</button>
      </div>
      <div class="test-result ${status === "err" ? "err" : status === "ok" ? "ok" : ""}" id="result-${escapeHtml(provider.id)}">${health?.error ? escapeHtml(shortError(health.error)) : status === "ok" ? "✓ 自动检测通过" : ""}</div>
    </article>`;
  }).join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>智云 AI Proxy</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #090c12;
      color: #e9eefc;
      letter-spacing: 0;
    }
    header {
      height: 64px;
      border-bottom: 1px solid #202736;
      background: #121722;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 28px;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .brand { display: flex; align-items: center; gap: 12px; font-weight: 800; font-size: 18px; }
    .logo {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      color: white;
      background: linear-gradient(135deg, #5975ff, #a77bff);
      font-size: 13px;
      font-weight: 900;
    }
    .top-actions { display: flex; align-items: center; gap: 12px; }
    .status { color: #97a6bd; font-size: 13px; }
    .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #1ec997; margin-right: 6px; }
    button, .link-button {
      height: 30px;
      border: 1px solid #2a3448;
      border-radius: 8px;
      background: #171d2b;
      color: #eaf0ff;
      padding: 0 12px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
    }
    button:hover, .link-button:hover { border-color: #4f67a3; background: #1d2538; }
    button.primary { background: #4968ff; border-color: #4968ff; }
    .toggle {
      height: 30px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: #aeb9cc;
      font-size: 12px;
      font-weight: 700;
      user-select: none;
    }
    .toggle input { accent-color: #4968ff; }
    main { max-width: 1500px; margin: 0 auto; padding: 30px 28px 52px; }
    section { margin-bottom: 44px; }
    .section-title {
      color: #8796b3;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .08em;
      margin: 0 0 18px;
      font-weight: 800;
    }
    .providers {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(310px, 1fr));
      gap: 16px;
    }
    .provider-card {
      background: #1a2030;
      border: 1px solid #2a3144;
      border-radius: 8px;
      padding: 18px;
      min-height: 238px;
      display: flex;
      flex-direction: column;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.02);
    }
    .provider-card:hover { border-color: #394968; }
    .card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 18px; }
    h2 { margin: 0 0 8px; font-size: 18px; line-height: 1.1; }
    p { margin: 0; color: #8f9db6; font-size: 12px; }
    .tag {
      border-radius: 999px;
      padding: 5px 9px;
      font-size: 11px;
      font-weight: 800;
      white-space: nowrap;
    }
    .badges { display: flex; align-items: center; gap: 8px; }
    .health {
      border-radius: 999px;
      padding: 5px 9px;
      font-size: 11px;
      font-weight: 800;
      white-space: nowrap;
    }
    .health.ok { color: #0fd596; background: rgba(15, 213, 150, .12); }
    .health.err { color: #ff6478; background: rgba(255, 100, 120, .13); }
    .health.pending { color: #a8b4ca; background: rgba(168, 180, 202, .12); }
    .tag.openai { color: #12d69b; background: rgba(18, 214, 155, .12); }
    .tag.anthropic { color: #aa91ff; background: rgba(170, 145, 255, .14); }
    dl { display: grid; gap: 13px; margin: 0; }
    dl div { display: grid; grid-template-columns: 70px minmax(0, 1fr); align-items: center; gap: 10px; }
    dt { color: #8290aa; font-size: 12px; }
    dd {
      margin: 0;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: right;
      color: #f2f6ff;
      font-family: "JetBrains Mono", Consolas, monospace;
      font-size: 12px;
      font-weight: 700;
    }
    dd.model { color: #5f86ff; }
    .card-actions {
      display: flex;
      gap: 6px;
      padding-top: 16px;
      margin-top: auto;
      border-top: 1px solid #252d3e;
    }
    .card-actions button { height: 28px; padding: 0 9px; }
    .card-actions button.active { border-color: #395aff; color: #dfe6ff; background: #202b55; }
    .card-actions button.danger { color: #ff6375; border-color: transparent; background: transparent; }
    .test-result {
      margin-top: 12px;
      min-height: 0;
      border-radius: 8px;
      font-family: "JetBrains Mono", Consolas, monospace;
      font-size: 12px;
      color: #20d49d;
    }
    .test-result.ok, .test-result.err {
      padding: 10px 12px;
      border: 1px solid rgba(32, 212, 157, .35);
      background: rgba(32, 212, 157, .09);
    }
    .test-result.err {
      color: #ff7383;
      border-color: rgba(255, 115, 131, .35);
      background: rgba(255, 115, 131, .08);
    }
    .settings {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 12px;
    }
    .setting {
      background: #1a2030;
      border: 1px solid #2a3144;
      border-radius: 8px;
      padding: 16px;
      min-height: 74px;
    }
    .setting span { display: block; color: #8290aa; font-size: 12px; margin-bottom: 8px; }
    .setting strong { font-size: 15px; font-family: "JetBrains Mono", Consolas, monospace; }
    .api-row {
      background: #1a2030;
      border: 1px solid #2a3144;
      border-radius: 8px;
      height: 52px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 14px;
      font-family: "JetBrains Mono", Consolas, monospace;
      color: #96a5c2;
      font-size: 13px;
    }
    .import-box {
      background: #1a2030;
      border: 1px solid #2a3144;
      border-radius: 8px;
      padding: 16px;
      display: grid;
      gap: 12px;
    }
    textarea, input.text-input {
      width: 100%;
      border: 1px solid #2a3448;
      border-radius: 8px;
      background: #101622;
      color: #eaf0ff;
      padding: 12px;
      font: 13px "JetBrains Mono", Consolas, monospace;
      outline: none;
    }
    textarea { min-height: 130px; resize: vertical; }
    .import-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .import-actions .text-input { max-width: 170px; height: 34px; }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(4, 7, 12, .72);
      z-index: 50;
      padding: 20px;
    }
    .modal-backdrop.open { display: flex; }
    .modal {
      width: min(560px, 100%);
      background: #171d2b;
      border: 1px solid #303a50;
      border-radius: 8px;
      padding: 18px;
      box-shadow: 0 24px 80px rgba(0,0,0,.4);
    }
    .modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .modal-head h2 { margin: 0; font-size: 18px; }
    .form-grid { display: grid; gap: 12px; }
    .field label { display: block; color: #8b99b2; font-size: 12px; font-weight: 800; margin-bottom: 7px; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
    @media (max-width: 720px) {
      header { padding: 0 16px; }
      main { padding: 22px 14px 40px; }
      .providers { grid-template-columns: 1fr; }
      .top-actions .link-button { display: none; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand"><div class="logo">ZY</div><span>智云 AI Proxy</span></div>
    <div class="top-actions">
      <span class="status"><span class="dot"></span>运行中 · ${config.server.port}</span>
      <label class="toggle"><input id="hide-unavailable" type="checkbox" checked />隐藏不可用</label>
      <button id="test-all">一键测试</button>
      <a class="link-button" href="/providers">配置</a>
      <a class="link-button" href="/v1/models">模型</a>
      <button class="primary" id="open-add">+ 添加</button>
      <button id="open-import">批量导入</button>
    </div>
  </header>
  <main>
    <section>
      <h1 class="section-title">Providers</h1>
      <div class="providers">${providerCards}</div>
    </section>

    <section>
      <h1 class="section-title">通用配置</h1>
      <div class="settings">
        <div class="setting"><span>端口</span><strong>${config.server.port}</strong></div>
        <div class="setting"><span>默认 Provider</span><strong>${escapeHtml(config.defaultProvider || "未设置")}</strong></div>
        <div class="setting"><span>路由模式</span><strong>${escapeHtml(config.routing.mode)}</strong></div>
        <div class="setting"><span>最大输入字符</span><strong>${config.context.maxInputChars}</strong></div>
        <div class="setting"><span>Fallback</span><strong>${config.routing.fallback ? "true" : "false"}</strong></div>
        <div class="setting"><span>Provider 数量</span><strong>${config.providers.length}</strong></div>
        <div class="setting"><span>自动检测间隔</span><strong>${Math.round(config.routing.healthCheckIntervalMs / 1000)}s</strong></div>
      </div>
    </section>

    <section>
      <h1 class="section-title">API Keys</h1>
      <div class="api-row">
        <span>本地代理 Key: sk-local</span>
        <span>Base URL: http://${config.server.host}:${config.server.port}</span>
      </div>
    </section>
  </main>
  <div class="modal-backdrop" id="add-modal">
    <div class="modal">
      <div class="modal-head">
        <h2>添加 Provider</h2>
        <button id="close-add">关闭</button>
      </div>
      <div class="form-grid">
        <input id="add-id" type="hidden" />
        <div class="field">
          <label>名称</label>
          <input id="add-name" class="text-input" placeholder="例如 my-provider" />
        </div>
        <div class="field">
          <label>Base URL</label>
          <input id="add-base-url" class="text-input" placeholder="https://api.example.com" />
        </div>
        <div class="field">
          <label>API Key</label>
          <input id="add-api-key" class="text-input" placeholder="sk-..." />
        </div>
        <div class="field">
          <label>Model（可留空自动识别）</label>
          <input id="add-model" class="text-input" placeholder="留空自动读取 /v1/models" />
        </div>
        <div class="field">
          <label>Path</label>
          <input id="add-path" class="text-input" value="/v1/chat/completions" />
        </div>
      </div>
      <div class="modal-actions">
        <span id="add-result" class="status"></span>
        <button id="save-add" class="primary">保存</button>
      </div>
    </div>
  </div>
  <div class="modal-backdrop" id="import-modal">
    <div class="modal">
      <div class="modal-head">
        <h2>批量导入</h2>
        <button id="close-import">关闭</button>
      </div>
      <div class="import-box">
        <textarea id="modal-import-text" placeholder="直接粘贴包含 base URL 和 sk- key 的文本，例如：

https://api.example.com
sk-xxxxxxxxxxxxxxxxxxxxxxxx

https://other.example.com
sk-yyyyyyyyyyyyyyyyyyyyyyyy

解析只在本机进行，识别后会写入 config.local.json。"></textarea>
        <div class="import-actions">
          <input id="modal-import-model" class="text-input" placeholder="模型可留空自动识别" />
          <button id="modal-import-providers" class="primary">识别并添加</button>
          <span id="modal-import-result" class="status"></span>
        </div>
      </div>
    </div>
  </div>
  <script>
    const addModal = document.getElementById("add-modal");
    const importModal = document.getElementById("import-modal");
    document.getElementById("open-add").addEventListener("click", () => {
      resetAddForm();
      addModal.classList.add("open");
      document.getElementById("add-base-url").focus();
    });
    document.getElementById("open-import").addEventListener("click", () => {
      importModal.classList.add("open");
      document.getElementById("modal-import-text").focus();
    });
    document.getElementById("close-add").addEventListener("click", () => {
      addModal.classList.remove("open");
    });
    document.getElementById("close-import").addEventListener("click", () => {
      importModal.classList.remove("open");
    });
    addModal.addEventListener("click", (event) => {
      if (event.target === addModal) addModal.classList.remove("open");
    });
    importModal.addEventListener("click", (event) => {
      if (event.target === importModal) importModal.classList.remove("open");
    });

    document.getElementById("save-add").addEventListener("click", async () => {
      const button = document.getElementById("save-add");
      const result = document.getElementById("add-result");
      button.disabled = true;
      button.textContent = "保存中...";
      result.textContent = "";

      try {
        const providerId = document.getElementById("add-id").value;
        const response = await fetch(providerId ? "/providers/" + encodeURIComponent(providerId) : "/providers/add", {
          method: providerId ? "PUT" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: document.getElementById("add-name").value,
            baseUrl: document.getElementById("add-base-url").value,
            apiKey: document.getElementById("add-api-key").value,
            model: document.getElementById("add-model").value,
            path: document.getElementById("add-path").value || "/v1/chat/completions"
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || "保存失败");
        result.textContent = "已保存 " + data.provider.id + "，正在刷新...";
        setTimeout(() => location.reload(), 700);
      } catch (error) {
        result.textContent = "保存失败: " + error.message;
      } finally {
        button.disabled = false;
        button.textContent = "保存";
      }
    });

    document.querySelectorAll("[data-edit]").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.getAttribute("data-edit");
        const result = document.getElementById("add-result");
        result.textContent = "加载中...";
        try {
          const response = await fetch("/providers/" + encodeURIComponent(id));
          const data = await response.json();
          if (!response.ok) throw new Error(data.error?.message || "加载失败");
          document.getElementById("add-id").value = data.provider.id;
          document.getElementById("add-name").value = data.provider.name;
          document.getElementById("add-base-url").value = data.provider.baseUrl;
          document.getElementById("add-api-key").value = data.provider.apiKey;
          document.getElementById("add-model").value = data.provider.models.join(",");
          document.getElementById("add-path").value = data.provider.path;
          document.querySelector("#add-modal .modal-head h2").textContent = "编辑 Provider";
          document.getElementById("save-add").textContent = "保存";
          result.textContent = "";
          addModal.classList.add("open");
          document.getElementById("add-name").focus();
        } catch (error) {
          result.textContent = "加载失败: " + error.message;
          addModal.classList.add("open");
        }
      });
    });

    document.querySelectorAll("[data-default]").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.getAttribute("data-default");
        button.disabled = true;
        const wasDefault = button.classList.contains("active");
        button.textContent = wasDefault ? "取消中..." : "设置中...";
        try {
          const response = await fetch("/providers/" + encodeURIComponent(id) + "/default", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}"
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error?.message || "设置失败");
          location.reload();
        } catch (error) {
          button.disabled = false;
          button.textContent = wasDefault ? "取消默认" : "设为默认";
          alert("设置默认失败: " + error.message);
        }
      });
    });

    document.getElementById("modal-import-providers").addEventListener("click", async () => {
      const button = document.getElementById("modal-import-providers");
      const result = document.getElementById("modal-import-result");
      button.disabled = true;
      button.textContent = "识别中...";
      result.textContent = "";

      try {
        const response = await fetch("/providers/import-text", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: document.getElementById("modal-import-text").value,
            model: document.getElementById("modal-import-model").value
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || "导入失败");
        result.textContent = "新增 " + data.added.length + " 个，跳过 " + data.skipped.length + " 个；正在刷新...";
        setTimeout(() => location.reload(), 900);
      } catch (error) {
        result.textContent = "导入失败: " + error.message;
      } finally {
        button.disabled = false;
        button.textContent = "识别并添加";
      }
    });

    document.querySelectorAll("[data-test]").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.getAttribute("data-test");
        const result = document.getElementById("result-" + id);
        result.className = "test-result";
        result.textContent = "测试中...";
        try {
          const response = await fetch("/providers/" + encodeURIComponent(id) + "/test", { method: "POST" });
          const data = await response.json();
          result.className = "test-result " + (response.ok ? "ok" : "err");
          result.textContent = response.ok
            ? "✓ 连接成功 · " + data.latencyMs + "ms"
            : "连接失败 · " + data.error.message;
          refreshHealth();
        } catch (error) {
          result.className = "test-result err";
          result.textContent = "连接失败 · " + error.message;
        }
      });
    });

    document.getElementById("test-all").addEventListener("click", async () => {
      const button = document.getElementById("test-all");
      button.disabled = true;
      button.textContent = "测试中...";
      document.querySelectorAll(".test-result").forEach((node) => {
        node.className = "test-result";
        node.textContent = "等待检测...";
      });

      try {
        const response = await fetch("/providers/test-all", { method: "POST" });
        const data = await response.json();
        updateHealthView(data);
      } catch (error) {
        alert("一键测试失败: " + error.message);
      } finally {
        button.disabled = false;
        button.textContent = "一键测试";
      }
    });

    async function refreshHealth() {
      const response = await fetch("/health-checks");
      const data = await response.json();
      updateHealthView(data);
    }

    function updateHealthView(data) {
      const healthById = new Map(data.providers.map((item) => [item.id, item]));
      for (const item of data.providers) {
        const card = Array.from(document.querySelectorAll(".provider-card"))
          .find((node) => node.dataset.providerId === item.id);
        const status = document.getElementById("health-" + item.id);
        const latency = document.getElementById("latency-" + item.id);
        const checked = document.getElementById("checked-" + item.id);
        const result = document.getElementById("result-" + item.id);
        const state = item.ok === true ? "ok" : item.ok === false ? "err" : "pending";
        if (card) {
          card.dataset.healthState = state;
          card.dataset.latency = item.latencyMs ? String(item.latencyMs) : "999999999";
        }
        if (status) {
          status.className = "health " + state;
          status.textContent = state === "ok" ? "可用" : state === "err" ? "异常" : "检测中";
        }
        if (latency) latency.textContent = item.latencyMs ? item.latencyMs + "ms" : "待检测";
        if (checked) checked.textContent = item.checkedAt ? new Date(item.checkedAt).toLocaleTimeString() : "待检测";
        if (result) {
          result.className = "test-result " + (state === "pending" ? "" : state);
          result.textContent = item.error ? item.error.slice(0, 180) : state === "ok" ? "✓ 自动检测通过" : "";
        }
      }
      sortProviderCards(healthById);
      applyUnavailableFilter();
    }

    function sortProviderCards(healthById) {
      const container = document.querySelector(".providers");
      const cards = Array.from(container.querySelectorAll(".provider-card"));
      const stateRank = { ok: 0, pending: 1, err: 2 };
      cards.sort((a, b) => {
        const ah = healthById.get(a.dataset.providerId);
        const bh = healthById.get(b.dataset.providerId);
        const aState = ah?.ok === true ? "ok" : ah?.ok === false ? "err" : "pending";
        const bState = bh?.ok === true ? "ok" : bh?.ok === false ? "err" : "pending";
        const stateDelta = stateRank[aState] - stateRank[bState];
        if (stateDelta !== 0) return stateDelta;
        const latencyDelta = Number(a.dataset.latency || 999999999) - Number(b.dataset.latency || 999999999);
        if (latencyDelta !== 0) return latencyDelta;
        return a.dataset.providerId.localeCompare(b.dataset.providerId);
      });
      for (const card of cards) container.appendChild(card);
    }

    function applyUnavailableFilter() {
      const hide = document.getElementById("hide-unavailable").checked;
      document.querySelectorAll(".provider-card").forEach((card) => {
        card.style.display = hide && card.dataset.healthState === "err" ? "none" : "";
      });
    }

    document.getElementById("hide-unavailable").addEventListener("change", applyUnavailableFilter);
    refreshHealth();
    setInterval(refreshHealth, 5000);

    function resetAddForm() {
      document.getElementById("add-id").value = "";
      document.getElementById("add-name").value = "";
      document.getElementById("add-base-url").value = "";
      document.getElementById("add-api-key").value = "";
      document.getElementById("add-model").value = "";
      document.getElementById("add-path").value = "/v1/chat/completions";
      document.getElementById("add-result").textContent = "";
      document.querySelector("#add-modal .modal-head h2").textContent = "添加 Provider";
      document.getElementById("save-add").textContent = "保存";
    }
  </script>
</body>
</html>`;
});

app.post("/providers/:id/test", async (request, reply) => {
  const { id } = request.params as { id: string };
  const provider = config.providers.find((item) => item.id === id);

  if (!provider) {
    reply.code(404);
    return {
      type: "error",
      error: {
        type: "not_found_error",
        message: `Provider ${id} not found`
      }
    };
  }

  try {
    const result = await testProviderChat(provider, 15000);
    providerHealth.set(provider.id, {
      id: provider.id,
      ok: true,
      latencyMs: result.latencyMs,
      checkedAt: Date.now()
    });
    metrics.recordSuccess(provider.id, provider.models[0] ?? "unknown", result.latencyMs);
    return {
      ok: true,
      latencyMs: result.latencyMs,
      response: result.response
    };
  } catch (error) {
    providerHealth.set(provider.id, {
      id: provider.id,
      ok: false,
      checkedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error)
    });
    metrics.recordFailure(provider.id, provider.models[0] ?? "unknown");
    reply.code(502);
    return {
      type: "error",
      error: {
        type: "api_error",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
});

app.post("/providers/test-all", async () => {
  await runHealthChecks("manual");
  return healthSnapshot();
});

app.get("/providers/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const provider = config.providers.find((item) => item.id === id);

  if (!provider) {
    reply.code(404);
    return {
      type: "error",
      error: {
        type: "not_found_error",
        message: `Provider ${id} not found`
      }
    };
  }

  return { provider };
});

app.post("/providers/:id/default", async (request, reply) => {
  const { id } = request.params as { id: string };
  const provider = config.providers.find((item) => item.id === id);

  if (!provider) {
    reply.code(404);
    return {
      type: "error",
      error: {
        type: "not_found_error",
        message: `Provider ${id} not found`
      }
    };
  }

  config.defaultProvider = config.defaultProvider === id ? "" : id;
  saveConfig(config);
  return { ok: true, defaultProvider: config.defaultProvider };
});

app.post("/providers/add", async (request, reply) => {
  const body = addProviderSchema.parse(request.body);
  const baseUrl = sanitizeUrl(body.baseUrl);
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  if (config.providers.some((provider) => normalizeBaseUrl(provider.baseUrl) === normalizedBaseUrl)) {
    reply.code(409);
    return {
      type: "error",
      error: {
        type: "conflict_error",
        message: "这个 Base URL 已存在"
      }
    };
  }

  if (config.providers.some((provider) => provider.apiKey === body.apiKey)) {
    reply.code(409);
    return {
      type: "error",
      error: {
        type: "conflict_error",
        message: "这个 API Key 已存在"
      }
    };
  }

  const hostname = new URL(baseUrl).hostname;
  const priority = Math.max(0, ...config.providers.map((provider) => provider.priority)) + 10;
  const provider: ProviderConfig = {
    id: uniqueProviderId(hostToId(hostname)),
    name: body.name?.trim() || hostname,
    type: "openai",
    baseUrl,
    path: body.path,
    apiKey: body.apiKey.trim(),
    models: await resolveProviderModels(baseUrl, body.path, body.apiKey.trim(), body.model),
    enabled: true,
    priority
  };

  config.providers.push(provider);
  providerHealth.set(provider.id, { id: provider.id });
  saveConfig(config);
  void runProviderHealthCheck(provider.id, "manual");

  return {
    provider: {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      path: provider.path,
      models: provider.models
    }
  };
});

app.put("/providers/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = addProviderSchema.parse(request.body);
  const index = config.providers.findIndex((item) => item.id === id);

  if (index < 0) {
    reply.code(404);
    return {
      type: "error",
      error: {
        type: "not_found_error",
        message: `Provider ${id} not found`
      }
    };
  }

  const baseUrl = sanitizeUrl(body.baseUrl);
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  if (config.providers.some((provider) => provider.id !== id && normalizeBaseUrl(provider.baseUrl) === normalizedBaseUrl)) {
    reply.code(409);
    return {
      type: "error",
      error: {
        type: "conflict_error",
        message: "这个 Base URL 已存在"
      }
    };
  }

  if (config.providers.some((provider) => provider.id !== id && provider.apiKey === body.apiKey)) {
    reply.code(409);
    return {
      type: "error",
      error: {
        type: "conflict_error",
        message: "这个 API Key 已存在"
      }
    };
  }

  const current = config.providers[index];
  const provider: ProviderConfig = {
    ...current,
    name: body.name?.trim() || new URL(baseUrl).hostname,
    baseUrl,
    path: body.path,
    apiKey: body.apiKey.trim(),
    models: await resolveProviderModels(baseUrl, body.path, body.apiKey.trim(), body.model)
  };

  config.providers[index] = provider;
  providerHealth.set(provider.id, { id: provider.id });
  saveConfig(config);
  void runProviderHealthCheck(provider.id, "manual");

  return {
    provider: {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      path: provider.path,
      models: provider.models
    }
  };
});

app.post("/providers/import-text", async (request, reply) => {
  const body = importProvidersSchema.parse(request.body);
  const parsed = parseProvidersFromText(body.text, body.model, body.path);

  if (parsed.length === 0) {
    reply.code(400);
    return {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "没有识别到可配对的 URL 和 sk- key"
      }
    };
  }

  const existingKeys = new Set(config.providers.map((provider) => provider.apiKey));
  const existingUrls = new Set(config.providers.map((provider) => normalizeBaseUrl(provider.baseUrl)));
  const added: ProviderConfig[] = [];
  const skipped: Array<{ baseUrl: string; reason: string }> = [];
  let priority = Math.max(0, ...config.providers.map((provider) => provider.priority)) + 10;

  for (const candidate of parsed) {
    if (existingKeys.has(candidate.apiKey)) {
      skipped.push({ baseUrl: candidate.baseUrl, reason: "duplicate_key" });
      continue;
    }

    if (existingUrls.has(normalizeBaseUrl(candidate.baseUrl))) {
      skipped.push({ baseUrl: candidate.baseUrl, reason: "duplicate_url" });
      continue;
    }

    const provider: ProviderConfig = {
      id: uniqueProviderId(hostToId(new URL(candidate.baseUrl).hostname)),
      name: new URL(candidate.baseUrl).hostname,
      type: "openai",
      baseUrl: candidate.baseUrl,
      path: candidate.path,
      apiKey: candidate.apiKey,
      models: await resolveProviderModels(candidate.baseUrl, candidate.path, candidate.apiKey, candidate.model),
      enabled: true,
      priority
    };

    priority += 10;
    config.providers.push(provider);
    providerHealth.set(provider.id, { id: provider.id });
    existingKeys.add(provider.apiKey);
    existingUrls.add(normalizeBaseUrl(provider.baseUrl));
    added.push(provider);
  }

  if (added.length > 0) {
    saveConfig(config);
    void runHealthChecks("manual");
  }

  return {
    added: added.map((provider) => ({
      id: provider.id,
      baseUrl: provider.baseUrl,
      path: provider.path,
      models: provider.models
    })),
    skipped
  };
});

app.get("/health", async () => ({
  ok: true,
  port: config.server.port,
  routing: config.routing.mode
}));

app.get("/providers", async () => ({
  providers: config.providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    path: provider.path,
    models: provider.models,
    enabled: provider.enabled,
    priority: provider.priority
  })),
  metrics: metrics.snapshot()
}));

app.get("/health-checks", async () => healthSnapshot());

app.get("/route-preview/:model", async (request) => {
  const { model } = request.params as { model: string };
  const decision = router.preview(model);
  return {
    selected: {
      providerId: decision.provider.id,
      providerName: decision.provider.name,
      model: decision.model
    },
    candidates: decision.candidates.map((candidate) => ({
      providerId: candidate.provider.id,
      providerName: candidate.provider.name,
      model: candidate.model,
      score: metrics.score(candidate.provider.id, candidate.model)
    }))
  };
});

app.get("/v1/models", async () => {
  const modelIds = new Set<string>();
  for (const provider of config.providers.filter((item) => item.enabled)) {
    for (const model of provider.models) {
      modelIds.add(model);
    }
  }
  for (const alias of Object.keys(config.modelAliases)) {
    modelIds.add(alias);
  }

  return {
    data: [...modelIds].sort().map((id) => ({
      id,
      type: "model",
      display_name: id,
      created_at: "2026-01-01T00:00:00Z"
    })),
    has_more: false,
    first_id: null,
    last_id: null
  };
});

app.post("/v1/messages", async (request, reply) => {
  const parsed = claudeRequestSchema.parse(request.body) as ClaudeMessagesRequest;
  const internal = toInternalRequest(parsed, config);
  const decision = router.choose(internal);
  const candidates = config.routing.fallback ? decision.candidates : [decision.candidates[0]];
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      reply.header("x-proxy-provider", candidate.provider.id);
      reply.header("x-proxy-model", candidate.model);
      if (internal.stream) {
        const result = await streamProvider(
          candidate.provider,
          candidate.model,
          internal,
          reply,
          config.routing.requestTimeoutMs
        );
        reply.header("x-proxy-upstream-latency-ms", String(result.latencyMs));
        metrics.recordSuccess(candidate.provider.id, candidate.model, result.latencyMs);
        return reply;
      }

      const result = await callProvider(
        candidate.provider,
        candidate.model,
        internal,
        config.routing.requestTimeoutMs
      );
      reply.header("x-proxy-upstream-latency-ms", String(result.latencyMs));
      metrics.recordSuccess(candidate.provider.id, candidate.model, result.latencyMs);
      return result.response;
    } catch (error) {
      metrics.recordFailure(candidate.provider.id, candidate.model);
      errors.push(error instanceof Error ? error.message : String(error));
      if (internal.stream && reply.raw.headersSent) {
        request.log.error({ errors }, "stream failed after headers were sent");
        reply.raw.end();
        return reply;
      }
    }
  }

  reply.code(502);
  return {
    type: "error",
    error: {
      type: "api_error",
      message: errors.join(" | ")
    }
  };
});

app.setErrorHandler((error, _request, reply) => {
  const status = error instanceof z.ZodError ? 400 : 500;
  reply.code(status).send({
    type: "error",
    error: {
      type: status === 400 ? "invalid_request_error" : "api_error",
      message: error.message
    }
  });
});

startHealthChecker();

await app.listen({
  host: config.server.host,
  port: config.server.port
});

function startHealthChecker(): void {
  for (const provider of config.providers) {
    providerHealth.set(provider.id, { id: provider.id });
  }

  setTimeout(() => {
    void runHealthChecks("startup");
  }, 500);

  setInterval(() => {
    void runHealthChecks("timer");
  }, config.routing.healthCheckIntervalMs);
}

async function runHealthChecks(reason: "startup" | "timer" | "manual"): Promise<void> {
  if (healthCheckRunning) return;
  healthCheckRunning = true;

  try {
    const enabledProviders = config.providers.filter((provider) => provider.enabled);
    await Promise.allSettled(enabledProviders.map((provider) => runProviderHealthCheck(provider.id, reason)));
  } finally {
    healthCheckRunning = false;
  }
}

async function runProviderHealthCheck(providerId: string, _reason: "startup" | "timer" | "manual"): Promise<void> {
  const provider = config.providers.find((item) => item.id === providerId);
  if (!provider) return;

  try {
    const result = await testProviderChat(provider, Math.min(config.routing.requestTimeoutMs, 15000));
    providerHealth.set(provider.id, {
      id: provider.id,
      ok: true,
      latencyMs: result.latencyMs,
      checkedAt: Date.now()
    });
    metrics.recordSuccess(provider.id, provider.models[0] ?? "unknown", result.latencyMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    providerHealth.set(provider.id, {
      id: provider.id,
      ok: false,
      checkedAt: Date.now(),
      error: shortError(message)
    });
    metrics.recordFailure(provider.id, provider.models[0] ?? "unknown");
  }
}

function healthSnapshot(): { providers: ProviderHealth[]; running: boolean; intervalMs: number } {
  return {
    providers: config.providers.map((provider) => providerHealth.get(provider.id) ?? { id: provider.id }),
    running: healthCheckRunning,
    intervalMs: config.routing.healthCheckIntervalMs
  };
}

function sortedProvidersForView() {
  return [...config.providers].sort((a, b) => {
    const ah = providerHealth.get(a.id);
    const bh = providerHealth.get(b.id);
    const stateDelta = healthRank(ah) - healthRank(bh);
    if (stateDelta !== 0) return stateDelta;
    const latencyDelta = (ah?.latencyMs ?? Number.MAX_SAFE_INTEGER) - (bh?.latencyMs ?? Number.MAX_SAFE_INTEGER);
    if (latencyDelta !== 0) return latencyDelta;
    return a.priority - b.priority;
  });
}

function healthRank(health?: ProviderHealth): number {
  if (health?.ok === true) return 0;
  if (health?.ok === false) return 2;
  return 1;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function maskKey(key: string): string {
  if (key.length <= 12) return "••••";
  return `${key.slice(0, 6)}••••${key.slice(-4)}`;
}

function statusLabel(status: "ok" | "err" | "pending"): string {
  if (status === "ok") return "可用";
  if (status === "err") return "异常";
  return "检测中";
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
}

function shortError(error: string): string {
  return error.length > 180 ? `${error.slice(0, 180)}...` : error;
}

async function resolveProviderModels(baseUrl: string, path: string, apiKey: string, modelInput?: string): Promise<string[]> {
  const explicitModels = (modelInput ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);

  if (explicitModels.length > 0) {
    return [...new Set(explicitModels)];
  }

  const probeProvider: ProviderConfig = {
    id: "model-probe",
    name: "Model Probe",
    type: "openai",
    baseUrl,
    path,
    apiKey,
    models: ["gpt-5.5"],
    enabled: true,
    priority: 0
  };

  try {
    const result = await testProviderModels(probeProvider, 8000);
    const discovered = extractModelIds(result.response);
    if (discovered.length > 0) {
      return discovered;
    }
  } catch {
    // If model discovery fails, keep add/edit usable and let health checks expose provider errors.
  }

  return ["gpt-5.5"];
}

function extractModelIds(response: unknown): string[] {
  if (!response || typeof response !== "object") return [];
  const data = "data" in response ? (response as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return [];

  return [...new Set(data
    .map((item) => {
      if (item && typeof item === "object" && "id" in item) {
        return String((item as { id: unknown }).id);
      }
      return "";
    })
    .filter(Boolean))];
}

function parseProvidersFromText(text: string, model: string, path: string): Array<{ baseUrl: string; apiKey: string; model: string; path: string }> {
  const tokenPattern = /(https?:\/\/[^\s"',，。；;]+)|(sk-[A-Za-z0-9_-]{16,})/g;
  const tokens: Array<{ type: "url" | "key"; value: string; index: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text)) !== null) {
    if (match[1]) {
      tokens.push({ type: "url", value: sanitizeUrl(match[1]), index: match.index });
    } else if (match[2]) {
      tokens.push({ type: "key", value: match[2], index: match.index });
    }
  }

  const pairs: Array<{ baseUrl: string; apiKey: string; model: string; path: string }> = [];
  const usedKeys = new Set<number>();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== "url") continue;

    let bestKeyIndex = -1;
    let bestDistance = Number.MAX_SAFE_INTEGER;
    for (let j = 0; j < tokens.length; j += 1) {
      if (usedKeys.has(j) || tokens[j].type !== "key") continue;
      const distance = Math.abs(tokens[j].index - token.index);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestKeyIndex = j;
      }
    }

    if (bestKeyIndex >= 0) {
      usedKeys.add(bestKeyIndex);
      pairs.push({
        baseUrl: token.value,
        apiKey: tokens[bestKeyIndex].value,
        model,
        path
      });
    }
  }

  return pairs;
}

function sanitizeUrl(url: string): string {
  const parsed = new URL(url.replace(/[)\]}]+$/, ""));
  return `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`.replace(/\/v1\/?$/, "");
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

function hostToId(hostname: string): string {
  return hostname
    .replace(/^api\./, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || `provider-${Date.now()}`;
}

function uniqueProviderId(base: string): string {
  const existing = new Set(config.providers.map((provider) => provider.id));
  if (!existing.has(base)) return base;

  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }

  return `${base}-${Date.now()}`;
}
