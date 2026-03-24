import { ChatOpenAI } from "@langchain/openai";

export function createSuggestLLM(model?: string): ChatOpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Add it to .env or set it in your environment.\n" +
      "Get one at https://platform.openai.com/api-keys"
    );
  }

  return new ChatOpenAI({
    modelName: model ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    apiKey,
    streaming: false,
    temperature: 0.15,
  });
}
