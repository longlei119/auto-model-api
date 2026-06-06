import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { AppConfig } from "./types.js";

const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["openai", "anthropic"]),
  baseUrl: z.string().url(),
  path: z.string().min(1),
  apiKey: z.string(),
  models: z.array(z.string()).min(1),
  enabled: z.boolean(),
  priority: z.number().int().default(100)
});

const configSchema = z.object({
  server: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().positive().default(8088)
  }),
  routing: z.object({
    mode: z.enum(["manual", "session", "fastest", "fallback"]).default("session"),
    fallback: z.boolean().default(true),
    healthCheckIntervalMs: z.number().int().positive().default(30000),
    requestTimeoutMs: z.number().int().positive().default(120000)
  }),
  defaultProvider: z.string(),
  context: z.object({
    mode: z.enum(["preserve", "truncate"]).default("preserve"),
    maxInputChars: z.number().int().positive().default(180000),
    pinSystem: z.boolean().default(true),
    pinRecentTurns: z.number().int().nonnegative().default(12)
  }),
  modelAliases: z.record(z.array(z.string())).default({}),
  providers: z.array(providerSchema).min(1)
});

export function loadConfig(): AppConfig {
  const configPath = getConfigPath();
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  return configSchema.parse(raw);
}

export function saveConfig(config: AppConfig): void {
  writeFileSync(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function getConfigPath(): string {
  const localPath = resolve(process.cwd(), "config.local.json");
  const examplePath = resolve(process.cwd(), "config.example.json");
  return existsSync(localPath) ? localPath : examplePath;
}
