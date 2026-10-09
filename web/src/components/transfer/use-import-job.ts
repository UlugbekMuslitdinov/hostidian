"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { ImportJob } from "@hostidian/api-types";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/error";
import { qk } from "@/lib/api/keys";
import { unwrap } from "@/lib/api/unwrap";
import { describeUploadError, uploadMultipart } from "@/lib/files/upload";

/** How often we re-check an accepted import job (conventions §8). */
export const IMPORT_POLL_INTERVAL_MS = 1500;

export type ImportPhase = "idle" | "uploading" | "processing" | "done" | "failed";

export interface ImportState {
  phase: ImportPhase;
  /** 0..1 while the file is streamed to the server. */
  uploadFraction: number;
  /** Latest job snapshot once the server has accepted the upload (202). */
  job: ImportJob | null;
  error: string | null;
}

const IDLE: ImportState = { phase: "idle", uploadFraction: 0, job: null, error: null };

export interface UseImportJobOptions {
  /** Test seam; defaults to the XHR multipart uploader. */
  upload?: typeof uploadMultipart;
  /** Test seam; defaults to {@link IMPORT_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
}

/** Cheap pre-flight check so we never stream a file the server will reject outright. */
export function validateImportFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith(".zip")) {
    return "Choose a .zip file — an Obsidian vault or a Hostidian export.";
  }
  if (file.size === 0) return `“${file.name}” is empty.`;
  return null;
}

const isTerminal = (job: ImportJob) => job.status === "done" || job.status === "failed";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface UseImportJobResult {
  state: ImportState;
  /** Upload the zip and, on 202, poll until the job finishes. Resolves `true` once accepted. */
  start: (file: File, parentId?: string | null) => Promise<boolean>;
  /** Abort an in-flight upload/poll and return to the idle state. */
  reset: () => void;
}

/**
 * Drives the workspace import: multipart upload with progress, then polling of
 * `GET /import-jobs/{jobId}` until `done`/`failed`. Polling stops on unmount or `reset`.
 */
export function useImportJob(workspaceId: string, options: UseImportJobOptions = {}): UseImportJobResult {
  const { upload = uploadMultipart, pollIntervalMs = IMPORT_POLL_INTERVAL_MS } = options;
  const qc = useQueryClient();
  const [state, setState] = useState<ImportState>(IDLE);
  const aliveRef = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState(IDLE);
  }, []);

  const start = useCallback(
    async (file: File, parentId?: string | null): Promise<boolean> => {
      const invalid = validateImportFile(file);
      if (invalid) {
        setState({ ...IDLE, phase: "failed", error: invalid });
        toast.error("Couldn't import the file", { description: invalid });
        return false;
      }

      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setState({ phase: "uploading", uploadFraction: 0, job: null, error: null });

      let accepted: ImportJob | undefined;
      try {
        accepted = await upload<ImportJob>(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/import`,
          { parentId: parentId ?? undefined },
          file,
          {
            signal: controller.signal,
            onProgress: (progress) => {
              if (aliveRef.current && !controller.signal.aborted) {
                setState((s) => ({ ...s, uploadFraction: progress.fraction }));
              }
            },
          },
        );
      } catch (error) {
        if (controller.signal.aborted || !aliveRef.current) return false;
        const message = describeUploadError(error);
        setState({ phase: "failed", uploadFraction: 0, job: null, error: message });
        toast.error("Couldn't import the file", { description: message });
        return false;
      }

      if (!accepted?.id) {
        if (aliveRef.current) {
          const message = "The server sent an unexpected response.";
          setState({ phase: "failed", uploadFraction: 0, job: null, error: message });
          toast.error("Couldn't import the file", { description: message });
        }
        return false;
      }
      if (!aliveRef.current) return true;

      const jobId = accepted.id;
      setState({ phase: "processing", uploadFraction: 1, job: accepted, error: null });

      void (async () => {
        while (aliveRef.current && !controller.signal.aborted) {
          await sleep(pollIntervalMs, controller.signal);
          if (!aliveRef.current || controller.signal.aborted) return;

          let job: ImportJob;
          try {
            job = await unwrap(api.GET("/import-jobs/{jobId}", { params: { path: { jobId } } }));
          } catch (error) {
            if (!aliveRef.current || controller.signal.aborted) return;
            const message = errorMessage(error);
            setState((s) => ({ ...s, phase: "failed", error: message }));
            toast.error("The import stopped", { description: message });
            return;
          }
          if (!aliveRef.current || controller.signal.aborted) return;

          if (!isTerminal(job)) {
            setState((s) => ({ ...s, phase: "processing", job }));
            continue;
          }

          if (job.status === "done") {
            setState({ phase: "done", uploadFraction: 1, job, error: null });
            await qc.invalidateQueries({ queryKey: qk.pages(workspaceId) });
            const count = job.result?.rootPageIds?.length ?? 0;
            const warnings = job.result?.warnings?.length ?? 0;
            toast.success(count === 1 ? "Imported 1 page" : `Imported ${count} pages`, {
              description: warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : undefined,
            });
          } else {
            const message = job.error ?? "The import failed.";
            setState({ phase: "failed", uploadFraction: 1, job, error: message });
            toast.error("Import failed", { description: message });
          }
          return;
        }
      })();

      return true;
    },
    [pollIntervalMs, qc, upload, workspaceId],
  );

  return { state, start, reset };
}
