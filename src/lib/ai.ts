import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { z } from "zod";
import { homedir } from "node:os";

export type LLMProvider = "openai" | "anthropic" | "claude-cli";

export function detectProvider(model?: string): LLMProvider {
  const resolvedModel =
    model ?? process.env.OPENAI_MODEL ?? process.env.ANTHROPIC_MODEL;
  const isAnthropic =
    resolvedModel?.startsWith("claude-") ||
    (!process.env.OPENAI_API_KEY && process.env.ANTHROPIC_API_KEY);

  if (isAnthropic) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";

  // No API keys — fall back to claude CLI if available
  try {
    const result = Bun.spawnSync(["claude", "--version"]);
    if (result.exitCode === 0) return "claude-cli";
  } catch {}

  throw new Error(
    "No API key found and Claude CLI is not installed.\n" +
      "Either set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env,\n" +
      "or install Claude Code CLI: https://docs.anthropic.com/en/docs/claude-code",
  );
}

export function createSuggestLLM(model?: string): BaseChatModel {
  const resolvedModel =
    model ?? process.env.OPENAI_MODEL ?? process.env.ANTHROPIC_MODEL;
  const provider = detectProvider(model);

  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Add it to .env or set it in your environment.\n" +
          "Get one at https://console.anthropic.com/settings/keys",
      );
    }
    return new ChatAnthropic({
      modelName: resolvedModel ?? "claude-sonnet-4-20250514",
      anthropicApiKey: apiKey,
      temperature: 0.15,
    });
  }

  if (provider === "claude-cli") {
    throw new Error(
      "claude-cli provider does not return a LangChain model. Use invokeClaudeCLI() instead.",
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No API key found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env or your environment.",
    );
  }

  return new ChatOpenAI({
    modelName: resolvedModel ?? "gpt-5.4-mini",
    apiKey,
    streaming: false,
    temperature: 0.15,
  });
}

export function getAIInfo(): { provider: LLMProvider; model: string } {
  const resolvedModel = process.env.OPENAI_MODEL ?? process.env.ANTHROPIC_MODEL;
  try {
    const provider = detectProvider();
    let model: string;
    if (provider === "anthropic")
      model = resolvedModel ?? "claude-sonnet-4-20250514";
    else if (provider === "openai") model = resolvedModel ?? "gpt-5.4-mini";
    else {
      // claude-cli: read default model from ~/.claude/settings.json
      let cliModel = resolvedModel;
      if (!cliModel) {
        try {
          const settingsPath = `${homedir()}/.claude/settings.json`;
          const settings = JSON.parse(
            require("node:fs").readFileSync(settingsPath, "utf-8"),
          );
          if (settings.model) cliModel = settings.model;
        } catch {}
      }
      model = cliModel ?? "unknown";
    }
    return { provider, model };
  } catch {
    return {
      provider: "claude-cli" as LLMProvider,
      model: resolvedModel ?? "unknown",
    };
  }
}

export async function invokeClaudeCLI<T>(
  systemPrompt: string,
  humanMessage: string,
  schema: z.ZodType<T>,
  model?: string,
): Promise<T> {
  console.log("Invoking Claude CLI with system prompt\n", systemPrompt);
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema), null, 2);

  const args = [
    "claude",
    "-p",
    "--system-prompt",
    `
    You must respond with valid JSON that matches this schema:
    ${jsonSchema}

    Do NOT include any text outside the JSON object.
    
    ${systemPrompt}`,
  ];

  if (model) {
    args.push("--model", model);
  }

  const proc = Bun.spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(humanMessage);
  proc.stdin.end();

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`Claude CLI failed (exit ${exitCode}): ${stderr.trim()}`);
  }

  let raw = stdout.trim();
  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = raw.match(/^```(?:\w*)\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) raw = fenceMatch[1]!.trim();

  return schema.parse(JSON.parse(raw));
}
