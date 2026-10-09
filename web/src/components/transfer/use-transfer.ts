"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ApiError, errorMessage } from "@/lib/api/error";
import { downloadBlob, filenameFromDisposition, sanitizeFilename } from "@/lib/download";

/** Minimal workspace shape needed to name the download; keeps the hook easy to use and test. */
export interface ExportableWorkspace {
  id: string;
  name: string;
}

export interface UseExportWorkspaceResult {
  exportWorkspace: () => Promise<void>;
  isExporting: boolean;
}

/**
 * Downloads `GET /workspaces/{id}/export` as a zip. Mirrors `use-page-actions.exportPage`:
 * raw `fetch` (binary stream, not JSON) with the session cookie, then `downloadBlob`.
 */
export function useExportWorkspace(workspace: ExportableWorkspace): UseExportWorkspaceResult {
  const [isExporting, setIsExporting] = useState(false);
  const { id, name } = workspace;

  const exportWorkspace = useCallback(async () => {
    const toastId = toast.loading("Preparing export…");
    setIsExporting(true);
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(id)}/export`, { credentials: "include" });
      if (!res.ok) throw ApiError.fromResponse(res.status, await res.json().catch(() => undefined));
      const blob = await res.blob();
      const filename = filenameFromDisposition(res.headers.get("content-disposition")) ?? `${sanitizeFilename(name)}.zip`;
      downloadBlob(blob, filename);
      toast.success("Export downloaded", { id: toastId });
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 501
          ? "Export isn't available on this server yet."
          : errorMessage(error);
      toast.error("Couldn't export the workspace", { id: toastId, description: message });
    } finally {
      setIsExporting(false);
    }
  }, [id, name]);

  return { exportWorkspace, isExporting };
}
