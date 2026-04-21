import React from "react";
import { useTranslation } from "react-i18next";
import { Code2, Pencil, GraduationCap, Coffee, Lightbulb } from "lucide-react";
import type { ProjectSession, LLMProvider } from "../../../../types/app";
import { NextTaskBanner } from "../../../task-master";

// Empty state redesign — matches the claude.ai /new layout. Upstream
// had a 4-provider picker here (Claude / Cursor / Codex / Gemini);
// this fork is Claude-only, so the picker makes no sense. We show a
// big serif greeting with the sparkle, then a row of 5 suggestion
// pills that prefill the composer. The composer itself is rendered
// by ChatComposer below — this component owns only the hero region.
//
// Props are kept to match the upstream signature so callers
// (ChatMessagesPane) don't need to change.

type ProviderSelectionEmptyStateProps = {
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (next: LLMProvider) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  cursorModel: string;
  setCursorModel: (model: string) => void;
  codexModel: string;
  setCodexModel: (model: string) => void;
  geminiModel: string;
  setGeminiModel: (model: string) => void;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: React.Dispatch<React.SetStateAction<string>>;
};

type Suggestion = {
  id: string;
  label: string;
  prompt: string;
  Icon: React.ComponentType<{ className?: string }>;
};

const SUGGESTIONS: Suggestion[] = [
  {
    id: "code",
    label: "Code",
    prompt: "Review this code and suggest improvements.\n\n",
    Icon: Code2,
  },
  {
    id: "write",
    label: "Write",
    prompt: "Draft a concise summary of the following text.\n\n",
    Icon: Pencil,
  },
  {
    id: "learn",
    label: "Learn",
    prompt: "Explain this concept like I'm an experienced engineer new to the topic: ",
    Icon: GraduationCap,
  },
  {
    id: "life",
    label: "Life stuff",
    prompt: "Help me think through this decision: ",
    Icon: Coffee,
  },
  {
    id: "choice",
    label: "Claude's choice",
    prompt: "Pick a topic you'd enjoy helping with today and introduce it in one paragraph.",
    Icon: Lightbulb,
  },
];

// Corral 8-point sparkle — inline SVG so we don't ship an icon asset.
function Sparkle({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 1c.3 0 .55.2.62.49l1.2 4.95 4.5-1.9a.64.64 0 0 1 .78.93l-2.58 4.08 4.2 2.5a.64.64 0 0 1 0 1.1l-4.2 2.5 2.58 4.08a.64.64 0 0 1-.78.93l-4.5-1.9-1.2 4.95a.64.64 0 0 1-1.24 0l-1.2-4.95-4.5 1.9a.64.64 0 0 1-.78-.93l2.58-4.08-4.2-2.5a.64.64 0 0 1 0-1.1l4.2-2.5L3.4 5.47a.64.64 0 0 1 .78-.93l4.5 1.9L9.88 1.5A.64.64 0 0 1 10.5 1h1.5z" />
    </svg>
  );
}

export default function ProviderSelectionEmptyState({
  selectedSession,
  currentSessionId,
  textareaRef,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
}: ProviderSelectionEmptyStateProps) {
  const { t } = useTranslation("chat");
  const nextTaskPrompt = t("tasks.nextTaskPrompt", {
    defaultValue: "Start the next task",
  });

  const handleSuggestion = (s: Suggestion) => {
    setInput(s.prompt);
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  // Try to read the display name for the greeting. Falls back to the
  // stubbed "work" profile label until auth wiring lands in UI-2.5.
  const greetingName =
    (typeof window !== "undefined" && localStorage.getItem("current-username")) ||
    "work";

  /* ── New session — claude.ai /new layout ── */
  if (!selectedSession && !currentSessionId) {
    return (
      <div className="flex h-full w-full items-center justify-center px-4 md:px-8">
        <div className="w-full max-w-2xl">
          {/* Greeting — sparkle + serif display line */}
          <div className="mb-10 flex items-center justify-center gap-4">
            <Sparkle className="h-8 w-8 shrink-0 text-primary md:h-9 md:w-9" />
            <h1 className="font-display text-[36px] leading-[1.05] tracking-tight md:text-[50px]">
              {t("empty.greeting", {
                defaultValue: "{{name}} returns!",
                name: greetingName,
              })}
            </h1>
          </div>

          {/* Suggestion pills — prefill the composer */}
          <div className="mb-8 flex flex-wrap items-center justify-center gap-2">
            {SUGGESTIONS.map(({ id, label, Icon, prompt }) => (
              <button
                key={id}
                onClick={() =>
                  handleSuggestion({ id, label, Icon, prompt } as Suggestion)
                }
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
              >
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                <span>{label}</span>
              </button>
            ))}
          </div>

          {/* Task banner kept from upstream — renders only when the
              TaskMaster plugin is installed and enabled. */}
          {tasksEnabled && isTaskMasterInstalled && (
            <div className="mt-4">
              <NextTaskBanner
                onStartTask={() => setInput(nextTaskPrompt)}
                onShowAllTasks={onShowAllTasks}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ── Existing session — minimal continue prompt ── */
  if (selectedSession) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md px-6 text-center">
          <p className="mb-1.5 text-lg font-semibold text-foreground">
            {t("session.continue.title")}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("session.continue.description")}
          </p>

          {tasksEnabled && isTaskMasterInstalled && (
            <div className="mt-5">
              <NextTaskBanner
                onStartTask={() => setInput(nextTaskPrompt)}
                onShowAllTasks={onShowAllTasks}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
