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
      disclosureSections: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  },
};

const remCliOperatorSkill: CannedSkillDefinition = {
  id: "rem-cli-memory",
  name: "rem",
  description:
    "Single umbrella skill for rem memory recall, note operations, and plugin workflows via progressive disclosure.",
  pluginManifest: agentSkillsManifest,
  note: {
    id: "skill-rem-cli-memory",
    title: "Skill: REM CLI Operator Workflow",
    noteType: "agent-skill-playbook",
    tags: [
      "agent",
      "skill",
      "memory",
      "cli",
      "rem",
      "plugins",
      "playbook",
      "remember",
      "recall",
      "context",
      "knowledge",
      "history",
    ],
    lexicalState: {
      root: {
        type: "root",
        version: 1,
        children: [
          heading(1, "REM CLI Operator Workflow"),
          paragraph(
            "Use this single skill as an umbrella playbook for rem. Start with the section that matches the task and load only the commands needed for that step.",
          ),
          heading(2, "Progressive Disclosure"),
          paragraph("1. Memory Recall and Context: retrieval, timeline checks, and system health."),
          paragraph(
            "2. Note Operations: create/read/update notes and proposal-first section edits.",
          ),
          paragraph(
            "3. Plugin Workflows: daily notes, plugin lifecycle, runtime actions, templates, scheduler, and entities.",
          ),
          paragraph("4. Command Index: quick syntax lookup when you already know the workflow."),
          heading(2, "Invoke When"),
          paragraph(
            "You need rem as long-lived memory for recall, context restoration, and operational history.",
          ),
          paragraph(
            "You need canonical note create/read/update, including section-targeted proposals for agent edits.",
          ),
          paragraph(
            "You need daily-note or plugin-powered workflows (lifecycle, runtime, templates, scheduler, entities).",
          ),
          heading(2, "Memory Recall and Context"),
          paragraph(
            'rem search "<query>" --tags <csv> --note-types <csv> --plugin-namespaces <csv> --created-since <iso> --json',
          ),
          paragraph("rem get note <note-id> --format text --json"),
          paragraph(
            "rem events list --type <event-type> --entity-kind <note|proposal|plugin> --entity-id <id> --json",
          ),
          paragraph("rem status --json"),
          paragraph(
            "Recall flow: search first, read canonical note content, inspect events when history matters, then decide whether mutation is needed.",
          ),
          heading(2, "Note Operations"),
          paragraph("Create or update: rem notes save --input <path> --json"),
          paragraph("Read: rem get note <note-id> --format lexical|text|md --json"),
          paragraph("Section targeting: rem sections list --note <note-id> --json"),
          paragraph(
            "Agent-first edits: create proposal, then list/get/accept/reject proposals for reviewable changes.",
          ),
          paragraph(
            "No canonical note delete command is currently exposed in rem CLI/API; treat notes as create/read/update plus proposal workflows.",
          ),
          heading(2, "Plugin Workflows"),
          paragraph(
            "Daily notes: use API route POST /daily-notes/today for deterministic get-or-create behavior.",
          ),
          paragraph(
            "Lifecycle: rem plugin register|install|list|inspect|enable|disable|uninstall --json",
          ),
          paragraph(
            "Runtime: rem plugin run <namespace> <action-id> --input <json-or-path> --json",
          ),
          paragraph("Templates: rem plugin templates list|apply --json"),
          paragraph("Scheduler: rem plugin scheduler status|run --json"),
          paragraph("Entities: rem entities save|get|list|migrate --json"),
          paragraph(
            "When actor kind is agent, prefer proposal-first note mutation patterns unless an explicit override path is required.",
          ),
          heading(2, "Avoid When"),
          paragraph(
            "The task is unrelated to memory management in rem, such as browser automation, external integrations, or non-vault project edits.",
          ),
          heading(2, "Command Index"),
          paragraph("rem notes save --input <path> --json"),
          paragraph("rem get note <note-id> --format lexical|text|md --json"),
          paragraph("rem sections list --note <note-id> --json"),
          paragraph(
            'rem proposals create --note <note-id> --section <section-id> --text "..." --json',
          ),
          paragraph("rem proposals get <proposal-id> --json"),
          paragraph("rem proposals list --status open --json"),
          paragraph("rem proposals accept <proposal-id> --json"),
          paragraph("rem proposals reject <proposal-id> --json"),
          paragraph(
            'rem search "<query>" --tags <csv> --note-types <csv> --plugin-namespaces <csv> --json',
          ),
          paragraph("rem events list --limit 100 --json"),
          paragraph("rem plugin list --json"),
          paragraph("rem plugin inspect <namespace> --json"),
          paragraph("rem plugin templates list --json"),
          paragraph("rem plugin scheduler status --json"),
          paragraph("rem entities list --namespace <namespace> --type <entityType> --json"),
          paragraph("rem status --json"),
          heading(2, "Recommended Flow"),
          paragraph("1. Pick the section that matches intent: recall, notes, or plugins."),
          paragraph("2. Run reads first (`search`, `get note`, `events`, `status`)."),
          paragraph(
            "3. For note edits, prefer section-targeted proposals for agent-originated changes.",
          ),
          paragraph(
            "4. Run plugin lifecycle or runtime commands only after confirming plugin state.",
          ),
          paragraph("5. Keep outputs in `--json` form for deterministic downstream agent steps."),
        ],
      },
    },
    payload: {
      skillId: "rem-cli-memory",
      summary:
        "Umbrella rem skill with progressive disclosure for memory recall, note operations, and plugin workflows.",
      invokeWhen: [
        "Need durable memory recall, context restoration, or indexed timeline checks in rem.",
        "Need note create/read/update workflows with proposal-first guardrails for agent edits.",
        "Need built-in daily notes and broader plugin lifecycle/runtime/template/scheduler/entity workflows.",
      ],
      avoidWhen: [
        "Task does not involve rem vault data.",
        "Task is primarily browser or external system automation.",
      ],
      coreCommands: [
        'rem search "<query>" --tags <csv> --note-types <csv> --plugin-namespaces <csv> --json',
        "rem get note <note-id> --format lexical|text|md --json",
        "rem notes save --input <path> --json",
        "rem sections list --note <note-id> --json",
        'rem proposals create --note <note-id> --section <section-id> --text "..." --json',
        "rem proposals get <proposal-id> --json",
        "rem proposals list --status open --json",
        "rem proposals accept <proposal-id> --json",
        "rem proposals reject <proposal-id> --json",
        "rem plugin list --json",
        "rem plugin inspect <namespace> --json",
        "rem plugin run <namespace> <action-id> --input <json-or-path> --json",
        "rem plugin templates list --json",
        "rem plugin scheduler status --json",
        "rem entities list --namespace <namespace> --type <entityType> --json",
        "rem events list --limit 100 --json",
        "rem status --json",
      ],
      workflow: [
        "Route the task by section: memory recall, note operations, or plugin workflows.",
        "Run read operations before write operations.",
        "Use proposals for agent-originated note edits unless an explicit override is required.",
        "Verify plugin lifecycle state before plugin action or scheduler execution.",
        "Prefer --json for deterministic machine-readable output.",
      ],
      disclosureSections: [
        "Memory Recall and Context",
        "Note Operations",
        "Plugin Workflows",
        "Command Index",
      ],
    },
  },
};

const cannedSkills: CannedSkillDefinition[] = [remCliOperatorSkill];

export function listCannedSkills(): CannedSkillDefinition[] {
  return cannedSkills;
}

export function getCannedSkill(skillId: string): CannedSkillDefinition | undefined {
  return cannedSkills.find((skill) => skill.id === skillId);
}
