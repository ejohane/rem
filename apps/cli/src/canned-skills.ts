import type { PluginManifest } from "@rem/schemas";

export interface CannedSkillDefinition {
  id: string;
  name: string;
  description: string;
  pluginManifest: PluginManifest;
  note: {
    id: string;
    title: string;
    noteType: string;
    tags: string[];
    lexicalState: unknown;
    payload: Record<string, unknown>;
  };
}

function heading(level: 1 | 2 | 3 | 4 | 5 | 6, text: string): Record<string, unknown> {
  return {
    type: "heading",
    tag: `h${level}`,
    version: 1,
    children: [
      {
        type: "text",
        version: 1,
        text,
      },
    ],
  };
}

function paragraph(text: string): Record<string, unknown> {
  return {
    type: "paragraph",
    version: 1,
    children: [
      {
        type: "text",
        version: 1,
        text,
      },
    ],
  };
}

const agentSkillsManifest: PluginManifest = {
  namespace: "agent-skills",
  schemaVersion: "v1",
  payloadSchema: {
    type: "object",
    required: ["skillId", "summary", "invokeWhen", "coreCommands"],
    properties: {
      skillId: { type: "string" },
      summary: { type: "string" },
      invokeWhen: { type: "array", items: { type: "string" } },
      avoidWhen: { type: "array", items: { type: "string" } },
      coreCommands: { type: "array", items: { type: "string" } },
      workflow: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  },
};

const remCliMemorySkill: CannedSkillDefinition = {
  id: "rem-cli-memory",
  name: "REM CLI Memory",
  description:
    "Agent skill for when to use rem CLI and how to run memory-safe note/proposal/plugin workflows.",
  pluginManifest: agentSkillsManifest,
  note: {
    id: "skill-rem-cli-memory",
    title: "Skill: REM CLI Memory Workflow",
    noteType: "agent-skill",
    tags: ["agent", "skill", "memory", "cli", "rem"],
    lexicalState: {
      root: {
        type: "root",
        version: 1,
        children: [
          heading(1, "REM CLI Memory Workflow"),
          paragraph(
            "Use this skill when an agent needs durable memory operations in rem (notes, sections, proposals, plugins, and status/event checks).",
          ),
          heading(2, "Invoke When"),
          paragraph(
            "You need to capture or update memory in the vault, inspect prior context, or perform proposal-based edits instead of free-form file changes.",
          ),
          paragraph(
            "You need deterministic retrieval via search filters like tags, note types, plugin namespaces, or time windows.",
          ),
          heading(2, "Avoid When"),
          paragraph(
            "The task is unrelated to memory management in rem, such as browser automation, external integrations, or non-vault project edits.",
          ),
          heading(2, "Core Commands"),
          paragraph("rem notes save --input <path> --json"),
          paragraph("rem sections list --note <note-id> --json"),
          paragraph(
            'rem proposals create --note <note-id> --section <section-id> --text "..." --json',
          ),
          paragraph("rem proposals list --status open --json"),
          paragraph("rem proposals accept <proposal-id> --json"),
          paragraph(
            'rem search "<query>" --tags <csv> --note-types <csv> --plugin-namespaces <csv> --json',
          ),
          paragraph("rem status --json"),
          heading(2, "Recommended Flow"),
          paragraph("1. Search for existing memory before writing."),
          paragraph("2. Save or update notes with structured metadata."),
          paragraph(
            "3. Use section-targeted proposals for edits that should be reviewable or reversible.",
          ),
          paragraph(
            "4. Verify system health/events when debugging stale results or sync concerns.",
          ),
        ],
      },
    },
    payload: {
      skillId: "rem-cli-memory",
      summary:
        "Use rem CLI for durable memory creation, retrieval, and proposal-based edits in agent workflows.",
      invokeWhen: [
        "Need to create or update memory notes in rem.",
        "Need filtered retrieval using tags, note types, plugin namespaces, or time windows.",
        "Need section-targeted proposal review instead of direct note overwrite.",
        "Need event and status visibility while debugging memory pipelines.",
      ],
      avoidWhen: [
        "Task does not involve rem vault data.",
        "Task is primarily browser or external system automation.",
      ],
      coreCommands: [
        "rem notes save --input <path> --json",
        "rem sections list --note <note-id> --json",
        'rem proposals create --note <note-id> --section <section-id> --text "..." --json',
        "rem proposals list --status open --json",
        "rem proposals accept <proposal-id> --json",
        'rem search "<query>" --tags <csv> --note-types <csv> --plugin-namespaces <csv> --json',
        "rem status --json",
      ],
      workflow: [
        "Search existing memory first.",
        "Write or update canonical notes with metadata.",
        "Use proposals for section-scoped updates.",
        "Review status/events to confirm indexing health.",
      ],
    },
  },
};

const cannedSkills: CannedSkillDefinition[] = [remCliMemorySkill];

export function listCannedSkills(): CannedSkillDefinition[] {
  return cannedSkills;
}

export function getCannedSkill(skillId: string): CannedSkillDefinition | undefined {
  return cannedSkills.find((skill) => skill.id === skillId);
}
