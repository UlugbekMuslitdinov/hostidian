import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ImportJob } from "@hostidian/api-types";
import { qk } from "@/lib/api/keys";
import { UploadError, uploadMultipart } from "@/lib/files/upload";
import { jsonResponse, routeFetch } from "@/test/fetch-mock";
import { makeTestQueryClient } from "@/test/render";
import { describeJobError, validateImportFile, useImportJob } from "./use-import-job";

vi.mock("sonner", () => ({
  toast: { loading: vi.fn(() => "toast-id"), success: vi.fn(), error: vi.fn() },
}));

const job = (overrides: Partial<ImportJob> = {}): ImportJob => ({
  id: "job-1",
  status: "running",
  total: 3,
  processed: 0,
  createdAt: "2026-10-09T00:00:00Z",
  ...overrides,
});

const zip = () => new File([new Uint8Array(4)], "vault.zip");

function setup(options: { upload?: typeof uploadMultipart; pollIntervalMs?: number } = {}) {
  const qc = makeTestQueryClient();
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useImportJob("ws-1", options), { wrapper });
  return { qc, invalidate, result };
}

describe("validateImportFile", () => {
  it("requires a non-empty .zip", () => {
    expect(validateImportFile(new File(["x"], "notes.txt"))).toMatch(/\.zip/);
    expect(validateImportFile(new File([], "vault.zip"))).toMatch(/empty/);
    expect(validateImportFile(zip())).toBeNull();
  });
});

describe("useImportJob", () => {
  it("uploads, polls until done, invalidates the page tree and reports roots", async () => {
    let polls = 0;
    routeFetch({
      "GET /import-jobs/job-1": () => {
        polls += 1;
        return jsonResponse(
          polls === 1
            ? job({ processed: 2 })
            : job({ status: "done", processed: 3, result: { rootPageIds: ["a", "b"] } }),
        );
      },
    });
    const uploadMock = vi.fn(async () => job());
    const upload = uploadMock as unknown as typeof uploadMultipart;
    const { result, invalidate } = setup({ upload, pollIntervalMs: 5 });

    await act(async () => {
      await result.current.start(zip(), "parent-1");
    });

    await waitFor(() => expect(result.current.state.phase).toBe("done"));
    expect(uploadMock).toHaveBeenCalledWith(
      "/api/workspaces/ws-1/import",
      { parentId: "parent-1" },
      expect.any(File),
      expect.anything(),
    );
    expect(result.current.state.job?.result?.rootPageIds).toEqual(["a", "b"]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.pages("ws-1") });
    expect(polls).toBe(2);
  });

  it("reports a failed job with its server error", async () => {
    routeFetch({ "GET /import-jobs/job-1": () => jsonResponse(job({ status: "failed", error: "bad zip" })) });
    const upload = vi.fn(async () => job()) as unknown as typeof uploadMultipart;
    const { result } = setup({ upload, pollIntervalMs: 5 });

    await act(async () => {
      await result.current.start(zip());
    });

    await waitFor(() => expect(result.current.state.phase).toBe("failed"));
    expect(result.current.state.error).toBe("bad zip");
  });

  it("surfaces upload errors (e.g. 413) and never polls", async () => {
    const upload = vi.fn(async () => {
      throw new UploadError("too_large", "Max 200 MB.", 413);
    }) as unknown as typeof uploadMultipart;
    const { result } = setup({ upload });

    let accepted = true;
    await act(async () => {
      accepted = await result.current.start(zip());
    });

    expect(accepted).toBe(false);
    expect(result.current.state.phase).toBe("failed");
    expect(result.current.state.error).toBe("Max 200 MB.");
  });

  it("rejects invalid files before touching the network", async () => {
    const upload = vi.fn() as unknown as typeof uploadMultipart;
    const { result } = setup({ upload });

    await act(async () => {
      await result.current.start(new File(["x"], "notes.txt"));
    });

    expect(upload).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe("failed");
  });

  it("stops polling when reset is called", async () => {
    routeFetch({ "GET /import-jobs/job-1": () => jsonResponse(job({ processed: 1 })) });
    const upload = vi.fn(async () => job()) as unknown as typeof uploadMultipart;
    const { result } = setup({ upload, pollIntervalMs: 5 });

    await act(async () => {
      await result.current.start(zip());
    });
    expect(result.current.state.phase).toBe("processing");
    act(() => result.current.reset());
    expect(result.current.state.phase).toBe("idle");
  });
});

describe("describeJobError", () => {
  it("drops the machine-readable code prefix the API puts in front of a job's error", () => {
    expect(describeJobError("bad_request: The uploaded file is not a valid zip.")).toBe("The uploaded file is not a valid zip.");
    expect(describeJobError("Plain message with: a colon")).toBe("Plain message with: a colon");
    expect(describeJobError(null)).toBe("The import failed.");
    expect(describeJobError("  ")).toBe("The import failed.");
  });
});
