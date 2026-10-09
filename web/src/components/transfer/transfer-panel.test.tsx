import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportJob } from "@hostidian/api-types";
import { qk } from "@/lib/api/keys";
import { uploadMultipart } from "@/lib/files/upload";
import { jsonResponse, routeFetch } from "@/test/fetch-mock";
import { makePage } from "@/test/factories";
import { renderWithApp } from "@/test/render";
import { toast } from "sonner";
import { ImportExportSection } from "./transfer-panel";

vi.mock("sonner", () => ({
  toast: { loading: vi.fn(() => "toast-id"), success: vi.fn(), error: vi.fn() },
}));

const runningJob = (overrides: Partial<ImportJob> = {}): ImportJob => ({
  id: "job-1",
  status: "running",
  total: 2,
  processed: 0,
  createdAt: "2026-10-09T00:00:00Z",
  ...overrides,
});

const pickZip = async (name = "vault.zip") => {
  const input = await screen.findByLabelText("Zip file");
  fireEvent.change(input, { target: { files: [new File([new Uint8Array(4)], name)] } });
  return input;
};

beforeEach(() => {
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(() => "blob:mock");
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

describe("ImportExportSection – export", () => {
  it("downloads the workspace zip, naming it from Content-Disposition", async () => {
    routeFetch({ "GET /workspaces/ws-1/pages": () => jsonResponse([]) });
    const fetchStub = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-disposition": 'attachment; filename="acme-export.zip"' },
        }),
    );
    vi.stubGlobal("fetch", fetchStub);

    renderWithApp(<ImportExportSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Export" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Export downloaded", expect.anything()));
    expect(toast.error).not.toHaveBeenCalled();
    expect(fetchStub).toHaveBeenCalledWith("/api/workspaces/ws-1/export", { credentials: "include" });
  });

  it("reports export failures", async () => {
    routeFetch({ "GET /workspaces/ws-1/pages": () => jsonResponse([]) });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "internal", message: "boom" } }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    renderWithApp(<ImportExportSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Export" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't export the workspace",
        expect.objectContaining({ description: "boom" }),
      ),
    );
  });
});

describe("ImportExportSection – import", () => {
  it("uploads a zip, follows the job and reports imported root pages", async () => {
    let polls = 0;
    routeFetch({
      "GET /workspaces/ws-1/pages": () => jsonResponse([makePage({ id: "p1", title: "Notes" })]),
      "GET /import-jobs/job-1": () => {
        polls += 1;
        return jsonResponse(
          polls < 2
            ? runningJob({ processed: 1 })
            : runningJob({ status: "done", processed: 2, result: { rootPageIds: ["a"] } }),
        );
      },
    });
    const uploadMock = vi.fn(
      async (
        _url: string,
        _fields: unknown,
        _file: File,
        options?: { onProgress?: (p: { loaded: number; total: number; fraction: number }) => void },
      ) => {
        options?.onProgress?.({ loaded: 4, total: 4, fraction: 1 });
        return runningJob();
      },
    );
    const upload = uploadMock as unknown as typeof uploadMultipart;

    const { qc } = renderWithApp(<ImportExportSection upload={upload} pollIntervalMs={5} />);
    const invalidate = vi.spyOn(qc, "invalidateQueries");

    await pickZip();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(uploadMock.mock.calls[0]?.[0]).toBe("/api/workspaces/ws-1/import");
    expect(await screen.findByText("1 root page imported.")).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.pages("ws-1") });
    expect(toast.success).toHaveBeenCalledWith("Imported 1 page", expect.anything());
  });

  it("rejects non-zip files without uploading", async () => {
    routeFetch({ "GET /workspaces/ws-1/pages": () => jsonResponse([]) });
    const upload = vi.fn() as unknown as typeof uploadMultipart;
    renderWithApp(<ImportExportSection upload={upload} />);

    await pickZip("notes.txt");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByText(/choose a \.zip/i)).toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
  });
});
