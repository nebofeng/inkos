import { Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fetchJson, putApi, useApi } from "../hooks/use-api";
import type { TFunction } from "../hooks/use-i18n";
import {
  buildDeAIConfig,
  deAIDraftFromConfig,
  DEFAULT_DEAI_DRAFT,
  formatSkillErrors,
  prepareSkillEditorContent,
  skillOptionDisabled,
  type DeAIOnFail,
  type DeAISettingsDraft,
  type DeAISkillOption,
} from "./deai-settings-model";

interface ConfigResponse {
  readonly deAI?: Partial<DeAISettingsDraft> | null;
  readonly effective?: Partial<DeAISettingsDraft> | null;
}

interface SkillsResponse {
  readonly skills: ReadonlyArray<DeAISkillOption>;
}

const fieldClass = "w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm outline-none focus:border-primary/50";

export function DeAISettingsPanel({
  t,
  bookId,
  embedded = false,
}: {
  t: TFunction;
  bookId?: string;
  embedded?: boolean;
}) {
  const configPath = bookId ? `/deai/config?bookId=${encodeURIComponent(bookId)}` : "/deai/config";
  const skillsPath = bookId ? `/deai/skills?bookId=${encodeURIComponent(bookId)}` : "/deai/skills";
  const { data: configData, refetch: refetchConfig } = useApi<ConfigResponse>(configPath);
  const { data: skillsData, refetch: refetchSkills } = useApi<SkillsResponse>(skillsPath);
  const [draft, setDraft] = useState<DeAISettingsDraft>(DEFAULT_DEAI_DRAFT);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; message: string } | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorId, setEditorId] = useState<string>(DEFAULT_DEAI_DRAFT.skill);
  const [editorContent, setEditorContent] = useState("");
  const [editorSource, setEditorSource] = useState<string>("");
  const [editorBusy, setEditorBusy] = useState<"validate" | "save" | null>(null);
  const [editorErrors, setEditorErrors] = useState<string>("");

  useEffect(() => {
    if (!configData) return;
    setDraft(deAIDraftFromConfig(configData));
  }, [configData]);

  const skills = (skillsData?.skills ?? []).filter((skill) => !skill.shadowed);
  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.id === draft.skill),
    [draft.skill, skills],
  );

  const saveConfig = async () => {
    setSaving(true);
    setNotice(null);
    try {
      await putApi("/deai/config", {
        scope: bookId ? "book" : "project",
        bookId,
        deAI: buildDeAIConfig(draft),
      });
      await refetchConfig();
      setNotice({ tone: "ok", message: t("settings.saved") });
    } catch (error) {
      setNotice({ tone: "err", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  const openEditor = async (skillId: string) => {
    setEditorOpen(true);
    setEditorId(skillId);
    setEditorErrors("");
    try {
      const qs = bookId ? `?bookId=${encodeURIComponent(bookId)}` : "";
      const skill = await fetchJson<{ content: string; source: string }>(
        `/deai/skills/${encodeURIComponent(skillId)}${qs}`,
      );
      setEditorSource(skill.source);
      setEditorContent(prepareSkillEditorContent(skill.content, skill.source));
    } catch (error) {
      setEditorContent("");
      setEditorErrors(error instanceof Error ? error.message : String(error));
    }
  };

  const runValidate = async (): Promise<boolean> => {
    setEditorBusy("validate");
    setEditorErrors("");
    try {
      const result = await fetchJson<{ valid: boolean; errors: Array<{ message?: string }> }>(
        "/deai/skills/validate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: editorContent }),
        },
      );
      if (!result.valid) {
        setEditorErrors(result.errors.map((error) => error.message).filter(Boolean).join("\n") || t("settings.deaiInvalidSkill"));
        return false;
      }
      setEditorErrors("");
      return true;
    } catch (error) {
      setEditorErrors(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setEditorBusy(null);
    }
  };

  const saveSkill = async () => {
    const ok = await runValidate();
    if (!ok) return;
    setEditorBusy("save");
    try {
      await putApi(`/deai/skills/${encodeURIComponent(editorId)}`, {
        scope: bookId ? "book" : "project",
        bookId,
        content: editorContent,
      });
      await refetchSkills();
      setNotice({ tone: "ok", message: t("settings.saved") });
    } catch (error) {
      setEditorErrors(error instanceof Error ? error.message : String(error));
    } finally {
      setEditorBusy(null);
    }
  };

  const fields = (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
        />
        {t("settings.deaiEnable")}
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-muted-foreground space-y-1">
          <span>{t("settings.deaiThreshold")}</span>
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={draft.aiFlavorThreshold}
            onChange={(e) => setDraft((d) => ({ ...d, aiFlavorThreshold: Number(e.target.value) }))}
            className={fieldClass}
          />
        </label>
        <label className="text-xs text-muted-foreground space-y-1">
          <span>{t("settings.deaiMaxRetries")}</span>
          <input
            type="number"
            min={0}
            max={10}
            step={1}
            value={draft.maxRetries}
            onChange={(e) => setDraft((d) => ({ ...d, maxRetries: Number(e.target.value) }))}
            className={fieldClass}
          />
        </label>
      </div>
      <label className="text-xs text-muted-foreground space-y-1 block">
        <span>{t("settings.deaiOnFail")}</span>
        <select
          value={draft.onFail}
          onChange={(e) => setDraft((d) => ({ ...d, onFail: e.target.value as DeAIOnFail }))}
          className={fieldClass}
        >
          <option value="warn">{t("settings.deaiOnFailWarn")}</option>
          <option value="retry">{t("settings.deaiOnFailRetry")}</option>
          <option value="pause">{t("settings.deaiOnFailPause")}</option>
        </select>
      </label>
      <label className="text-xs text-muted-foreground space-y-1 block">
        <span>{t("settings.deaiSkill")}</span>
        <select
          value={draft.skill}
          onChange={(e) => setDraft((d) => ({ ...d, skill: e.target.value }))}
          className={fieldClass}
        >
          {skills.map((skill) => (
            <option key={`${skill.source}:${skill.id}`} value={skill.id} disabled={skillOptionDisabled(skill)}>
              {skill.id} [{skill.source}]{skill.valid ? "" : ` — ${formatSkillErrors(skill)}`}
            </option>
          ))}
        </select>
        {selectedSkill && !selectedSkill.valid ? (
          <p className="text-xs text-destructive">{formatSkillErrors(selectedSkill)}</p>
        ) : null}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void saveConfig()}
          disabled={saving}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground disabled:opacity-40"
        >
          {saving ? t("config.saving") : t("config.save")}
        </button>
        <button
          type="button"
          onClick={() => void openEditor(draft.skill)}
          className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground"
        >
          {t("settings.deaiViewSkill")}
        </button>
      </div>
      {notice ? (
        <p className={`text-xs ${notice.tone === "err" ? "text-destructive" : "text-muted-foreground"}`}>{notice.message}</p>
      ) : null}
      {editorOpen ? (
        <div className="space-y-2 rounded-xl border border-border/60 bg-secondary/20 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold">
              {editorId}
              {editorSource ? (
                <span className="ml-2 rounded-full bg-background px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {editorSource}
                </span>
              ) : null}
            </div>
            <button type="button" onClick={() => setEditorOpen(false)} className="text-xs text-muted-foreground">
              {t("config.cancel")}
            </button>
          </div>
          <textarea
            value={editorContent}
            onChange={(e) => setEditorContent(e.target.value)}
            rows={12}
            spellCheck={false}
            className={`${fieldClass} min-h-[240px] resize-y font-mono leading-6`}
          />
          {editorErrors ? <p className="whitespace-pre-wrap text-xs text-destructive">{editorErrors}</p> : null}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void runValidate()}
              disabled={editorBusy !== null}
              className="rounded-lg border border-border px-3 py-2 text-sm font-semibold disabled:opacity-40"
            >
              {t("settings.deaiValidate")}
            </button>
            <button
              type="button"
              onClick={() => void saveSkill()}
              disabled={editorBusy !== null}
              className="rounded-lg bg-primary px-3 py-2 text-sm font-bold text-primary-foreground disabled:opacity-40"
            >
              {editorBusy === "save" ? t("config.saving") : t("config.save")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );

  if (embedded) {
    return (
      <div className="space-y-3">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("settings.deai")}</h3>
        {fields}
      </div>
    );
  }

  return (
    <section className="rounded-2xl border border-border/50 bg-card/70 p-5 shadow-sm space-y-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-xl bg-primary/10 p-2 text-primary"><Sparkles size={18} /></div>
        <div>
          <h2 className="text-base font-bold">{t("settings.deai")}</h2>
          <p className="mt-1 text-sm text-muted-foreground leading-relaxed">{t("settings.deaiHint")}</p>
        </div>
      </div>
      {fields}
    </section>
  );
}
