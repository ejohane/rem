import { describe, expect, test } from "bun:test";

import {
  type PluginPanelSource,
  deriveHostedPluginPanels,
  groupHostedPluginPanelsBySlot,
} from "./plugin-panels";

describe("plugin panel slot host contract", () => {
  test("derives deterministic declarative panel descriptors from eligible plugins", () => {
    const plugins: PluginPanelSource[] = [
      {
        manifest: {
          namespace: "beta",
          capabilities: ["ui_panels"],
          ui: {
            panels: [
              {
                id: "review",
                title: "Review",
                slot: "proposal.review",
              },
            ],
          },
        },
        meta: {
          lifecycleState: "enabled",
        },
      },
      {
        manifest: {
          namespace: "alpha",
          capabilities: ["ui_panels"],
          ui: {
            panels: [
              {
                id: "toolbar",
                title: "Toolbar",
                slot: "note.toolbar",
                requiredPermissions: ["notes.read"],
              },
              {
                id: "sidebar",
                title: "Sidebar",
                slot: "note.sidebar",
              },
            ],
          },
        },
        meta: {
          lifecycleState: "installed",
        },
      },
      {
        manifest: {
          namespace: "disabled-plugin",
          capabilities: ["ui_panels"],
          ui: {
            panels: [
              {
                id: "hidden",
                title: "Hidden",
                slot: "note.sidebar",
              },
            ],
          },
        },
        meta: {
          lifecycleState: "disabled",
        },
      },
      {
        manifest: {
          namespace: "non-ui",
          capabilities: ["templates"],
        },
        meta: {
          lifecycleState: "enabled",
        },
      },
    ];

    const hostedPanels = deriveHostedPluginPanels(plugins);
    expect(hostedPanels).toEqual([
      {
        namespace: "alpha",
        panelId: "sidebar",
        title: "Sidebar",
        slot: "note.sidebar",
        requiredPermissions: [],
        lifecycleState: "installed",
      },
      {
        namespace: "alpha",
        panelId: "toolbar",
        title: "Toolbar",
        slot: "note.toolbar",
        requiredPermissions: ["notes.read"],
        lifecycleState: "installed",
      },
      {
        namespace: "beta",
        panelId: "review",
        title: "Review",
        slot: "proposal.review",
        requiredPermissions: [],
        lifecycleState: "enabled",
      },
    ]);
  });

  test("groups hosted panels by slot for note sidebar, toolbar, and proposal review surfaces", () => {
    const grouped = groupHostedPluginPanelsBySlot(
      deriveHostedPluginPanels([
        {
          manifest: {
            namespace: "alpha",
            capabilities: ["ui_panels"],
            ui: {
              panels: [
                { id: "sidebar", title: "Sidebar", slot: "note.sidebar" },
                { id: "toolbar", title: "Toolbar", slot: "note.toolbar" },
                { id: "review", title: "Review", slot: "proposal.review" },
              ],
            },
          },
          meta: {
            lifecycleState: "enabled",
          },
        },
      ]),
    );

    expect(grouped.sidebar.length).toBe(1);
    expect(grouped.toolbar.length).toBe(1);
    expect(grouped.proposalReview.length).toBe(1);
    expect(grouped.sidebar[0]?.slot).toBe("note.sidebar");
    expect(grouped.toolbar[0]?.slot).toBe("note.toolbar");
    expect(grouped.proposalReview[0]?.slot).toBe("proposal.review");
  });
});
