export type PluginPanelSlot = "note.sidebar" | "note.toolbar" | "proposal.review";

export type PluginPanelDefinition = {
  id: string;
  title: string;
  slot: PluginPanelSlot;
  requiredPermissions?: string[];
};

export type PluginPanelSource = {
  manifest: {
    namespace: string;
    capabilities?: string[];
    ui?: {
      panels?: PluginPanelDefinition[];
    };
  };
  meta: {
    lifecycleState: "registered" | "installed" | "enabled" | "disabled";
  };
};

export type HostedPluginPanel = {
  namespace: string;
  panelId: string;
  title: string;
  slot: PluginPanelSlot;
  requiredPermissions: string[];
  lifecycleState: PluginPanelSource["meta"]["lifecycleState"];
};

export type PluginPanelsBySlot = {
  sidebar: HostedPluginPanel[];
  toolbar: HostedPluginPanel[];
  proposalReview: HostedPluginPanel[];
};

const EMPTY_PLUGIN_PANELS: PluginPanelsBySlot = {
  sidebar: [],
  toolbar: [],
  proposalReview: [],
};

function slotOrder(slot: PluginPanelSlot): number {
  if (slot === "note.sidebar") {
    return 0;
  }
  if (slot === "note.toolbar") {
    return 1;
  }

  return 2;
}

function isUiPanelHostEligible(plugin: PluginPanelSource): boolean {
  if (!["installed", "enabled"].includes(plugin.meta.lifecycleState)) {
    return false;
  }

  return plugin.manifest.capabilities?.includes("ui_panels") ?? false;
}

export function deriveHostedPluginPanels(plugins: PluginPanelSource[]): HostedPluginPanel[] {
  const hostedPanels: HostedPluginPanel[] = [];

  for (const plugin of plugins) {
    if (!isUiPanelHostEligible(plugin)) {
      continue;
    }

    const namespace = plugin.manifest.namespace;
    for (const panel of plugin.manifest.ui?.panels ?? []) {
      hostedPanels.push({
        namespace,
        panelId: panel.id,
        title: panel.title,
        slot: panel.slot,
        requiredPermissions: panel.requiredPermissions ?? [],
        lifecycleState: plugin.meta.lifecycleState,
      });
    }
  }

  hostedPanels.sort((left, right) => {
    const slotDiff = slotOrder(left.slot) - slotOrder(right.slot);
    if (slotDiff !== 0) {
      return slotDiff;
    }

    if (left.namespace !== right.namespace) {
      return left.namespace.localeCompare(right.namespace);
    }

    return left.panelId.localeCompare(right.panelId);
  });

  return hostedPanels;
}

export function groupHostedPluginPanelsBySlot(
  hostedPanels: HostedPluginPanel[],
): PluginPanelsBySlot {
  if (hostedPanels.length === 0) {
    return EMPTY_PLUGIN_PANELS;
  }

  return {
    sidebar: hostedPanels.filter((panel) => panel.slot === "note.sidebar"),
    toolbar: hostedPanels.filter((panel) => panel.slot === "note.toolbar"),
    proposalReview: hostedPanels.filter((panel) => panel.slot === "proposal.review"),
  };
}
