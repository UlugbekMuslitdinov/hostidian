"use client";

import { useQuery } from "@tanstack/react-query";
import { Download, FileArchive, Upload } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import { FormError, FormField } from "@/components/common/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { formatBytes, uploadMultipart } from "@/lib/files/upload";
import { pagesOptions } from "@/lib/api/queries";
import { useWorkspace } from "@/lib/workspace";
import { SettingsSection } from "@/components/settings/settings-shell";
import { useImportJob } from "./use-import-job";
import { useExportWorkspace } from "./use-transfer";

function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${pct}%` }} />
    </div>
  );
}

export interface ImportExportSectionProps {
  /** Test seams, forwarded to {@link useImportJob}. */
  upload?: typeof uploadMultipart;
  pollIntervalMs?: number;
}

/**
 * "Import & export" card for workspace settings. Export streams the whole workspace as a zip;
 * import accepts an Obsidian-compatible zip and reports async job progress.
 */
export function ImportExportSection({ upload, pollIntervalMs }: ImportExportSectionProps = {}) {
  const { workspace, role } = useWorkspace();
  const { exportWorkspace, isExporting } = useExportWorkspace(workspace);
  const { state, start, reset } = useImportJob(workspace.id, { upload, pollIntervalMs });
  const pages = useQuery(pagesOptions(workspace.id));
  const [file, setFile] = useState<File | null>(null);
  const [parentId, setParentId] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = state.phase === "uploading" || state.phase === "processing";
  const guest = role === "guest";
  const importedCount = state.job?.result?.rootPageIds?.length ?? 0;
  const warnings = state.job?.result?.warnings ?? [];

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setFile(event.target.files?.[0] ?? null);
    if (state.phase === "failed" || state.phase === "done") reset();
  };

  const onReset = () => {
    reset();
    setFile(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const onImport = () => {
    if (!file) return;
    void start(file, parentId || null);
  };

  return (
    <SettingsSection
      title="Import & export"
      description={`Move pages in and out of ${workspace.name} as Markdown files.`}
    >
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
          <div className="min-w-0">
            <p className="font-medium">Export workspace</p>
            <p className="text-sm text-muted-foreground">
              Download every page you can see as Markdown files in a single zip.
            </p>
          </div>
          <Button variant="outline" className="shrink-0" disabled={isExporting} onClick={() => void exportWorkspace()}>
            <Download />
            {isExporting ? "Preparing…" : "Export"}
          </Button>
        </div>

        <div className="grid gap-3 rounded-xl border p-4">
          <div>
            <p className="font-medium">Import</p>
            <p className="text-sm text-muted-foreground">
              Upload a zip of Markdown files — an Obsidian vault or a Hostidian export. Images and other attachments are
              re-created automatically.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Zip file" hint="Markdown files plus attachments, in a .zip.">
              {(p) => (
                <Input
                  {...p}
                  ref={inputRef}
                  type="file"
                  accept=".zip,application/zip"
                  disabled={busy}
                  onChange={onFileChange}
                />
              )}
            </FormField>
            <FormField
              label="Import into"
              hint={guest ? "Guests must choose a page they can edit." : undefined}
            >
              {(p) => (
                <NativeSelect
                  {...p}
                  className="w-full"
                  value={parentId}
                  disabled={busy || pages.isPending}
                  onChange={(e) => setParentId(e.target.value)}
                >
                  <option value="">Workspace root</option>
                  {(pages.data ?? []).map((page) => (
                    <option key={page.id} value={page.id}>
                      {page.title?.trim() ? page.title : "Untitled"}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
          </div>

          {state.phase === "failed" && state.error ? <FormError message={state.error} /> : null}

          {state.phase === "uploading" ? (
            <div className="grid gap-1.5">
              <ProgressBar value={state.uploadFraction} label="Upload progress" />
              <p className="text-xs text-muted-foreground">
                Uploading{file ? ` (${formatBytes(file.size)})` : ""}… {Math.round(state.uploadFraction * 100)}%
              </p>
            </div>
          ) : null}

          {state.phase === "processing" ? (
            <div className="grid gap-1.5">
              <ProgressBar
                value={state.job && state.job.total > 0 ? state.job.processed / state.job.total : 0}
                label="Import progress"
              />
              <p className="text-xs text-muted-foreground">
                {state.job ? `Processed ${state.job.processed} of ${state.job.total}` : "Starting…"}
              </p>
            </div>
          ) : null}

          {state.phase === "done" ? (
            <div className="grid gap-1 text-sm">
              <p className="text-muted-foreground">
                {importedCount === 1 ? "1 root page imported." : `${importedCount} root pages imported.`}
              </p>
              {warnings.length > 0 ? (
                <ul className="list-disc pl-5 text-xs text-muted-foreground">
                  {warnings.map((warning, index) => (
                    <li key={`${index}-${warning}`}>{warning}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={onImport} disabled={!file || busy || (guest && !parentId)}>
              <Upload />
              {busy ? "Importing…" : "Import"}
            </Button>
            {busy || state.phase === "done" || state.phase === "failed" ? (
              <Button variant="ghost" onClick={onReset}>
                {busy ? "Cancel" : "Close"}
              </Button>
            ) : null}
            {file ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <FileArchive className="size-3.5" aria-hidden="true" />
                {file.name}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}
