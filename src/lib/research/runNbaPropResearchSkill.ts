import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

import type {
  ResearchInput,
  ResearchOutput,
  RunNbaPropResearchSkillOptions,
} from "../../types/research";
import { normalizeResearchVerdict } from "./normalizeResearchVerdict";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..", "..", "..");
const promptPath = path.join(projectRoot, "prompts", "nba-prop-research-skill.md");
const schemaPath = path.join(projectRoot, "schemas", "nbaPropResearch.schema.json");
const DEFAULT_MODEL = "gpt-5.4";

const readTextFile = async (filename: string) => fs.readFile(filename, "utf8");

const parseJsonResponse = (response: Record<string, unknown>) => {
  const outputText = typeof response.output_text === "string" ? response.output_text.trim() : "";
  if (outputText) {
    return JSON.parse(outputText);
  }

  const output = Array.isArray(response.output) ? response.output : [];
  const blocks = output
    .filter((item) => item && typeof item === "object" && "type" in item && item.type === "message")
    .flatMap((item) => {
      const content = "content" in item ? item.content : [];
      return Array.isArray(content) ? content : [];
    })
    .filter((item) => item && typeof item === "object" && "type" in item && item.type === "output_text")
    .map((item) => ("text" in item && typeof item.text === "string" ? item.text : ""))
    .filter(Boolean);

  if (!blocks.length) {
    throw new Error("NBA prop research skill did not return any text output.");
  }

  return JSON.parse(blocks.join("\n"));
};

const validateInput = (input: ResearchInput) => {
  if (!input.player?.trim()) throw new Error("Research input requires a player name.");
  if (!input.team?.trim()) throw new Error("Research input requires a team.");
  if (!input.opponent?.trim()) throw new Error("Research input requires an opponent.");
  if (!Number.isFinite(input.line)) throw new Error("Research input requires a valid numeric line.");
};

export const runNbaPropResearchSkill = async (
  input: ResearchInput,
  options: RunNbaPropResearchSkillOptions = {},
): Promise<ResearchOutput> => {
  validateInput(input);

  const [systemPrompt, schemaText] = await Promise.all([
    readTextFile(promptPath),
    readTextFile(schemaPath),
  ]);

  const schema = JSON.parse(schemaText);
  const client = options.client || new OpenAI({ apiKey: options.apiKey || process.env.OPENAI_API_KEY });
  const model = options.model || DEFAULT_MODEL;

  const response = await client.responses.create({
    model,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: systemPrompt }],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Evaluate this NBA prop research input and return only structured JSON.\n${JSON.stringify(input, null, 2)}`,
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "nba_prop_research",
        schema,
        strict: true,
      },
    },
  });

  const rawResult = parseJsonResponse(response as Record<string, unknown>) as ResearchOutput;
  const normalized = normalizeResearchVerdict(rawResult);
  return normalized.result;
};
