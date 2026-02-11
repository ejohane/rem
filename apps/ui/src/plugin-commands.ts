export type PluginCommandAction = {
  id: string;
  title: string;
  requiredPermissions?: string[];
};

export type PluginCommandSource = {
  manifest: {
    namespace: string;
    capabilities?: string[];
    permissions?: string[];
    cli?: {
      actions?: PluginCommandAction[];
    };
  };
  meta: {
    lifecycleState: "registered" | "installed" | "enabled" | "disabled";
  };
};

export type HostedPluginCommand = {
  namespace: string;
  actionId: string;
  title: string;
  requiredPermissions: string[];
  missingPermissions: string[];
  allowed: boolean;
};

export type PluginCommandInvocationContext = {
  noteId: string | null;
  title: string;
  tags: string[];
  plainText: string;
};

export type PluginCommandInvocationPayload = {
  actor: {
    kind: "human";
    id: string;
  };
  requestId: string;
  input: {
    source: "ui.command";
    noteId: string | null;
    title: string;
    tags: string[];
    plainText: string;
  };
};

export function deriveHostedPluginCommands(plugins: PluginCommandSource[]): HostedPluginCommand[] {
  const commands: HostedPluginCommand[] = [];

  for (const plugin of plugins) {
    if (plugin.meta.lifecycleState !== "enabled") {
      continue;
    }

    if (!(plugin.manifest.capabilities?.includes("cli_actions") ?? false)) {
      continue;
    }

    const grantedPermissions = new Set(plugin.manifest.permissions ?? []);
    for (const action of plugin.manifest.cli?.actions ?? []) {
      const requiredPermissions = action.requiredPermissions ?? [];
      const missingPermissions = requiredPermissions.filter(
        (permission) => !grantedPermissions.has(permission),
      );
      commands.push({
        namespace: plugin.manifest.namespace,
        actionId: action.id,
        title: action.title,
        requiredPermissions,
        missingPermissions,
        allowed: missingPermissions.length === 0,
      });
    }
  }

  commands.sort((left, right) => {
    if (left.namespace !== right.namespace) {
      return left.namespace.localeCompare(right.namespace);
    }

    return left.actionId.localeCompare(right.actionId);
  });

  return commands;
}

export function buildPluginCommandInvocationPayload(
  context: PluginCommandInvocationContext,
  options?: {
    actorId?: string;
    requestId?: string;
  },
): PluginCommandInvocationPayload {
  return {
    actor: {
      kind: "human",
      id: options?.actorId ?? "ui-command-runner",
    },
    requestId: options?.requestId ?? crypto.randomUUID(),
    input: {
      source: "ui.command",
      noteId: context.noteId,
      title: context.title,
      tags: context.tags,
      plainText: context.plainText,
    },
  };
}
