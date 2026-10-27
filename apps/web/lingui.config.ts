import { defineConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";

// Top-level optional pages already sit behind lazy UI boundaries.
const deferredPages = [
  "src/pages/AccountSettingsOverlay.tsx",
  "src/pages/ActivityList.tsx",
  "src/pages/Artifacts.tsx",
  "src/pages/BillingSettingsPanel.tsx",
  "src/pages/Board.tsx",
  "src/pages/BotContextMenu.tsx",
  "src/pages/ExternalConversationSettings.tsx",
  "src/pages/GroupPanel.tsx",
  "src/pages/HostComputerPrompt.tsx",
  "src/pages/IntegrationSetup.tsx",
  "src/pages/KnowledgeSection.tsx",
  "src/pages/LocalSettings.tsx",
  "src/pages/McpOAuthCallback.tsx",
  "src/pages/McpServersOverlay.tsx",
  "src/pages/MemorySettingsOverlay.tsx",
  "src/pages/MessagingSettingsOverlay.tsx",
  "src/pages/ModelBackupsSettings.tsx",
  "src/pages/ModelSettingsControls.tsx",
  "src/pages/ModelSettingsOverlay.tsx",
  "src/pages/Onboarding.tsx",
  "src/pages/Paywall.tsx",
  "src/pages/PeerMessagesOverlay.tsx",
  "src/pages/PluginsOverlay.tsx",
  "src/pages/RecruitingCorrespondence.tsx",
  "src/pages/RoutineEditor.tsx",
  "src/pages/RoutineList.tsx",
  "src/pages/RoutineRunHistory.tsx",
  "src/pages/RoutineSchedule.tsx",
  "src/pages/ScratchpadSection.tsx",
  "src/pages/SettingsOverlay.tsx",
  "src/pages/SpaceSearch.tsx",
  "src/pages/VoiceSettingsOverlay.tsx",
  "src/pages/Welcome.tsx",
];

export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "de", "ko", "tr", "hi", "pt-BR", "zh-CN", "es", "ru", "fr"],
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}/messages",
      include: deferredPages,
      exclude: ["**/locales/**", "**/*.test.*"],
    },
    {
      path: "<rootDir>/src/locales/{locale}/startup",
      include: ["src"],
      exclude: ["**/locales/**", "**/*.test.*", ...deferredPages],
    },
  ],
  compileNamespace: "es",
  // Keep file paths in `#:` origins, but drop line numbers. A shift in a large
  // source file otherwise rewrites the same reference in every locale catalog.
  format: formatter({ lineNumbers: false }),
});
